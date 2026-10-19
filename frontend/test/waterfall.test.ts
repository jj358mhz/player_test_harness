import {describe, expect, it} from 'vitest';
import type {RequestTiming} from '../src/engines/types';
import {fromResourceTiming, requestDetail, requestKey, requestState} from '../src/lib/waterfall';

const SEG: RequestTiming = {
    kind: 'segment',
    name: 'f · seg 5933',
    start: 1000,
    end: 1400,
    status: 200,
    bytes: 2_500_000,
    failed: false,
    url: 'https://cdn.example.com/ause1/slices/F00001735.ts?pbs=secret&CMCD=br%3D5694%2Cot%3Dv%2Csid%3D%22s1%22',
    ttfb: 1100,
    mediaDuration: 4.096,
};

describe('waterfall detail', () => {
    it('splits wait and download and redacts the URL', () => {
        const d = requestDetail(SEG, 'hls.js');
        const rows = Object.fromEntries(d.rows);
        expect(rows.URL).not.toContain('secret');
        expect(rows.Host).toBe('cdn.example.com');
        expect(rows['First byte']).toBe('100 ms (request → first byte)');
        expect(rows.Download).toBe('300 ms');
        expect(rows.Throughput).toBe('66.7 Mbps (download only)');
        expect(rows.Media).toBe('4.096 s · loaded in 10% of its duration');
        expect(rows['CMCD sent']).toBe('video · br 5694 kbps');
        expect(d.waitShare).toBeCloseTo(0.25);
        expect(d.notes.join(' ')).toMatch(/X-Cache/);
    });
    it('says why first byte is missing', () => {
        const d = requestDetail({...SEG, ttfb: null, url: undefined}, 'Shaka Player');
        expect(d.notes[0]).toMatch(/not reported by Shaka Player.*Timing-Allow-Origin/);
        expect(Object.fromEntries(d.rows).Throughput).toBe('50.0 Mbps (whole request)');
        expect(d.waitShare).toBeNull();
    });
    it('flags slow segments against their own duration', () => {
        expect(requestState(SEG, 6000)).toBe('segment');
        expect(requestState({...SEG, end: 4000}, 6000)).toBe('slow');
        expect(requestState({...SEG, mediaDuration: null, end: 3500}, 6000)).toBe('segment');
        expect(requestState({...SEG, failed: true}, 6000)).toBe('err');
        expect(requestKey(SEG)).toBe('1000.0|f · seg 5933');
    });
    it('takes first byte from Resource Timing only when the host allows it', () => {
        const none = {...SEG, ttfb: null};
        expect(
            fromResourceTiming(none, {responseStart: 0, nextHopProtocol: '', startTime: 999}),
        ).toEqual({});
        expect(
            fromResourceTiming(none, {responseStart: 1150, nextHopProtocol: 'h2', startTime: 999}),
        ).toEqual({
            ttfb: 1150,
            protocol: 'h2',
        });
        expect(
            fromResourceTiming(SEG, {responseStart: 1150, nextHopProtocol: '', startTime: 999}),
        ).toEqual({});
        expect(fromResourceTiming(SEG, undefined)).toEqual({});
    });
});
