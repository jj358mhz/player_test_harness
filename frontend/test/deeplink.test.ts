import {describe, expect, it} from 'vitest';
import {isVersion, parseView, viewQuery} from '../src/lib/deeplink';

describe('deep links', () => {
    it('reads a full view', () => {
        expect(parseView('?channel=12&format=dash&engine=shaka@5.3.0&drm=wv&rays=def')).toEqual({
            channel: 12,
            format: 'mpd',
            engine: 'shaka-player',
            version: '5.3.0',
            drm: 'wv',
            rays: 'fed',
        });
    });
    it('reads and writes delay for channels only', () => {
        expect(parseView('?channel=3&delay=20').delay).toBe(20);
        expect(parseView('?channel=3&delay=9999').delay).toBeUndefined();
        expect(viewQuery({channel: 3, delay: 20})).toBe('channel=3&delay=20');
        expect(viewQuery({src: 'https://h/x.m3u8', delay: 20})).not.toContain('delay');
    });
    it('reads and writes the SSAI ad server for channels only', () => {
        expect(parseView('?channel=3&ad=fw2').ad).toBe('fw2');
        expect(parseView('?channel=3&ad=../x').ad).toBeUndefined();
        expect(parseView('?channel=3&ad=a%20b').ad).toBeUndefined();
        expect(viewQuery({channel: 3, delay: 20, ad: 'fw2', cmcd: true})).toBe(
            'channel=3&delay=20&ad=fw2&cmcd=1',
        );
        expect(viewQuery({src: 'https://h/x.m3u8', ad: 'fw2'})).not.toContain('ad=');
    });
    it('carries per-load ad params with an ad server', () => {
        const view = parseView('?channel=3&ad=fw2&ad.lib=KOR&ad.kv=a,b&cmcd=1');
        expect(view.params).toBe('ad.lib=KOR&ad.kv=a%2Cb');
        expect(viewQuery(view)).toBe('channel=3&ad=fw2&ad.lib=KOR&ad.kv=a%2Cb&cmcd=1');
        // v3.22.0 links packed them into adp=; they still load, and are rewritten plainly.
        const old = parseView('?channel=3&ad=fw2&adp=ad.lib%3DKOR');
        expect(viewQuery(old)).toBe('channel=3&ad=fw2&ad.lib=KOR');
        // Without an ad server (or expand set), or with bad values, they're dropped.
        expect(parseView('?channel=3&ad.lib=KOR').params).toBeUndefined();
        expect(parseView('?channel=3&ad=fw2&ad.lib=%3Cx%3E').params).toBeUndefined();
    });
    it('carries expand= and other Uplynk params without an ad server', () => {
        const view = parseView('?channel=3&expand=ad_01,pb_01&ad.lib=KOR&ifo=1&embed=1&x=1');
        expect(view.params).toBe('expand=ad_01%2Cpb_01&ad.lib=KOR&ifo=1');
        expect(viewQuery(view)).toBe('channel=3&expand=ad_01%2Cpb_01&ad.lib=KOR&ifo=1');
        expect(viewQuery({src: 'https://h/x.m3u8', params: 'ifo=1'})).not.toContain('ifo');
    });
    it('accepts long engine names and a missing version', () => {
        expect(parseView('?engine=hls.js')).toEqual({engine: 'hls.js'});
        expect(parseView('?engine=dash.js@5.2.1')).toEqual({engine: 'dashjs', version: '5.2.1'});
        expect(parseView('?engine=native@1.0.0')).toEqual({engine: 'native'});
    });
    it('drops anything that is not a plain value', () => {
        expect(
            parseView(
                '?channel=-3&engine=hlsjs@1.0.0/../../gh/x/y@1&format=flv&drm=clearkey&rays=a1&src=javascript:alert(1)',
            ),
        ).toEqual({engine: 'hls.js'});
        expect(parseView('?engine=vlc@3.0.0')).toEqual({});
        expect(parseView('?channel=7&engine=native@browser&drm=fps')).toMatchObject({
            channel: 7,
            drm: 'fps',
        });
        expect(isVersion('1.6.15')).toBe(true);
        expect(isVersion('5.0.0-beta.2')).toBe(true);
        expect(isVersion('1.6')).toBe(false);
        expect(isVersion('1.6.15/../x')).toBe(false);
    });
    it('writes a readable, stable query', () => {
        expect(
            viewQuery({
                channel: 12,
                format: 'mpd',
                engine: 'dashjs',
                version: '5.2.1',
                drm: 'wv',
                rays: 'fed',
            }),
        ).toBe('channel=12&format=dash&engine=dashjs@5.2.1&drm=wv&rays=fed');
        expect(viewQuery({channel: 3, format: 'm3u8', engine: 'native', version: 'browser'})).toBe(
            'channel=3&engine=native',
        );
    });
    it('round-trips a pasted URL and leaves rays to synced channels', () => {
        const src = 'https://content.example.com/channel/chan0001.m3u8?tc=1&exp=1&sig=abc';
        const query = viewQuery({src, channel: 4, engine: 'hls.js', version: '1.7.3', rays: 'fed'});
        expect(query).not.toContain('channel=');
        expect(query).not.toContain('rays=');
        expect(parseView(`?${query}`)).toEqual({src, engine: 'hls.js', version: '1.7.3'});
    });
});
