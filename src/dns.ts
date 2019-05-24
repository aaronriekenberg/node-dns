#!/usr/bin/env node

import * as dnsPacket from 'dns-packet';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as net from 'net';
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

const UTF8 = 'utf8';

const asyncReadFile = async (filePath: string, encoding?: string) => {
    let fileHandle: fs.promises.FileHandle | undefined;
    try {
        fileHandle = await fs.promises.open(filePath, 'r');
        return await fileHandle.readFile({
            encoding
        });
    } finally {
        if (fileHandle) {
            await fileHandle.close();
        }
    }
};

const getNowSeconds = (): number => {
    const now = new Date();
    now.setMilliseconds(0);
    return now.getTime() / 1000.;
};

interface Configuration {
    readonly serverAddress: string;
    readonly serverPort: number;
    readonly remoteAddress: string;
    readonly remotePort: number;
    readonly minTTLSeconds: number;
    readonly maxTTLSeconds: number;
    readonly requestTimeoutSeconds: number;
    readonly tcpConnectionTimeoutSeconds: number;
    readonly timerIntervalSeconds: number;
    readonly fixedResponses?: dnsPacket.DNSPacket[];
};

class RemoteInfo {

    private constructor(
        readonly udpSocket: dgram.Socket | null,
        readonly udpRemoteInfo: dgram.RemoteInfo | null,
        readonly tcpSocket: net.Socket | null) {

    }

    static createUDP(udpSocket: dgram.Socket, udpRemoteInfo: dgram.RemoteInfo): RemoteInfo {
        return new RemoteInfo(udpSocket, udpRemoteInfo, null);
    }

    static createTCP(tcpSocket: net.Socket): RemoteInfo {
        return new RemoteInfo(null, null, tcpSocket);
    }

    writeResponse(dnsResponse: dnsPacket.DNSPacket) {
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

    get isUDP(): boolean {
        return ((this.udpSocket !== null) && (this.udpRemoteInfo !== null));
    }
};

class OutgoingRequestInfo {

    constructor(
        readonly outgoingRequestID: number,
        readonly clientRemoteInfo: RemoteInfo,
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
        readonly decodedResponse: dnsPacket.DNSPacket,
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

const createTCPReadHandler = (messageCallback: (decodedMessage: dnsPacket.DNSPacket) => void): ((data: Buffer) => void) => {
    let readingHeader = true;
    let buffer = Buffer.of();
    let bodyLength = 0;

    return (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        let done = false;
        while (!done) {
            if (readingHeader) {
                if (buffer.byteLength >= 2) {
                    bodyLength = buffer.readUInt16BE(0);
                    readingHeader = false;
                } else {
                    done = true;
                }
            } else {
                if (buffer.byteLength >= (2 + bodyLength)) {
                    const decodedMessage = dnsPacket.streamDecode(buffer.slice(0, 2 + bodyLength));
                    messageCallback(decodedMessage);
                    buffer = buffer.slice(2 + bodyLength);
                    readingHeader = true;
                    bodyLength = 0;
                } else {
                    done = true;
                }
            }
        }
    };
};

class TCPRemoteServerConnection {

    private readonly socketTimeoutMilliseconds: number;

    private readonly remoteAddress: string;

    private readonly remotePort: number;

    private socket: net.Socket | null = null;

    private connecting: boolean = false;

    private requestBuffer: dnsPacket.DNSPacket[] = [];

    constructor(configuration: Configuration, readonly messageCallback: (decodedMessage: dnsPacket.DNSPacket) => void) {
        this.socketTimeoutMilliseconds = configuration.tcpConnectionTimeoutSeconds * 1000;
        this.remoteAddress = configuration.remoteAddress;
        this.remotePort = configuration.remotePort;
    }

    writeRequest(dnsRequest: dnsPacket.DNSPacket) {
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

    private createSocketIfNecessary() {
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

};

class DNSProxy {

    private static readonly originalTTLSymbol = Symbol('originalTTL');

    private readonly outgoingIDToRequestInfo = new Map<number, OutgoingRequestInfo>();
    private readonly outgoingRequestInfoPriorityQueue = new TinyQueue<OutgoingRequestInfo>([], (a: OutgoingRequestInfo, b: OutgoingRequestInfo) => a.compareByExpirationTime(b));

    private readonly questionToFixedResponse = new Map<string, dnsPacket.DNSPacket>();

    private readonly questionToResponse = new Map<string, CacheObject>();
    private readonly questionToResponsePriorityQueue = new TinyQueue<CacheObject>([], (a: CacheObject, b: CacheObject) => a.compareByExpirationTime(b));

    private fixedResponses: number = 0;
    private cacheHits: number = 0;
    private cacheMisses: number = 0;
    private remoteUDPRequests: number = 0;
    private remoteTCPRequests: number = 0;

    private readonly udpServerSocket = dgram.createSocket('udp4');
    private readonly udpRemoteSocket = dgram.createSocket('udp4');

    private readonly tcpServerSocket = net.createServer();

    private readonly tcpRemoteServerConnection: TCPRemoteServerConnection;

    constructor(private readonly configuration: Configuration) {
        this.tcpRemoteServerConnection = new TCPRemoteServerConnection(configuration, (decodedMessage) => {
            this.handleRemoteSocketMessage(decodedMessage);
        });
    }

    private getQuestionCacheKey(questions?: dnsPacket.DNSQuestion[]): string | undefined {
        let key: string | undefined;
        let firstQuestion = true;

        (questions || []).forEach((question) => {
            if (firstQuestion) {
                key = "";
            } else {
                key += '|';
            }
            key += `name:${question.name}_type:${question.type}_class:${question.class}`.toLowerCase();
            firstQuestion = false;
        });

        return key;
    }

    private getRandomDNSID(): number {
        const getRandomInt = (min: number, max: number): number => {
            return Math.floor(Math.random() * (max - min + 1)) + min
        };
        return getRandomInt(1, 65534);
    }

    private buildFixedResponses() {
        (this.configuration.fixedResponses || []).forEach((fixedResponse) => {
            const questionCacheKey = this.getQuestionCacheKey(fixedResponse.questions);
            if (!questionCacheKey) {
                throw new Error('fixed response missing questions');
            }
            this.questionToFixedResponse.set(questionCacheKey, fixedResponse);
        });
        logger.info(`questionToFixedResponse.size = ${this.questionToFixedResponse.size}`);
    }

    private getMinTTLSecondsForAnswers(answers: dnsPacket.DNSAnswer[] | undefined): number | undefined {
        let minTTL: number | undefined;
        (answers || []).forEach((answer) => {
            if ((answer.ttl === undefined) || (answer.ttl < this.configuration.minTTLSeconds)) {
                answer.ttl = this.configuration.minTTLSeconds;
            }
            if (answer.ttl > this.configuration.maxTTLSeconds) {
                answer.ttl = this.configuration.maxTTLSeconds;
            }
            (answer as any)[DNSProxy.originalTTLSymbol] = answer.ttl;
            if ((minTTL === undefined) || (answer.ttl < minTTL)) {
                minTTL = answer.ttl;
            }
        });
        return minTTL;
    }

    private adjustTTL(cacheObject: CacheObject): boolean {
        let valid = true;

        const nowSeconds = getNowSeconds();

        const secondsUntilExpiration = cacheObject.expirationTimeSeconds - nowSeconds;

        if (secondsUntilExpiration <= 0) {
            valid = false;
        } else {
            const secondsInCache = nowSeconds - cacheObject.cacheTimeSeconds;
            (cacheObject.decodedResponse.answers || []).forEach((answer) => {
                answer.ttl = (answer as any)[DNSProxy.originalTTLSymbol] - secondsInCache;
                if (answer.ttl <= 0) {
                    valid = false;
                }
            });
        }

        return valid;
    }

    private timerPop() {
        logger.info('begin timer pop');

        const nowSeconds = getNowSeconds();
        let done: boolean;

        done = false;
        let expiredOutgoingIDs = 0;
        while ((this.outgoingRequestInfoPriorityQueue.length > 0) && (!done)) {
            const outgoingRequestInfo = this.outgoingRequestInfoPriorityQueue.peek();
            if (outgoingRequestInfo && outgoingRequestInfo.expired(nowSeconds)) {
                this.outgoingRequestInfoPriorityQueue.pop();
                this.outgoingIDToRequestInfo.delete(outgoingRequestInfo.outgoingRequestID);
                ++expiredOutgoingIDs;
            } else {
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
                    ++expiredQuestionCacheKeys
                }
            } else {
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

    private handleServerSocketMessage(decodedRequestObject: dnsPacket.DNSPacket, clientRemoteInfo: RemoteInfo) {
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

            const outgoingID = this.getRandomDNSID();

            const requestTimeoutSeconds = getNowSeconds() + this.configuration.requestTimeoutSeconds;

            const outgoingRequestInfo =
                new OutgoingRequestInfo(outgoingID, clientRemoteInfo, decodedRequestObject.id, requestTimeoutSeconds);

            this.outgoingRequestInfoPriorityQueue.push(outgoingRequestInfo);
            this.outgoingIDToRequestInfo.set(outgoingID, outgoingRequestInfo);

            decodedRequestObject.id = outgoingID;

            if (clientRemoteInfo.isUDP) {
                ++this.remoteUDPRequests;
                const outgoingMessage = dnsPacket.encode(decodedRequestObject);
                this.udpRemoteSocket.send(outgoingMessage, 0, outgoingMessage.length, this.configuration.remotePort, this.configuration.remoteAddress);
            } else {
                ++this.remoteTCPRequests;
                this.tcpRemoteServerConnection.writeRequest(decodedRequestObject);
            }
        }
    }

    private handleRemoteSocketMessage(decodedResponseObject: dnsPacket.DNSPacket) {
        // logger.info(`remoteSocket message decodedResponse = ${stringifyPretty(decodedResponse)}`);

        if (decodedResponseObject.id === undefined) {
            logger.warn(`handleRemoteSocketMessage invalid decodedResponseObject ${decodedResponseObject}`);
            return;
        }

        if (decodedResponseObject.rcode === 'NOERROR') {

            const minTTLSeconds = this.getMinTTLSecondsForAnswers(decodedResponseObject.answers);

            if ((minTTLSeconds !== undefined) && (minTTLSeconds > 0)) {

                const questionCacheKey = this.getQuestionCacheKey(decodedResponseObject.questions);

                if (questionCacheKey) {
                    const nowSeconds = getNowSeconds();
                    const expirationTimeSeconds = nowSeconds + minTTLSeconds;

                    const cacheObject = new CacheObject(
                        questionCacheKey, decodedResponseObject, nowSeconds, expirationTimeSeconds);

                    this.questionToResponsePriorityQueue.push(cacheObject);
                    this.questionToResponse.set(questionCacheKey, cacheObject);
                }
            }
        }

        const clientRequestInfo = this.outgoingIDToRequestInfo.get(decodedResponseObject.id);
        if (clientRequestInfo) {
            this.outgoingIDToRequestInfo.delete(decodedResponseObject.id);

            decodedResponseObject.id = clientRequestInfo.clientRequestID;

            const clientRemoteInfo = clientRequestInfo.clientRemoteInfo;

            clientRemoteInfo.writeResponse(decodedResponseObject);
        }
    }

    private setupSocketEvents() {

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

        this.udpServerSocket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
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

        this.udpRemoteSocket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
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
                this.handleServerSocketMessage(decodedMessage, RemoteInfo.createTCP(connection))
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

};

const readConfiguration = async (configFilePath: string) => {
    logger.info(`readConfiguration '${configFilePath}'`);

    const fileContent = await asyncReadFile(configFilePath, UTF8);

    const configuration = JSON.parse(fileContent.toString()) as Configuration;

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
