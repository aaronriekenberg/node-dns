#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dnsPacket = require("dns-packet");
const dgram = require("dgram");
const process = require("process");
const winston = require("winston");
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
const getRandomDNSID = () => {
    const getRandomInt = (min, max) => {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };
    return getRandomInt(1, 65534);
};
const SERVER_PORT = 10053;
const REMOTE_IP = '8.8.8.8';
const REMOTE_PORT = 53;
class OutgoingRequestInfo {
    constructor(clientRemoteInfo, clientRequestID) {
        this.clientRemoteInfo = clientRemoteInfo;
        this.clientRequestID = clientRequestID;
    }
}
;
class CacheObject {
    constructor(decodedResponse) {
        this.decodedResponse = decodedResponse;
    }
}
;
const main = () => {
    logger.info('begin main');
    const outgoingIDToRequestInfo = new Map();
    const questionToResponse = new Map();
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
        logger.info(`serverSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);
        let cacheHit = false;
        if (decodedObject.questions &&
            (decodedObject.questions.length === 1) &&
            (decodedObject.questions[0].type === 'A')) {
            const question = decodedObject.questions[0];
            const questionCacheKey = `${question.name}_${question.type}_${question.class}`;
            logger.info(`questionCacheKey = ${questionCacheKey}`);
            const cacheObject = questionToResponse.get(questionCacheKey);
            if (cacheObject) {
                const cachedResponse = cacheObject.decodedResponse;
                cachedResponse.id = decodedObject.id;
                const outgoingMessage = dnsPacket.encode(cachedResponse, null, null);
                serverSocket.send(outgoingMessage, 0, outgoingMessage.length, remoteInfo.port, remoteInfo.address);
                cacheHit = true;
            }
        }
        logger.info(`cacheHit = ${cacheHit}`);
        if (!cacheHit) {
            const outgoingID = getRandomDNSID();
            outgoingIDToRequestInfo.set(outgoingID, new OutgoingRequestInfo(remoteInfo, decodedObject.id));
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
        logger.info(`remoteSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);
        if (decodedObject.questions &&
            (decodedObject.questions.length === 1) &&
            (decodedObject.questions[0].type === 'A') &&
            (decodedObject.rcode === 'NOERROR')) {
            const question = decodedObject.questions[0];
            const questionCacheKey = `${question.name}_${question.type}_${question.class}`;
            logger.info(`questionCacheKey = ${questionCacheKey}`);
            const cacheObject = new CacheObject(decodedObject);
            questionToResponse.set(questionCacheKey, cacheObject);
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
