// Minimal ID3v2 frame parser for the metadata Uplynk puts in segments:
// TXXX frames carry the encoder wallclock, PRIV frames can carry SCTE-35.

export interface Id3Frame {
    id: string;
    data: Uint8Array;
}

export function parseId3(data: Uint8Array): Id3Frame[] {
    const frames: Id3Frame[] = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33 ? 10 : 0; // "ID3" header
    while (offset + 10 <= data.length && data[offset] !== 0) {
        const id = String.fromCharCode(...data.subarray(offset, offset + 4));
        const size = view.getUint32(offset + 4, false);
        frames.push({id, data: data.subarray(offset + 10, offset + 10 + size)});
        offset += 10 + size;
    }
    return frames;
}

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes).replace(/\0/g, '');

export interface Txxx {
    description: string;
    value: string;
    /** Parsed when the description names a time and the value is a date. */
    wallclock: Date | null;
}

export function parseTxxx(data: Uint8Array): Txxx {
    // byte 0 = text encoding; then description \0 value
    const end = data.indexOf(0, 1);
    if (end === -1) return {description: '', value: latin1(data.subarray(1)), wallclock: null};
    const description = latin1(data.subarray(1, end));
    const value = latin1(data.subarray(end + 1)).trim();
    return {description, value, wallclock: parseWallclock(description, value)};
}

function parseWallclock(description: string, value: string): Date | null {
    if (!/time|wallclock/i.test(description)) return null;
    // Uplynk sends ISO-8601 without a zone; treat it as UTC.
    const hasZone = /(Z|[+-]\d\d:?\d\d)$/.test(value);
    const date = new Date(hasZone ? value : `${value}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

export interface Priv {
    owner: string;
    data: Uint8Array;
    /** SCTE-35 sections start with table_id 0xFC. */
    isScte35: boolean;
}

export function parsePriv(data: Uint8Array): Priv {
    const end = data.indexOf(0);
    if (end === -1) return {owner: '', data, isScte35: false};
    const payload = data.subarray(end + 1);
    return {owner: latin1(data.subarray(0, end)), data: payload, isScte35: payload[0] === 0xfc};
}

export const toHex = (bytes: Uint8Array, max = 64): string =>
    Array.from(bytes.subarray(0, max), (b) => b.toString(16).padStart(2, '0')).join('') +
    (bytes.length > max ? '…' : '');
