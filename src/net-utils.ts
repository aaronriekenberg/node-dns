import { logger } from './logging.js';
import * as utils from './utils.js';
import dnsPacket from 'dns-packet';
import dgram from 'dgram';
import net from 'net';
import tls from 'tls';

const writeDNSPacketToTCPSocket = (tcpSocket: net.Socket, packet: dnsPacket.DNSPacket) => {
    try {
        if (!tcpSocket.destroyed) {
            tcpSocket.write(dnsPacket.streamEncode(packet));
        }
    } catch (err) {
        logger.error(`writeDNSPacketToTCPSocket error err = ${utils.formatError(err)}`);
    }
};

const writeDNSPacketToUDPSocket = (udpSocket: dgram.Socket, port: number, address: string, packet: dnsPacket.DNSPacket) => {
    try {
        const outgoingMessage = dnsPacket.encode(packet);
        udpSocket.send(outgoingMessage, port, address);
    } catch (err) {
        logger.error(`writeDNSPacketToUDPSocket error err = ${utils.formatError(err)}`);
    }
};

export class ClientRemoteInfo {

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

}

export type MessageCallback = (decodedMessage: dnsPacket.DNSPacket) => void;

export type MessageAndClientRemoteInfoCallback = (decodedMessage: dnsPacket.DNSPacket, clientRemoteInfo: ClientRemoteInfo) => void;

export interface LocalServer {
    start(): void;
}

export const socketConnectionString = (socket: net.Socket | tls.TLSSocket): string => {
    try {
        return `${socket.localAddress}:${socket.localPort} -> ${socket.remoteAddress}:${socket.remotePort}`;
    } catch (err) {
        logger.error(`socketConnectionString error err = ${utils.formatError(err)}`);
        return "UNKNOWN";
    }
}