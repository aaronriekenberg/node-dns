import * as configuration from './configuration.js';
import { logger } from './logging.js';
import * as utils from './utils.js';
import * as netUtils from './net-utils.js';
import net from 'net';

const createTCPDataHandler = (messageCallback: netUtils.MessageCallback): ((data: Buffer) => void) => {
    let readingHeader = true;
    let buffer = Buffer.of();
    let bodyLength = 0;

    return (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        let done = false;
        while (!done) {
            if (readingHeader) {
                if (buffer.byteLength >= 2) {
                    bodyLength = buffer.readUInt16BE(0);
                    readingHeader = false;
                } else {
                    done = true;
                }
            } else {
                if (buffer.byteLength >= (2 + bodyLength)) {
                    const decodedMessage = utils.streamDecodeDNSPacket(buffer.slice(0, 2 + bodyLength));
                    if (decodedMessage) {
                        messageCallback(decodedMessage);
                    }
                    buffer = buffer.slice(2 + bodyLength);
                    readingHeader = true;
                    bodyLength = 0;
                } else {
                    done = true;
                }
            }
        }
    };
};

export class TCPLocalServer implements netUtils.LocalServer {

    private readonly tcpServerSocket: net.Server;

    constructor(
        private readonly configuration: configuration.Configuration,
        private readonly callback: netUtils.MessageAndClientRemoteInfoCallback) {

        this.tcpServerSocket = net.createServer();
    }

    start() {

        let tcpServerSocketListening = false;
        this.tcpServerSocket.on('error', (err) => {
            logger.warn(`tcpServerSocket error ${utils.formatError(err)}`);
            if (!tcpServerSocketListening) {
                throw new Error('tcp server socket listen error');
            }
        });

        this.tcpServerSocket.on('listening', () => {
            tcpServerSocketListening = true;
            logger.info(`tcpServerSocket listening on ${utils.stringify(this.tcpServerSocket.address())}`);
        });

        this.tcpServerSocket.on('connection', (connection) => {

            connection.on('error', (err) => {
                logger.warn(`tcp client error ${utils.formatError(err)}`);
                connection.destroy();
            });

            connection.on('close', () => {

            });

            connection.on('data', createTCPDataHandler((decodedMessage) => {
                this.callback(decodedMessage, netUtils.ClientRemoteInfo.createTCP(connection))
            }));

            connection.on('timeout', () => {
                connection.destroy();
            });

            connection.setTimeout(this.configuration.tcpConnectionTimeoutSeconds * 1000);
        });

        this.tcpServerSocket.listen(
            this.configuration.listenAddressAndPort.port,
            this.configuration.listenAddressAndPort.address);
    }
}