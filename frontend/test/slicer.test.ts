import {describe, expect, it} from 'vitest';
import {describeSlicerWallclock, id3Reason, type SlicerSettings} from '../src/lib/slicer';

const base: SlicerSettings = {
    slicer_id: 'slicer01',
    found: true,
    wallclock: true,
    captured_at: '2026-10-19T12:00:00Z',
    running: true,
    error: null,
};

describe('describeSlicerWallclock', () => {
    it('says on or off with the capture time', () => {
        expect(describeSlicerWallclock(base)).toBe(
            'on (wallclock: 1) · config of 2026-10-19 12:00:00Z',
        );
        expect(describeSlicerWallclock({...base, wallclock: false, captured_at: null})).toBe('off');
    });

    it('says why it is unknown', () => {
        expect(describeSlicerWallclock(null)).toMatch(/asking/);
        expect(describeSlicerWallclock({...base, slicer_id: null})).toMatch(/no slicer/);
        expect(describeSlicerWallclock({...base, found: false, wallclock: null})).toMatch(
            /on-prem/,
        );
        expect(describeSlicerWallclock({...base, wallclock: null})).toMatch(/no config/);
        expect(
            describeSlicerWallclock({...base, found: false, error: 'slicer console answered 500'}),
        ).toBe('unknown: slicer console answered 500');
    });
});

describe('id3Reason', () => {
    it('separates no ID3 from ID3 without a wallclock', () => {
        expect(id3Reason(0, 0, base)).toBe('no ID3 in the stream yet');
        expect(id3Reason(5, 2, base)).toMatch(/waiting/);
    });

    it('uses the console when it knows', () => {
        expect(id3Reason(5, 0, {...base, wallclock: false})).toMatch(/has it off/);
        expect(id3Reason(5, 0, base)).toMatch(/slicer has wallclock: 1/);
        expect(id3Reason(5, 0, null)).toMatch(/off\?/);
        expect(id3Reason(5, 0, {...base, wallclock: null})).toMatch(/off\?/);
    });
});
