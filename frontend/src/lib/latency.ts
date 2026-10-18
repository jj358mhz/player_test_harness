// ID3 wallclock latency measured at the playhead.
//
// Each ID3 sample has a media time (pts) and the encoder's wallclock. When
// the playhead is at currentTime, the picture on screen was encoded at
// wallclock + (currentTime - pts) for the latest sample at or before it, so
// latency = now - that. (The original player subtracted at download time,
// which ignores the buffer and over-reports by its length.)

interface Anchor {
    mediaTime: number;
    wallclockMs: number;
}

export class Id3Clock {
    private anchors: Anchor[] = [];

    add(mediaTime: number, wallclockMs: number): void {
        this.anchors.push({mediaTime, wallclockMs});
        this.anchors.sort((a, b) => a.mediaTime - b.mediaTime);
        if (this.anchors.length > 500) this.anchors.splice(0, this.anchors.length - 500);
    }

    /** Seconds behind the encoder, or null before the first usable sample. */
    latencyAt(currentTime: number, nowMs: number = Date.now()): number | null {
        let anchor: Anchor | undefined;
        for (const a of this.anchors) {
            if (a.mediaTime <= currentTime) anchor = a;
            else break;
        }
        if (!anchor) return null;
        const onScreenMs = anchor.wallclockMs + (currentTime - anchor.mediaTime) * 1000;
        return (nowMs - onScreenMs) / 1000;
    }

    clear(): void {
        this.anchors = [];
    }
}

/** hls.js reports sample pts in seconds; guard against 90 kHz ticks. */
export const ptsToSeconds = (pts: number): number => (pts > 1e7 ? pts / 90000 : pts);
