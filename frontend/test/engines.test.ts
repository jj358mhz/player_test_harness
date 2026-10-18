import {describe, expect, it} from 'vitest';
import {hex, mpdLicenseUrl, requestKind} from '../src/engines/dashjs';
import {
    dataCueFrame,
    mediaErrorText,
    mediaPlaylistInfo,
    nativeRequestKind,
    parseAttributes,
    parseMaster,
    renditionForHeight,
} from '../src/engines/native';
import {parsePriv, parseTxxx} from '../src/lib/id3';

const MASTER = `#EXTM3U
#UPLYNK-MEDIA0:256x144x15,main-13,2x48000
#EXT-X-STREAM-INF:PROGRAM-ID=1,RESOLUTION=256x144,BANDWIDTH=328900,CODECS="mp4a.40.5,avc1.4d000d",FRAME-RATE=15.000
https://content.example.com/channel/chan0001/a.m3u8?pbs=x
#UPLYNK-MEDIA0:1280x720x30,high-31,2x48000
#EXT-X-STREAM-INF:PROGRAM-ID=1,RESOLUTION=1280x720,BANDWIDTH=5565000,CODECS="mp4a.40.5,avc1.64001f"
https://content.example.com/channel/chan0001/f.m3u8?pbs=x
#UPLYNK-MEDIA0:960x540x30,main-31,2x48000
#EXT-X-STREAM-INF:PROGRAM-ID=1,RESOLUTION=960x540,BANDWIDTH=2328000,CODECS="mp4a.40.5,avc1.4d001f"
https://content.example.com/channel/chan0001/d.m3u8?pbs=x
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="ifo.m3u8"
`;

describe('dash.js helpers', () => {
    it('finds the Widevine license URL Uplynk puts in <ms:laurl>', () => {
        const mpd =
            '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">' +
            '<ms:laurl xmlns:ms="urn:microsoft" licenseUrl="https://content-x.example.com/wv?b=1&amp;c=chan0001"></ms:laurl>';
        expect(mpdLicenseUrl(mpd)).toBe('https://content-x.example.com/wv?b=1&c=chan0001');
        expect(mpdLicenseUrl('<MPD></MPD>')).toBeNull();
    });
    it('classifies responses by dash.js context, then by URL', () => {
        expect(requestKind('https://x/D00001.m4f', {type: 'MediaSegment'})).toBe('segment');
        expect(requestKind('https://x/whatever', {type: 'InitializationSegment'})).toBe('init');
        expect(requestKind('https://x/channel/chan0001.mpd?tc=1')).toBe('manifest');
        expect(requestKind('https://x/F_init.mp4?pbs=1')).toBe('init');
        expect(requestKind('https://x/TK_00005950.m4f?pbs=1')).toBe('segment');
        expect(requestKind('https://x/misc/utcservertime')).toBeNull();
    });
    it('hex-encodes key ids', () => {
        expect(hex(new Uint8Array([0x7e, 0xb0, 0x36, 0x0a]))).toBe('7eb0360a');
        expect(hex(new Uint8Array([1, 2]).buffer)).toBe('0102');
    });
});

describe('native helpers', () => {
    it('parses a master into a ray-labelled ladder, lowest first, skipping I-frames', () => {
        const ladder = parseMaster(MASTER, 'https://content.example.com/channel/chan0001.m3u8');
        expect(ladder.map((r) => r.ray)).toEqual(['a', 'd', 'f']);
        expect(ladder.map((r) => r.index)).toEqual([0, 1, 2]);
        const [a, , f] = ladder;
        expect(a).toMatchObject({width: 256, height: 144, bitrate: 328900, fps: 15});
        expect(a?.profile).toBe('main-13');
        expect(f).toMatchObject({height: 720, fps: 30, profile: 'high-31'});
    });
    it('parses attribute lists with quoted commas', () => {
        expect(parseAttributes('BANDWIDTH=1,CODECS="a,b",RESOLUTION=2x3')).toEqual({
            BANDWIDTH: '1',
            CODECS: 'a,b',
            RESOLUTION: '2x3',
        });
    });
    it('summarises a media playlist', () => {
        const media = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-PROGRAM-DATE-TIME:2026-10-18T16:00:00Z
#EXTINF:4.0,
F00000100.ts
#EXTINF:4.0,
F00000101.ts
`;
        const info = mediaPlaylistInfo(media, 'https://x/channel/chan0001/f.m3u8?pbs=1');
        expect(info).toMatchObject({
            format: 'hls',
            ray: 'f',
            live: true,
            targetDuration: 4,
            windowSeconds: 8,
            segments: 2,
            firstSn: 100,
            lastSn: 101,
            hasProgramDateTime: true,
            container: 'TS',
        });
        expect(mediaPlaylistInfo(`${media}#EXT-X-ENDLIST\n`, '').live).toBe(false);
    });
    it('maps the decoded height to a rendition', () => {
        const ladder = parseMaster(MASTER, 'https://content.example.com/x.m3u8');
        expect(renditionForHeight(ladder, 720)?.ray).toBe('f');
        expect(renditionForHeight(ladder, 576)?.ray).toBe('d'); // nearest
        expect(renditionForHeight([], 720)).toBeNull();
    });
    it('classifies resource timing entries', () => {
        expect(nativeRequestKind('https://x/f.m3u8?pbs=1')).toBe('playlist');
        expect(nativeRequestKind('https://x/F00000100.ts?a=1')).toBe('segment');
        expect(nativeRequestKind('https://x/store/key?r=f')).toBe('key');
        expect(nativeRequestKind('https://x/thumb.jpg')).toBeNull();
    });
    it("rebuilds ID3 frames from Safari's DataCue values", () => {
        const txxx = dataCueFrame({key: 'TXXX', info: 'wallclock', data: '1792345000.5'});
        expect(txxx?.id).toBe('TXXX');
        const parsed = parseTxxx(txxx?.data ?? new Uint8Array());
        expect(parsed).toMatchObject({description: 'wallclock', value: '1792345000.5'});
        const priv = dataCueFrame({
            key: 'PRIV',
            info: 'com.example.scte35',
            data: new Uint8Array([0xfc, 0x30]).buffer,
        });
        const p = parsePriv(priv?.data ?? new Uint8Array());
        expect(p.owner).toBe('com.example.scte35');
        expect([...p.data]).toEqual([0xfc, 0x30]);
        expect(dataCueFrame(undefined)).toBeNull();
    });
    it('explains media errors', () => {
        expect(mediaErrorText(4, '')).toMatch(/^MEDIA_ERR_SRC_NOT_SUPPORTED · .*use hls\.js/);
        expect(mediaErrorText(3, 'bad frame')).toBe('MEDIA_ERR_DECODE bad frame');
    });
});
