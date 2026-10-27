// Pretty-print XML (the MPD in the Manifest tab) for reading.
//
// Uplynk serves the MPD on one line. This re-indents it without parsing
// into a DOM: tags, comments, CDATA and processing instructions are kept
// byte for byte, whitespace-only text between tags is dropped, and an
// element holding only text stays on one line (`<BaseURL>…</BaseURL>`).
// Text that isn't well-formed still comes out, just less tidy.

const TOKEN =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g;

export function prettyXml(text: string, indent = '  '): string {
    const tokens = text.match(TOKEN) ?? [];
    const lines: string[] = [];
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i] ?? '';
        if (!tok.startsWith('<')) {
            const t = tok.trim();
            if (t) lines.push(indent.repeat(depth) + t);
            continue;
        }
        if (tok.startsWith('</')) {
            depth = Math.max(0, depth - 1);
            lines.push(indent.repeat(depth) + tok);
            continue;
        }
        const special = tok.startsWith('<!') || tok.startsWith('<?');
        if (special || tok.endsWith('/>')) {
            lines.push(indent.repeat(depth) + tok);
            continue;
        }
        // <a>text</a> on one line.
        const next = tokens[i + 1];
        const close = tokens[i + 2];
        if (next && !next.startsWith('<') && close?.startsWith('</')) {
            lines.push(indent.repeat(depth) + tok + next.trim() + close);
            i += 2;
            continue;
        }
        lines.push(indent.repeat(depth) + tok);
        depth++;
    }
    return lines.join('\n');
}
