// FairPlay Streaming over Uplynk Studio DRM (Safari, native HLS + EME).
//
// Uplynk's flow (docs: "Apple FairPlay DRM (HLS)"):
//  - Preplay with `rmt=fps` returns `drm.fairplayCertificateURL`; the media
//    playlists carry `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://…/fp-spc/…"`.
//  - The license (key server) URL is that skd:// URI with an https scheme.
//  - Request: POST `{"spc": "<base64 SPC>"}` as application/json; the
//    response is `{"ckc": "<base64 CKC>"}`, whose bytes go to session.update().

export const FAIRPLAY_KEY_SYSTEM = 'com.apple.fps';
/**
 * Apple's older, WebKit-prefixed EME. Safari's standard EME only handles
 * FairPlay for fMP4; MPEG-TS with SAMPLE-AES (Uplynk's FP_….ts segments)
 * still needs this one (Shaka says the same).
 */
export const FAIRPLAY_LEGACY_KEY_SYSTEM = 'com.apple.fps.1_0';

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
    const clean = text.trim().replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
    return data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * The skd:// URI in an `encrypted` event's initData. Safari hands it over
 * as UTF-8 (initDataType "skd") or, in the older WebKit form, as UTF-16LE
 * after a 4-byte length; both are handled.
 */
export function skdFromInitData(data: ArrayBuffer | ArrayBufferView): string | null {
    const bytes = toBytes(data);
    const zeros = bytes.filter((b, i) => i % 2 === 1 && b === 0).length;
    const utf16 = bytes.length > 8 && zeros > bytes.length / 4;
    const text = utf16
        ? new TextDecoder('utf-16le').decode(bytes.subarray(bytes.length % 2))
        : new TextDecoder().decode(bytes);
    const match = /skd:\/\/[^\s\0"]+/.exec(text);
    return match ? match[0] : null;
}

/** The key server URL for an skd:// key URI (same host and path, https). */
export function licenseUrlFromSkd(skd: string): string | null {
    return skd.startsWith('skd://') ? `https://${skd.slice('skd://'.length)}` : null;
}

/** The first FairPlay key URI in a media playlist, if any. */
export function fairplayKeyUri(playlist: string): string | null {
    for (const line of playlist.split(/\r?\n/)) {
        if (!line.startsWith('#EXT-X-KEY:')) continue;
        const uri = /URI="(skd:\/\/[^"]+)"/.exec(line)?.[1];
        if (uri) return uri;
    }
    return null;
}

/**
 * The application certificate's DER bytes. Served as binary, or as base64
 * text by some key servers; DER always starts with 0x30 (SEQUENCE).
 */
export function certificateBytes(body: ArrayBuffer): Uint8Array {
    const bytes = new Uint8Array(body);
    if (bytes[0] === 0x30) return bytes;
    const text = new TextDecoder().decode(bytes).trim();
    if (/^[A-Za-z0-9+/=_-\s]+$/.test(text)) {
        try {
            const decoded = base64ToBytes(text.replace(/\s+/g, ''));
            if (decoded[0] === 0x30) return decoded;
        } catch {
            // not base64 after all
        }
    }
    return bytes;
}

/** JSON body for the key server, from the CDM's SPC message. */
export function spcRequestBody(message: ArrayBuffer | ArrayBufferView): string {
    return JSON.stringify({spc: bytesToBase64(toBytes(message))});
}

/** CKC bytes from the key server's answer: `{"ckc": …}`, `<ckc>…</ckc>` or bare base64. */
export function ckcFromResponse(text: string): Uint8Array {
    const body = text.trim();
    let encoded: string | null = null;
    if (body.startsWith('{')) {
        const json = JSON.parse(body) as {ckc?: unknown; CkcMessage?: unknown};
        const value = json.ckc ?? json.CkcMessage;
        if (typeof value !== 'string' || !value) throw new Error('no ckc in the response');
        encoded = value;
    } else {
        encoded = /<ckc>([^<]+)<\/ckc>/i.exec(body)?.[1] ?? body;
    }
    return base64ToBytes(encoded);
}

/** A MediaKeyStatusMap's key ids as hex. */
export function keyIdHex(id: ArrayBuffer | ArrayBufferView): string {
    return Array.from(toBytes(id), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The content id the legacy API wants: the skd:// URI's host (Apple's sample, Shaka). */
export function contentIdFromSkd(skd: string): string {
    return /^skd:\/\/([^/?#]+)/.exec(skd)?.[1] ?? skd.replace(/^skd:\/\//, '');
}

/**
 * Legacy init data: the needkey init data, then the content id (UTF-16LE)
 * and the certificate, each after a little-endian 32-bit length.
 */
export function legacyInitData(
    initData: Uint8Array,
    contentId: string,
    certificate: Uint8Array,
): Uint8Array {
    const id = new Uint8Array(contentId.length * 2);
    for (let i = 0; i < contentId.length; i++) {
        const code = contentId.charCodeAt(i);
        id[i * 2] = code & 0xff;
        id[i * 2 + 1] = code >> 8;
    }
    const out = new Uint8Array(initData.length + 4 + id.length + 4 + certificate.length);
    const view = new DataView(out.buffer);
    let offset = 0;
    out.set(initData, offset);
    offset += initData.length;
    view.setUint32(offset, id.length, true);
    offset += 4;
    out.set(id, offset);
    offset += id.length;
    view.setUint32(offset, certificate.length, true);
    offset += 4;
    out.set(certificate, offset);
    return out;
}
