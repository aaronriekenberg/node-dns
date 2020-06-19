export class RequestProtocolMetrics {
    constructor() {
        this.udp = 0;
        this.tcp = 0;
    }
}
export class Metrics {
    constructor() {
        this.fixedResponses = 0;
        this.localRequests = new RequestProtocolMetrics();
        this.remoteRequests = 0;
        this.remoteRequestErrors = 0;
    }
}
