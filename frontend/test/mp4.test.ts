import {describe, expect, it} from 'vitest';
import {initTimescale, payloadPreview, readSegmentBoxes, wallAtSegmentStart} from '../src/lib/mp4';

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let at = 8;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

function bytes(...fields: [number, 1 | 2 | 3 | 4 | 8][]): Uint8Array {
    const out = new Uint8Array(fields.reduce((n, [, w]) => n + w, 0));
    const view = new DataView(out.buffer);
    let at = 0;
    for (const [value, width] of fields) {
        if (width === 8) {
            view.setUint32(at, Math.floor(value / 2 ** 32));
            view.setUint32(at + 4, value % 2 ** 32);
        } else if (width === 4) view.setUint32(at, value);
        else if (width === 3) {
            view.setUint8(at, value >> 16);
            view.setUint16(at + 1, value & 0xffff);
        } else if (width === 2) view.setUint16(at, value);
        else view.setUint8(at, value);
        at += width;
    }
    return out;
}

const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};

// 2026-10-19T12:00:00.500Z as NTP: seconds since 1900 + half a second.
const UNIX_S = Date.UTC(2026, 9, 19, 12) / 1000;
const NTP_S = UNIX_S + 2208988800;

const prft = (version: 0 | 1, mediaTime: number, flags = 0) =>
    box(
        'prft',
        bytes(
            [version, 1],
            [flags, 3],
            [1, 4],
            [NTP_S, 4],
            [2 ** 31, 4],
            [mediaTime, version ? 8 : 4],
        ),
    );
const tfdt = (version: 0 | 1, t: number) =>
    box('tfdt', bytes([version, 1], [0, 3], [t, version ? 8 : 4]));
const segment = (...head: Uint8Array[]) =>
    concat(
        box('styp', bytes([0, 4])),
        ...head,
        box('moof', box('mfhd', bytes([0, 4], [7, 4])), box('traf', tfdt(1, 9_000_000))),
        box('mdat', new Uint8Array(32)),
    );

describe('readSegmentBoxes', () => {
    it('reads prft (v0 and v1) and the first tfdt', () => {
        const found = readSegmentBoxes(segment(prft(1, 9_090_000, 24)));
        expect(found.tfdt).toBe(9_000_000);
        expect(found.prft).toHaveLength(1);
        expect(found.prft[0]).toMatchObject({flags: 24, trackId: 1, mediaTime: 9_090_000});
        expect(found.prft[0]?.wallMs).toBe(UNIX_S * 1000 + 500);
        expect(readSegmentBoxes(segment(prft(0, 1234))).prft[0]?.mediaTime).toBe(1234);
    });

    it('finds nothing in a segment without prft', () => {
        expect(readSegmentBoxes(segment()).prft).toEqual([]);
    });

    it('survives truncated data', () => {
        const whole = segment(prft(1, 5));
        expect(() => readSegmentBoxes(whole.subarray(0, 30))).not.toThrow();
        expect(readSegmentBoxes(new Uint8Array(3)).prft).toEqual([]);
    });

    it('accepts a view into a larger buffer', () => {
        const whole = concat(new Uint8Array(5), segment(prft(1, 5)));
        expect(readSegmentBoxes(whole.subarray(5)).prft).toHaveLength(1);
    });
});

describe('initTimescale', () => {
    it('reads mdhd (v0 and v1)', () => {
        const mdhd = (version: 0 | 1, timescale: number) =>
            box(
                'mdhd',
                version
                    ? bytes([1, 1], [0, 3], [0, 8], [0, 8], [timescale, 4], [0, 8])
                    : bytes([0, 1], [0, 3], [0, 4], [0, 4], [timescale, 4], [0, 4]),
            );
        const init = (m: Uint8Array) =>
            concat(box('ftyp', bytes([0, 4])), box('moov', box('trak', box('mdia', m))));
        expect(initTimescale(init(mdhd(0, 90000)))).toBe(90000);
        expect(initTimescale(init(mdhd(1, 10_000_000)))).toBe(10_000_000);
        expect(initTimescale(box('ftyp'))).toBeNull();
    });
});

describe('wallAtSegmentStart', () => {
    const p = {flags: 0, trackId: 1, wallMs: 10_000, mediaTime: 9_090_000};
    it('moves back by the prft media time past tfdt', () => {
        expect(wallAtSegmentStart(p, 9_000_000, 90000)).toBe(9_000);
    });
    it('uses the prft time without a timescale or tfdt', () => {
        expect(wallAtSegmentStart(p, null, 90000)).toBe(10_000);
        expect(wallAtSegmentStart(p, 9_000_000, null)).toBe(10_000);
    });
});

describe('payloadPreview', () => {
    it('shows text or hex', () => {
        expect(payloadPreview(new TextEncoder().encode('asset=abc\n'))).toBe('asset=abc');
        expect(payloadPreview(Uint8Array.of(0, 1, 0xff))).toBe('0x0001ff');
        expect(payloadPreview(new Uint8Array(40))).toMatch(/^0x0{64}…$/);
        expect(payloadPreview(undefined)).toBe('');
    });
});
