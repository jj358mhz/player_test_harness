import {describe, expect, it} from 'vitest';
import {
    capPush,
    RequestTally,
    redact,
    redactDeep,
    stripQuery,
    summarize,
} from '../src/lib/recording';
import {RunningStats} from '../src/lib/stats';
import {tickMinutes} from '../src/ui/charts';

const SIGNED =
    'https://content.example.com/channel/chan0001.m3u8?tc=1&exp=9&cid=chan0001&sig=abc123';

describe('recordings', () => {
    it('redacts signatures and session tokens everywhere', () => {
        expect(redact(SIGNED)).toBe(SIGNED.replace('abc123', '…'));
        const deep = redactDeep({
            log: [{text: `LOAD ${SIGNED}`}],
            url: 'https://x/f.m3u8?pbs=sess&amp;pbs=two',
            n: 4,
            none: null,
        });
        expect(JSON.stringify(deep)).not.toMatch(/abc123|sess|two/);
        expect(deep.n).toBe(4);
        expect(deep.none).toBeNull();
    });
    it('redacts percent-encoded signatures in deep links', () => {
        const link = `src=${encodeURIComponent(SIGNED)}&engine=hlsjs`;
        expect(redact(link)).not.toContain('abc123');
        expect(redact(link)).toContain('%26sig%3D…');
    });
    it('masks the session in Preplay play URL paths', () => {
        expect(
            redact(
                'https://content-x.example.com/preplay2/channel/chan0001/sid0001/tok123.mpd?pbs=s',
            ),
        ).toBe('https://content-x.example.com/preplay2/channel/chan0001/…?pbs=…');
    });
    it('keeps only origin and path of license URLs', () => {
        expect(stripQuery('https://content-x.example.com/wv?b=1&tok=secret')).toBe(
            'https://content-x.example.com/wv',
        );
        expect(stripQuery(null)).toBeNull();
    });
    it('caps lists by dropping the oldest', () => {
        const list: number[] = [];
        for (let i = 0; i < 10; i++) capPush(list, i, 4);
        expect(list).toEqual([6, 7, 8, 9]);
    });
    it('summarises running stats, with nulls when empty', () => {
        const stats = new RunningStats();
        expect(summarize(stats)).toEqual({count: 0, last: null, avg: null, min: null, max: null});
        stats.add(4);
        stats.add(8);
        expect(summarize(stats)).toEqual({count: 2, last: 8, avg: 6, min: 4, max: 8});
    });
    it('tallies requests per kind with p95', () => {
        const tally = new RequestTally();
        for (let i = 1; i <= 20; i++) tally.add('segment', i * 10, 1000, i === 20);
        tally.add('license', 150, 300, false);
        const s = tally.summary();
        expect(s.segment).toEqual({count: 20, failed: 1, avgMs: 105, p95Ms: 200, bytes: 20000});
        expect(s.license?.p95Ms).toBe(150);
    });
    it('spaces replay ticks to about eight', () => {
        expect(tickMinutes(5)).toBe(1);
        expect(tickMinutes(30)).toBe(5);
        expect(tickMinutes(90)).toBe(15);
        expect(tickMinutes(6 * 60)).toBe(60);
    });
});
