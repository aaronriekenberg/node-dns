import { logger } from './logging.js';
import dnsPacket from 'dns-packet';
import fs from 'fs';
export const stringify = JSON.stringify;
export const stringifyPretty = (object) => stringify(object, null, 2);
export const formatError = (err, includeStack = true) => {
    return ((includeStack && err.stack) || err.message);
};
export const asyncReadFile = async (filePath, encoding) => {
    let fileHandle;
    try {
        fileHandle = await fs.promises.open(filePath, 'r');
        return await fileHandle.readFile({
            encoding
        });
    }
    finally {
        if (fileHandle) {
            await fileHandle.close();
        }
    }
};
export const getNowSeconds = () => {
    return process.hrtime()[0];
};
export const isNumber = (x) => {
    return (typeof x === 'number');
};
export const isPositiveNumber = (x) => {
    return (isNumber(x) && (x > 0));
};
export const streamDecodeDNSPacket = (buffer) => {
    let packet;
    try {
        packet = dnsPacket.streamDecode(buffer);
    }
    catch (err) {
        logger.error(`streamDecodeDNSPacket error err = ${formatError(err)}`);
    }
    return packet;
};
export const encodeDNSPacket = (packet) => {
    let buffer;
    try {
        buffer = dnsPacket.encode(packet);
    }
    catch (err) {
        logger.error(`encodeDNSPacket error err = ${formatError(err)}`);
    }
    return buffer;
};
export const decodeDNSPacket = (buffer) => {
    let packet;
    try {
        packet = dnsPacket.decode(buffer);
    }
    catch (err) {
        logger.error(`decodeDNSPacket error err = ${formatError(err)}`);
    }
    return packet;
};
