#!/usr/bin/env node

import * as configuration from './configuration';
import ExpiringCache from './expiring-cache';
import * as dnsPacket from 'dns-packet';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as net from 'net';
import * as process from 'process';
import * as winston from 'winston';
import { decode } from 'punycode';

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

const isNumber = (x: number | null | undefined): x is number => {
    return (typeof x === 'number');
};

const isPositiveNumber = (x: number | null | undefined): x is number => {
    return (isNumber(x) && (x > 0));
};

const writeDNSPacketToTCPSocket = (tcpSocket: net.Socket, packet: dnsPacket.DNSPacket) => {
    try {
        if (!tcpSocket.destroyed) {
            tcpSocket.write(dnsPacket.streamEncode(packet));
        }
    } catch (err) {
        logger.error(`writeDNSPacketToTCPSocket error err = ${formatError(err)}`);
    }
};

const writeDNSPacketToUDPSocket = (udpSocket: dgram.Socket, port: number, address: string, packet: dnsPacket.DNSPacket) => {
    try {
        const outgoingMessage = dnsPacket.encode(packet);
        udpSocket.send(outgoingMessage, 0, outgoingMessage.length, port, address);
    } catch (err) {
        logger.error(`writeDNSPacketToUDPSocket error err = ${formatError(err)}`);
    }
};

const streamDecodeDNSPacket = (buffer: Buffer): dnsPacket.DNSPacket | undefined => {
    let packet: dnsPacket.DNSPacket | undefined;
    try {
        packet = dnsPacket.streamDecode(buffer);
    } catch (err) {
        logger.error(`streamDecodeDNSPacket error err = ${formatError(err)}`);
    }
    return packet;
};

const decodeDNSPacket = (buffer: Buffer): dnsPacket.DNSPacket | undefined => {
    let packet: dnsPacket.DNSPacket | undefined;
    try {
        packet = dnsPacket.decode(buffer);
    } catch (err) {
        logger.error(`decodeDNSPacket error err = ${formatError(err)}`);
    }
    return packet;
};

class ClientRemoteInfo {

    private constructor(
        readonly udpSocket: dgram.Socket | null,
        readonly udpRemoteInfo: dgram.RemoteInfo | null,
        readonly tcpSocket: net.Socket | null) {

    }

    static createUDP(udpSocket: dgram.Socket, udpRemoteInfo: dgram.RemoteInfo): ClientRemoteInfo {
        return new ClientRemoteInfo(udpSocket, udpRemoteInfo, null);
    }

    static createTCP(tcpSocket: net.Socket): ClientRemoteInfo {
        return new ClientRemoteInfo(null, null, tcpSocket);
    }

    writeResponse(dnsResponse: dnsPacket.DNSPacket) {
        if (this.udpSocket && this.udpRemoteInfo) {
            writeDNSPacketToUDPSocket(this.udpSocket, this.udpRemoteInfo.port, this.udpRemoteInfo.address, dnsResponse);
        }

        else if (this.tcpSocket) {
            writeDNSPacketToTCPSocket(this.tcpSocket, dnsResponse);
        }
    }

    get isUDP(): boolean {
        return ((this.udpSocket !== null) && (this.udpRemoteInfo !== null));
    }
}

class OutgoingRequestInfo {

    constructor(
        readonly clientRemoteInfo: ClientRemoteInfo,
        readonly clientRequestID: number,
        readonly questionCacheKey: string) {

    }

}

class CacheObject {

    constructor(
        readonly expirationTimeSeconds: number,
        readonly decodedResponse: dnsPacket.DNSPacket,
        readonly cacheTimeSeconds: number) {

    }

}

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
                    const decodedMessage = streamDecodeDNSPacket(buffer.slice(0, 2 + bodyLength));
                    if (decodedMessage) {
                        messageCallback(decodedMessage);
                    }
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

const createUDPSocket = (socketBufferSizes?: configuration.SocketBufferSizes): dgram.Socket => {
    let recvBufferSize: number | undefined;
    let sendBufferSize: number | undefined;

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

interface RemoteServerConnection {
    writeRequest(dnsRequest: dnsPacket.DNSPacket): void;
}

class UDPRemoteServerConnection implements RemoteServerConnection {

    private readonly socket: dgram.Socket;

    private socketListening = false;

    constructor(
        private readonly remoteAddressAndPort: configuration.AddressAndPort,
        private readonly messageCallback: (decodedMessage: dnsPacket.DNSPacket) => void,
        socketBufferSizes?: configuration.SocketBufferSizes) {

        this.socket = createUDPSocket(socketBufferSizes);

        this.setupSocketEvents();
    }

    private setupSocketEvents() {

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

        this.socket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
            const decodedMessage = decodeDNSPacket(message);
            if (decodedMessage) {
                this.messageCallback(decodedMessage);
            }
        });

        this.socket.bind();
    }

    writeRequest(dnsRequest: dnsPacket.DNSPacket): void {
        if (this.socketListening) {
            writeDNSPacketToUDPSocket(this.socket, this.remoteAddressAndPort.port, this.remoteAddressAndPort.address, dnsRequest);
        }
    }

}

class TCPRemoteServerConnection implements RemoteServerConnection {

    private socket: net.Socket | null = null;

    private connecting: boolean = false;

    private requestBuffer: dnsPacket.DNSPacket[] = [];

    constructor(
        private readonly socketTimeoutMilliseconds: number,
        private readonly remoteAddressAndPort: configuration.AddressAndPort,
        private readonly messageCallback: (decodedMessage: dnsPacket.DNSPacket) => void) {

    }

    writeRequest(dnsRequest: dnsPacket.DNSPacket): void {
        this.createSocketIfNecessary();

        if (this.connecting) {
            this.requestBuffer.push(dnsRequest);
        }

        else if (this.socket) {
            writeDNSPacketToTCPSocket(this.socket, dnsRequest);
        }
    }

    private createSocketIfNecessary() {
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
                    writeDNSPacketToTCPSocket(socket, bufferedRequest);
                });
                this.requestBuffer = [];
            });

            socket.connect(this.remoteAddressAndPort.port, this.remoteAddressAndPort.address);
            this.connecting = true;
        }
    }

}

class Metrics {
    cacheHits: number = 0;
    cacheMisses: number = 0;
    fixedResponses: number = 0;
    remoteUDPRequests: number = 0;
    remoteTCPRequests: number = 0;
    responseQuestionCacheKeyMismatch: number = 0;
}

class DNSProxy {

    private static readonly originalTTLSymbol = Symbol('originalTTL');

    private readonly metrics = new Metrics();

    private readonly questionToFixedResponse = new Map<string, dnsPacket.DNSPacket>();

    private readonly outgoingRequestCache = new ExpiringCache<number, OutgoingRequestInfo>();

    private readonly questionToResponseCache = new ExpiringCache<string, CacheObject>();

    private readonly udpServerSocket: dgram.Socket;

    private readonly tcpServerSocket = net.createServer();

    private readonly udpRemoteServerConnections: UDPRemoteServerConnection[] = [];

    private readonly tcpRemoteServerConnections: TCPRemoteServerConnection[] = [];

    constructor(private readonly configuration: configuration.Configuration) {
        this.udpServerSocket = createUDPSocket(configuration.udpSocketBufferSizes);

        configuration.remoteAddressesAndPorts.forEach((remoteAddressAndPort) => {
            this.udpRemoteServerConnections.push(
                new UDPRemoteServerConnection(
                    remoteAddressAndPort,
                    (decodedMessage) => {
                        this.handleRemoteSocketMessage(decodedMessage);
                    },
                    configuration.udpSocketBufferSizes));
            this.tcpRemoteServerConnections.push(
                new TCPRemoteServerConnection(
                    configuration.tcpConnectionTimeoutSeconds * 1000,
                    remoteAddressAndPort,
                    (decodedMessage) => {
                        this.handleRemoteSocketMessage(decodedMessage);
                    }));
        });
    }

    private getQuestionCacheKey(questions?: dnsPacket.DNSQuestion[]): string {
        let key: string = '';
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

    private getRandomDNSID(): number {
        const getRandomIntInclusive = (min: number, max: number): number => {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        };
        return getRandomIntInclusive(1, 65534);
    }

    private buildRemoteServerConnectionGetter(list: RemoteServerConnection[]): () => RemoteServerConnection {
        let nextIndex = 0;
        return () => {
            if (nextIndex >= list.length) {
                nextIndex = 0;
            }
            const retVal = list[nextIndex];
            ++nextIndex;
            return retVal;
        }
    }

    private readonly getNextUDPRemoteServerConnection = this.buildRemoteServerConnectionGetter(this.udpRemoteServerConnections);

    private readonly getNextTCPRemoteServerConnection = this.buildRemoteServerConnectionGetter(this.tcpRemoteServerConnections);

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

    private getMinTTLSecondsForResponse(
        response: dnsPacket.DNSPacket): number | undefined {

        let minTTL: number | undefined;

        const processObject = (object: { ttl?: number, [DNSProxy.originalTTLSymbol]?: number }) => {
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

    private adjustTTL(cacheObject: CacheObject): boolean {
        let valid = true;

        const nowSeconds = getNowSeconds();

        const secondsUntilExpiration = cacheObject.expirationTimeSeconds - nowSeconds;

        if (secondsUntilExpiration <= 0) {
            valid = false;
        } else {
            const secondsInCache = nowSeconds - cacheObject.cacheTimeSeconds;

            const adjustObject = (object: { ttl?: number, readonly [DNSProxy.originalTTLSymbol]?: number }) => {
                const originalTTL = object[DNSProxy.originalTTLSymbol];
                if (!isNumber(originalTTL)) {
                    valid = false;
                } else {
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

    private timerPop() {
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

    private handleServerSocketMessage(decodedRequestObject: dnsPacket.DNSPacket, clientRemoteInfo: ClientRemoteInfo) {
        // logger.info(`serverSocket message remoteInfo = ${stringifyPretty(clientRemoteInfo)}\ndecodedRequestObject = ${stringifyPretty(decodedRequestObject)}`);

        if ((!isNumber(decodedRequestObject.id)) || (!decodedRequestObject.questions)) {
            logger.warn(`handleServerSocketMessage invalid decodedRequestObject ${decodedRequestObject}`);
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

                ++this.metrics.cacheHits;
            }
        }

        if (!responded) {
            ++this.metrics.cacheMisses;

            const outgoingRequestID = this.getRandomDNSID();

            const expirationTimeSeconds = getNowSeconds() + this.configuration.requestTimeoutSeconds;

            const outgoingRequestInfo =
                new OutgoingRequestInfo(
                    clientRemoteInfo,
                    decodedRequestObject.id,
                    questionCacheKey);

            this.outgoingRequestCache.add(outgoingRequestID, outgoingRequestInfo, expirationTimeSeconds);

            decodedRequestObject.id = outgoingRequestID;

            if (clientRemoteInfo.isUDP) {
                ++this.metrics.remoteUDPRequests;
                this.getNextUDPRemoteServerConnection().writeRequest(decodedRequestObject);
            } else {
                ++this.metrics.remoteTCPRequests;
                this.getNextTCPRemoteServerConnection().writeRequest(decodedRequestObject);
            }
        }
    }

    private handleRemoteSocketMessage(decodedResponseObject: dnsPacket.DNSPacket) {
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

                const cacheObject = new CacheObject(
                    expirationTimeSeconds,
                    decodedResponseObject,
                    nowSeconds);

                this.questionToResponseCache.add(clientRequestInfo.questionCacheKey, cacheObject, expirationTimeSeconds);
            }
        }

        decodedResponseObject.id = clientRequestInfo.clientRequestID;

        const clientRemoteInfo = clientRequestInfo.clientRemoteInfo;

        clientRemoteInfo.writeResponse(decodedResponseObject);
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
            logger.info(`udpServerSocket listening on ${stringify(this.udpServerSocket.address())} rcvbuf=${this.udpServerSocket.getRecvBufferSize()} sndbuf=${this.udpServerSocket.getSendBufferSize()}`);
        });

        this.udpServerSocket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
            const decodedMessage = decodeDNSPacket(message);
            if (decodedMessage) {
                this.handleServerSocketMessage(decodedMessage, ClientRemoteInfo.createUDP(this.udpServerSocket, remoteInfo));
            }
        });

        this.udpServerSocket.bind(
            this.configuration.listenAddressAndPort.port,
            this.configuration.listenAddressAndPort.address);

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
                this.handleServerSocketMessage(decodedMessage, ClientRemoteInfo.createTCP(connection))
            }));

            connection.on('timeout', () => {
                connection.destroy();
            });

            connection.setTimeout(this.configuration.tcpConnectionTimeoutSeconds * 1000);
        });

        this.tcpServerSocket.listen(
            this.configuration.listenAddressAndPort.port,
            this.configuration.listenAddressAndPort.address);
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

    const configuration = JSON.parse(fileContent.toString()) as configuration.Configuration;

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
