import {describe, expect, it} from 'vitest';
import {compareSearch, delta, PRESETS, parseCompare, presetQueries} from '../src/lib/compare';

describe('compare', () => {
    it('builds both panes from a preset', () => {
        expect(presetQueries('hls-dash', 7)).toEqual({
            a: 'channel=7&engine=hlsjs',
            b: 'channel=7&format=dash&engine=shaka',
        });
        expect(presetQueries('delay', 7).b).toBe('channel=7&engine=hlsjs&delay=20');
        expect(Object.keys(PRESETS)).toHaveLength(4);
    });
    it('round-trips its own link', () => {
        const search = compareSearch('?channel=7&engine=hlsjs@1.7.3', 'channel=7&format=dash');
        expect(parseCompare(search)).toEqual({
            a: 'channel=7&engine=hlsjs@1.7.3',
            b: 'channel=7&format=dash',
        });
    });
    it('passes pane queries through the deep-link checks', () => {
        const search = compareSearch('channel=7&engine=hlsjs@1.0.0/../../x&embed=0', '');
        expect(parseCompare(search)).toEqual({a: 'channel=7&engine=hlsjs', b: null});
        expect(parseCompare('?a=src%3Djavascript%3Aalert(1)')).toEqual({a: null, b: null});
    });
    it('subtracts B − A only when both are known', () => {
        expect(delta(10, 14.5)).toBe(4.5);
        expect(delta(null, 3)).toBeNull();
        expect(delta(3, undefined)).toBeNull();
    });
});
