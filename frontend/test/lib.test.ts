import {describe, expect, it} from 'vitest';
import {bandFor} from '../src/lib/bands';
import {parseId3, parsePriv, parseTxxx} from '../src/lib/id3';
import {Id3Clock, ptsToSeconds} from '../src/lib/latency';
import {parseUplynkMedia, rayFromUri, raysParam} from '../src/lib/rays';
import {RunningStats, Series} from '../src/lib/stats';

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function id3Tag(frames: [string, Uint8Array][]): Uint8Array {
    const body = frames.flatMap(([id, data]) => {
        const size = data.length;
        return [
            ...bytes(id),
            (size >>> 24) & 255,
            (size >>> 16) & 255,
            (size >>> 8) & 255,
            size & 255,
            0,
            0,
            ...data,
        ];
    });
    return Uint8Array.from([...bytes('ID3'), 4, 0, 0, 0, 0, 0, 0, ...body]);
}

describe('bands', () => {
    it.each([
        [3, 'awesome'],
        [10, 'good'],
        [18.9, 'good'],
        [19, 'average'],
        [30, 'above'],
        [40, 'yuk'],
    ])('%s s is %s', (s, key) => {
        expect(bandFor(s).key).toBe(key);
    });
});

describe('RunningStats', () => {
    it('tracks min, max, average and when extremes happened', () => {
        const stats = new RunningStats();
        stats.add(8, new Date(1000));
        stats.add(12, new Date(2000));
        stats.add(7, new Date(3000));
        expect(stats.count).toBe(3);
        expect(stats.average).toBe(9);
        expect([stats.min, stats.minAt?.getTime()]).toEqual([7, 3000]);
        expect([stats.max, stats.maxAt?.getTime()]).toEqual([12, 2000]);
        stats.reset();
        expect(stats.count).toBe(0);
        expect(stats.average).toBeNull();
    });
});

describe('Series', () => {
    it('drops points older than the window', () => {
        const s = new Series(1000);
        s.push(1, 0);
        s.push(2, 600);
        s.push(3, 1500);
        expect(s.points.map((p) => p.v)).toEqual([2, 3]);
    });
});

describe('ID3', () => {
    it('reads TXXX wallclock (no zone means UTC) and PRIV SCTE-35', () => {
        const txxx = Uint8Array.from([
            3,
            ...bytes('wallclock'),
            0,
            ...bytes('2026-10-18T04:15:21.600'),
        ]);
        const priv = Uint8Array.from([...bytes('com.uplynk.scte35'), 0, 0xfc, 0x30, 0x11]);
        const frames = parseId3(
            id3Tag([
                ['TXXX', txxx],
                ['PRIV', priv],
            ]),
        );
        expect(frames.map((f) => f.id)).toEqual(['TXXX', 'PRIV']);

        const t = parseTxxx(frames[0]?.data as Uint8Array);
        expect(t.description).toBe('wallclock');
        expect(t.wallclock?.toISOString()).toBe('2026-10-18T04:15:21.600Z');

        const p = parsePriv(frames[1]?.data as Uint8Array);
        expect(p.owner).toBe('com.uplynk.scte35');
        expect(p.isScte35).toBe(true);
    });

    it('ignores TXXX values that are not times', () => {
        const t = parseTxxx(Uint8Array.from([3, ...bytes('asset'), 0, ...bytes('abc123')]));
        expect(t.value).toBe('abc123');
        expect(t.wallclock).toBeNull();
    });
});

describe('Id3Clock', () => {
    it('measures latency at the playhead, not at download', () => {
        const clock = new Id3Clock();
        clock.add(100, 1_000_000); // sample at media 100 s encoded at t=1000 s
        clock.add(104, 1_004_000);
        // playhead 102.5 s → picture encoded at 1002.5 s; now 1010 s → 7.5 s
        expect(clock.latencyAt(102.5, 1_010_000)).toBeCloseTo(7.5);
        expect(clock.latencyAt(99, 1_010_000)).toBeNull();
    });

    it('accepts 90 kHz pts defensively', () => {
        expect(ptsToSeconds(12.5)).toBe(12.5);
        expect(ptsToSeconds(90000 * 200)).toBe(200);
    });
});

describe('rays', () => {
    const master = [
        '#EXTM3U',
        '#UPLYNK-MEDIA0:1280x720x30,high-31,2x48000',
        '#EXT-X-STREAM-INF:RESOLUTION=1280x720,BANDWIDTH=3414500',
        'https://content.example.com/channel/chan0001/e.m3u8?tc=1&sig=x',
        '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=93444,URI="https://content.example.com/channel/chan0001/ifo.m3u8"',
        '#UPLYNK-MEDIA0:256x144x15,main-13,1x48000',
        '#EXT-X-STREAM-INF:RESOLUTION=256x144,BANDWIDTH=283125',
        'https://content.example.com/channel/chan0001/a.m3u8?tc=1&sig=x',
    ].join('\n');

    it('takes the ray from the variant URI', () => {
        expect(rayFromUri('https://x/channel/chan0001/e.m3u8?sig=1')).toBe('e');
        expect(rayFromUri('https://x/whatever/playlist.m3u8')).toBeNull();
    });

    it('maps rays to #UPLYNK-MEDIA0 details', () => {
        const media = parseUplynkMedia(master);
        expect([...media.keys()]).toEqual(['e', 'a']);
        expect(media.get('e')).toEqual({
            width: 1280,
            height: 720,
            fps: 30,
            profile: 'high-31',
            audio: '2x48000',
        });
    });

    it('builds rays= only for a subset, highest first', () => {
        expect(raysParam(['d', 'f', 'e'], 'abcdef')).toBe('fed');
        expect(raysParam('abcdef', 'abcdef')).toBeNull();
        expect(raysParam([], 'abc')).toBeNull();
    });
});

describe('app helpers', async () => {
    const {keyIdentity, redactSignatures} = await import('../src/app');

    it('treats per-ray key URIs as one key', () => {
        const a = 'https://content.example.com/check2?b=1&v=chan0001&r=a&c=x';
        const f = 'https://content.example.com/check2?b=1&v=chan0001&r=f&c=x';
        expect(keyIdentity(a)).toBe(keyIdentity(f));
        expect(keyIdentity(a)).not.toBe(keyIdentity(a.replace('b=1', 'b=2')));
    });

    it('hides signatures in manifest text', () => {
        expect(redactSignatures('https://x/e.m3u8?tc=1&sig=abc123&pbs=999')).toBe(
            'https://x/e.m3u8?tc=1&sig=…&pbs=…',
        );
    });
});
