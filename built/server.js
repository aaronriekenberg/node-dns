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
        this.serverSocket = dgram.createSocket('udp4');
        this.serverSocketListening = false;
        this.remoteSocket = dgram.createSocket('udp4');
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
    timerPop() {
        logger.info('begin timer pop');
        const nowSeconds = getNowSeconds();
        let done;
        done = false;
        let expiredOutgoingIDs = 0;
        while ((this.outgoingRequestInfoPriorityQueue.length > 0) && (!done)) {
            const outgoingRequestInfo = this.outgoingRequestInfoPriorityQueue.peek();
            if (outgoingRequestInfo && outgoingRequestInfo.expired(nowSeconds)) {
                this.outgoingRequestInfoPriorityQueue.pop();
                this.outgoingIDToRequestInfo.delete(outgoingRequestInfo.outgoingRequestID);
                ++expiredOutgoingIDs;
            }
            else {
                done = true;
            }
        }
        done = false;
        let expiredQuestionCacheKeys = 0;
        while ((this.questionToResponsePriorityQueue.length > 0) && (!done)) {
            const queueCacheObject = this.questionToResponsePriorityQueue.peek();
            if (queueCacheObject && queueCacheObject.expired(nowSeconds)) {
                this.questionToResponsePriorityQueue.pop();
                const mapCacheObject = this.questionToResponse.get(queueCacheObject.questionCacheKey);
                // validate expired cache object has not been re-added to map
                if (mapCacheObject && mapCacheObject.expired(nowSeconds)) {
                    this.questionToResponse.delete(mapCacheObject.questionCacheKey);
                    ++expiredQuestionCacheKeys;
                }
            }
            else {
                done = true;
            }
        }
        logger.info(`end timer pop cacheHits=${this.cacheHits} cacheMisses=${this.cacheMisses}` +
            ` expiredOutgoingIDs=${expiredOutgoingIDs} outgoingIDToRequestInfo=${this.outgoingIDToRequestInfo.size} outgoingRequestInfoPriorityQueue=${this.outgoingRequestInfoPriorityQueue.length}` +
            ` expiredQuestionCacheKeys=${expiredQuestionCacheKeys} questionToResponse=${this.questionToResponse.size} questionToResponsePriorityQueue=${this.questionToResponsePriorityQueue.length}`);
    }
    handleServerSocketMessage(message, remoteInfo) {
        const decodedObject = dnsPacket.decode(message, null);
        // logger.info(`serverSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);
        let cacheHit = false;
        if (decodedObject.questions) {
            const questionCacheKey = stringify(decodedObject.questions).toLowerCase();
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
            const outgoingRequestInfo = new OutgoingRequestInfo(outgoingID, remoteInfo, decodedObject.id, requestTimeoutSeconds);
            this.outgoingRequestInfoPriorityQueue.push(outgoingRequestInfo);
            this.outgoingIDToRequestInfo.set(outgoingID, outgoingRequestInfo);
            decodedObject.id = outgoingID;
            const outgoingMessage = dnsPacket.encode(decodedObject, null, null);
            this.remoteSocket.send(outgoingMessage, 0, outgoingMessage.length, REMOTE_PORT, REMOTE_IP);
        }
    }
    handleRemoteSocketMessage(message, remoteInfo) {
        const decodedObject = dnsPacket.decode(message, null);
        // logger.info(`remoteSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);
        if ((decodedObject.rcode === 'NOERROR') &&
            decodedObject.questions) {
            const minTTLSeconds = this.getMinTTLSecondsForAnswers(decodedObject.answers);
            if ((minTTLSeconds !== undefined) && (minTTLSeconds > 0)) {
                const questionCacheKey = stringify(decodedObject.questions).toLowerCase();
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
            this.serverSocket.send(outgoingMessage, 0, outgoingMessage.length, clientRemoteInfo.port, clientRemoteInfo.address);
        }
    }
    start() {
        logger.info('begin start');
        setInterval(() => this.timerPop(), TIMER_INTERVAL_SECONDS * 1000);
        this.serverSocket.on('error', (err) => {
            logger.warn(`serverSocketError ${formatError(err)}`);
            if (!this.serverSocketListening) {
                process.exit(1);
            }
        });
        this.serverSocket.on('listening', () => {
            this.serverSocketListening = true;
            logger.info(`serverSocket listening on ${stringify(this.serverSocket.address())}`);
        });
        this.serverSocket.on('message', (message, remoteInfo) => {
            this.handleServerSocketMessage(message, remoteInfo);
        });
        this.remoteSocket.on('error', (err) => {
            logger.warn(`remoteSocket ${formatError(err)}`);
        });
        this.remoteSocket.on('listening', () => {
            logger.info(`remoteSocket listening on ${stringify(this.remoteSocket.address())}`);
            this.serverSocket.bind(SERVER_PORT);
        });
        this.remoteSocket.on('message', (message, remoteInfo) => {
            this.handleRemoteSocketMessage(message, remoteInfo);
        });
        this.remoteSocket.bind();
    }
}
DNSProxy.originalTTLSymbol = Symbol('originalTTL');
;
const main = () => {
    new DNSProxy().start();
};
main();
