import dnsPacket from 'dns-packet';

export interface AddressAndPort {
    readonly address: string,
    readonly port: number
}

export interface SocketBufferSizes {
    readonly rcvbuf: number;
    readonly sndbuf: number;
}

export interface UDPServerConfiguration {
    readonly socketBufferSizes?: SocketBufferSizes;
    readonly listenAddressAndPort: AddressAndPort;
}

export interface TCPServerConfiguration {
    readonly listenAddressAndPort: AddressAndPort;
    readonly connectionTimeoutSeconds: number;
}

export interface RemoteHttp2Configuration {
    readonly url: string,
    readonly path: string,
    readonly sessionIdleTimeoutSeconds: number,
    readonly sessionMaxAgeSeconds: number,
    readonly requestTimeoutSeconds: number
}

export interface ProxyConfiguration {
    readonly minTTLSeconds: number;
    readonly maxTTLSeconds: number;
    readonly timerIntervalSeconds: number;
}

export interface Configuration {
    readonly udpServerConfiguration: UDPServerConfiguration;
    readonly tcpServerConfiguration: TCPServerConfiguration;
    readonly remoteHttp2Configuration: RemoteHttp2Configuration;
    readonly proxyConfiguration: ProxyConfiguration;
    readonly fixedResponses?: dnsPacket.DNSPacket[];
}