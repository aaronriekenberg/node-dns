import { logger } from './logging.js';
import * as utils from './utils.js';
;
const decodeDOHJSONRRType = (type) => {
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
export const decodeJSONResponse = (dnsRequest, responseString) => {
    try {
        const responseObject = JSON.parse(responseString);
        const dnsResponsePacket = {
            id: dnsRequest.id,
            type: 'response'
        };
        dnsResponsePacket.flags = 0;
        // RA
        dnsResponsePacket.flags |= (1 << 7);
        // RD
        dnsResponsePacket.flags |= (1 << 8);
        if (responseObject.Status === 0) {
            dnsResponsePacket.rcode = 'NOERROR';
        }
        else if (responseObject.Status === 2) {
            dnsResponsePacket.rcode = 'SERVFAIL';
            dnsResponsePacket.flags |= 2;
        }
        else if (responseObject.Status === 3) {
            dnsResponsePacket.rcode = 'NXDOMAIN';
            dnsResponsePacket.flags |= 3;
        }
        else {
            logger.warn(`got unknown responseObject.Status=${responseObject.Status}`);
            dnsResponsePacket.rcode = 'SERVFAIL';
            dnsResponsePacket.flags |= 2;
        }
        dnsResponsePacket.questions =
            (responseObject.Question ?? []).map(question => {
                // strip leading and trailing .
                const name = question.name?.replace(/^\.|\.$/gm, '');
                return {
                    name: name,
                    type: decodeDOHJSONRRType(question.type),
                    class: 'IN',
                };
            });
        dnsResponsePacket.answers =
            (responseObject.Answer ?? []).map(answer => {
                // strip leading and trailing .
                const name = answer.name?.replace(/^\.|\.$/gm, '');
                const data = answer.data?.replace(/^\.|\.$/gm, '');
                return {
                    name: name,
                    type: decodeDOHJSONRRType(answer.type),
                    ttl: answer.TTL,
                    class: 'IN',
                    data: data
                };
            });
        dnsResponsePacket.authorities = [];
        dnsResponsePacket.additionals = [];
        return dnsResponsePacket;
    }
    catch (err) {
        logger.error(`decodeJSONResponse error err = ${utils.formatError(err)}`);
    }
    return undefined;
};
