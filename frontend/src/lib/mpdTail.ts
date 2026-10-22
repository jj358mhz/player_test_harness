// The end of a live MPD's timeline, for stalls: where the newest Periods
// start and end, and how far their listed video segments reach. Uplynk
// stitches each SSAI ad in as its own Period, and Shaka has been seen to
// stall in whichever Period was newest when it got there.

/** ISO 8601 duration (PT1H2M3.5S) → seconds. */
export function isoSeconds(value: string | null): number | null {
    const m = value && /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(value);
    if (!m) return null;
    const [, d, h, min, sec] = m;
    return (
        Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(sec ?? 0)
    );
}

export interface PeriodTail {
    id: string | null;
    /** Seconds on the MPD timeline (Period@start). */
    start: number | null;
    /** Period@duration, if the MPD gives one. */
    duration: number | null;
    /** The Period's ad-asset-id, if it is an Uplynk ad. */
    adAsset: string | null;
    /** Video segments listed, and where the last one ends on the MPD timeline. */
    segments: number;
    segmentsEnd: number | null;
}

/** The last `count` Periods of an MPD (oldest first), or [] if it won't parse. */
export function mpdTail(mpd: string | null | undefined, count = 2): PeriodTail[] {
    if (!mpd) return [];
    const doc = new DOMParser().parseFromString(mpd, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return [];
    const periods = [...doc.getElementsByTagNameNS('*', 'Period')];
    return periods.slice(-count).map((period) => {
        const start = isoSeconds(period.getAttribute('start'));
        const ad = [...period.getElementsByTagNameNS('*', 'AssetIdentifier')].find(
            (a) => a.getAttribute('schemeIdUri') === 'urn:com:uplynk:ad-asset-id',
        );
        const {segments, end} = videoTimeline(period);
        return {
            id: period.getAttribute('id'),
            start,
            duration: isoSeconds(period.getAttribute('duration')),
            adAsset: ad?.getAttribute('value') ?? null,
            segments,
            segmentsEnd: end === null || start === null ? null : start + end,
        };
    });
}

/** Video segment count and the end of the last one, in seconds from the Period start. */
function videoTimeline(period: Element): {segments: number; end: number | null} {
    const sets = [...period.getElementsByTagNameNS('*', 'AdaptationSet')];
    const video =
        sets.find(
            (s) =>
                s.getAttribute('contentType') === 'video' ||
                (s.getAttribute('mimeType') ?? '').startsWith('video/'),
        ) ?? sets[0];
    const template = video?.getElementsByTagNameNS('*', 'SegmentTemplate')[0];
    const timeline = template?.getElementsByTagNameNS('*', 'SegmentTimeline')[0];
    if (!template || !timeline) return {segments: 0, end: null};
    const timescale = Number(template.getAttribute('timescale') ?? 1) || 1;
    const offset = Number(template.getAttribute('presentationTimeOffset') ?? 0);
    let t = 0;
    let segments = 0;
    let end: number | null = null;
    for (const s of timeline.getElementsByTagNameNS('*', 'S')) {
        const d = Number(s.getAttribute('d') ?? 0);
        const repeat = Number(s.getAttribute('r') ?? 0);
        if (s.hasAttribute('t')) t = Number(s.getAttribute('t'));
        const n = repeat >= 0 ? repeat + 1 : 1;
        t += d * n;
        segments += n;
        end = (t - offset) / timescale;
    }
    return {segments, end};
}

/** One log line: the playhead against the newest Periods. */
export function describeTail(tail: PeriodTail[], playhead: number): string {
    if (!tail.length) return 'no Periods found in the MPD';
    const fmt = (v: number | null) => (v === null ? '?' : v.toFixed(1));
    const parts = tail.map((p, i) => {
        const what = p.adAsset ? `ad ${p.adAsset.slice(0, 8)}…` : 'content';
        const end = p.duration !== null && p.start !== null ? p.start + p.duration : null;
        const span = `${fmt(p.start)}–${end === null ? 'open' : fmt(end)} s`;
        const segs = `${p.segments} video segs to ${fmt(p.segmentsEnd)} s`;
        const label = i === tail.length - 1 ? 'newest' : 'before';
        return `${label}: ${what} ${span}, ${segs}`;
    });
    const newest = tail[tail.length - 1] as PeriodTail;
    let where = '';
    if (newest.segmentsEnd !== null) {
        const ahead = newest.segmentsEnd - playhead;
        where =
            ahead > 0
                ? ` · listed segments run ${ahead.toFixed(1)} s past the playhead`
                : ` · playhead is ${(-ahead).toFixed(1)} s past the last listed segment`;
    }
    return `playhead ${playhead.toFixed(1)} s · ${parts.join(' · ')}${where}`;
}
