// Latency bands (seconds): GOAT, Awesome, Good, Average, Yuk.

export type BandKey = 'goat' | 'awesome' | 'good' | 'average' | 'yuk';

export interface Band {
    key: BandKey;
    label: string;
    /** Upper bound in seconds (exclusive). */
    below: number;
}

export const BANDS: readonly Band[] = [
    {key: 'goat', label: 'GOAT', below: 10},
    {key: 'awesome', label: 'Awesome', below: 19},
    {key: 'good', label: 'Good', below: 25},
    {key: 'average', label: 'Average', below: 45},
    {key: 'yuk', label: 'Yuk', below: Number.POSITIVE_INFINITY},
];

export function bandFor(seconds: number): Band {
    // The last band is unbounded, so find always succeeds.
    return BANDS.find((b) => seconds < b.below) as Band;
}
