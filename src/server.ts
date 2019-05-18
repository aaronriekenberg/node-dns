#!/usr/bin/env node

import * as dnsPacket from 'dns-packet';
import * as dgram from 'dgram';
import TinyQueue from 'tinyqueue';
import * as process from 'process';
import * as winston from 'winston';

const stringify = JSON.stringify;
const stringifyPretty = (object: any) => stringify(object, null, 2);

const formatError = (err: Error, includeStack = true) => {
    return ((includeStack && err.stack) || err.message);
};

const LOG_DATE_TIME_FORMAT = 'YYYY-MM-DD[T]HH:mm:ss.SSSZZ';

const logger = winston.createLogger({
    format: winston.format.combine(winston.format.timestamp({
        format: LOG_DATE_TIME_FORMAT
    }), winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`)),
    transports: [new winston.transports.Console()]
});

const SERVER_PORT = 10053;

const REMOTE_IP = '8.8.8.8';
const REMOTE_PORT = 53;

const MIN_TTL_SECONDS = 300;
const REQUEST_TIMEOUT_SECONDS = 10;

const TIMER_INTERVAL_SECONDS = 10;

class OutgoingRequestInfo {

    constructor(
        readonly outgoingRequestID: number,
        readonly clientRemoteInfo: dgram.RemoteInfo,
        readonly clientRequestID: number,
        readonly expirationTimeSeconds: number) {

    }

    expired(nowSeconds: number): boolean {
        return nowSeconds >= this.expirationTimeSeconds;
    }

    compareByExpirationTime(other: OutgoingRequestInfo): number {
        if (this.expirationTimeSeconds < other.expirationTimeSeconds) {
            return -1;
        } else if (this.expirationTimeSeconds === other.expirationTimeSeconds) {
            return 0;
        } else {
            return 1;
        }
    }
};

class CacheObject {

    constructor(
        readonly questionCacheKey: string,
        readonly decodedResponse: any,
        readonly cacheTimeSeconds: number,
        readonly expirationTimeSeconds: number) {

    }

    expired(nowSeconds: number): boolean {
        return nowSeconds >= this.expirationTimeSeconds;
    }

    compareByExpirationTime(other: CacheObject): number {
        if (this.expirationTimeSeconds < other.expirationTimeSeconds) {
            return -1;
        } else if (this.expirationTimeSeconds === other.expirationTimeSeconds) {
            return 0;
        } else {
            return 1;
        }
    }
};

const getNowSeconds = (): number => {
    const now = new Date();
    now.setMilliseconds(0);
    return now.getTime() / 1000.;
};

class DNSProxy {

    private static readonly originalTTLSymbol = Symbol('originalTTL');

    private readonly outgoingIDToRequestInfo = new Map<number, OutgoingRequestInfo>();
    private readonly outgoingRequestInfoPriorityQueue = new TinyQueue<OutgoingRequestInfo>([], (a: OutgoingRequestInfo, b: OutgoingRequestInfo) => a.compareByExpirationTime(b));

    private readonly questionToResponse = new Map<string, CacheObject>();
    private readonly questionToResponsePriorityQueue = new TinyQueue<CacheObject>([], (a: CacheObject, b: CacheObject) => a.compareByExpirationTime(b));

    private cacheHits: number = 0;
    private cacheMisses: number = 0;

    private readonly serverSocket = dgram.createSocket('udp4');
    private readonly remoteSocket = dgram.createSocket('udp4');

    private getRandomDNSID(): number {
        const getRandomInt = (min: number, max: number): number => {
            return Math.floor(Math.random() * (max - min + 1)) + min
        };
        return getRandomInt(1, 65534);
    }

    private getMinTTLSecondsForAnswers(answers: any): number | undefined {
        let minTTL: number | undefined;
        (answers || []).forEach((answer: any) => {
            if ((answer.ttl === undefined) || (answer.ttl === null) || (answer.ttl < MIN_TTL_SECONDS)) {
                answer.ttl = MIN_TTL_SECONDS;
            }
            answer[DNSProxy.originalTTLSymbol] = answer.ttl;
            if ((minTTL === undefined) || (answer.ttl < minTTL)) {
                minTTL = answer.ttl;
            }
        });
        return minTTL;
    }

    private adjustTTL(cacheObject: CacheObject): boolean {
        let valid = true;

        const nowSeconds = getNowSeconds();

        const secondsUntilExpiration = cacheObject.expirationTimeSeconds - nowSeconds;

        if (secondsUntilExpiration <= 0) {
            valid = false;
        } else {
            const secondsInCache = nowSeconds - cacheObject.cacheTimeSeconds;
            (cacheObject.decodedResponse.answers || []).forEach((answer: any) => {
                answer.ttl = answer[DNSProxy.originalTTLSymbol] - secondsInCache;
                // logger.info(`new answer.ttl = ${answer.ttl}`);
            });
        }

        return valid;
    }

    private timerPop() {
        logger.info('begin timer pop');

        const nowSeconds = getNowSeconds();
        let done: boolean;

        done = false;
        const expiredOutgoingIDs: number[] = [];
        while ((this.outgoingRequestInfoPriorityQueue.length > 0) && (!done)) {
            const outgoingRequestInfo = this.outgoingRequestInfoPriorityQueue.peek();
            if (outgoingRequestInfo && outgoingRequestInfo.expired(nowSeconds)) {
                this.outgoingRequestInfoPriorityQueue.pop();
                expiredOutgoingIDs.push(outgoingRequestInfo.outgoingRequestID);
            } else {
                done = true;
            }
        }
        expiredOutgoingIDs.forEach((id) => {
            this.outgoingIDToRequestInfo.delete(id);
        });

        done = false;
        const expiredQuestionCacheKeys: string[] = [];
        while ((this.questionToResponsePriorityQueue.length > 0) && (!done)) {
            const cacheObject = this.questionToResponsePriorityQueue.peek();
            if (cacheObject && cacheObject.expired(nowSeconds)) {
                this.questionToResponsePriorityQueue.pop();
                expiredQuestionCacheKeys.push(cacheObject.questionCacheKey);
            } else {
                done = true;
            }
        }
        expiredQuestionCacheKeys.forEach((questionCacheKey) => {
            this.questionToResponse.delete(questionCacheKey);
        });

        logger.info(`end timer pop cacheHits=${this.cacheHits} cacheMisses=${this.cacheMisses}` +
            ` expiredOutgoingIDs=${expiredOutgoingIDs.length} outgoingIDToRequestInfo=${this.outgoingIDToRequestInfo.size} outgoingRequestInfoPriorityQueue=${this.outgoingRequestInfoPriorityQueue.length}` +
            ` expiredQuestionCacheKeys=${expiredQuestionCacheKeys.length} questionToResponse=${this.questionToResponse.size} questionToResponsePriorityQueue=${this.questionToResponsePriorityQueue.length}`);
    }

    start() {
        logger.info('begin start');

        setInterval(() => this.timerPop(), TIMER_INTERVAL_SECONDS * 1000);

        this.serverSocket.on('error', (err) => {
            logger.warn(`serverSocketError ${formatError(err)}`);
            process.exit(1);
        });

        this.serverSocket.on('listening', () => {
            logger.info(`serverSocket listening on ${stringify(this.serverSocket.address())}`);
        });

        this.serverSocket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
            const decodedObject = dnsPacket.decode(message, null);
            // logger.info(`serverSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);

            let cacheHit = false;

            if (decodedObject.questions) {

                const questionCacheKey = stringify(decodedObject.questions);

                const cacheObject = this.questionToResponse.get(questionCacheKey);
                if (cacheObject && this.adjustTTL(cacheObject)) {
                    const cachedResponse = cacheObject.decodedResponse;
                    cachedResponse.id = decodedObject.id;

                    const outgoingMessage = dnsPacket.encode(cachedResponse, null, null);
                    this.serverSocket.send(outgoingMessage, 0, outgoingMessage.length, remoteInfo.port, remoteInfo.address);

                    cacheHit = true;

                    ++this.cacheHits;
                }
            }

            if (!cacheHit) {
                ++this.cacheMisses;

                const outgoingID = this.getRandomDNSID();

                const requestTimeoutSeconds = getNowSeconds() + REQUEST_TIMEOUT_SECONDS;

                const outgoingRequestInfo =
                    new OutgoingRequestInfo(outgoingID, remoteInfo, decodedObject.id, requestTimeoutSeconds);

                this.outgoingRequestInfoPriorityQueue.push(outgoingRequestInfo);
                this.outgoingIDToRequestInfo.set(outgoingID, outgoingRequestInfo);

                decodedObject.id = outgoingID;
                const outgoingMessage = dnsPacket.encode(decodedObject, null, null);

                this.remoteSocket.send(outgoingMessage, 0, outgoingMessage.length, REMOTE_PORT, REMOTE_IP);
            }
        });

        this.remoteSocket.on('error', (err) => {
            logger.warn(`remoteSocket ${formatError(err)}`);
            process.exit(1);
        });

        this.remoteSocket.on('listening', () => {
            logger.info(`remoteSocket listening on ${stringify(this.remoteSocket.address())}`);

            this.serverSocket.bind(SERVER_PORT);
        });

        this.remoteSocket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
            const decodedObject = dnsPacket.decode(message, null);
            // logger.info(`remoteSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);

            if ((decodedObject.rcode === 'NOERROR') &&
                decodedObject.questions) {

                const minTTLSeconds = this.getMinTTLSecondsForAnswers(decodedObject.answers);

                if ((minTTLSeconds !== undefined) && (minTTLSeconds > 0)) {

                    const questionCacheKey = stringify(decodedObject.questions);

                    const nowSeconds = getNowSeconds();
                    const expirationTimeSeconds = nowSeconds + minTTLSeconds;

                    const cacheObject = new CacheObject(
                        questionCacheKey, decodedObject, nowSeconds, expirationTimeSeconds);

                    this.questionToResponsePriorityQueue.push(cacheObject);
                    this.questionToResponse.set(questionCacheKey, cacheObject);
                }
            }

            const clientRequestInfo = this.outgoingIDToRequestInfo.get(decodedObject.id);
            if (clientRequestInfo) {
                this.outgoingIDToRequestInfo.delete(decodedObject.id);

                decodedObject.id = clientRequestInfo.clientRequestID;
                const outgoingMessage = dnsPacket.encode(decodedObject, null, null);

                const clientRemoteInfo = clientRequestInfo.clientRemoteInfo;

                this.serverSocket.send(outgoingMessage, 0, outgoingMessage.length, clientRemoteInfo.port, clientRemoteInfo.address);
            }
        });

        this.remoteSocket.bind();
    }

};

const main = () => {
    new DNSProxy().start();
};

main();