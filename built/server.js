#!/usr/bin/env node
"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dnsPacket = __importStar(require("dns-packet"));
const dgram = __importStar(require("dgram"));
const tinyqueue_1 = __importDefault(require("tinyqueue"));
const process = __importStar(require("process"));
const winston = __importStar(require("winston"));
const stringify = JSON.stringify;
const stringifyPretty = (object) => stringify(object, null, 2);
const formatError = (err, includeStack = true) => {
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
    constructor(outgoingRequestID, clientRemoteInfo, clientRequestID, expirationTimeSeconds) {
        this.outgoingRequestID = outgoingRequestID;
        this.clientRemoteInfo = clientRemoteInfo;
        this.clientRequestID = clientRequestID;
        this.expirationTimeSeconds = expirationTimeSeconds;
    }
    expired(nowSeconds) {
        return nowSeconds >= this.expirationTimeSeconds;
    }
    compareByExpirationTime(other) {
        if (this.expirationTimeSeconds < other.expirationTimeSeconds) {
            return -1;
        }
        else if (this.expirationTimeSeconds === other.expirationTimeSeconds) {
            return 0;
        }
        else {
            return 1;
        }
    }
}
;
class CacheObject {
    constructor(questionCacheKey, decodedResponse, cacheTimeSeconds, expirationTimeSeconds) {
        this.questionCacheKey = questionCacheKey;
        this.decodedResponse = decodedResponse;
        this.cacheTimeSeconds = cacheTimeSeconds;
        this.expirationTimeSeconds = expirationTimeSeconds;
    }
    expired(nowSeconds) {
        return nowSeconds >= this.expirationTimeSeconds;
    }
    compareByExpirationTime(other) {
        if (this.expirationTimeSeconds < other.expirationTimeSeconds) {
            return -1;
        }
        else if (this.expirationTimeSeconds === other.expirationTimeSeconds) {
            return 0;
        }
        else {
            return 1;
        }
    }
}
;
const getNowSeconds = () => {
    const now = new Date();
    now.setMilliseconds(0);
    return now.getTime() / 1000.;
};
class DNSProxy {
    constructor() {
        this.outgoingIDToRequestInfo = new Map();
        this.outgoingRequestInfoPriorityQueue = new tinyqueue_1.default([], (a, b) => a.compareByExpirationTime(b));
        this.questionToResponse = new Map();
        this.questionToResponsePriorityQueue = new tinyqueue_1.default([], (a, b) => a.compareByExpirationTime(b));
        this.cacheHits = 0;
        this.cacheMisses = 0;
    }
    getRandomDNSID() {
        const getRandomInt = (min, max) => {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        };
        return getRandomInt(1, 65534);
    }
    getMinTTLSecondsForAnswers(answers) {
        let minTTL;
        (answers || []).forEach((answer) => {
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
    adjustTTL(cacheObject) {
        let valid = true;
        const nowSeconds = getNowSeconds();
        const secondsUntilExpiration = cacheObject.expirationTimeSeconds - nowSeconds;
        if (secondsUntilExpiration <= 0) {
            valid = false;
        }
        else {
            const secondsInCache = nowSeconds - cacheObject.cacheTimeSeconds;
            (cacheObject.decodedResponse.answers || []).forEach((answer) => {
                answer.ttl = answer[DNSProxy.originalTTLSymbol] - secondsInCache;
                // logger.info(`new answer.ttl = ${answer.ttl}`);
            });
        }
        return valid;
    }
    start() {
        logger.info('begin start');
        setInterval(() => {
            logger.info('begin timer pop');
            const nowSeconds = getNowSeconds();
            let done;
            done = false;
            const expiredOutgoingIDs = [];
            while ((this.outgoingRequestInfoPriorityQueue.length > 0) && (!done)) {
                const outgoingRequestInfo = this.outgoingRequestInfoPriorityQueue.peek();
                if (outgoingRequestInfo && outgoingRequestInfo.expired(nowSeconds)) {
                    this.outgoingRequestInfoPriorityQueue.pop();
                    expiredOutgoingIDs.push(outgoingRequestInfo.outgoingRequestID);
                }
                else {
                    done = true;
                }
            }
            expiredOutgoingIDs.forEach((id) => {
                this.outgoingIDToRequestInfo.delete(id);
            });
            done = false;
            const expiredQuestionCacheKeys = [];
            while ((this.questionToResponsePriorityQueue.length > 0) && (!done)) {
                const cacheObject = this.questionToResponsePriorityQueue.peek();
                if (cacheObject && cacheObject.expired(nowSeconds)) {
                    this.questionToResponsePriorityQueue.pop();
                    expiredQuestionCacheKeys.push(cacheObject.questionCacheKey);
                }
                else {
                    done = true;
                }
            }
            expiredQuestionCacheKeys.forEach((questionCacheKey) => {
                this.questionToResponse.delete(questionCacheKey);
            });
            logger.info(`end timer pop cacheHits=${this.cacheHits} cacheMisses=${this.cacheMisses}` +
                ` expiredOutgoingIDs=${expiredOutgoingIDs.length} outgoingIDToRequestInfo=${this.outgoingIDToRequestInfo.size} outgoingRequestInfoPriorityQueue=${this.outgoingRequestInfoPriorityQueue.length}` +
                ` expiredQuestionCacheKeys=${expiredQuestionCacheKeys.length} questionToResponse=${this.questionToResponse.size} questionToResponsePriorityQueue=${this.questionToResponsePriorityQueue.length}`);
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
        serverSocket.on('message', (message, remoteInfo) => {
            const decodedObject = dnsPacket.decode(message, null);
            let cacheHit = false;
            if (decodedObject.questions &&
                (decodedObject.questions.length === 1)) {
                const question = decodedObject.questions[0];
                const questionCacheKey = `${question.name}_${question.type}_${question.class}`;
                const cacheObject = this.questionToResponse.get(questionCacheKey);
                if (cacheObject && this.adjustTTL(cacheObject)) {
                    const cachedResponse = cacheObject.decodedResponse;
                    cachedResponse.id = decodedObject.id;
                    const outgoingMessage = dnsPacket.encode(cachedResponse, null, null);
                    serverSocket.send(outgoingMessage, 0, outgoingMessage.length, remoteInfo.port, remoteInfo.address);
                    cacheHit = true;
                    ++this.cacheHits;
                }
            }
            if (!cacheHit) {
                ++this.cacheMisses;
                const outgoingID = this.getRandomDNSID();
                const requestTimeoutSeconds = getNowSeconds() + REQUEST_TIMEOUT_SECONDS;
                const outgoingRequestInfo = new OutgoingRequestInfo(outgoingID, remoteInfo, decodedObject.id, requestTimeoutSeconds);
                this.outgoingRequestInfoPriorityQueue.push(outgoingRequestInfo);
                this.outgoingIDToRequestInfo.set(outgoingID, outgoingRequestInfo);
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
        remoteSocket.on('message', (message, remoteInfo) => {
            const decodedObject = dnsPacket.decode(message, null);
            // logger.info(`remoteSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);
            if ((decodedObject.rcode === 'NOERROR') &&
                decodedObject.questions &&
                (decodedObject.questions.length === 1)) {
                const minTTLSeconds = this.getMinTTLSecondsForAnswers(decodedObject.answers);
                if ((minTTLSeconds !== undefined) && (minTTLSeconds > 0)) {
                    const question = decodedObject.questions[0];
                    const questionCacheKey = `${question.name}_${question.type}_${question.class}`;
                    const nowSeconds = getNowSeconds();
                    const expirationTimeSeconds = nowSeconds + minTTLSeconds;
                    const cacheObject = new CacheObject(questionCacheKey, decodedObject, nowSeconds, expirationTimeSeconds);
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
                serverSocket.send(outgoingMessage, 0, outgoingMessage.length, clientRemoteInfo.port, clientRemoteInfo.address);
            }
        });
        remoteSocket.bind();
    }
}
DNSProxy.originalTTLSymbol = Symbol('originalTTL');
;
const main = () => {
    new DNSProxy().start();
};
main();
