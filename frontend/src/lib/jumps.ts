// Playhead jumps: why the playhead moved without playing through. Engines
// skip gaps by seeking (Shaka says so with `gapjumped`; dash.js and hls.js
// just seek), so the app watches the video element and labels each jump.

export interface JumpContext {
    from: number;
    to: number;
    /** How long playback had been stalled when the jump happened, if it was. */
    stalledMs: number | null;
    /** Milliseconds since the engine reported a gap jump or stall fix, if it did. */
    engineGapAgoMs: number | null;
    /** What the engine said ("Shaka jumped a gap"), shown with the jump. */
    engineNote: string | null;
    /** Milliseconds since the app asked for Jump to live / auto-sync, if it did. */
    liveJumpAgoMs: number | null;
}

export interface JumpEntry {
    kind: 'err' | 'info';
    label: string;
    text: string;
}

/** Jumps under this many seconds are left out (nudges, rounding). */
export const MIN_JUMP_S = 1;
const RECENT_MS = 2000;

export function describeJump(c: JumpContext): JumpEntry | null {
    const delta = c.to - c.from;
    if (!Number.isFinite(delta) || Math.abs(delta) < MIN_JUMP_S) return null;
    const recent = (ms: number | null) => ms !== null && ms < RECENT_MS;
    let text = `${c.from.toFixed(1)} → ${c.to.toFixed(1)} s (${delta > 0 ? '+' : ''}${delta.toFixed(1)} s)`;
    if (recent(c.liveJumpAgoMs)) return {kind: 'info', label: 'JUMP TO LIVE', text};
    const gap = c.stalledMs !== null || recent(c.engineGapAgoMs);
    if (c.stalledMs !== null) text += ` · after ${(c.stalledMs / 1000).toFixed(1)} s stalled`;
    if (recent(c.engineGapAgoMs) && c.engineNote) text += ` · ${c.engineNote}`;
    if (gap && delta > 0) text += ` · ${delta.toFixed(1)} s of content skipped`;
    return gap ? {kind: 'err', label: 'GAP JUMP', text} : {kind: 'info', label: 'SEEK', text};
}
