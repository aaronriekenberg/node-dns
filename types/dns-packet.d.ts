export const AUTHENTIC_DATA: number;
export const AUTHORITATIVE_ANSWER: number;
export const CHECKING_DISABLED: number;
export const DNSSEC_OK: number;
export const RECURSION_AVAILABLE: number;
export const RECURSION_DESIRED: number;
export const TRUNCATED_RESPONSE: number;

export interface DNSAnswer {
    ttl?: number;
}

export interface DNSAuthority {
    ttl?: number;
}

export interface DNSQuestion {
    name?: string;
    type?: string;
    class?: string;
}

export interface DNSPacket {
    id?: number;
    rcode?: string;
    questions?: DNSQuestion[];
    answers?: DNSAnswer[];
    authorities?: DNSAuthority[];
}

export namespace a {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(host: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(): any;
}
export namespace aaaa {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(host: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(): any;
}
export namespace answer {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(a: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(a: any): any;
}
export namespace caa {
    const ISSUER_CRITICAL: number;
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export namespace cname {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export function decode(buf: Buffer, offset?: number): DNSPacket;
export namespace decode {
    const bytes: number;
}
export namespace dname {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export namespace dnskey {
    const PROTOCOL_DNSSEC: number;
    const SECURE_ENTRYPOINT: number;
    const ZONE_KEY: number;
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(key: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(key: any): any;
}
export namespace ds {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(digest: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(digest: any): any;
}
export function encode(result: DNSPacket, buf?: Buffer, offset?: number): Buffer;
export namespace encode {
    const bytes: number;
}
export function encodingLength(result: any): any;
export namespace hinfo {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export namespace mx {
    function decode(buf: any, offset: any): any;
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export namespace name {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(str: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(n: any): any;
}
export namespace ns {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export namespace nsec {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(record: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(record: any): any;
}
export namespace nsec3 {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(record: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(record: any): any;
}
export namespace opt {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(options: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(options: any): any;
}
export namespace option {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(option: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(option: any): any;
}
export namespace ptr {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export namespace question {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(q: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(q: any): any;
}
export function record(type: any): any;
export namespace rp {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export namespace rrsig {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(sig: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(sig: any): any;
}
export namespace soa {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export namespace srv {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export function streamDecode(sbuf: Buffer): DNSPacket;
export namespace streamDecode {
    const bytes: number;
}
export function streamEncode(result: DNSPacket): Buffer;
export namespace streamEncode {
    const bytes: number;
}
export namespace txt {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
export namespace unknown {
    function decode(buf: any, offset: any): any;
    namespace decode {
        const bytes: number;
    }
    function encode(data: any, buf: any, offset: any): any;
    namespace encode {
        const bytes: number;
    }
    function encodingLength(data: any): any;
}
