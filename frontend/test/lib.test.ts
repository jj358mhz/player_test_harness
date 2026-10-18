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

describe('uplynkSegment', async () => {
    const {uplynkSegment} = await import('../src/engines/hlsjs');

    it.each([
        [[['UPLYNK-SEGMENT', ' asset0001,0000001a,ad']]],
        [[['#UPLYNK-SEGMENT: asset0001,0000001a,ad']]],
        [
            [
                ['EXTINF', '4.096'],
                ['UPLYNK-SEGMENT', 'asset0001,0000001a,ad'],
            ],
        ],
    ])('reads asset and kind from %j', (tagList) => {
        expect(uplynkSegment({tagList})).toEqual({assetId: 'asset0001', kind: 'ad'});
    });

    it('returns null without the tag', () => {
        expect(uplynkSegment({tagList: [['EXTINF', '4']]})).toBeNull();
    });
});

describe('shaka helpers', async () => {
    const {drmHint, rayFromRepresentation, rayFromSegmentUrl} = await import(
        '../src/engines/shaka'
    );
    const {defaultLicenseUrl} = await import('../src/app');

    it('reads rays from DASH representation ids and segment URLs', () => {
        expect(rayFromRepresentation('G')).toBe('g');
        expect(rayFromRepresentation('video=2960177')).toBeNull();
        expect(
            rayFromSegmentUrl('https://cdn.example.com/slices/643/x/y/D00003391.m4s?pbs=1'),
        ).toBe('d');
        expect(rayFromSegmentUrl('https://cdn.example.com/slices/643/x/y/F00003391.ts')).toBe('f');
        expect(rayFromSegmentUrl('https://cdn.example.com/slices/643/x/y/TK_init.mp4')).toBeNull();
    });

    it('explains common DRM errors', () => {
        expect(drmHint(6007)).toMatch(/license request failed/i);
        expect(drmHint(1001)).toBeNull();
    });

    it('derives the license URL from the stream zone', () => {
        expect(
            defaultLicenseUrl('https://content-ausw2-up-1.uplynk.com/preplay2/x.mpd?pbs=1', 'wv'),
        ).toBe('https://content-ausw2-up-1.uplynk.com/wv');
        expect(defaultLicenseUrl('https://example.com/a.mpd', 'pr')).toBe(
            'https://content.uplynk.com/pr',
        );
    });
});

describe('chart scale', async () => {
    const {niceStep} = await import('../src/ui/charts');
    it('keeps about five grid lines for any range', () => {
        expect(niceStep(3)).toBe(5);
        expect(niceStep(12)).toBe(20);
        expect(niceStep(1.7e9 / 5)).toBe(5e8);
        expect(niceStep(Number.POSITIVE_INFINITY)).toBe(5);
    });
});

describe('videoProfile', async () => {
    const {videoProfile} = await import('../src/lib/codecs');
    it.each([
        ['avc1.64001f', 'high-31'],
        ['avc1.640028,mp4a.40.5', 'high-40'],
        ['mp4a.40.5,avc1.4d001e', 'main-30'],
        ['avc1.42000b', 'baseline-11'],
        ['hvc1.2.4.L123.B0', 'hevc'],
        ['mp4a.40.2', null],
    ])('%s → %s', (codecs, expected) => {
        expect(videoProfile(codecs)).toBe(expected);
    });
});

describe('mpdInfo', async () => {
    const {mpdInfo, isoSeconds} = await import('../src/engines/shaka');
    const {redactSignatures} = await import('../src/app');
    const mpd = `<MPD type="dynamic" availabilityStartTime="2026-10-18T06:14:03Z" maxSegmentDuration="PT2.048S" minimumUpdatePeriod="PT8.000S" timeShiftBufferDepth="PT1M30S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
<Period id="0"><AssetIdentifier schemeIdUri="urn:com:uplynk:ad-asset-id" value="x"/><AdaptationSet mimeType="video/mp4"/></Period>
<Period id="1"><AdaptationSet mimeType="video/mp4"/></Period>
<BaseURL>https://cdn.example.com/a/?pbs=abc&amp;sig=def</BaseURL></MPD>`;

    it('reads the MPD root and periods', () => {
        const info = mpdInfo(mpd);
        expect(info.format).toBe('dash');
        expect(info.live).toBe(true);
        expect(info.targetDuration).toBeCloseTo(2.048);
        expect(info.windowSeconds).toBe(90);
        expect(info.container).toBe('fMP4');
        expect(info.dash).toMatchObject({updatePeriod: 8, periods: 2, adPeriods: 1});
    });

    it('parses ISO durations and hides MPD signatures', () => {
        expect(isoSeconds('PT1H2M3.5S')).toBeCloseTo(3723.5);
        expect(isoSeconds('bogus')).toBeNull();
        expect(redactSignatures(mpd)).toContain('?pbs=…&amp;sig=…<');
    });
});
