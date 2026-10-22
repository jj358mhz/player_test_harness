import {describe, expect, it} from 'vitest';
import {describeJump} from '../src/lib/jumps';

const base = {
    from: 3566.1,
    to: 3683.5,
    stalledMs: null,
    engineGapAgoMs: null,
    engineNote: null,
    liveJumpAgoMs: null,
};

describe('describeJump', () => {
    it('calls a jump out of a stall a gap jump, with what was skipped', () => {
        const e = describeJump({...base, stalledMs: 148_400});
        expect(e?.label).toBe('GAP JUMP');
        expect(e?.kind).toBe('err');
        expect(e?.text).toBe(
            '3566.1 → 3683.5 s (+117.4 s) · after 148.4 s stalled · 117.4 s of content skipped',
        );
    });

    it('names the engine when it reported the gap', () => {
        const e = describeJump({...base, engineGapAgoMs: 40, engineNote: 'Shaka jumped a gap'});
        expect(e?.label).toBe('GAP JUMP');
        expect(e?.text).toContain('Shaka jumped a gap');
    });

    it('labels our own jump to live, and other moves as seeks', () => {
        expect(describeJump({...base, liveJumpAgoMs: 100, stalledMs: 5000})?.label).toBe(
            'JUMP TO LIVE',
        );
        expect(describeJump(base)?.label).toBe('SEEK');
        expect(describeJump({...base, engineGapAgoMs: 9000, engineNote: 'old'})?.label).toBe(
            'SEEK',
        );
    });

    it('ignores nudges under a second', () => {
        expect(describeJump({...base, to: base.from + 0.4, stalledMs: 2000})).toBeNull();
    });
});
