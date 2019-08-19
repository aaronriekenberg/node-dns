#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const expiring_cache_1 = __importDefault(require("./expiring-cache"));
const dnsPacket = __importStar(require("dns-packet"));
const dgram = __importStar(require("dgram"));
const fs = __importStar(require("fs"));
const http2 = __importStar(require("http2"));
const net = __importStar(require("net"));
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
    const now = new Date();
    now.setMilliseconds(0);
    return now.getTime() / 1000.;
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
class OutgoingRequestInfo {
    constructor(clientRemoteInfo, clientRequestID, questionCacheKey) {
        this.clientRemoteInfo = clientRemoteInfo;
        this.clientRequestID = clientRequestID;
        this.questionCacheKey = questionCacheKey;
    }
}
class CacheObject {
    constructor(expirationTimeSeconds, decodedResponse, cacheTimeSeconds) {
        this.expirationTimeSeconds = expirationTimeSeconds;
        this.decodedResponse = decodedResponse;
        this.cacheTimeSeconds = cacheTimeSeconds;
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
class UDPRemoteServerConnection {
    constructor(remoteAddressAndPort, messageCallback, socketBufferSizes) {
        this.remoteAddressAndPort = remoteAddressAndPort;
        this.messageCallback = messageCallback;
        this.socketListening = false;
        this.socket = createUDPSocket(socketBufferSizes);
        this.setupSocketEvents();
    }
    setupSocketEvents() {
        this.socket.on('error', (err) => {
            logger.warn(`udp remote socket error remoteAddressAndPort=${stringify(this.remoteAddressAndPort)} ${formatError(err)}`);
            if (!this.socketListening) {
                throw new Error(`udp remote socket error remoteAddressAndPort=${stringify(this.remoteAddressAndPort)}`);
            }
        });
        this.socket.on('listening', () => {
            this.socketListening = true;
            logger.info(`udpRemoteSocket listening on ${stringify(this.socket.address())} remoteAddressAndPort=${stringify(this.remoteAddressAndPort)} rcvbuf=${this.socket.getRecvBufferSize()} sndbuf=${this.socket.getSendBufferSize()}`);
        });
        this.socket.on('message', (message, remoteInfo) => {
            const decodedMessage = decodeDNSPacket(message);
            if (decodedMessage) {
                this.messageCallback(decodedMessage);
            }
        });
        this.socket.bind();
    }
    writeRequest(dnsRequest) {
        if (this.socketListening) {
            writeDNSPacketToUDPSocket(this.socket, this.remoteAddressAndPort.port, this.remoteAddressAndPort.address, dnsRequest);
        }
    }
}
class TCPRemoteServerConnection {
    constructor(socketTimeoutMilliseconds, remoteAddressAndPort, messageCallback) {
        this.socketTimeoutMilliseconds = socketTimeoutMilliseconds;
        this.remoteAddressAndPort = remoteAddressAndPort;
        this.messageCallback = messageCallback;
        this.socket = null;
        this.connecting = false;
        this.requestBuffer = [];
    }
    writeRequest(dnsRequest) {
        this.createSocketIfNecessary();
        if (this.connecting) {
            this.requestBuffer.push(dnsRequest);
        }
        else if (this.socket) {
            writeDNSPacketToTCPSocket(this.socket, dnsRequest);
        }
    }
    createSocketIfNecessary() {
        if (!this.socket) {
            const socket = new net.Socket();
            this.socket = socket;
            socket.on('error', (err) => {
                logger.warn(`remote tcp client error remoteAddressAndPort=${stringify(this.remoteAddressAndPort)} ${formatError(err)}`);
                socket.destroy();
            });
            socket.on('close', () => {
                this.socket = null;
                this.connecting = false;
                this.requestBuffer = [];
            });
            socket.on('data', createTCPDataHandler((decodedMessage) => this.messageCallback(decodedMessage)));
            socket.on('timeout', () => {
                socket.destroy();
            });
            socket.setTimeout(this.socketTimeoutMilliseconds);
            socket.on('connect', () => {
                this.connecting = false;
                this.requestBuffer.forEach((bufferedRequest) => {
                    writeDNSPacketToTCPSocket(socket, bufferedRequest);
                });
                this.requestBuffer = [];
            });
            socket.connect(this.remoteAddressAndPort.port, this.remoteAddressAndPort.address);
            this.connecting = true;
        }
    }
}
// https://tools.ietf.org/html/rfc8484
class Http2RemoteServerConnection {
    constructor(url, path, sessionTimeoutMilliseconds, requestTimeoutMilliseconds, messageCallback) {
        this.url = url;
        this.path = path;
        this.sessionTimeoutMilliseconds = sessionTimeoutMilliseconds;
        this.requestTimeoutMilliseconds = requestTimeoutMilliseconds;
        this.messageCallback = messageCallback;
        this.clientHttp2Session = null;
    }
    writeRequest(dnsRequest) {
        const originalID = dnsRequest.id;
        dnsRequest.id = 0;
        const outgoingRequestBuffer = encodeDNSPacket(dnsRequest);
        if (!outgoingRequestBuffer) {
            return;
        }
        this.createSessionIfNecessary();
        if (this.clientHttp2Session &&
            (!this.clientHttp2Session.destroyed)) {
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
                logger.warn(`request error error = ${error}`);
            });
            request.setTimeout(this.requestTimeoutMilliseconds);
            request.on('timeout', () => {
                logger.warn(`request timeout`);
            });
            request.on('end', () => {
                logger.info(`request end responseChunks.length = ${responseChunks.length}`);
                const responseBuffer = Buffer.concat(responseChunks);
                const response = decodeDNSPacket(responseBuffer);
                if (response) {
                    response.id = originalID;
                    //logger.info(`response = ${stringifyPretty(response)}`);
                    this.messageCallback(response);
                }
            });
            request.end(outgoingRequestBuffer);
            logger.info('after request.end');
        }
    }
    createSessionIfNecessary() {
        if (this.clientHttp2Session) {
            return;
        }
        const clientHttp2Session = http2.connect(this.url);
        logger.info(`created clientHttp2Session connecting = ${clientHttp2Session.connecting}`);
        clientHttp2Session.on('connect', (session, socket) => {
            logger.info(`clientHttp2Session on connect session.connecting = ${session.connecting}`);
        });
        clientHttp2Session.on('close', () => {
            logger.info(`clientHttp2Session on close`);
            this.clientHttp2Session = null;
        });
        clientHttp2Session.on('error', (error) => {
            logger.info(`clientHttp2Session on error error = ${error}`);
            clientHttp2Session.destroy();
        });
        clientHttp2Session.on('timeout', () => {
            logger.info(`clientHttp2Session on timeout`);
            clientHttp2Session.destroy();
        });
        clientHttp2Session.setTimeout(this.sessionTimeoutMilliseconds);
        this.clientHttp2Session = clientHttp2Session;
    }
}
class RequestProtocolMetrics {
    constructor() {
        this.http2 = 0;
        this.udp = 0;
        this.tcp = 0;
    }
}
class Metrics {
    constructor() {
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.fixedResponses = 0;
        this.localRequests = new RequestProtocolMetrics();
        this.remoteRequests = new RequestProtocolMetrics();
        this.responseQuestionCacheKeyMismatch = 0;
    }
}
class DNSProxy {
    constructor(configuration) {
        this.configuration = configuration;
        this.metrics = new Metrics();
        this.questionToFixedResponse = new Map();
        this.outgoingRequestCache = new expiring_cache_1.default();
        this.questionToResponseCache = new expiring_cache_1.default();
        this.tcpServerSocket = net.createServer();
        this.udpRemoteServerConnections = [];
        this.tcpRemoteServerConnections = [];
        this.getNextUDPRemoteServerConnection = this.buildRemoteServerConnectionGetter(this.udpRemoteServerConnections);
        this.getNextTCPRemoteServerConnection = this.buildRemoteServerConnectionGetter(this.tcpRemoteServerConnections);
        this.udpServerSocket = createUDPSocket(configuration.udpSocketBufferSizes);
        (configuration.remoteAddressesAndPorts || []).forEach((remoteAddressAndPort) => {
            this.udpRemoteServerConnections.push(new UDPRemoteServerConnection(remoteAddressAndPort, (decodedMessage) => {
                this.handleRemoteSocketMessage(decodedMessage);
            }, configuration.udpSocketBufferSizes));
            this.tcpRemoteServerConnections.push(new TCPRemoteServerConnection(configuration.tcpConnectionTimeoutSeconds * 1000, remoteAddressAndPort, (decodedMessage) => {
                this.handleRemoteSocketMessage(decodedMessage);
            }));
        });
        if (configuration.remoteHttp2Configuration) {
            this.http2RemoteServerConnection = new Http2RemoteServerConnection(configuration.remoteHttp2Configuration.url, configuration.remoteHttp2Configuration.path, configuration.remoteHttp2Configuration.sessionTimeoutSeconds * 1000, configuration.remoteHttp2Configuration.requestTimeoutSeconds * 1000, (decodedMessage) => this.handleRemoteSocketMessage(decodedMessage));
        }
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
    getRandomDNSID() {
        const getRandomIntInclusive = (min, max) => {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        };
        return getRandomIntInclusive(1, 65534);
    }
    buildRemoteServerConnectionGetter(list) {
        let nextIndex = 0;
        return () => {
            if (nextIndex >= list.length) {
                nextIndex = 0;
            }
            const retVal = list[nextIndex];
            ++nextIndex;
            return retVal;
        };
    }
    routeRemoteRequest(clientRemoteInfo, request) {
        if (this.http2RemoteServerConnection) {
            ++this.metrics.remoteRequests.http2;
            this.http2RemoteServerConnection.writeRequest(request);
        }
        else {
            if (clientRemoteInfo.isUDP) {
                ++this.metrics.remoteRequests.udp;
                this.getNextUDPRemoteServerConnection().writeRequest(request);
            }
            else {
                ++this.metrics.remoteRequests.tcp;
                this.getNextTCPRemoteServerConnection().writeRequest(request);
            }
        }
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
        let minTTL;
        const processObject = (object) => {
            if ((!isNumber(object.ttl)) || (object.ttl < this.configuration.minTTLSeconds)) {
                object.ttl = this.configuration.minTTLSeconds;
            }
            if (object.ttl > this.configuration.maxTTLSeconds) {
                object.ttl = this.configuration.maxTTLSeconds;
            }
            object[DNSProxy.originalTTLSymbol] = object.ttl;
            if ((minTTL === undefined) || (object.ttl < minTTL)) {
                minTTL = object.ttl;
            }
        };
        (response.answers || []).forEach((answer) => processObject(answer));
        (response.additionals || []).forEach((additional) => processObject(additional));
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
            (cacheObject.decodedResponse.additionals || []).forEach((additional) => adjustObject(additional));
            (cacheObject.decodedResponse.authorities || []).forEach((authority) => adjustObject(authority));
        }
        return valid;
    }
    timerPop() {
        logger.info('begin timer pop');
        const nowSeconds = getNowSeconds();
        const expiredOutgoingIDs = this.outgoingRequestCache.periodicCleanUp(nowSeconds);
        const expiredQuestionCacheKeys = this.questionToResponseCache.periodicCleanUp(nowSeconds);
        const logData = {
            metrics: this.metrics,
            expiredOutgoingIDs,
            outgoingRequestMapSize: this.outgoingRequestCache.mapSize,
            outgoingRequestQueueSize: this.outgoingRequestCache.queueSize,
            expiredQuestionCacheKeys,
            questionToResponseMapSize: this.questionToResponseCache.mapSize,
            questionToResponseQueueSize: this.questionToResponseCache.queueSize
        };
        logger.info(`end timer pop ${stringify(logData)}`);
    }
    handleServerSocketMessage(decodedRequestObject, clientRemoteInfo) {
        // logger.info(`serverSocket message remoteInfo = ${stringifyPretty(clientRemoteInfo)}\ndecodedRequestObject = ${stringifyPretty(decodedRequestObject)}`);
        if ((!isNumber(decodedRequestObject.id)) || (!decodedRequestObject.questions)) {
            logger.warn(`handleServerSocketMessage invalid decodedRequestObject ${decodedRequestObject}`);
            return;
        }
        if (clientRemoteInfo.isUDP) {
            ++this.metrics.localRequests.udp;
        }
        else {
            ++this.metrics.localRequests.tcp;
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
                ++this.metrics.cacheHits;
            }
        }
        if (!responded) {
            ++this.metrics.cacheMisses;
            const outgoingRequestID = this.getRandomDNSID();
            const expirationTimeSeconds = getNowSeconds() + this.configuration.requestTimeoutSeconds;
            const outgoingRequestInfo = new OutgoingRequestInfo(clientRemoteInfo, decodedRequestObject.id, questionCacheKey);
            this.outgoingRequestCache.add(outgoingRequestID, outgoingRequestInfo, expirationTimeSeconds);
            decodedRequestObject.id = outgoingRequestID;
            this.routeRemoteRequest(clientRemoteInfo, decodedRequestObject);
        }
    }
    handleRemoteSocketMessage(decodedResponseObject) {
        // logger.info(`remoteSocket message decodedResponseObject = ${stringifyPretty(decodedResponseObject)}`);
        if (!isNumber(decodedResponseObject.id) || (!decodedResponseObject.questions)) {
            logger.warn(`handleRemoteSocketMessage invalid decodedResponseObject ${decodedResponseObject}`);
            return;
        }
        const clientRequestInfo = this.outgoingRequestCache.get(decodedResponseObject.id);
        if (!clientRequestInfo) {
            return;
        }
        const responseQuestionCacheKey = this.getQuestionCacheKey(decodedResponseObject.questions);
        if (responseQuestionCacheKey !== clientRequestInfo.questionCacheKey) {
            ++this.metrics.responseQuestionCacheKeyMismatch;
            return;
        }
        this.outgoingRequestCache.delete(decodedResponseObject.id);
        if ((decodedResponseObject.rcode === 'NOERROR') ||
            (decodedResponseObject.rcode === 'NXDOMAIN')) {
            const minTTLSeconds = this.getMinTTLSecondsForResponse(decodedResponseObject);
            if (isPositiveNumber(minTTLSeconds)) {
                const nowSeconds = getNowSeconds();
                const expirationTimeSeconds = nowSeconds + minTTLSeconds;
                const cacheObject = new CacheObject(expirationTimeSeconds, decodedResponseObject, nowSeconds);
                this.questionToResponseCache.add(clientRequestInfo.questionCacheKey, cacheObject, expirationTimeSeconds);
            }
        }
        decodedResponseObject.id = clientRequestInfo.clientRequestID;
        const clientRemoteInfo = clientRequestInfo.clientRemoteInfo;
        clientRemoteInfo.writeResponse(decodedResponseObject);
    }
    setupSocketEvents() {
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
                this.handleServerSocketMessage(decodedMessage, ClientRemoteInfo.createUDP(this.udpServerSocket, remoteInfo));
            }
        });
        this.udpServerSocket.bind(this.configuration.listenAddressAndPort.port, this.configuration.listenAddressAndPort.address);
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
                this.handleServerSocketMessage(decodedMessage, ClientRemoteInfo.createTCP(connection));
            }));
            connection.on('timeout', () => {
                connection.destroy();
            });
            connection.setTimeout(this.configuration.tcpConnectionTimeoutSeconds * 1000);
        });
        this.tcpServerSocket.listen(this.configuration.listenAddressAndPort.port, this.configuration.listenAddressAndPort.address);
    }
    start() {
        logger.info('begin start');
        this.buildFixedResponses();
        this.setupSocketEvents();
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
