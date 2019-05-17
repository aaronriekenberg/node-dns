#!/usr/bin/env node

import * as dnsPacket from 'dns-packet';
import * as dgram from 'dgram';
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

const getRandomInt = (min: number, max: number): number => {
    return Math.floor(Math.random() * (max - min + 1)) + min
};

const getRandomDNSID = () => getRandomInt(1, 65534);

const SERVER_PORT = 10053;

const REMOTE_IP = '8.8.8.8';
const REMOTE_PORT = 53;

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
        const decodedObject = dnsPacket.decode(message, 0);
        logger.info(`serverSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);

        let cacheHit = false;

        if (decodedObject.questions &&
            (decodedObject.questions.length === 1) &&
            (decodedObject.questions[0].type === 'A')) {
            const question = decodedObject.questions[0];
            const questionCacheKey = `${question.name}_${question.type}_${question.class}`;
            logger.info(`questionCacheKey = ${questionCacheKey}`);

            const cachedResponse = questionToResponse.get(questionCacheKey);
            if (cachedResponse) {
                cachedResponse.id = decodedObject.id;
                const outgoingMessage = dnsPacket.encode(cachedResponse, null, null);

                serverSocket.send(outgoingMessage, 0, outgoingMessage.length, remoteInfo.port, remoteInfo.address);

                cacheHit = true;
            }
        }

        logger.info(`cacheHit = ${cacheHit}`);

        if (!cacheHit) {
            const outgoingID = getRandomDNSID();

            outgoingIDToRequestInfo.set(outgoingID, {
                remoteInfo,
                clientID: decodedObject.id
            });

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
            questionToResponse.set(questionCacheKey, decodedObject);
        }

        const clientRequestInfo = outgoingIDToRequestInfo.get(decodedObject.id);
        if (clientRequestInfo) {
            outgoingIDToRequestInfo.delete(decodedObject.id);

            decodedObject.id = clientRequestInfo.clientID;
            const outgoingMessage = dnsPacket.encode(decodedObject, null, null);

            const clientRemoteInfo = clientRequestInfo.remoteInfo;

            serverSocket.send(outgoingMessage, 0, outgoingMessage.length, clientRemoteInfo.port, clientRemoteInfo.address);
        }
    });

    remoteSocket.bind();
};

main();