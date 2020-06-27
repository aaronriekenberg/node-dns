import dnsPacket from 'dns-packet';
import { logger } from './logging.js';
import * as utils from './utils.js';

interface DOHJSONResponseQuestion {
    name?: string;
    type?: number;
}

interface DOHJSONResponseAnswer {
    name?: string;
    type?: number;
    TTL?: number;
    data?: string;
}

interface DOHJSONResponse {
    Status?: number;
    Question?: DOHJSONResponseQuestion[];
    Answer?: DOHJSONResponseAnswer[];
};

const leadingAndTrailingDotsRegex = /^\.|\.$/gm;

const decodeDOHJSONRRType = (type?: number): string | undefined => {
    if (!utils.isNumber(type)) {
        logger.warn(`got non-number RR type in DOH response: ${type}`);
        return undefined;
    }

    switch (type) {
        case 1:
            return 'A';
        case 5:
            return 'CNAME';
        case 6:
            return 'SOA';
        case 12:
            return 'PTR';
        case 16:
            return 'TXT';
        case 28:
            return 'AAAA';
        case 33:
            return 'SRV';
        case 43:
            return 'DS';
    }

    logger.warn(`got unknown RR type in DOH response: ${type}`);
    return undefined;
};

export const buildURLPathForRequest = (path: string, dnsRequest: dnsPacket.DNSPacket): string => {
    if (dnsRequest?.questions?.length !== 1) {
        throw new Error(`unknown request questions length: ${dnsRequest?.questions?.length}`);
    }

    const question = dnsRequest.questions[0];

    if ((!utils.isString(question.name)) || (!utils.isString(question.type))) {
        throw new Error(`invalid request question: ${utils.stringify(question)}`);
    }

    return `${path}?name=${question.name}&type=${question.type}`;
}

export const decodeJSONResponse = (dnsRequest: dnsPacket.DNSPacket, responseString: string): dnsPacket.DNSPacket | undefined => {
    try {
        const responseObject = JSON.parse(responseString) as DOHJSONResponse;

        const questions = (responseObject.Question ?? []).map(question => {
            const name = question.name?.replace(leadingAndTrailingDotsRegex, '');

            return {
                name: name,
                type: decodeDOHJSONRRType(question.type),
                class: 'IN',
            };
        });

        const answers = (responseObject.Answer ?? []).map(answer => {
            const name = answer.name?.replace(leadingAndTrailingDotsRegex, '');
            const data = answer.data?.replace(leadingAndTrailingDotsRegex, '');

            return {
                name: name,
                type: decodeDOHJSONRRType(answer.type),
                ttl: answer.TTL,
                class: 'IN',
                data: data
            };
        });

        const dnsResponsePacket: dnsPacket.DNSPacket = {
            id: dnsRequest.id,
            flags: 0,
            type: 'response',
            rcode: 'NOERROR',
            questions: questions,
            answers: answers,
            authorities: [],
            additionals: []
        };

        // RA, RD
        dnsResponsePacket.flags = (1 << 7) | (1 << 8);

        if (responseObject.Status !== 0) {
            if (responseObject.Status === 2) {
                dnsResponsePacket.rcode = 'SERVFAIL';
                dnsResponsePacket.flags |= 2;
            } else if (responseObject.Status === 3) {
                dnsResponsePacket.rcode = 'NXDOMAIN';
                dnsResponsePacket.flags |= 3;
            } else {
                logger.warn(`got unknown responseObject.Status=${responseObject.Status}`);
                dnsResponsePacket.rcode = 'SERVFAIL';
                dnsResponsePacket.flags |= 2;
            }
        }

        return dnsResponsePacket;
    } catch (err) {
        logger.error(`decodeJSONResponse error err = ${utils.formatError(err)}`);
    }

    return undefined;
}