import * as configuration from './configuration.js';
import { logger } from './logging.js';
import * as utils from './utils.js';
import * as netUtils from './net-utils.js';
import dgram from 'dgram';

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

export class UDPLocalServer implements netUtils.LocalServer {

    private readonly udpServerSocket: dgram.Socket;

    constructor(
        private readonly configuration: configuration.Configuration,
        private readonly callback: netUtils.MessageAndClientRemoteInfoCallback) {

        this.udpServerSocket = createUDPSocket(configuration.udpSocketBufferSizes);
    }

    start() {

        let udpServerSocketListening = false;
        this.udpServerSocket.on('error', (err) => {
            logger.warn(`udpServerSocket error ${utils.formatError(err)}`);
            if (!udpServerSocketListening) {
                throw new Error('udp server socket bind error');
            }
        });

        this.udpServerSocket.on('listening', () => {
            udpServerSocketListening = true;
            logger.info(`udpServerSocket listening on ${utils.stringify(this.udpServerSocket.address())} rcvbuf=${this.udpServerSocket.getRecvBufferSize()} sndbuf=${this.udpServerSocket.getSendBufferSize()}`);
        });

        this.udpServerSocket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
            const decodedMessage = utils.decodeDNSPacket(message);
            if (decodedMessage) {
                this.callback(decodedMessage, netUtils.ClientRemoteInfo.createUDP(this.udpServerSocket, remoteInfo));
            }
        });

        this.udpServerSocket.bind(
            this.configuration.listenAddressAndPort.port,
            this.configuration.listenAddressAndPort.address);
    }
}