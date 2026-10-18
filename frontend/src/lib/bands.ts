// Latency bands carried over from the original player.

export type BandKey = 'awesome' | 'good' | 'average' | 'above' | 'yuk';

export interface Band {
    key: BandKey;
    label: string;
    /** Upper bound in seconds (exclusive). */
    below: number;
}

export const BANDS: readonly Band[] = [
    {key: 'awesome', label: 'Awesome', below: 10},
    {key: 'good', label: 'Good', below: 19},
    {key: 'average', label: 'Average', below: 25},
    {key: 'above', label: 'Above avg', below: 40},
    {key: 'yuk', label: 'Yuk', below: Number.POSITIVE_INFINITY},
];

export function bandFor(seconds: number): Band {
    // The last band is unbounded, so find always succeeds.
    return BANDS.find((b) => seconds < b.below) as Band;
}
