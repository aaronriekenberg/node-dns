#!/usr/bin/env node

const dnsPacket = require('dns-packet')
const dgram = require('dgram')
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

const getRandomInt = (min, max) => {
    return Math.floor(Math.random() * (max - min + 1)) + min
};

const getRandomDNSID = () => getRandomInt(1, 65534);

const main = () => {
    logger.info('begin main');

    const outgoingIDToRequestInfo = new Map();

    const remoteSocket = dgram.createSocket('udp4');
    const serverSocket = dgram.createSocket('udp4');
    serverSocket.bind(10053, () => {
        logger.info(`serverSocket.address = ${stringify(serverSocket.address())}`);

        remoteSocket.bind(() => {
            logger.info(`remoteSocket.address = ${stringify(remoteSocket.address())}`);

            remoteSocket.on('message', (message, remoteInfo) => {
                const decodedObject = dnsPacket.decode(message);
                logger.info(`remoteSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);

                const clientRequestInfo = outgoingIDToRequestInfo.get(decodedObject.id);
                if (clientRequestInfo) {
                    outgoingIDToRequestInfo.delete(decodedObject.id);

                    decodedObject.id = clientRequestInfo.clientID;
                    const outgoingMessage = dnsPacket.encode(decodedObject);

                    const clientRemoteInfo = clientRequestInfo.remoteInfo;

                    serverSocket.send(outgoingMessage, 0, outgoingMessage.length, clientRemoteInfo.port, clientRemoteInfo.address);
                }
            });

            serverSocket.on('message', (message, remoteInfo) => {
                const decodedObject = dnsPacket.decode(message);
                logger.info(`serverSocket message remoteInfo = ${stringifyPretty(remoteInfo)}\ndecodedObject = ${stringifyPretty(decodedObject)}`);

                const outgoingID = getRandomDNSID();

                outgoingIDToRequestInfo.set(outgoingID, {
                    remoteInfo,
                    clientID: decodedObject.id
                });

                decodedObject.id = outgoingID;
                const outgoingMessage = dnsPacket.encode(decodedObject);

                remoteSocket.send(outgoingMessage, 0, outgoingMessage.length, 53, '8.8.8.8')
            });
        });
    });


};

main();