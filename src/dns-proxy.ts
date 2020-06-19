#!/usr/bin/env node

import * as configuration from './configuration.js';
import * as dohClient from './doh-client.js';
import { logger } from './logging.js';
import * as metrics from './metrics.js';
import * as netUtils from './net-utils.js';
import * as tcpServer from './tcp-server.js';
import * as udpServer from './udp-server.js';
import * as utils from './utils.js';
import ExpiringCache from './expiring-cache.js';
import dnsPacket from 'dns-packet';
import process from 'process';

class CacheObject {

    constructor(
        readonly expirationTimeSeconds: number,
        readonly decodedResponse: dnsPacket.DNSPacket,
        readonly cacheTimeSeconds: number) {

    }

}

class DNSProxy {

    private static readonly originalTTLSymbol = Symbol('originalTTL');

    private readonly metrics = new metrics.Metrics();

    private readonly questionToFixedResponse = new Map<string, dnsPacket.DNSPacket>();

    private readonly questionToResponseCache = new ExpiringCache<string, CacheObject>();

    private readonly localServers: netUtils.LocalServer[] = [];

    private readonly http2RemoteServerConnection: dohClient.Http2RemoteServerConnection;

    constructor(private readonly configuration: configuration.Configuration) {

        this.localServers.push(
            new udpServer.UDPLocalServer(
                configuration,
                (decodeDNSPacket, clientRemoteInfo) => {
                    ++this.metrics.localRequests.udp;
                    this.handleLocalRequest(decodeDNSPacket, clientRemoteInfo);
                }));

        this.localServers.push(
            new tcpServer.TCPLocalServer(
                configuration,
                (decodeDNSPacket, clientRemoteInfo) => {
                    ++this.metrics.localRequests.tcp;
                    this.handleLocalRequest(decodeDNSPacket, clientRemoteInfo);
                }));

        this.http2RemoteServerConnection = new dohClient.Http2RemoteServerConnection(configuration.remoteHttp2Configuration);
    }

    private getQuestionCacheKey(questions?: dnsPacket.DNSQuestion[]): string {
        let key: string = '';
        let firstQuestion = true;

        (questions || []).forEach((question) => {
            if (!firstQuestion) {
                key += '|';
            }
            key += `name:${question.name}_type:${question.type}_class:${question.class}`.toLowerCase();
            firstQuestion = false;
        });

        return key;
    }

    private buildFixedResponses() {
        (this.configuration.fixedResponses || []).forEach((fixedResponse) => {
            const questionCacheKey = this.getQuestionCacheKey(fixedResponse.questions);
            if (!questionCacheKey) {
                throw new Error('fixed response missing questions');
            }
            this.questionToFixedResponse.set(questionCacheKey, fixedResponse);
        });
        logger.info(`questionToFixedResponse.size = ${this.questionToFixedResponse.size}`);
    }

    private getMinTTLSecondsForResponse(
        response: dnsPacket.DNSPacket): number | undefined {

        let foundRRHeaderTTL = false;
        let minTTL = this.configuration.minTTLSeconds;

        const processObject = (object: { ttl?: number, [DNSProxy.originalTTLSymbol]?: number }) => {
            if ((!utils.isNumber(object.ttl)) || (object.ttl < this.configuration.minTTLSeconds)) {
                object.ttl = this.configuration.minTTLSeconds;
            }
            if (object.ttl > this.configuration.maxTTLSeconds) {
                object.ttl = this.configuration.maxTTLSeconds;
            }
            object[DNSProxy.originalTTLSymbol] = object.ttl;

            if ((!foundRRHeaderTTL) || (object.ttl < minTTL)) {
                minTTL = object.ttl;
                foundRRHeaderTTL = true;
            }
        };

        (response.answers || []).forEach((answer) => processObject(answer));
        (response.additionals || []).forEach((additional) => {
            if (additional.type !== "OPT") {
                processObject(additional);
            }
        });
        (response.authorities || []).forEach((authority) => processObject(authority));

        return minTTL;
    }

    private adjustTTL(cacheObject: CacheObject): boolean {
        let valid = true;

        const nowSeconds = utils.getNowSeconds();

        const secondsUntilExpiration = cacheObject.expirationTimeSeconds - nowSeconds;

        if (secondsUntilExpiration <= 0) {
            valid = false;
        } else {
            const secondsInCache = nowSeconds - cacheObject.cacheTimeSeconds;

            const adjustObject = (object: { ttl?: number, readonly [DNSProxy.originalTTLSymbol]?: number }) => {
                const originalTTL = object[DNSProxy.originalTTLSymbol];
                if (!utils.isNumber(originalTTL)) {
                    valid = false;
                } else {
                    object.ttl = originalTTL - secondsInCache;
                    if (object.ttl <= 0) {
                        valid = false;
                    }
                }
            };

            (cacheObject.decodedResponse.answers || []).forEach((answer) => adjustObject(answer));
            (cacheObject.decodedResponse.additionals || []).forEach((additional) => {
                if (additional.type !== "OPT") {
                    adjustObject(additional);
                }
            });
            (cacheObject.decodedResponse.authorities || []).forEach((authority) => adjustObject(authority));
        }

        return valid;
    }

    private timerPop() {
        const nowSeconds = utils.getNowSeconds();

        const expiredCacheKeys = this.questionToResponseCache.periodicCleanUp(nowSeconds);

        const logData = {
            metrics: this.metrics,
            expiredCacheKeys,
            cacheStats: this.questionToResponseCache.stats
        };

        logger.info(`end timer pop ${utils.stringify(logData)}`);
    }

    private handleLocalRequest(decodedRequestObject: dnsPacket.DNSPacket, clientRemoteInfo: netUtils.ClientRemoteInfo) {
        // logger.info(`handleLocalRequest message remoteInfo = ${stringifyPretty(clientRemoteInfo)}\ndecodedRequestObject = ${stringifyPretty(decodedRequestObject)}`);

        if ((!utils.isNumber(decodedRequestObject.id)) || (!decodedRequestObject.questions)) {
            logger.warn(`handleLocalRequest invalid decodedRequestObject ${decodedRequestObject}`);
            return;
        }

        let responded = false;

        const questionCacheKey = this.getQuestionCacheKey(decodedRequestObject.questions);

        if (!responded) {
            const fixedResponse = this.questionToFixedResponse.get(questionCacheKey);
            if (fixedResponse) {
                fixedResponse.id = decodedRequestObject.id;

                clientRemoteInfo.writeResponse(fixedResponse);

                responded = true;

                ++this.metrics.fixedResponses;
            }
        }

        if (!responded) {
            const cacheObject = this.questionToResponseCache.get(questionCacheKey);
            if (cacheObject && this.adjustTTL(cacheObject)) {
                const cachedResponse = cacheObject.decodedResponse;
                cachedResponse.id = decodedRequestObject.id;

                clientRemoteInfo.writeResponse(cachedResponse);

                responded = true;
            }
        }

        if (!responded) {
            this.sendRemoteRequest(clientRemoteInfo, decodedRequestObject);
        }
    }

    private async sendRemoteRequest(clientRemoteInfo: netUtils.ClientRemoteInfo, request: dnsPacket.DNSPacket) {

        let response: dnsPacket.DNSPacket | undefined;

        try {
            ++this.metrics.remoteRequests;
            response = await this.http2RemoteServerConnection.writeRequest(request);
        } catch (err) {
            ++this.metrics.remoteRequestErrors;
            logger.error(`http2RemoteServerConnection.writeRequest error err = ${utils.formatError(err)}`);
        }

        if (response) {
            this.handleRemoteResponse(clientRemoteInfo, response);
        }
    }

    private handleRemoteResponse(clientRemoteInfo: netUtils.ClientRemoteInfo, decodedResponseObject: dnsPacket.DNSPacket) {
        // logger.info(`handleRemoteResponse decodedResponseObject = ${stringifyPretty(decodedResponseObject)}`);

        if (!utils.isNumber(decodedResponseObject.id) || (!decodedResponseObject.questions)) {
            logger.warn(`handleRemoteSocketMessage invalid decodedResponseObject ${decodedResponseObject}`);
            return;
        }

        const responseQuestionCacheKey = this.getQuestionCacheKey(decodedResponseObject.questions);

        if ((decodedResponseObject.rcode === 'NOERROR') ||
            (decodedResponseObject.rcode === 'NXDOMAIN')) {

            const minTTLSeconds = this.getMinTTLSecondsForResponse(decodedResponseObject);

            if (utils.isPositiveNumber(minTTLSeconds)) {

                const nowSeconds = utils.getNowSeconds();

                const expirationTimeSeconds = nowSeconds + minTTLSeconds;

                const cacheObject = new CacheObject(
                    expirationTimeSeconds,
                    decodedResponseObject,
                    nowSeconds);

                this.questionToResponseCache.add(responseQuestionCacheKey, cacheObject, expirationTimeSeconds);
            }
        }

        clientRemoteInfo.writeResponse(decodedResponseObject);
    }

    start() {
        logger.info('begin start');

        this.buildFixedResponses();

        this.localServers.forEach((localServer) => localServer.start());

        setInterval(() => this.timerPop(), this.configuration.timerIntervalSeconds * 1000);
    }

};

const readConfiguration = async (configFilePath: string) => {
    logger.info(`readConfiguration '${configFilePath}'`);

    const fileContent = await utils.asyncReadFile(configFilePath, 'utf8');

    const configuration = JSON.parse(fileContent.toString()) as configuration.Configuration;

    logger.info(`configuration = ${utils.stringifyPretty(configuration)}`);

    return configuration;
};

const main = async () => {
    if (process.argv.length !== 3) {
        throw new Error('config json path required as command line argument');
    }

    const configuration = await readConfiguration(process.argv[2]);

    new DNSProxy(configuration).start();
};

main().catch((err) => {
    logger.error(`main error err = ${utils.formatError(err)}`);
    process.exit(1);
});
