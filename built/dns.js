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
;
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
;
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
class TCPRemoteServerConnection {
    constructor(configuration, messageCallback) {
        this.messageCallback = messageCallback;
        this.socket = null;
        this.connecting = false;
        this.requestBuffer = [];
        this.socketTimeoutMilliseconds = configuration.tcpConnectionTimeoutSeconds * 1000;
        this.remoteAddress = configuration.remoteAddress;
        this.remotePort = configuration.remotePort;
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
                logger.warn(`remote tcp client error ${formatError(err)}`);
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
            socket.connect(this.remotePort, this.remoteAddress);
            this.connecting = true;
        }
    }
}
;
class DNSProxy {
    constructor(configuration) {
        this.configuration = configuration;
        this.outgoingIDToRequestInfo = new Map();
        this.outgoingRequestInfoPriorityQueue = new tinyqueue_1.default([], (a, b) => a.compareByExpirationTime(b));
        this.questionToFixedResponse = new Map();
        this.questionToResponse = new Map();
        this.questionToResponsePriorityQueue = new tinyqueue_1.default([], (a, b) => a.compareByExpirationTime(b));
        this.fixedResponses = 0;
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.remoteUDPRequests = 0;
        this.remoteTCPRequests = 0;
        this.udpServerSocket = dgram.createSocket('udp4');
        this.udpRemoteSocket = dgram.createSocket('udp4');
        this.tcpServerSocket = net.createServer();
        this.tcpRemoteServerConnection = new TCPRemoteServerConnection(configuration, (decodedMessage) => {
            this.handleRemoteSocketMessage(decodedMessage);
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
    getMinTTLSecondsForAnswers(answers) {
        let minTTL;
        (answers || []).forEach((answer) => {
            if ((answer.ttl === undefined) || (answer.ttl < this.configuration.minTTLSeconds)) {
                answer.ttl = this.configuration.minTTLSeconds;
            }
            if (answer.ttl > this.configuration.maxTTLSeconds) {
                answer.ttl = this.configuration.maxTTLSeconds;
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
                if (answer.ttl <= 0) {
                    valid = false;
                }
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
        const metrics = {
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses,
            fixedResponses: this.fixedResponses,
            expiredOutgoingIDs,
            outgoingIDToRequestInfo: this.outgoingIDToRequestInfo.size,
            outgoingRequestInfoPriorityQueue: this.outgoingRequestInfoPriorityQueue.length,
            expiredQuestionCacheKeys,
            questionToResponse: this.questionToResponse.size,
            questionToResponsePriorityQueue: this.questionToResponsePriorityQueue.length,
            remoteUDPRequests: this.remoteUDPRequests,
            remoteTCPRequests: this.remoteTCPRequests
        };
        logger.info(`end timer pop ${stringify(metrics)}`);
    }
    handleServerSocketMessage(decodedRequestObject, clientRemoteInfo) {
        // logger.info(`serverSocket message remoteInfo = ${stringifyPretty(clientRemoteInfo)}\ndecodedRequestObject = ${stringifyPretty(decodedRequestObject)}`);
        if ((decodedRequestObject.id === undefined) || (decodedRequestObject.questions === undefined)) {
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
                ++this.fixedResponses;
            }
        }
        if ((!responded) && questionCacheKey) {
            const cacheObject = this.questionToResponse.get(questionCacheKey);
            if (cacheObject && this.adjustTTL(cacheObject)) {
                const cachedResponse = cacheObject.decodedResponse;
                cachedResponse.id = decodedRequestObject.id;
                clientRemoteInfo.writeResponse(cachedResponse);
                responded = true;
                ++this.cacheHits;
            }
        }
        if (!responded) {
            ++this.cacheMisses;
            const outgoingRequestID = this.getRandomDNSID();
            const expirationTimeSeconds = getNowSeconds() + this.configuration.requestTimeoutSeconds;
            const outgoingRequestInfo = new OutgoingRequestInfo(outgoingRequestID, clientRemoteInfo, decodedRequestObject.id, expirationTimeSeconds, questionCacheKey);
            this.outgoingRequestInfoPriorityQueue.push(outgoingRequestInfo);
            this.outgoingIDToRequestInfo.set(outgoingRequestID, outgoingRequestInfo);
            decodedRequestObject.id = outgoingRequestID;
            if (clientRemoteInfo.isUDP) {
                ++this.remoteUDPRequests;
                const outgoingMessage = dnsPacket.encode(decodedRequestObject);
                this.udpRemoteSocket.send(outgoingMessage, 0, outgoingMessage.length, this.configuration.remotePort, this.configuration.remoteAddress);
            }
            else {
                ++this.remoteTCPRequests;
                this.tcpRemoteServerConnection.writeRequest(decodedRequestObject);
            }
        }
    }
    handleRemoteSocketMessage(decodedResponseObject) {
        // logger.info(`remoteSocket message decodedResponse = ${stringifyPretty(decodedResponse)}`);
        if (decodedResponseObject.id === undefined) {
            logger.warn(`handleRemoteSocketMessage invalid decodedResponseObject ${decodedResponseObject}`);
            return;
        }
        let responseQuestionCacheKey;
        if (decodedResponseObject.rcode === 'NOERROR') {
            const minTTLSeconds = this.getMinTTLSecondsForAnswers(decodedResponseObject.answers);
            if ((minTTLSeconds !== undefined) && (minTTLSeconds > 0)) {
                responseQuestionCacheKey = this.getQuestionCacheKey(decodedResponseObject.questions);
                if (responseQuestionCacheKey) {
                    const nowSeconds = getNowSeconds();
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
            if (clientRequestInfo.requestQuestionCacheKey !== responseQuestionCacheKey) {
                logger.warn(`clientRequestInfo.requestQuestionCacheKey !== responseQuestionCacheKey requestQuestionCacheKey=${clientRequestInfo.requestQuestionCacheKey} responseQuestionCacheKey=${responseQuestionCacheKey}`);
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
            logger.info(`udpServerSocket listening on ${stringify(this.udpServerSocket.address())}`);
        });
        this.udpServerSocket.on('message', (message, remoteInfo) => {
            const decodedMessage = dnsPacket.decode(message);
            this.handleServerSocketMessage(decodedMessage, RemoteInfo.createUDP(this.udpServerSocket, remoteInfo));
        });
        this.udpRemoteSocket.on('error', (err) => {
            logger.warn(`udpRemoteSocket error ${formatError(err)}`);
        });
        this.udpRemoteSocket.on('listening', () => {
            logger.info(`udpRemoteSocket listening on ${stringify(this.udpRemoteSocket.address())}`);
            this.udpServerSocket.bind(this.configuration.serverPort, this.configuration.serverAddress);
        });
        this.udpRemoteSocket.on('message', (message, remoteInfo) => {
            this.handleRemoteSocketMessage(dnsPacket.decode(message));
        });
        this.udpRemoteSocket.bind();
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
        this.tcpServerSocket.listen(this.configuration.serverPort, this.configuration.serverAddress);
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
