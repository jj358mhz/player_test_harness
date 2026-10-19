import {describe, expect, it} from 'vitest';
import {
    base64ToBytes,
    bytesToBase64,
    certificateBytes,
    ckcFromResponse,
    fairplayKeyUri,
    keyIdHex,
    licenseUrlFromSkd,
    skdFromInitData,
    spcRequestBody,
} from '../src/lib/fairplay';

const SKD = 'skd://content.example.com/fp-spc/chan0001?r=b&kid=1234';

function utf16WithLength(text: string): Uint8Array {
    const out = new Uint8Array(4 + text.length * 2);
    new DataView(out.buffer).setUint32(0, text.length * 2, true);
    for (let i = 0; i < text.length; i++) out[4 + i * 2] = text.charCodeAt(i);
    return out;
}

describe('FairPlay', () => {
    it('finds the skd:// URI in UTF-8 and UTF-16 init data', () => {
        expect(skdFromInitData(new TextEncoder().encode(SKD))).toBe(SKD);
        expect(skdFromInitData(utf16WithLength(SKD))).toBe(SKD);
        expect(skdFromInitData(new Uint8Array([1, 2, 3]))).toBeNull();
    });

    it('turns the key URI into the key server URL', () => {
        expect(licenseUrlFromSkd(SKD)).toBe(
            'https://content.example.com/fp-spc/chan0001?r=b&kid=1234',
        );
        expect(licenseUrlFromSkd('https://x')).toBeNull();
    });

    it('reads the FairPlay key from a media playlist', () => {
        const playlist = [
            '#EXTM3U',
            '#EXT-X-KEY:METHOD=NONE',
            `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${SKD}",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"`,
            '#EXTINF:4.096,',
            'FP_B00001777.ts',
        ].join('\n');
        expect(fairplayKeyUri(playlist)).toBe(SKD);
        expect(fairplayKeyUri('#EXT-X-KEY:METHOD=AES-128,URI="https://k"')).toBeNull();
    });

    it('accepts the certificate as DER or base64', () => {
        const der = new Uint8Array([0x30, 0x82, 0x01, 0x02]);
        expect(certificateBytes(der.buffer)).toEqual(der);
        const b64 = new TextEncoder().encode(`${bytesToBase64(der)}\n`);
        expect(certificateBytes(b64.buffer)).toEqual(der);
    });

    it('wraps the SPC and unwraps the CKC', () => {
        const spc = new Uint8Array([1, 2, 250]);
        expect(JSON.parse(spcRequestBody(spc.buffer))).toEqual({spc: 'AQL6'});
        const ckc = [9, 8, 7];
        expect([...ckcFromResponse('{"ckc":"CQgH"}')]).toEqual(ckc);
        expect([...ckcFromResponse('<ckc>CQgH</ckc>')]).toEqual(ckc);
        expect([...ckcFromResponse('CQgH\n')]).toEqual(ckc);
        expect(() => ckcFromResponse('{"error":"denied"}')).toThrow(/no ckc/);
    });

    it('round-trips base64 (url-safe and unpadded too) and hexes key ids', () => {
        expect([...base64ToBytes('-_8')]).toEqual([251, 255]);
        expect(keyIdHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
    });
});
