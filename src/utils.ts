import { logger } from './logging.js';
import dnsPacket from 'dns-packet';
import fs from 'fs';

export const stringify = JSON.stringify;
export const stringifyPretty = (object: any) => stringify(object, null, 2);

export const formatError = (err: Error, includeStack = true) => {
    return ((includeStack && err.stack) || err.message);
};

export const asyncReadFile = async (filePath: string, encoding?: BufferEncoding) => {
    let fileHandle: fs.promises.FileHandle | undefined;
    try {
        fileHandle = await fs.promises.open(filePath, 'r');
        return await fileHandle.readFile({
            encoding
        });
    } finally {
        if (fileHandle) {
            await fileHandle.close();
        }
    }
};

export const getNowSeconds = (): number => {
    return process.hrtime()[0];
};

export const isNumber = (x: number | null | undefined): x is number => {
    return (typeof x === 'number');
};

export const isPositiveNumber = (x: number | null | undefined): x is number => {
    return (isNumber(x) && (x > 0));
};

export const streamDecodeDNSPacket = (buffer: Buffer): dnsPacket.DNSPacket | undefined => {
    let packet: dnsPacket.DNSPacket | undefined;
    try {
        packet = dnsPacket.streamDecode(buffer);
    } catch (err) {
        logger.error(`streamDecodeDNSPacket error err = ${formatError(err)}`);
    }
    return packet;
};

export const encodeDNSPacket = (packet: dnsPacket.DNSPacket): Buffer | undefined => {
    let buffer: Buffer | undefined;
    try {
        buffer = dnsPacket.encode(packet);
    } catch (err) {
        logger.error(`encodeDNSPacket error err = ${formatError(err)}`);
    }
    return buffer;
}

export const decodeDNSPacket = (buffer: Buffer): dnsPacket.DNSPacket | undefined => {
    let packet: dnsPacket.DNSPacket | undefined;
    try {
        packet = dnsPacket.decode(buffer);
    } catch (err) {
        logger.error(`decodeDNSPacket error err = ${formatError(err)}`);
    }
    return packet;
};