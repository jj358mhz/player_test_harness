// Running min/avg/max since load, and a fixed-size series for charts.

export class RunningStats {
    count = 0;
    private sum = 0;
    min = Number.POSITIVE_INFINITY;
    max = Number.NEGATIVE_INFINITY;
    minAt: Date | null = null;
    maxAt: Date | null = null;
    last: number | null = null;

    add(value: number, at: Date = new Date()): void {
        this.count += 1;
        this.sum += value;
        this.last = value;
        if (value < this.min) {
            this.min = value;
            this.minAt = at;
        }
        if (value > this.max) {
            this.max = value;
            this.maxAt = at;
        }
    }

    get average(): number | null {
        return this.count ? this.sum / this.count : null;
    }

    reset(): void {
        Object.assign(this, new RunningStats());
    }
}

export interface Point {
    t: number; // ms since epoch
    v: number;
}

/** Keeps points from the last `windowMs`. */
export class Series {
    readonly points: Point[] = [];

    constructor(readonly windowMs: number) {}

    push(v: number, t: number = Date.now()): void {
        this.points.push({t, v});
        const cutoff = t - this.windowMs;
        while (this.points.length && (this.points[0] as Point).t < cutoff) this.points.shift();
    }

    clear(): void {
        this.points.length = 0;
    }
}
