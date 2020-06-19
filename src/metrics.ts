export class RequestProtocolMetrics {
    udp: number = 0;
    tcp: number = 0;
}

export class Metrics {
    fixedResponses: number = 0;
    readonly localRequests = new RequestProtocolMetrics();
    remoteRequests: number = 0;
    remoteRequestErrors: number = 0;
}
