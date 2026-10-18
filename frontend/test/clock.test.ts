import {describe, expect, it} from 'vitest';
import {clockFor, hlsStart, parseDelay} from '../src/lib/clock';

const HLS = 'https://content.example.com/channel/chan0001.m3u8?tc=1&cid=chan0001';

describe('latency clocks', () => {
    it('knows which clock a URL uses', () => {
        expect(clockFor('m3u8', `${HLS}&pdts=latency&sig=x`, null).kind).toBe('encoder');
        expect(clockFor('m3u8', `${HLS}&sig=x`, null).kind).toBe('session');
        expect(clockFor('mpd', 'https://content.example.com/x.mpd', null).kind).toBe('mpd');
        expect(clockFor('m3u8', 'not a url', null)).toMatchObject({kind: 'session', delay: null});
    });
    it('carries the measured DASH offset', () => {
        const clock = clockFor('mpd', 'https://content.example.com/x.mpd?delay=20', {
            offset_s: 30.9,
            edge_age_s: 31.2,
            reference: 'pdts=latency',
            slice: '#5933',
        });
        expect(clock).toEqual({
            kind: 'mpd-offset',
            offsetS: 30.9,
            edgeAgeS: 31.2,
            slice: '#5933',
            delay: 20,
        });
    });
    it('accepts only plausible delays', () => {
        expect(parseDelay('20')).toBe(20);
        expect(parseDelay('0')).toBe(0);
        expect(parseDelay('601')).toBeNull();
        expect(parseDelay('-1')).toBeNull();
        expect(parseDelay('1e3')).toBeNull();
        expect(parseDelay(null)).toBeNull();
    });
    it('describes EXT-X-START', () => {
        expect(hlsStart('#EXTM3U\n#EXT-X-START:TIME-OFFSET=0.00\n')).toMatch(/oldest segment/);
        expect(hlsStart('#EXTM3U\n#EXT-X-START:TIME-OFFSET=-12,PRECISE=YES\n')).toMatch(
            /12 s before the live edge/,
        );
        expect(hlsStart('#EXTM3U\n')).toBeNull();
        expect(hlsStart(null)).toBeNull();
    });
});
