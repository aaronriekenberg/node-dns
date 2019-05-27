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
const fs = __importStar(require("fs"));
const net = __importStar(require("net"));
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
class RemoteInfo {
    constructor(udpSocket, udpRemoteInfo, tcpSocket) {
        this.udpSocket = udpSocket;
        this.udpRemoteInfo = udpRemoteInfo;
        this.tcpSocket = tcpSocket;
    }
    static createUDP(udpSocket, udpRemoteInfo) {
        return new RemoteInfo(udpSocket, udpRemoteInfo, null);
    }
    static createTCP(tcpSocket) {
        return new RemoteInfo(null, null, tcpSocket);
    }
    writeResponse(dnsResponse) {
        if (this.udpSocket && this.udpRemoteInfo) {
            const outgoingMessage = dnsPacket.encode(dnsResponse);
            this.udpSocket.send(outgoingMessage, 0, outgoingMessage.length, this.udpRemoteInfo.port, this.udpRemoteInfo.address);
        }
        else if (this.tcpSocket) {
            if (!this.tcpSocket.destroyed) {
                this.tcpSocket.write(dnsPacket.streamEncode(dnsResponse));
            }
        }
    }
    get isUDP() {
        return ((this.udpSocket !== null) && (this.udpRemoteInfo !== null));
    }
}
class OutgoingRequestInfo {
    constructor(outgoingRequestID, clientRemoteInfo, clientRequestID, expirationTimeSeconds, requestQuestionCacheKey) {
        this.outgoingRequestID = outgoingRequestID;
        this.clientRemoteInfo = clientRemoteInfo;
        this.clientRequestID = clientRequestID;
        this.expirationTimeSeconds = expirationTimeSeconds;
        this.requestQuestionCacheKey = requestQuestionCacheKey;
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
const createTCPReadHandler = (messageCallback) => {
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
                    const decodedMessage = dnsPacket.streamDecode(buffer.slice(0, 2 + bodyLength));
                    messageCallback(decodedMessage);
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
            this.messageCallback(dnsPacket.decode(message));
        });
        this.socket.bind();
    }
    writeRequest(dnsRequest) {
        if (this.socketListening) {
            const outgoingMessage = dnsPacket.encode(dnsRequest);
            this.socket.send(outgoingMessage, 0, outgoingMessage.length, this.remoteAddressAndPort.port, this.remoteAddressAndPort.address);
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
            if (!this.socket.destroyed) {
                this.socket.write(dnsPacket.streamEncode(dnsRequest));
            }
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
            socket.on('data', createTCPReadHandler((decodedMessage) => this.messageCallback(decodedMessage)));
            socket.on('timeout', () => {
                socket.destroy();
            });
            socket.setTimeout(this.socketTimeoutMilliseconds);
            socket.on('connect', () => {
                this.connecting = false;
                this.requestBuffer.forEach((bufferedRequest) => {
                    if (!socket.destroyed) {
                        socket.write(dnsPacket.streamEncode(bufferedRequest));
                    }
                });
                this.requestBuffer = [];
            });
            socket.connect(this.remoteAddressAndPort.port, this.remoteAddressAndPort.address);
            this.connecting = true;
        }
    }
}
class Metrics {
    constructor() {
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.fixedResponses = 0;
        this.remoteUDPRequests = 0;
        this.remoteTCPRequests = 0;
        this.responseQuestionCacheKeyMismatch = 0;
    }
}
class DNSProxy {
    constructor(configuration) {
        this.configuration = configuration;
        this.metrics = new Metrics();
        this.outgoingIDToRequestInfo = new Map();
        this.outgoingRequestInfoPriorityQueue = new tinyqueue_1.default([], (a, b) => a.compareByExpirationTime(b));
        this.questionToFixedResponse = new Map();
        this.questionToResponse = new Map();
        this.questionToResponsePriorityQueue = new tinyqueue_1.default([], (a, b) => a.compareByExpirationTime(b));
        this.tcpServerSocket = net.createServer();
        this.udpRemoteServerConnections = [];
        this.tcpRemoteServerConnections = [];
        this.getNextUDPRemoteServerConnection = this.buildRemoteServerConnectionGetter(this.udpRemoteServerConnections);
        this.getNextTCPRemoteServerConnection = this.buildRemoteServerConnectionGetter(this.tcpRemoteServerConnections);
        this.udpServerSocket = createUDPSocket(configuration.udpSocketBufferSizes);
        configuration.remoteAddressesAndPorts.forEach((remoteAddressAndPort) => {
            this.udpRemoteServerConnections.push(new UDPRemoteServerConnection(remoteAddressAndPort, (decodedMessage) => {
                this.handleRemoteSocketMessage(decodedMessage);
            }, configuration.udpSocketBufferSizes));
            this.tcpRemoteServerConnections.push(new TCPRemoteServerConnection(configuration.tcpConnectionTimeoutSeconds * 1000, remoteAddressAndPort, (decodedMessage) => {
                this.handleRemoteSocketMessage(decodedMessage);
            }));
        });
    }
    getQuestionCacheKey(questions) {
        let key;
        let firstQuestion = true;
        (questions || []).forEach((question) => {
            if (firstQuestion) {
                key = "";
            }
            else {
                key += '|';
            }
            key += `name:${question.name}_type:${question.type}_class:${question.class}`.toLowerCase();
            firstQuestion = false;
        });
        return key;
    }
    getRandomDNSID() {
        const getRandomInt = (min, max) => {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        };
        return getRandomInt(1, 65534);
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
        const logData = {
            metrics: this.metrics,
            expiredOutgoingIDs,
            outgoingIDToRequestInfo: this.outgoingIDToRequestInfo.size,
            outgoingRequestInfoPriorityQueue: this.outgoingRequestInfoPriorityQueue.length,
            expiredQuestionCacheKeys,
            questionToResponse: this.questionToResponse.size,
            questionToResponsePriorityQueue: this.questionToResponsePriorityQueue.length
        };
        logger.info(`end timer pop ${stringify(logData)}`);
    }
    handleServerSocketMessage(decodedRequestObject, clientRemoteInfo) {
        // logger.info(`serverSocket message remoteInfo = ${stringifyPretty(clientRemoteInfo)}\ndecodedRequestObject = ${stringifyPretty(decodedRequestObject)}`);
        if (!isNumber(decodedRequestObject.id)) {
            logger.warn(`handleServerSocketMessage invalid decodedRequestObject ${decodedRequestObject}`);
            return;
        }
        let responded = false;
        const questionCacheKey = this.getQuestionCacheKey(decodedRequestObject.questions);
        if (questionCacheKey) {
            const fixedResponse = this.questionToFixedResponse.get(questionCacheKey);
            if (fixedResponse) {
                fixedResponse.id = decodedRequestObject.id;
                clientRemoteInfo.writeResponse(fixedResponse);
                responded = true;
                ++this.metrics.fixedResponses;
            }
        }
        if ((!responded) && questionCacheKey) {
            const cacheObject = this.questionToResponse.get(questionCacheKey);
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
            const outgoingRequestInfo = new OutgoingRequestInfo(outgoingRequestID, clientRemoteInfo, decodedRequestObject.id, expirationTimeSeconds, questionCacheKey);
            this.outgoingRequestInfoPriorityQueue.push(outgoingRequestInfo);
            this.outgoingIDToRequestInfo.set(outgoingRequestID, outgoingRequestInfo);
            decodedRequestObject.id = outgoingRequestID;
            if (clientRemoteInfo.isUDP) {
                ++this.metrics.remoteUDPRequests;
                this.getNextUDPRemoteServerConnection().writeRequest(decodedRequestObject);
            }
            else {
                ++this.metrics.remoteTCPRequests;
                this.getNextTCPRemoteServerConnection().writeRequest(decodedRequestObject);
            }
        }
    }
    handleRemoteSocketMessage(decodedResponseObject) {
        // logger.info(`remoteSocket message decodedResponseObject = ${stringifyPretty(decodedResponseObject)}`);
        if (!isNumber(decodedResponseObject.id)) {
            logger.warn(`handleRemoteSocketMessage invalid decodedResponseObject ${decodedResponseObject}`);
            return;
        }
        let responseQuestionCacheKey;
        let minTTLSeconds;
        const nowSeconds = getNowSeconds();
        if ((decodedResponseObject.rcode === 'NOERROR') ||
            (decodedResponseObject.rcode === 'NXDOMAIN')) {
            minTTLSeconds = this.getMinTTLSecondsForResponse(decodedResponseObject);
            if (isPositiveNumber(minTTLSeconds)) {
                responseQuestionCacheKey = this.getQuestionCacheKey(decodedResponseObject.questions);
                if (responseQuestionCacheKey) {
                    const expirationTimeSeconds = nowSeconds + minTTLSeconds;
                    const cacheObject = new CacheObject(responseQuestionCacheKey, decodedResponseObject, nowSeconds, expirationTimeSeconds);
                    this.questionToResponsePriorityQueue.push(cacheObject);
                    this.questionToResponse.set(responseQuestionCacheKey, cacheObject);
                }
            }
        }
        const clientRequestInfo = this.outgoingIDToRequestInfo.get(decodedResponseObject.id);
        if (clientRequestInfo) {
            this.outgoingIDToRequestInfo.delete(decodedResponseObject.id);
            if (clientRequestInfo.requestQuestionCacheKey &&
                (clientRequestInfo.requestQuestionCacheKey !== responseQuestionCacheKey) &&
                isPositiveNumber(minTTLSeconds)) {
                ++this.metrics.responseQuestionCacheKeyMismatch;
                const expirationTimeSeconds = nowSeconds + minTTLSeconds;
                const cacheObject = new CacheObject(clientRequestInfo.requestQuestionCacheKey, decodedResponseObject, nowSeconds, expirationTimeSeconds);
                this.questionToResponsePriorityQueue.push(cacheObject);
                this.questionToResponse.set(clientRequestInfo.requestQuestionCacheKey, cacheObject);
            }
            decodedResponseObject.id = clientRequestInfo.clientRequestID;
            const clientRemoteInfo = clientRequestInfo.clientRemoteInfo;
            clientRemoteInfo.writeResponse(decodedResponseObject);
        }
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
            const decodedMessage = dnsPacket.decode(message);
            this.handleServerSocketMessage(decodedMessage, RemoteInfo.createUDP(this.udpServerSocket, remoteInfo));
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
            connection.on('data', createTCPReadHandler((decodedMessage) => {
                this.handleServerSocketMessage(decodedMessage, RemoteInfo.createTCP(connection));
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
