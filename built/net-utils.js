import { logger } from './logging.js';
import * as utils from './utils.js';
import dnsPacket from 'dns-packet';
const writeDNSPacketToTCPSocket = (tcpSocket, packet) => {
    try {
        if (!tcpSocket.destroyed) {
            tcpSocket.write(dnsPacket.streamEncode(packet));
        }
    }
    catch (err) {
        logger.error(`writeDNSPacketToTCPSocket error err = ${utils.formatError(err)}`);
    }
};
const writeDNSPacketToUDPSocket = (udpSocket, port, address, packet) => {
    try {
        const outgoingMessage = dnsPacket.encode(packet);
        udpSocket.send(outgoingMessage, port, address);
    }
    catch (err) {
        logger.error(`writeDNSPacketToUDPSocket error err = ${utils.formatError(err)}`);
    }
};
export class ClientRemoteInfo {
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
