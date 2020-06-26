import * as dohJson from './doh-json.js';
import { logger } from './logging.js';
import * as utils from './utils.js';
import http2 from 'http2';
// https://tools.ietf.org/html/rfc8484
export class Http2RemoteServerConnection {
    constructor(configuration) {
        this.clientHttp2Session = null;
        this.nextSessionNumber = 0;
        this.sessionCreationTimeSeconds = 0;
        this.url = configuration.url;
        this.path = configuration.path;
        this.requestTimeoutMilliseconds = configuration.requestTimeoutSeconds * 1000;
        this.sessionIdleTimeoutMilliseconds = configuration.sessionIdleTimeoutSeconds * 1000;
        this.sessionMaxAgeSeconds = configuration.sessionMaxAgeSeconds;
    }
    writeRequest(dnsRequest) {
        const requestURLPath = dohJson.buildURLPathForRequest(this.path, dnsRequest);
        return new Promise((resolve, reject) => {
            this.createSessionIfNecessary();
            if ((!this.clientHttp2Session) || this.clientHttp2Session.closed || this.clientHttp2Session.destroyed) {
                reject(new Error('clientHttp2Session invalid state'));
                return;
            }
            const request = this.clientHttp2Session.request({
                'content-type': 'application/dns-json',
                'accept': 'application/dns-json',
                ':method': 'GET',
                ':path': requestURLPath
            });
            const responseChunks = [];
            request.on('data', (chunk) => {
                responseChunks.push(chunk);
            });
            request.on('error', (error) => {
                request.close();
                reject(new Error(`http2 request error error = ${utils.formatError(error)}`));
            });
            request.setTimeout(this.requestTimeoutMilliseconds);
            request.on('timeout', () => {
                request.close();
                reject(new Error(`http2 request timeout`));
            });
            request.on('response', (headers) => {
                if (headers[':status'] !== 200) {
                    request.close();
                    reject(new Error(`got non-200 http status response ${headers[':status']}`));
                }
            });
            request.once('end', () => {
                if (responseChunks.length === 0) {
                    request.close();
                    reject(new Error('responseChunks empty'));
                }
                else {
                    const responseBuffer = Buffer.concat(responseChunks);
                    const response = dohJson.decodeJSONResponse(dnsRequest, responseBuffer.toString());
                    if (!response) {
                        request.close();
                        reject(new Error('error decoding dns packet'));
                    }
                    else {
                        resolve(response);
                    }
                }
            });
            request.end();
        });
    }
    createSessionIfNecessary() {
        const nowSeconds = utils.getNowSeconds();
        if (this.clientHttp2Session) {
            if ((nowSeconds - this.sessionCreationTimeSeconds) > this.sessionMaxAgeSeconds) {
                logger.info('this.clientHttp2Session is too old, closing');
                this.clientHttp2Session.close();
            }
            else {
                return;
            }
        }
        const newClientHttp2Session = http2.connect(this.url);
        const sessionNumber = this.nextSessionNumber++;
        logger.info(`created newClientHttp2Session ${sessionNumber}`);
        newClientHttp2Session.on('connect', () => {
            logger.info(`newClientHttp2Session ${sessionNumber} on connect`);
        });
        newClientHttp2Session.once('close', () => {
            logger.info(`newClientHttp2Session ${sessionNumber} on close`);
            if (this.clientHttp2Session === newClientHttp2Session) {
                this.clientHttp2Session = null;
                logger.info('set this.clientHttp2Session = null');
            }
        });
        newClientHttp2Session.on('error', (error) => {
            logger.info(`newClientHttp2Session ${sessionNumber} on error error = ${utils.formatError(error)}`);
            newClientHttp2Session.destroy();
        });
        newClientHttp2Session.on('timeout', () => {
            logger.info(`newClientHttp2Session ${sessionNumber} on timeout`);
            newClientHttp2Session.close();
        });
        newClientHttp2Session.setTimeout(this.sessionIdleTimeoutMilliseconds);
        this.clientHttp2Session = newClientHttp2Session;
        this.sessionCreationTimeSeconds = nowSeconds;
    }
}
