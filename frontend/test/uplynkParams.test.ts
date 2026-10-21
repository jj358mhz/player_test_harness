import {describe, expect, it} from 'vitest';
import {isParamKey, PARAM_GROUPS, paramInfo, parseParams} from '../src/lib/uplynkParams';

describe('parseParams', () => {
    it('normalizes params', () => {
        expect(parseParams('', false)).toEqual({query: '', pairs: []});
        expect(parseParams(' ?ad.lib=KOR ', true)).toEqual({
            query: 'ad.lib=KOR',
            pairs: [['ad.lib', 'KOR']],
        });
        expect(parseParams('expand=ad_01,pb_01&ifo=1&fp.hd.hdcp=-1', false)).toEqual({
            query: 'expand=ad_01%2Cpb_01&ifo=1&fp.hd.hdcp=-1',
            pairs: [
                ['expand', 'ad_01,pb_01'],
                ['ifo', '1'],
                ['fp.hd.hdcp', '-1'],
            ],
        });
    });
    it('lets ad.* ride on an ad server or an expand set', () => {
        expect(parseParams('ad.lib=KOR', false)).toEqual({
            error: 'ad.lib needs an ad server (Ads) or an expand= set that names one',
        });
        expect(parseParams('expand=ad_kor&ad.flex=10', false)).toHaveProperty('query');
    });
    it('says what is wrong', () => {
        for (const bad of [
            'ad.lib',
            'ad.lib=<x>',
            'ad.lib=%E0%A4%A',
            'nonsense=1',
            'ad.=1',
            'expand=a b',
            'expand=',
        ]) {
            expect(parseParams(bad, true)).toHaveProperty('error');
        }
        expect(parseParams('ad=fw2', true)).toEqual({
            error: 'choose the ad server in the Ads menu, not as ad=',
        });
        expect(parseParams('delay=20', true)).toEqual({error: 'use the Delay menu, not delay='});
        expect(parseParams('sig=abc', true)).toEqual({error: 'sig= is part of the token'});
        const many = Array.from({length: 21}, (_, i) => `ad.k${i}=1`).join('&');
        expect(parseParams(many, true)).toEqual({error: 'at most 20 params'});
    });
});

describe('the + param menu', () => {
    it('lists only keys parseParams accepts, once each', () => {
        const keys = PARAM_GROUPS.flatMap((g) => g.params.map((q) => q.key));
        expect(new Set(keys).size).toBe(keys.length);
        for (const key of keys) expect(isParamKey(key), key).toBe(true);
        expect(paramInfo('expand')?.value).toBe('');
        expect(isParamKey('rays')).toBe(false);
    });
    it('has values that parse', () => {
        for (const group of PARAM_GROUPS)
            for (const q of group.params)
                if (q.value && q.key !== 'expand')
                    expect(parseParams(`${q.key}=${q.value}`, true), q.key).toHaveProperty('query');
    });
});
