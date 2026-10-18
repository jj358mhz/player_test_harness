// Uplynk names renditions by ray letter (a = lowest). The ray is the
// basename of each variant URI in the HLS master (…/channel/<id>/e.m3u8),
// and the line before #EXT-X-STREAM-INF is
// #UPLYNK-MEDIA0:<W>x<H>x<fps>,<profile-level>,<channels>x<rate>.

export function rayFromUri(uri: string): string | null {
    const path = uri.split('?')[0] ?? '';
    const match = /\/([a-z]{1,3})\.m3u8$/i.exec(path);
    return match ? (match[1] as string).toLowerCase() : null;
}

export interface UplynkMedia {
    width: number;
    height: number;
    fps: number;
    profile: string;
    audio: string;
}

/** Map ray letter → #UPLYNK-MEDIA0 details from a master playlist. */
export function parseUplynkMedia(master: string): Map<string, UplynkMedia> {
    const out = new Map<string, UplynkMedia>();
    let pending: UplynkMedia | null = null;
    for (const raw of master.split(/\r?\n/)) {
        const line = raw.trim();
        const media = /^#UPLYNK-MEDIA0:(\d+)x(\d+)x([\d.]+),([^,]*),(.*)$/.exec(line);
        if (media) {
            const [, w, h, fps, profile, audio] = media as unknown as string[];
            pending = {
                width: Number(w),
                height: Number(h),
                fps: Number(fps),
                profile: profile ?? '',
                audio: audio ?? '',
            };
            continue;
        }
        if (line && !line.startsWith('#')) {
            const ray = rayFromUri(line);
            if (ray && pending) out.set(ray, pending);
            pending = null;
        }
    }
    return out;
}

/** "rays=fed" for a subset, or null when every ray is selected. */
export function raysParam(selected: Iterable<string>, all: Iterable<string>): string | null {
    const chosen = [...new Set(selected)].sort().reverse();
    const total = new Set(all).size;
    return chosen.length && chosen.length < total ? chosen.join('') : null;
}
