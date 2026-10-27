import {describe, expect, it} from 'vitest';
import {prettyXml} from '../src/lib/xml';

describe('prettyXml', () => {
    it('indents a one-line MPD', () => {
        const mpd =
            '<?xml version="1.0"?><MPD type="dynamic"><Period id="p0">' +
            '<BaseURL>https://example.com/</BaseURL><AdaptationSet>' +
            '<Representation id="A" bandwidth="1"/></AdaptationSet></Period></MPD>';
        expect(prettyXml(mpd)).toBe(
            [
                '<?xml version="1.0"?>',
                '<MPD type="dynamic">',
                '  <Period id="p0">',
                '    <BaseURL>https://example.com/</BaseURL>',
                '    <AdaptationSet>',
                '      <Representation id="A" bandwidth="1"/>',
                '    </AdaptationSet>',
                '  </Period>',
                '</MPD>',
            ].join('\n'),
        );
    });

    it('re-indents already formatted text and keeps comments and attributes', () => {
        const mpd = '<MPD>\n    <!-- note -->\n\t<Period a="x > y"\n  b="2">\n</Period>\n</MPD>\n';
        expect(prettyXml(mpd)).toBe(
            ['<MPD>', '  <!-- note -->', '  <Period a="x > y"\n  b="2"></Period>', '</MPD>'].join(
                '\n',
            ),
        );
    });

    it('keeps an Event body with its element', () => {
        expect(prettyXml('<EventStream><Event id="1">{"a":1}</Event></EventStream>')).toBe(
            '<EventStream>\n  <Event id="1">{"a":1}</Event>\n</EventStream>',
        );
    });
});
