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

const getRandomDNSID = (): number => {
    const getRandomInt = (min: number, max: number): number => {
        return Math.floor(Math.random() * (max - min + 1)) + min
    };
    return getRandomInt(1, 65534);
}

const SERVER_PORT = 10053;

const REMOTE_IP = '8.8.8.8';
const REMOTE_PORT = 53;

const MIN_TTL_SECONDS = 10;
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

const originalTTLSymbol = Symbol('originalTTL');

const getMinTTLSecondsForAnswers = (answers: any): number | undefined => {
    let minTTL: number | undefined;
    (answers || []).forEach((answer: any) => {
        if ((answer.ttl === undefined) || (answer.ttl === null) || (answer.ttl < MIN_TTL_SECONDS)) {
            answer.ttl = MIN_TTL_SECONDS;
        }
        answer[originalTTLSymbol] = answer.ttl;
        if ((minTTL === undefined) || (answer.ttl < minTTL)) {
            minTTL = answer.ttl;
        }
    });
    return minTTL;
};

const adjustTTL = (cacheObject: CacheObject): boolean => {
    let valid = true;

    const nowSeconds = getNowSeconds();

    const secondsUntilExpiration = cacheObject.expirationTimeSeconds - nowSeconds;

    if (secondsUntilExpiration <= 0) {
        valid = false;
    } else {
        const secondsInCache = nowSeconds - cacheObject.cacheTimeSeconds;
        (cacheObject.decodedResponse.answers || []).forEach((answer: any) => {
            answer.ttl = answer[originalTTLSymbol] - secondsInCache;
            // logger.info(`new answer.ttl = ${answer.ttl}`);
        });
    }

    return valid;
};

const main = () => {
    logger.info('begin main');

    const outgoingIDToRequestInfo = new Map<number, OutgoingRequestInfo>();
    const outgoingRequestInfoPriorityQueue = new TinyQueue<OutgoingRequestInfo>([], (a: OutgoingRequestInfo, b: OutgoingRequestInfo) => a.compareByExpirationTime(b));

    const questionToResponse = new Map<string, CacheObject>();
    const questionToResponsePriorityQueue = new TinyQueue<CacheObject>([], (a: CacheObject, b: CacheObject) => a.compareByExpirationTime(b));

    let cacheHits = 0;
    let cacheMisses = 0;

    setInterval(() => {
        logger.info('begin timer pop');

        const nowSeconds = getNowSeconds();
        let done: boolean;

        done = false;
        const expiredOutgoingIDs: number[] = [];
        while ((outgoingRequestInfoPriorityQueue.length > 0) && (!done)) {
            const outgoingRequestInfo = outgoingRequestInfoPriorityQueue.peek();
            if (outgoingRequestInfo && outgoingRequestInfo.expired(nowSeconds)) {
                outgoingRequestInfoPriorityQueue.pop();
                expiredOutgoingIDs.push(outgoingRequestInfo.outgoingRequestID);
            } else {
                done = true;
            }
        }
        expiredOutgoingIDs.forEach((id) => {
            outgoingIDToRequestInfo.delete(id);
        });

        done = false;
        const expiredQuestionCacheKeys: string[] = [];
        while ((questionToResponsePriorityQueue.length > 0) && (!done)) {
            const cacheObject = questionToResponsePriorityQueue.peek();
            if (cacheObject && cacheObject.expired(nowSeconds)) {
                questionToResponsePriorityQueue.pop();
                expiredQuestionCacheKeys.push(cacheObject.questionCacheKey);
            } else {
                done = true;
            }
        }
        expiredQuestionCacheKeys.forEach((questionCacheKey) => {
            questionToResponse.delete(questionCacheKey);
        });

        logger.info(`end timer pop cacheHits=${cacheHits} cacheMisses=${cacheMisses}` +
            ` expiredOutgoingIDs=${expiredOutgoingIDs.length} outgoingIDToRequestInfo=${outgoingIDToRequestInfo.size} outgoingRequestInfoPriorityQueue=${outgoingRequestInfoPriorityQueue.length}` +
            ` expiredQuestionCacheKeys=${expiredQuestionCacheKeys.length} questionToResponse=${questionToResponse.size} questionToResponsePriorityQueue=${questionToResponsePriorityQueue.length}`);

    }, TIMER_INTERVAL_SECONDS * 1000);

    const serverSocket = dgram.createSocket('udp4');
    const remoteSocket = dgram.createSocket('udp4');

    serverSocket.on('error', (err) => {
        logger.warn(`serverSocketError ${formatError(err)}`);
        process.exit(1);
    });

    serverSocket.on('listening', () => {
        logger.info(`serverSocket listening on ${stringify(serverSocket.address())}`);
    });

    serverSocket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
        const decodedObject = dnsPacket.decode(message, null);

        let cacheHit = false;

        if (decodedObject.questions &&
            (decodedObject.questions.length === 1) &&
            (decodedObject.questions[0].type === 'A')) {

            const question = decodedObject.questions[0];
            const questionCacheKey = `${question.name}_${question.type}_${question.class}`;

            const cacheObject = questionToResponse.get(questionCacheKey);
            if (cacheObject && adjustTTL(cacheObject)) {
                const cachedResponse = cacheObject.decodedResponse;
                cachedResponse.id = decodedObject.id;

                const outgoingMessage = dnsPacket.encode(cachedResponse, null, null);
                serverSocket.send(outgoingMessage, 0, outgoingMessage.length, remoteInfo.port, remoteInfo.address);

                cacheHit = true;

                ++cacheHits;
            }
        }

        if (!cacheHit) {
            ++cacheMisses;

            const outgoingID = getRandomDNSID();

            const requestTimeoutSeconds = getNowSeconds() + REQUEST_TIMEOUT_SECONDS;

            const outgoingRequestInfo =
                new OutgoingRequestInfo(outgoingID, remoteInfo, decodedObject.id, requestTimeoutSeconds);

            outgoingRequestInfoPriorityQueue.push(outgoingRequestInfo);
            outgoingIDToRequestInfo.set(outgoingID, outgoingRequestInfo);

            decodedObject.id = outgoingID;
            const outgoingMessage = dnsPacket.encode(decodedObject, null, null);

            remoteSocket.send(outgoingMessage, 0, outgoingMessage.length, REMOTE_PORT, REMOTE_IP);
        }
    });

    remoteSocket.on('error', (err) => {
        logger.warn(`remoteSocket ${formatError(err)}`);
        process.exit(1);
    });

    remoteSocket.on('listening', () => {
        logger.info(`remoteSocket listening on ${stringify(remoteSocket.address())}`);

        serverSocket.bind(SERVER_PORT);
    });

    remoteSocket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
        const decodedObject = dnsPacket.decode(message, null);
        // logger.info(`remoteSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);

        if ((decodedObject.rcode === 'NOERROR') &&
            decodedObject.questions &&
            (decodedObject.questions.length === 1) &&
            (decodedObject.questions[0].type === 'A')) {

            const minTTLSeconds = getMinTTLSecondsForAnswers(decodedObject.answers);

            if ((minTTLSeconds !== undefined) && (minTTLSeconds > 0)) {
                const question = decodedObject.questions[0];
                const questionCacheKey = `${question.name}_${question.type}_${question.class}`;

                const nowSeconds = getNowSeconds();
                const expirationTimeSeconds = nowSeconds + minTTLSeconds;

                const cacheObject = new CacheObject(
                    questionCacheKey, decodedObject, nowSeconds, expirationTimeSeconds);

                questionToResponsePriorityQueue.push(cacheObject);
                questionToResponse.set(questionCacheKey, cacheObject);
            }
        }

        const clientRequestInfo = outgoingIDToRequestInfo.get(decodedObject.id);
        if (clientRequestInfo) {
            outgoingIDToRequestInfo.delete(decodedObject.id);

            decodedObject.id = clientRequestInfo.clientRequestID;
            const outgoingMessage = dnsPacket.encode(decodedObject, null, null);

            const clientRemoteInfo = clientRequestInfo.clientRemoteInfo;

            serverSocket.send(outgoingMessage, 0, outgoingMessage.length, clientRemoteInfo.port, clientRemoteInfo.address);
        }
    });

    remoteSocket.bind();
};

main();