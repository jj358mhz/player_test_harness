import {describe, expect, it} from 'vitest';
import {decodeScte35, describeScte35, hexToBytes} from '../src/lib/scte35';

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Sample messages from the SCTE-35 specification (section 14).
const TIME_SIGNAL_PPO_START =
    '/DA0AAAAAAAA///wBQb+cr0AUAAeAhxDVUVJSAAAjn/PAAGlmbAICAAAAAAsoKGKNAIAmsnRfg==';
const SPLICE_INSERT_OUT = '/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=';

describe('decodeScte35', () => {
    it('decodes time_signal with a Provider Placement Opportunity Start', () => {
        const info = decodeScte35(b64(TIME_SIGNAL_PPO_START));
        expect(info.command).toBe('time_signal');
        expect(info.spliceTime).toBeCloseTo(0x072bd0050 / 90000, 3);
        expect(info.segmentations).toHaveLength(1);
        const seg = info.segmentations[0];
        expect(seg?.typeId).toBe(0x34);
        expect(seg?.typeName).toBe('Provider Placement Opportunity Start');
        expect(seg?.duration).toBeCloseTo(307, 1);
        expect(info.direction).toBe('out');
        expect(info.duration).toBeCloseTo(307, 1);
    });

    it('decodes splice_insert out of network with a break duration', () => {
        const info = decodeScte35(b64(SPLICE_INSERT_OUT));
        expect(info.command).toBe('splice_insert');
        expect(info.eventId).toBe(0x4800008f);
        expect(info.outOfNetwork).toBe(true);
        expect(info.autoReturn).toBe(true);
        expect(info.breakDuration).toBeCloseTo(0x0052ccf5 / 90000, 3);
        expect(info.direction).toBe('out');
        expect(describeScte35(info)).toMatch(
            /^splice_insert · CUE-OUT · event 1207959695 · 60\.3 s/,
        );
    });

    it('rejects non-SCTE-35 bytes and reads hex', () => {
        expect(() => decodeScte35(Uint8Array.from([0x47, 0x00]))).toThrow(/table_id/);
        expect(hexToBytes('0xFC30')).toEqual(Uint8Array.from([0xfc, 0x30]));
    });
});
