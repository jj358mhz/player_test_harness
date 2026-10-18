// Small DOM helpers; the player has no UI framework.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Attrs = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2), value);
        } else if (key === 'class') {
            el.className = String(value);
        } else {
            el.setAttribute(key, value === true ? '' : String(value));
        }
    }
    append(el, children);
    return el;
}

export function append(el: Element, children: Child[]): void {
    for (const c of children) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : String(c));
    }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number>,
    parent?: Element,
): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    parent?.appendChild(el);
    return el;
}

export const clock = (d: Date): string =>
    d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});

export const kbps = (bps: number): string => `${Math.round(bps / 1000).toLocaleString()} k`;
export const mbps = (bps: number): string => `${(bps / 1e6).toFixed(2)} Mbps`;
export const secs = (s: number | null | undefined, digits = 1): string =>
    s === null || s === undefined || !Number.isFinite(s) ? '--' : s.toFixed(digits);

/** "720p" style label, using height. */
export const resLabel = (height: number): string => (height ? `${height}p` : '?');
