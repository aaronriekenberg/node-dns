#!/usr/bin/env node
import ExpiringCache from './expiring-cache.js';
import dnsPacket from 'dns-packet';
import dgram from 'dgram';
import fs from 'fs';
import http2 from 'http2';
import net from 'net';
import process from 'process';
import winston from 'winston';
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
const UTF8 = 'utf8';
const asyncReadFile = async (filePath, encoding) => {
    let fileHandle;
    try {
        fileHandle = await fs.promises.open(filePath, 'r');
        return await fileHandle.readFile({
            encoding
        });
    }
    finally {
        if (fileHandle) {
            await fileHandle.close();
        }
    }
};
const getNowSeconds = () => {
    return process.hrtime()[0];
};
const isNumber = (x) => {
    return (typeof x === 'number');
};
const isPositiveNumber = (x) => {
    return (isNumber(x) && (x > 0));
};
const writeDNSPacketToTCPSocket = (tcpSocket, packet) => {
    try {
        if (!tcpSocket.destroyed) {
            tcpSocket.write(dnsPacket.streamEncode(packet));
        }
    }
    catch (err) {
        logger.error(`writeDNSPacketToTCPSocket error err = ${formatError(err)}`);
    }
};
const writeDNSPacketToUDPSocket = (udpSocket, port, address, packet) => {
    try {
        const outgoingMessage = dnsPacket.encode(packet);
        udpSocket.send(outgoingMessage, port, address);
    }
    catch (err) {
        logger.error(`writeDNSPacketToUDPSocket error err = ${formatError(err)}`);
    }
};
const streamDecodeDNSPacket = (buffer) => {
    let packet;
    try {
        packet = dnsPacket.streamDecode(buffer);
    }
    catch (err) {
        logger.error(`streamDecodeDNSPacket error err = ${formatError(err)}`);
    }
    return packet;
};
const encodeDNSPacket = (packet) => {
    let buffer;
    try {
        buffer = dnsPacket.encode(packet);
    }
    catch (err) {
        logger.error(`encodeDNSPacket error err = ${formatError(err)}`);
    }
    return buffer;
};
const decodeDNSPacket = (buffer) => {
    let packet;
    try {
        packet = dnsPacket.decode(buffer);
    }
    catch (err) {
        logger.error(`decodeDNSPacket error err = ${formatError(err)}`);
    }
    return packet;
};
class ClientRemoteInfo {
    constructor(udpSocket, udpRemoteInfo, tcpSocket) {
        this.udpSocket = udpSocket;
        this.udpRemoteInfo = udpRemoteInfo;
        this.tcpSocket = tcpSocket;
    }
    static createUDP(udpSocket, udpRemoteInfo) {
        return new ClientRemoteInfo(udpSocket, udpRemoteInfo, null);
    }
    static createTCP(tcpSocket) {
        return new ClientRemoteInfo(null, null, tcpSocket);
    }
    writeResponse(dnsResponse) {
        if (this.udpSocket && this.udpRemoteInfo) {
            writeDNSPacketToUDPSocket(this.udpSocket, this.udpRemoteInfo.port, this.udpRemoteInfo.address, dnsResponse);
        }
        else if (this.tcpSocket) {
            writeDNSPacketToTCPSocket(this.tcpSocket, dnsResponse);
        }
    }
    get isUDP() {
        return ((this.udpSocket !== null) && (this.udpRemoteInfo !== null));
    }
}
class CacheObject {
    constructor(expirationTimeSeconds, decodedResponse, cacheTimeSeconds) {
        this.expirationTimeSeconds = expirationTimeSeconds;
        this.decodedResponse = decodedResponse;
        this.cacheTimeSeconds = cacheTimeSeconds;
    }
}
class RequestProtocolMetrics {
    constructor() {
        this.udp = 0;
        this.tcp = 0;
    }
}
class Metrics {
    constructor() {
        this.fixedResponses = 0;
        this.localRequests = new RequestProtocolMetrics();
        this.remoteRequests = 0;
        this.remoteRequestErrors = 0;
    }
}
const createTCPDataHandler = (messageCallback) => {
    let readingHeader = true;
    let buffer = Buffer.of();
    let bodyLength = 0;
    return (data) => {
        buffer = Buffer.concat([buffer, data]);
        let done = false;
        while (!done) {
            if (readingHeader) {
                if (buffer.byteLength >= 2) {
                    bodyLength = buffer.readUInt16BE(0);
                    readingHeader = false;
                }
                else {
                    done = true;
                }
            }
            else {
                if (buffer.byteLength >= (2 + bodyLength)) {
                    const decodedMessage = streamDecodeDNSPacket(buffer.slice(0, 2 + bodyLength));
                    if (decodedMessage) {
                        messageCallback(decodedMessage);
                    }
                    buffer = buffer.slice(2 + bodyLength);
                    readingHeader = true;
                    bodyLength = 0;
                }
                else {
                    done = true;
                }
            }
        }
    };
};
const createUDPSocket = (socketBufferSizes) => {
    let recvBufferSize;
    let sendBufferSize;
    if (socketBufferSizes) {
        recvBufferSize = socketBufferSizes.rcvbuf;
        sendBufferSize = socketBufferSizes.sndbuf;
    }
    return dgram.createSocket({
        type: 'udp4',
        recvBufferSize,
        sendBufferSize
    });
};
class UDPLocalServer {
    constructor(configuration, callback) {
        this.configuration = configuration;
        this.callback = callback;
        this.udpServerSocket = createUDPSocket(configuration.udpSocketBufferSizes);
    }
    start() {
        let udpServerSocketListening = false;
        this.udpServerSocket.on('error', (err) => {
            logger.warn(`udpServerSocket error ${formatError(err)}`);
            if (!udpServerSocketListening) {
                throw new Error('udp server socket bind error');
            }
        });
        this.udpServerSocket.on('listening', () => {
            udpServerSocketListening = true;
            logger.info(`udpServerSocket listening on ${stringify(this.udpServerSocket.address())} rcvbuf=${this.udpServerSocket.getRecvBufferSize()} sndbuf=${this.udpServerSocket.getSendBufferSize()}`);
        });
        this.udpServerSocket.on('message', (message, remoteInfo) => {
            const decodedMessage = decodeDNSPacket(message);
            if (decodedMessage) {
                this.callback(decodedMessage, ClientRemoteInfo.createUDP(this.udpServerSocket, remoteInfo));
            }
        });
        this.udpServerSocket.bind(this.configuration.listenAddressAndPort.port, this.configuration.listenAddressAndPort.address);
    }
}
class TCPLocalServer {
    constructor(configuration, callback) {
        this.configuration = configuration;
        this.callback = callback;
        this.tcpServerSocket = net.createServer();
    }
    start() {
        let tcpServerSocketListening = false;
        this.tcpServerSocket.on('error', (err) => {
            logger.warn(`tcpServerSocket error ${formatError(err)}`);
            if (!tcpServerSocketListening) {
                throw new Error('tcp server socket listen error');
            }
        });
        this.tcpServerSocket.on('listening', () => {
            tcpServerSocketListening = true;
            logger.info(`tcpServerSocket listening on ${stringify(this.tcpServerSocket.address())}`);
        });
        this.tcpServerSocket.on('connection', (connection) => {
            connection.on('error', (err) => {
                logger.warn(`tcp client error ${formatError(err)}`);
                connection.destroy();
            });
            connection.on('close', () => {
            });
            connection.on('data', createTCPDataHandler((decodedMessage) => {
                this.callback(decodedMessage, ClientRemoteInfo.createTCP(connection));
            }));
            connection.on('timeout', () => {
                connection.destroy();
            });
            connection.setTimeout(this.configuration.tcpConnectionTimeoutSeconds * 1000);
        });
        this.tcpServerSocket.listen(this.configuration.listenAddressAndPort.port, this.configuration.listenAddressAndPort.address);
    }
}
// https://tools.ietf.org/html/rfc8484
class Http2RemoteServerConnection {
    constructor(configuration) {
        this.clientHttp2Session = null;
        this.sessionCreationTimeSeconds = 0;
        this.url = configuration.url;
        this.path = configuration.path;
        this.requestTimeoutMilliseconds = configuration.requestTimeoutSeconds * 1000;
        this.sessionIdleTimeoutMilliseconds = configuration.sessionIdleTimeoutSeconds * 1000;
        this.sessionMaxAgeSeconds = configuration.sessionMaxAgeSeconds;
    }
    writeRequest(dnsRequest) {
        return new Promise((resolve, reject) => {
            const originalID = dnsRequest.id;
            dnsRequest.id = 0;
            const outgoingRequestBuffer = encodeDNSPacket(dnsRequest);
            if (!outgoingRequestBuffer) {
                reject(new Error('error encoding dns packet'));
                return;
            }
            this.createSessionIfNecessary();
            if ((!this.clientHttp2Session) || this.clientHttp2Session.closed || this.clientHttp2Session.destroyed) {
                reject(new Error('clientHttp2Session invalid state'));
                return;
            }
            const request = this.clientHttp2Session.request({
                'content-type': 'application/dns-message',
                'content-length': outgoingRequestBuffer.length,
                'accept': 'application/dns-message',
                ':method': 'POST',
                ':path': this.path
            });
            const responseChunks = [];
            request.on('data', (chunk) => {
                responseChunks.push(chunk);
            });
            request.on('error', (error) => {
                request.close();
                reject(new Error(`http2 request error error = ${formatError(error)}`));
            });
            request.setTimeout(this.requestTimeoutMilliseconds);
            request.on('timeout', () => {
                request.close();
                reject(new Error(`http2 request timeout`));
            });
            request.on('response', (headers) => {
                if (headers[':status'] !== 200) {
                    request.close();
                    reject(new Error(`got non-200 http status response ${headers[':status']}`));
                }
            });
            request.once('end', () => {
                if (responseChunks.length === 0) {
                    request.close();
                    reject(new Error('responseChunks empty'));
                }
                else {
                    const responseBuffer = Buffer.concat(responseChunks);
                    const response = decodeDNSPacket(responseBuffer);
                    if (!response) {
                        request.close();
                        reject(new Error('error decoding dns packet'));
                    }
                    else {
                        response.id = originalID;
                        resolve(response);
                    }
                }
            });
            request.end(outgoingRequestBuffer);
        });
    }
    createSessionIfNecessary() {
        const nowSeconds = getNowSeconds();
        if (this.clientHttp2Session) {
            if ((nowSeconds - this.sessionCreationTimeSeconds) > this.sessionMaxAgeSeconds) {
                logger.info('this.clientHttp2Session is too old, destroying');
                this.clientHttp2Session.destroy();
            }
            else {
                return;
            }
        }
        const newClientHttp2Session = http2.connect(this.url);
        newClientHttp2Session.on('connect', () => {
            logger.info('newClientHttp2Session on connect');
        });
        newClientHttp2Session.once('close', () => {
            logger.info('newClientHttp2Session on close');
            if (this.clientHttp2Session === newClientHttp2Session) {
                this.clientHttp2Session = null;
                logger.info('set this.clientHttp2Session = null');
            }
        });
        newClientHttp2Session.on('error', (error) => {
            logger.info(`newClientHttp2Session on error error = ${formatError(error)}`);
            newClientHttp2Session.destroy();
        });
        newClientHttp2Session.on('timeout', () => {
            logger.info('newClientHttp2Session on timeout');
            newClientHttp2Session.destroy();
        });
        newClientHttp2Session.setTimeout(this.sessionIdleTimeoutMilliseconds);
        this.clientHttp2Session = newClientHttp2Session;
        this.sessionCreationTimeSeconds = nowSeconds;
    }
}
class DNSProxy {
    constructor(configuration) {
        this.configuration = configuration;
        this.metrics = new Metrics();
        this.questionToFixedResponse = new Map();
        this.questionToResponseCache = new ExpiringCache();
        this.localServers = [];
        this.localServers.push(new UDPLocalServer(configuration, (decodeDNSPacket, clientRemoteInfo) => {
            ++this.metrics.localRequests.udp;
            this.handleLocalRequest(decodeDNSPacket, clientRemoteInfo);
        }));
        this.localServers.push(new TCPLocalServer(configuration, (decodeDNSPacket, clientRemoteInfo) => {
            ++this.metrics.localRequests.tcp;
            this.handleLocalRequest(decodeDNSPacket, clientRemoteInfo);
        }));
        this.http2RemoteServerConnection = new Http2RemoteServerConnection(configuration.remoteHttp2Configuration);
    }
    getQuestionCacheKey(questions) {
        let key = '';
        let firstQuestion = true;
        (questions || []).forEach((question) => {
            if (!firstQuestion) {
                key += '|';
            }
            key += `name:${question.name}_type:${question.type}_class:${question.class}`.toLowerCase();
            firstQuestion = false;
        });
        return key;
    }
    buildFixedResponses() {
        (this.configuration.fixedResponses || []).forEach((fixedResponse) => {
            const questionCacheKey = this.getQuestionCacheKey(fixedResponse.questions);
            if (!questionCacheKey) {
                throw new Error('fixed response missing questions');
            }
            this.questionToFixedResponse.set(questionCacheKey, fixedResponse);
        });
        logger.info(`questionToFixedResponse.size = ${this.questionToFixedResponse.size}`);
    }
    getMinTTLSecondsForResponse(response) {
        let foundRRHeaderTTL = false;
        let minTTL = this.configuration.minTTLSeconds;
        const processObject = (object) => {
            if ((!isNumber(object.ttl)) || (object.ttl < this.configuration.minTTLSeconds)) {
                object.ttl = this.configuration.minTTLSeconds;
            }
            if (object.ttl > this.configuration.maxTTLSeconds) {
                object.ttl = this.configuration.maxTTLSeconds;
            }
            object[DNSProxy.originalTTLSymbol] = object.ttl;
            if ((!foundRRHeaderTTL) || (object.ttl < minTTL)) {
                minTTL = object.ttl;
                foundRRHeaderTTL = true;
            }
        };
        (response.answers || []).forEach((answer) => processObject(answer));
        (response.additionals || []).forEach((additional) => {
            if (additional.type !== "OPT") {
                processObject(additional);
            }
        });
        (response.authorities || []).forEach((authority) => processObject(authority));
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
            const adjustObject = (object) => {
                const originalTTL = object[DNSProxy.originalTTLSymbol];
                if (!isNumber(originalTTL)) {
                    valid = false;
                }
                else {
                    object.ttl = originalTTL - secondsInCache;
                    if (object.ttl <= 0) {
                        valid = false;
                    }
                }
            };
            (cacheObject.decodedResponse.answers || []).forEach((answer) => adjustObject(answer));
            (cacheObject.decodedResponse.additionals || []).forEach((additional) => {
                if (additional.type !== "OPT") {
                    adjustObject(additional);
                }
            });
            (cacheObject.decodedResponse.authorities || []).forEach((authority) => adjustObject(authority));
        }
        return valid;
    }
    timerPop() {
        const nowSeconds = getNowSeconds();
        const expiredCacheKeys = this.questionToResponseCache.periodicCleanUp(nowSeconds);
        const logData = {
            metrics: this.metrics,
            expiredCacheKeys,
            cacheStats: this.questionToResponseCache.stats
        };
        logger.info(`end timer pop ${stringify(logData)}`);
    }
    handleLocalRequest(decodedRequestObject, clientRemoteInfo) {
        // logger.info(`handleLocalRequest message remoteInfo = ${stringifyPretty(clientRemoteInfo)}\ndecodedRequestObject = ${stringifyPretty(decodedRequestObject)}`);
        if ((!isNumber(decodedRequestObject.id)) || (!decodedRequestObject.questions)) {
            logger.warn(`handleLocalRequest invalid decodedRequestObject ${decodedRequestObject}`);
            return;
        }
        let responded = false;
        const questionCacheKey = this.getQuestionCacheKey(decodedRequestObject.questions);
        if (!responded) {
            const fixedResponse = this.questionToFixedResponse.get(questionCacheKey);
            if (fixedResponse) {
                fixedResponse.id = decodedRequestObject.id;
                clientRemoteInfo.writeResponse(fixedResponse);
                responded = true;
                ++this.metrics.fixedResponses;
            }
        }
        if (!responded) {
            const cacheObject = this.questionToResponseCache.get(questionCacheKey);
            if (cacheObject && this.adjustTTL(cacheObject)) {
                const cachedResponse = cacheObject.decodedResponse;
                cachedResponse.id = decodedRequestObject.id;
                clientRemoteInfo.writeResponse(cachedResponse);
                responded = true;
            }
        }
        if (!responded) {
            this.sendRemoteRequest(clientRemoteInfo, decodedRequestObject);
        }
    }
    async sendRemoteRequest(clientRemoteInfo, request) {
        let response;
        try {
            ++this.metrics.remoteRequests;
            response = await this.http2RemoteServerConnection.writeRequest(request);
        }
        catch (err) {
            ++this.metrics.remoteRequestErrors;
            logger.error(`http2RemoteServerConnection.writeRequest error err = ${formatError(err)}`);
        }
        if (response) {
            this.handleRemoteResponse(clientRemoteInfo, response);
        }
    }
    handleRemoteResponse(clientRemoteInfo, decodedResponseObject) {
        // logger.info(`handleRemoteResponse decodedResponseObject = ${stringifyPretty(decodedResponseObject)}`);
        if (!isNumber(decodedResponseObject.id) || (!decodedResponseObject.questions)) {
            logger.warn(`handleRemoteSocketMessage invalid decodedResponseObject ${decodedResponseObject}`);
            return;
        }
        const responseQuestionCacheKey = this.getQuestionCacheKey(decodedResponseObject.questions);
        if ((decodedResponseObject.rcode === 'NOERROR') ||
            (decodedResponseObject.rcode === 'NXDOMAIN')) {
            const minTTLSeconds = this.getMinTTLSecondsForResponse(decodedResponseObject);
            if (isPositiveNumber(minTTLSeconds)) {
                const nowSeconds = getNowSeconds();
                const expirationTimeSeconds = nowSeconds + minTTLSeconds;
                const cacheObject = new CacheObject(expirationTimeSeconds, decodedResponseObject, nowSeconds);
                this.questionToResponseCache.add(responseQuestionCacheKey, cacheObject, expirationTimeSeconds);
            }
        }
        clientRemoteInfo.writeResponse(decodedResponseObject);
    }
    start() {
        logger.info('begin start');
        this.buildFixedResponses();
        this.localServers.forEach((localServer) => localServer.start());
        setInterval(() => this.timerPop(), this.configuration.timerIntervalSeconds * 1000);
    }
}
DNSProxy.originalTTLSymbol = Symbol('originalTTL');
;
const readConfiguration = async (configFilePath) => {
    logger.info(`readConfiguration '${configFilePath}'`);
    const fileContent = await asyncReadFile(configFilePath, UTF8);
    const configuration = JSON.parse(fileContent.toString());
    logger.info(`configuration = ${stringifyPretty(configuration)}`);
    return configuration;
};
const main = async () => {
    if (process.argv.length !== 3) {
        throw new Error('config json path required as command line argument');
    }
    const configuration = await readConfiguration(process.argv[2]);
    new DNSProxy(configuration).start();
};
main().catch((err) => {
    logger.error(`main error err = ${formatError(err)}`);
    process.exit(1);
});
