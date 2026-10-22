import {describe, expect, it} from 'vitest';
import {describeTail, isoSeconds, mpdTail} from '../src/lib/mpdTail';

// Uplynk-shaped: content, then an ad Period whose video timeline is listed
// only as far as it has been published.
const period = (id: string, start: string, body: string, extra = '') => `
  <Period id="${id}" start="${start}"${extra}>${body}
    <AdaptationSet contentType="audio"><Representation id="m">
      <SegmentTemplate timescale="48000"><SegmentTimeline><S t="0" d="96000" r="2"/></SegmentTimeline></SegmentTemplate>
    </Representation></AdaptationSet>
    <AdaptationSet contentType="video"><Representation id="D">
      <SegmentTemplate timescale="90000" presentationTimeOffset="900000"><SegmentTimeline>
        <S t="900000" d="368640" r="2"/><S d="184320"/></SegmentTimeline></SegmentTemplate>
    </Representation></AdaptationSet>
  </Period>`;
const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
${period('4749.696000', 'PT4749.696S', '<AssetIdentifier schemeIdUri="urn:com:uplynk:ad-asset-id" value="aaaa1111bbbb"/>', ' duration="PT30.08S"')}
${period('4869.888000', 'PT4869.888S', '<AssetIdentifier schemeIdUri="urn:com:uplynk:ad-asset-id" value="fd7d27e8a60e"/>')}
</MPD>`;

describe('mpdTail', () => {
    it('reads the newest Periods and how far their video segments reach', () => {
        const [before, newest] = mpdTail(MPD);
        expect(before?.adAsset).toBe('aaaa1111bbbb');
        expect(before?.duration).toBeCloseTo(30.08);
        expect(newest?.start).toBeCloseTo(4869.888);
        expect(newest?.duration).toBeNull();
        // 3 × 4.096 s + 2.048 s = 14.336 s of video listed.
        expect(newest?.segments).toBe(4);
        expect(newest?.segmentsEnd).toBeCloseTo(4869.888 + 14.336);
    });

    it('says whether the playhead has run past what is listed', () => {
        const tail = mpdTail(MPD);
        expect(describeTail(tail, 4889.0)).toContain(
            'playhead is 4.8 s past the last listed segment',
        );
        expect(describeTail(tail, 4880.0)).toContain('run 4.2 s past the playhead');
        expect(describeTail(tail, 4889.0)).toContain(
            'newest: ad fd7d27e8… 4869.9–open s, 4 video segs',
        );
    });

    it('copes with nothing to read', () => {
        expect(mpdTail(null)).toEqual([]);
        expect(mpdTail('<MPD')).toEqual([]);
        expect(describeTail([], 1)).toBe('no Periods found in the MPD');
        expect(isoSeconds('PT1M0.5S')).toBeCloseTo(60.5);
    });
});
