// What csl-slicer-console says about a channel's slicer, in words.
//
// Only slicers with `wallclock: 1` write the encoder time into ID3, so
// the console's stored config answers "why no ID3 latency" outright for
// cloud slicers. On-prem slicers aren't in the console: unknown.

export interface SlicerSettings {
    slicer_id: string | null;
    found: boolean;
    /** From the last captured config; null = unknown. */
    wallclock: boolean | null;
    captured_at: string | null;
    running: boolean | null;
    error: string | null;
}

/** The Metadata tab's "Slicer wallclock" row. */
export function describeSlicerWallclock(info: SlicerSettings | null | undefined): string {
    if (!info) return 'asking the slicer console…';
    if (!info.slicer_id) return 'unknown: the channel has no slicer';
    if (info.error) return `unknown: ${info.error}`;
    if (!info.found) return 'unknown: not in the slicer console (on-prem?)';
    if (info.wallclock === null) return 'unknown: no config captured yet';
    const when = info.captured_at ? ` · config of ${info.captured_at.replace('T', ' ')}` : '';
    return `${info.wallclock ? 'on (wallclock: 1)' : 'off'}${when}`;
}

/** Why there's no ID3 latency yet, given what the stream and the console say. */
export function id3Reason(
    id3Count: number,
    wallclocks: number,
    slicer: SlicerSettings | null | undefined,
): string {
    if (!id3Count) return 'no ID3 in the stream yet';
    if (!wallclocks) {
        if (slicer?.wallclock === false) return 'ID3 has no wallclock: the slicer has it off';
        if (slicer?.wallclock === true) return 'no wallclock in ID3 yet (slicer has wallclock: 1)';
        return 'ID3 has no wallclock (slicer wallclock: 1 off?)';
    }
    return 'waiting for the playhead to reach a timestamp';
}
