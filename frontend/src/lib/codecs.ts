// Codec strings → the profile names Uplynk uses in #UPLYNK-MEDIA0
// (e.g. avc1.64001f → high-31), so DASH ladders read like HLS ones.

const AVC_PROFILES: Record<number, string> = {
    66: 'baseline',
    77: 'main',
    88: 'extended',
    100: 'high',
    110: 'high10',
    122: 'high422',
    244: 'high444',
};

export function videoProfile(codecs: string | null | undefined): string | null {
    if (!codecs) return null;
    const avc = /avc[13]\.([0-9a-f]{2})[0-9a-f]{2}([0-9a-f]{2})/i.exec(codecs);
    if (avc) {
        const profile =
            AVC_PROFILES[Number.parseInt(avc[1] as string, 16)] ??
            `profile${Number.parseInt(avc[1] as string, 16)}`;
        return `${profile}-${Number.parseInt(avc[2] as string, 16)}`;
    }
    if (/\b(hvc1|hev1)\./i.test(codecs)) return 'hevc';
    if (/\bav01\./i.test(codecs)) return 'av1';
    if (/\bvp0?9/i.test(codecs)) return 'vp9';
    return null;
}
