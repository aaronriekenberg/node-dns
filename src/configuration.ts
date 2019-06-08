import * as dnsPacket from 'dns-packet';

export interface SocketBufferSizes {
    readonly rcvbuf: number;
    readonly sndbuf: number;
}

export interface AddressAndPort {
    readonly address: string,
    readonly port: number
}

export interface Configuration {
    readonly udpSocketBufferSizes?: SocketBufferSizes;
    readonly listenAddressAndPort: AddressAndPort;
    readonly remoteAddressesAndPorts: AddressAndPort[];
    readonly minTTLSeconds: number;
    readonly maxTTLSeconds: number;
    readonly requestTimeoutSeconds: number;
    readonly tcpConnectionTimeoutSeconds: number;
    readonly timerIntervalSeconds: number;
    readonly fixedResponses?: dnsPacket.DNSPacket[];
}