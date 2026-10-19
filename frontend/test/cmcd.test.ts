import {describe, expect, it} from 'vitest';
import {cmcdFromUrl, contentIdFor, describeCmcd, newSessionId} from '../src/lib/cmcd';
import {parseView, viewQuery} from '../src/lib/deeplink';

const SEG =
    'https://cdn.example.com/ause1/slices/D0000173A.ts?pbs=x&CMCD=bl%3D21300%2Cbr%3D5694%2Ccid%3D%22chan0001%22%2Cd%3D4096%2Cmtp%3D48000%2Cot%3Dv%2Csf%3Dh%2Csid%3D%22a%2Cb%22%2Csu';

describe('CMCD', () => {
    it('reads the keys a request carried', () => {
        expect(cmcdFromUrl(SEG)).toEqual({
            bl: '21300',
            br: '5694',
            cid: 'chan0001',
            d: '4096',
            mtp: '48000',
            ot: 'v',
            sf: 'h',
            sid: 'a,b',
            su: 'true',
        });
        expect(cmcdFromUrl('https://cdn.example.com/x.ts?pbs=x')).toBeNull();
        expect(cmcdFromUrl('not a url at all %%')).toBeNull();
    });
    it('describes them briefly', () => {
        const keys = cmcdFromUrl(SEG) ?? {};
        expect(describeCmcd(keys)).toBe(
            'video · br 5694 kbps · buffer 21300 ms · throughput 48000 kbps · dur 4096 ms · su',
        );
        expect(describeCmcd({ot: 'm'})).toBe('manifest');
    });
    it('names the content and the session', () => {
        expect(contentIdFor('chan0001', 'https://h/x.m3u8')).toBe('chan0001');
        expect(contentIdFor(null, 'https://h/channel/abc.mpd?sig=1')).toBe('abc');
        expect(newSessionId()).toMatch(/^[0-9a-f-]{20,}$/);
        expect(newSessionId()).not.toBe(newSessionId());
    });
    it('is kept in deep links', () => {
        expect(parseView('?channel=3&cmcd=1').cmcd).toBe(true);
        expect(parseView('?channel=3&cmcd=yes').cmcd).toBeUndefined();
        expect(viewQuery({src: 'https://h/x.m3u8', cmcd: true})).toBe(
            'src=https://h/x.m3u8&cmcd=1',
        );
    });
});
