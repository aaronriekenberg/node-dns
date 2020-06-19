import dnsPacket from 'dns-packet';

export interface SocketBufferSizes {
    readonly rcvbuf: number;
    readonly sndbuf: number;
}

export interface AddressAndPort {
    readonly address: string,
    readonly port: number
}

export interface RemoteHttp2Configuration {
    readonly url: string,
    readonly path: string,
    readonly sessionIdleTimeoutSeconds: number,
    readonly sessionMaxAgeSeconds: number,
    readonly requestTimeoutSeconds: number
}

export interface Configuration {
    readonly udpSocketBufferSizes?: SocketBufferSizes;
    readonly listenAddressAndPort: AddressAndPort;
    readonly remoteHttp2Configuration: RemoteHttp2Configuration;
    readonly minTTLSeconds: number;
    readonly maxTTLSeconds: number;
    readonly requestTimeoutSeconds: number;
    readonly tcpConnectionTimeoutSeconds: number;
    readonly timerIntervalSeconds: number;
    readonly fixedResponses?: dnsPacket.DNSPacket[];
}