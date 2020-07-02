import { logger } from './logging.js';
import * as utils from './utils.js';
import * as netUtils from './net-utils.js';
import dgram from 'dgram';
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
export class UDPLocalServer {
    constructor(configuration, callback) {
        this.configuration = configuration;
        this.callback = callback;
        this.udpServerSocket = createUDPSocket(configuration.socketBufferSizes);
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
        this.udpServerSocket.on('message', (message, remoteInfo) => {
            const decodedMessage = utils.decodeDNSPacket(message);
            if (decodedMessage) {
                this.callback(decodedMessage, netUtils.ClientRemoteInfo.createUDP(this.udpServerSocket, remoteInfo));
            }
        });
        this.udpServerSocket.bind(this.configuration.listenAddressAndPort.port, this.configuration.listenAddressAndPort.address);
    }
}
