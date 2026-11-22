import sharp from 'sharp';
import { ImageUtils } from '../utils/ImageUtils.js';
import {
    sanitizePageLayout,
    type GeometryAnalysisResult
} from '../services/marking/ImageGeometryService.js';
import {
    resolveDocumentLayoutPolicy,
    formatUnsupportedLayoutMessage,
    formatPreInspectUnsupportedLayoutBanner,
    hasOneNotePrintoutSignature
} from '../services/marking/PreFlightRules.js';

function makeGeo(overrides: Partial<GeometryAnalysisResult> = {}): GeometryAnalysisResult {
    return {
        is_acceptable_quality: true,
        needs_rotation: 0,
        is_two_page_spread: false,
        page_layout: '1x1',
        is_marking_scheme: false,
        is_supported_doc: true,
        detected_subject: 'MATHS',
        ...overrides
    };
}

/** Creates a synthetic PNG Data URL with distinct colored quadrants or ink blocks for sharp tests. */
async function createSyntheticImage(
    width: number,
    height: number,
    drawPixel: (x: number, y: number) => [number, number, number]
): Promise<string> {
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = drawPixel(x, y);
            const idx = (y * width + x) * 3;
            raw[idx] = r;
            raw[idx + 1] = g;
            raw[idx + 2] = b;
        }
    }
    const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
}

async function getMeanColor(dataUrl: string): Promise<{ r: number; g: number; b: number }> {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    const stats = await sharp(buf).stats();
    return {
        r: Math.round(stats.channels[0].mean),
        g: Math.round(stats.channels[1].mean),
        b: Math.round(stats.channels[2].mean)
    };
}

describe('Generic Symmetric Grid Splitting (1x2, 2x1, 2x2) & Smart Gutter', () => {
    test('splits 1x2 landscape image into [Left, Right] in reading order', async () => {
        const img = await createSyntheticImage(200, 100, (x) =>
            x < 100 ? [20, 20, 200] : [200, 20, 20]
        );
        const tiles = await ImageUtils.splitImageGrid(img, 1, 2);
        expect(tiles).toHaveLength(2);
        expect(tiles[0].width + tiles[1].width).toBe(200);
        expect(tiles[0].height).toBe(100);
        expect((await getMeanColor(tiles[0].imageData)).b).toBeGreaterThan(150);
        expect((await getMeanColor(tiles[1].imageData)).r).toBeGreaterThan(150);
    });

    test('splits 2x1 stacked portrait image into [Top, Bottom] in reading order', async () => {
        const img = await createSyntheticImage(120, 240, (_x, y) =>
            y < 120 ? [20, 180, 20] : [180, 20, 180]
        );
        const tiles = await ImageUtils.splitImageGrid(img, 2, 1);
        expect(tiles).toHaveLength(2);
        expect(tiles[0].height + tiles[1].height).toBe(240);
        expect(tiles[0].width).toBe(120);
        expect((await getMeanColor(tiles[0].imageData)).g).toBeGreaterThan(140);
        expect((await getMeanColor(tiles[1].imageData)).r).toBeGreaterThan(140);
    });

    test('splits 2x2 4-up grid into [TL, TR, BL, BR] in row-major reading order', async () => {
        const img = await createSyntheticImage(200, 200, (x, y) => {
            if (y < 100 && x < 100) return [220, 20, 20];   // TL: Red
            if (y < 100 && x >= 100) return [20, 220, 20];  // TR: Green
            if (y >= 100 && x < 100) return [20, 20, 220];  // BL: Blue
            return [220, 220, 20];                          // BR: Yellow
        });
        const tiles = await ImageUtils.splitImageGrid(img, 2, 2);
        expect(tiles).toHaveLength(4);
        const [tl, tr, bl, br] = await Promise.all(tiles.map(t => getMeanColor(t.imageData)));
        expect(tl.r).toBeGreaterThan(180);
        expect(tr.g).toBeGreaterThan(180);
        expect(bl.b).toBeGreaterThan(180);
        expect(br.r).toBeGreaterThan(180);
        expect(br.g).toBeGreaterThan(180);
    });

    test('refines horizontal cut within ±8% to land on white gutter instead of dark text line at exact 50%', async () => {
        // Dark horizontal ink band at y=98..102 (right on exact 50% of 200px height), pure white gutter at y=108..112
        const img = await createSyntheticImage(160, 200, (_x, y) => {
            if (y >= 98 && y <= 102) return [10, 10, 10];
            if (y >= 108 && y <= 112) return [255, 255, 255];
            return [220, 220, 220];
        });
        const tiles = await ImageUtils.splitImageGrid(img, 2, 1);
        expect(tiles).toHaveLength(2);
        // Cut should move away from dark band y=100 into the white gutter around y=108..112
        expect(tiles[0].height).toBeGreaterThanOrEqual(106);
        expect(tiles[0].height).toBeLessThanOrEqual(114);
    });
});

describe('Asymmetric Canvas Whitespace Detection (OneNote Printout)', () => {
    test('detects OneNote-style left-half exam column with blank right-half whitespace', async () => {
        const oneNoteImg = await createSyntheticImage(200, 280, (x, y) => {
            // Exam page content occupies x=10..85, right half x>=110 is pure white
            if (x >= 10 && x <= 85 && (y % 8 < 2 || x === 10 || x === 85)) {
                return [30, 30, 30];
            }
            return [255, 255, 255];
        });
        const res = await ImageUtils.detectAsymmetricCanvasWhitespace(oneNoteImg);
        expect(res.isAsymmetricCanvas).toBe(true);
        expect(res.leftInkRatio).toBeGreaterThan(0.05);
        expect(res.rightInkRatio).toBeLessThan(0.005);
    });

    test('does NOT flag a normal full-width exam page as asymmetric canvas', async () => {
        const normalExam = await createSyntheticImage(200, 280, (x, y) => {
            if (x >= 15 && x <= 185 && y % 12 < 2) {
                return [40, 40, 40];
            }
            return [255, 255, 255];
        });
        const res = await ImageUtils.detectAsymmetricCanvasWhitespace(normalExam);
        expect(res.isAsymmetricCanvas).toBe(false);
    });
});

describe('sanitizePageLayout & resolveDocumentLayoutPolicy (Zero False Alarms)', () => {
    test('sanitizePageLayout downgrades 1x2 on portrait image to 1x1 and preserves backward compatibility', () => {
        expect(sanitizePageLayout({ rawPageLayout: '1x2', rawIsTwoPageSpread: true, isPhysicallyLandscape: false }))
            .toEqual({ pageLayout: '1x1', isTwoPageSpread: false });
        expect(sanitizePageLayout({ rawPageLayout: '1x2', rawIsTwoPageSpread: true, isPhysicallyLandscape: true }))
            .toEqual({ pageLayout: '1x2', isTwoPageSpread: true });
        expect(sanitizePageLayout({ rawPageLayout: undefined, rawIsTwoPageSpread: true, isPhysicallyLandscape: true }))
            .toEqual({ pageLayout: '1x2', isTwoPageSpread: true });
        expect(sanitizePageLayout({ rawPageLayout: '2x2', rawIsTwoPageSpread: false, isPhysicallyLandscape: false }))
            .toEqual({ pageLayout: '2x2', isTwoPageSpread: false });
    });

    test('NO FALSE ALARM: isolated 1-page unsupported_canvas or 2x1 hallucination in a 10-page normal exam is ignored', () => {
        const pages = Array.from({ length: 10 }, () => ({ width: 1200, height: 1600 }));
        const geos = Array.from({ length: 10 }, (_, idx) => {
            if (idx === 3) return makeGeo({ page_layout: 'unsupported_canvas' });
            if (idx === 6) return makeGeo({ page_layout: '2x1' });
            return makeGeo({ page_layout: '1x1' });
        });
        const policy = resolveDocumentLayoutPolicy({ pages, geometryResults: geos });
        expect(policy.shouldRejectUnsupportedLayout).toBe(false);
        expect(policy.effectivePageLayouts.every(l => l === '1x1')).toBe(true);
    });

    test('NO FALSE ALARM: single-page upload flagged unsupported_canvas WITHOUT pixel/OneNote corroboration is NOT rejected', () => {
        const policy = resolveDocumentLayoutPolicy({
            pages: [{ width: 1200, height: 1600 }],
            geometryResults: [makeGeo({ page_layout: 'unsupported_canvas' })],
            asymmetricCanvasFlags: [false],
            hasExplicitOneNoteCoverOrFooter: false
        });
        expect(policy.shouldRejectUnsupportedLayout).toBe(false);
        expect(policy.effectivePageLayouts).toEqual(['1x1']);
    });

    test('REJECTS OneNote Printout PDF with Page 1 signature + asymmetric whitespace', () => {
        const pages = Array.from({ length: 14 }, () => ({ width: 1200, height: 1600 }));
        const geos = pages.map((_, idx) =>
            idx === 0
                ? makeGeo({
                    detected_subject: 'NON_ACADEMIC',
                    is_supported_doc: false,
                    evidence_text_snippet: 'Printout 21 November 2026 17:53 New Section 1 Page 1'
                })
                : makeGeo({ page_layout: 'unsupported_canvas' })
        );
        expect(hasOneNotePrintoutSignature(geos[0].evidence_text_snippet)).toBe(true);
        const policy = resolveDocumentLayoutPolicy({
            pages,
            geometryResults: geos,
            asymmetricCanvasFlags: pages.map((_, idx) => idx > 0),
            hasExplicitOneNoteCoverOrFooter: true
        });
        expect(policy.shouldRejectUnsupportedLayout).toBe(true);
        expect(formatUnsupportedLayoutMessage(true)).toContain('Upload Corrected File');
        expect(formatUnsupportedLayoutMessage(true)).toContain('OneNote');
    });

    test('REJECTS 3-page Pre-Inspect sample (Page 0 OneNote Printout + 2 asymmetric content pages) even if flash-lite returns 1x1 or 2x1', () => {
        const sampledPages = [
            { width: 793, height: 1122 },
            { width: 793, height: 1122 },
            { width: 793, height: 1122 }
        ];
        const sampledGeos = [
            makeGeo({
                detected_subject: 'NON_ACADEMIC',
                is_supported_doc: false,
                evidence_text_snippet: 'Printout 21 November 2026 17:53 New Section 1 Page 1'
            }),
            makeGeo({ page_layout: '2x1' }),
            makeGeo({ page_layout: '1x1' })
        ];
        const policy = resolveDocumentLayoutPolicy({
            pages: sampledPages,
            geometryResults: sampledGeos,
            asymmetricCanvasFlags: [false, true, true]
        });
        expect(policy.shouldRejectUnsupportedLayout).toBe(true);
        expect(policy.isOneNoteDetected).toBe(true);
    });

    test('ALLOWS symmetric 2x1 and 2x2 batches with majority sweep', () => {
        const pages = Array.from({ length: 4 }, () => ({ width: 1200, height: 1600 }));
        const geos2x1 = [
            makeGeo({ page_layout: '2x1' }),
            makeGeo({ page_layout: '2x1' }),
            makeGeo({ page_layout: '2x1' }),
            makeGeo({ page_layout: '1x1' }) // Missed by preFlight, swept by majority 2x1 batch
        ];
        const policy2x1 = resolveDocumentLayoutPolicy({ pages, geometryResults: geos2x1 });
        expect(policy2x1.shouldRejectUnsupportedLayout).toBe(false);
        expect(policy2x1.effectivePageLayouts).toEqual(['2x1', '2x1', '2x1', '2x1']);

        const geos2x2 = [
            makeGeo({ page_layout: '2x2' }),
            makeGeo({ page_layout: '2x2' }),
            makeGeo({ page_layout: '2x2' }),
            makeGeo({ page_layout: '1x1' })
        ];
        const policy2x2 = resolveDocumentLayoutPolicy({ pages, geometryResults: geos2x2 });
        expect(policy2x2.shouldRejectUnsupportedLayout).toBe(false);
        expect(policy2x2.effectivePageLayouts).toEqual(['2x2', '2x2', '2x2', '2x2']);
    });
});
