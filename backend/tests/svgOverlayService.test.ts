import { SVGOverlayService } from '../services/marking/svgOverlayService.js';
import type { Annotation } from '../types/index.js';

describe('SVGOverlayService', () => {
  describe('mergeOverlappingAnnotations', () => {
    const merge = (annotations: Annotation[]) =>
      (SVGOverlayService as any).mergeOverlappingAnnotations(annotations, 1650, 2339) as Annotation[];

    it('sorts merged mark codes in UK examiner order (B -> P -> M -> C -> A) for A1 + M1', () => {
      const input: any[] = [
        { action: 'tick', text: 'A1', line_id: 'p0_q1a_line_3', bbox: [100, 300, 80, 40] },
        { action: 'tick', text: 'M1', line_id: 'p0_q1a_line_3', bbox: [100, 300, 80, 40] }
      ];

      const result = merge(input);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('M1 A1');
    });

    it('sorts A0 + M0 as M0 A0 and preserves diagnostic reasoning before ans:', () => {
      const input: any[] = [
        {
          action: 'cross',
          text: 'A0',
          line_id: 'p0_q2_line_12',
          reasoning: 'Ans: x = 16/9',
          bbox: [100, 1200, 80, 40]
        },
        {
          action: 'cross',
          text: 'M0',
          line_id: 'p0_q2_line_12',
          reasoning: 'Did not square u to find x',
          bbox: [100, 1200, 80, 40]
        }
      ];

      const result = merge(input);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('M0 A0');
      expect((result[0] as any).reasoning).toBe('Did not square u to find x; ans: x = 16/9');
    });

    it('orders full sequence B -> P -> M -> C -> A including dependent marks', () => {
      const input: any[] = [
        { action: 'tick', text: 'A1', line_id: 'l1', bbox: [0, 0, 10, 10] },
        { action: 'tick', text: 'C1', line_id: 'l1', bbox: [0, 0, 10, 10] },
        { action: 'tick', text: 'dM1', line_id: 'l1', bbox: [0, 0, 10, 10] },
        { action: 'tick', text: 'P1', line_id: 'l1', bbox: [0, 0, 10, 10] },
        { action: 'tick', text: 'B1', line_id: 'l1', bbox: [0, 0, 10, 10] }
      ];

      const result = merge(input);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('B1 P1 dM1 C1 A1');
    });

    it('does not merge annotations with different actions on the same line_id or without line_id', () => {
      const input: any[] = [
        { action: 'tick', text: 'M1', line_id: 'l1', bbox: [0, 0, 10, 10] },
        { action: 'cross', text: 'A0', line_id: 'l1', reasoning: 'Ans: 5', bbox: [0, 0, 10, 10] },
        { action: 'tick', text: 'B1', bbox: [0, 50, 10, 10] }
      ];

      const result = merge(input);
      expect(result).toHaveLength(3);
    });

    it('deduplicates identical or contained reasoning strings', () => {
      const mergeReasoning = (r1?: string, r2?: string) =>
        (SVGOverlayService as any).mergeReasoningStrings(r1, r2);

      expect(mergeReasoning('Missing units', 'missing units')).toBe('Missing units');
      expect(mergeReasoning('Wrong sign in quadratic; ans: x = 2', 'Wrong sign in quadratic')).toBe(
        'Wrong sign in quadratic; ans: x = 2'
      );
      expect(mergeReasoning(undefined, '  ')).toBeUndefined();
    });
  });

  describe('renderTeacherStyleReasoning non-crossing and placement', () => {
    it('prevents crossed leader lines between consecutive M0 and A0 lines in the middle of the page (Q1b)', () => {
      const actualWidth = 1650;
      const actualHeight = 2339;

      const m0Sym = { x: 1100, y: 1622, w: 90, h: 42 };
      const a0Sym = { x: 1100, y: 1685, w: 90, h: 42 };

      // Pre-occupy both symbol rects as PASS 1 does
      const occupiedRects = [
        { ...m0Sym },
        { ...a0Sym }
      ];

      const m0Item = {
        annotation: { action: 'cross', text: 'M0', bbox: [300, 1622, 500, 42] },
        symbolRect: m0Sym,
        studentRect: { x: 300, y: 1622, w: 500, h: 42 },
        reasoningText: 'Inside region not selected',
        color: '#e60000'
      };

      const a0Item = {
        annotation: { action: 'cross', text: 'A0', bbox: [300, 1685, 500, 42] },
        symbolRect: a0Sym,
        studentRect: { x: 300, y: 1685, w: 500, h: 42 },
        reasoningText: 'Ans: -1/2 < x < 4',
        color: '#e60000'
      };

      const studentWorkRects = [
        { x: 300, y: 1622, w: 500, h: 42 },
        { x: 300, y: 1685, w: 500, h: 42 }
      ];

      (SVGOverlayService as any).renderTeacherStyleReasoning(
        m0Item,
        actualWidth,
        actualHeight,
        occupiedRects,
        studentWorkRects,
        [],
        undefined,
        [a0Sym]
      );
      const m0Placed = occupiedRects[2];

      (SVGOverlayService as any).renderTeacherStyleReasoning(
        a0Item,
        actualWidth,
        actualHeight,
        occupiedRects,
        studentWorkRects,
        [],
        undefined,
        [m0Sym]
      );
      const a0Placed = occupiedRects[3];

      // M0 reasoning must NOT jump below A0 symbol
      expect(m0Placed.y).toBeLessThanOrEqual(a0Sym.y);
      // A0 reasoning must NOT jump above M0 symbol
      expect(a0Placed.y).toBeGreaterThanOrEqual(m0Sym.y + m0Sym.h);
      // Overall top-to-bottom order preserved (no X-crossing)
      expect(m0Placed.y).toBeLessThan(a0Placed.y);
    });

    it('places A0 reasoning above symbol when near the bottom of the page (> 80% height) and right side is unavailable', () => {
      const actualWidth = 1650;
      const actualHeight = 2339;
      const a0Sym = { x: 1500, y: 2050, w: 90, h: 42 }; // 2092 > 2339 * 0.80 = 1871.2, near right edge
      const occupiedRects = [{ ...a0Sym }];

      const a0Item = {
        annotation: { action: 'cross', text: 'A0', bbox: [300, 2050, 500, 42] },
        symbolRect: a0Sym,
        studentRect: { x: 300, y: 2050, w: 500, h: 42 },
        reasoningText: 'Ans: 42',
        color: '#e60000'
      };

      (SVGOverlayService as any).renderTeacherStyleReasoning(
        a0Item,
        actualWidth,
        actualHeight,
        occupiedRects,
        [{ x: 300, y: 2050, w: 500, h: 42 }],
        [],
        undefined,
        []
      );

      const a0Placed = occupiedRects[1];
      expect(a0Placed.y + a0Placed.h).toBeLessThanOrEqual(a0Sym.y);
    });

    it('produces valid SVG via createSVGOverlay with merged M0 A0', () => {
      const annotations: any[] = [
        {
          action: 'cross',
          text: 'A0',
          line_id: 'p0_q2_line_12',
          reasoning: 'Ans: x = 16/9',
          bbox: [200, 1200, 400, 40]
        },
        {
          action: 'cross',
          text: 'M0',
          line_id: 'p0_q2_line_12',
          reasoning: 'Did not square u to find x',
          bbox: [200, 1200, 400, 40]
        }
      ];

      const svg = (SVGOverlayService as any).createSVGOverlay(
        annotations,
        1650,
        2339,
        { width: 1650, height: 2339 }
      ) as string;

      expect(svg).toContain('M0 A0');
      expect(svg).toContain('Did not square u to find x; ans:');
      expect(svg).toContain('x = 16/9');
    });

    it('guards against crossing non-reasoning symbols (e.g. plain M1 tick) via allSymbolRects in createSVGOverlay', () => {
      const annotations: any[] = [
        {
          action: 'cross',
          text: 'M0',
          reasoning: 'Inside region not selected',
          bbox: [300, 1622, 500, 42]
        },
        {
          action: 'tick',
          text: 'M1',
          bbox: [300, 1685, 500, 42]
        }
      ];

      const svg = (SVGOverlayService as any).createSVGOverlay(
        annotations,
        1650,
        2339,
        { width: 1650, height: 2339 }
      ) as string;

      // Extract the y coordinate of the M0 reasoning text
      const match = svg.match(/<text[^>]*\sy="([^"]+)"[^>]*>Inside region[^<]*<\/text>/);
      expect(match).not.toBeNull();
      const reasoningY = Number(match![1]);
      // M0 reasoning should stay on/near M0's row (<= 1685), not jump below M1 at 1685
      expect(reasoningY).toBeLessThanOrEqual(1685);
    });

    it('burns SVG overlay end-to-end with InkDensityMap via burnSVGOverlayServerSide', async () => {
      const sharp = (await import('sharp')).default;
      const blankPng = await sharp({
        create: {
          width: 1650,
          height: 2339,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      })
        .png()
        .toBuffer();

      const dataUrl = `data:image/png;base64,${blankPng.toString('base64')}`;
      const annotations: any[] = [
        { action: 'tick', text: 'A1', line_id: 'p0_q1a_line_3', bbox: [200, 300, 400, 40] },
        { action: 'tick', text: 'M1', line_id: 'p0_q1a_line_3', bbox: [200, 300, 400, 40] },
        { action: 'cross', text: 'M0', line_id: 'p0_q1b_line_10', reasoning: 'Inside region not selected', bbox: [200, 1622, 500, 42] },
        { action: 'cross', text: 'A0', line_id: 'p0_q1b_line_11', reasoning: 'Ans: -1/2 < x < 4', bbox: [200, 1685, 500, 42] },
        { action: 'cross', text: 'A0', line_id: 'p0_q2_line_12', reasoning: 'Ans: x = 16/9', bbox: [200, 1200, 400, 40] },
        { action: 'cross', text: 'M0', line_id: 'p0_q2_line_12', reasoning: 'Did not square u to find x', bbox: [200, 1200, 400, 40] }
      ];

      const result = await SVGOverlayService.burnSVGOverlayServerSide(dataUrl, annotations, {
        width: 1650,
        height: 2339
      });
      expect(result).toMatch(/^data:image\/jpeg;base64,/);
      expect(result.length).toBeGreaterThan(1000);
    });
  });

  describe('createSymbolAnnotation reasoning budget & semicolon preservation', () => {
    const runCreateSymbol = (text: string, reasoning: string, symbol = '✗') => {
      const deferredReasonings: any[] = [];
      const occupiedRects: any[] = [];
      (SVGOverlayService as any).createSymbolAnnotation(
        { action: symbol === '✓' ? 'tick' : 'cross', text, reasoning, bbox: [200, 300, 400, 40] },
        200,
        300,
        400,
        40,
        symbol,
        text,
        reasoning,
        1650,
        2339,
        undefined,
        occupiedRects,
        deferredReasonings
      );
      return deferredReasonings[0]?.reasoningText as string | undefined;
    };

    it('gives merged badges (e.g. M0 A0) an 85-char / 14-word budget without chopping at semicolons', () => {
      // 81 chars, 13 words — exceeds 72-char single-badge limit, fits within 85-char merged-badge limit
      const reasoning81 = 'Used wrong formula for area; substituted radius instead of diameter at final step';
      expect(reasoning81.length).toBe(81);

      const mergedResult = runCreateSymbol('M0 A0', reasoning81);
      expect(mergedResult).toBe(reasoning81);
    });

    it('preserves semicolon-joined reasons on merged badges when truncating > 85 chars without ans:', () => {
      // 105 chars, 17 words, no period or '(' — enters else branch and slices up to 14 words / 85 chars without splitting on ';'
      const reasoning105 =
        'Used wrong formula for area; substituted radius instead of diameter into the volume expression at step 2';
      expect(reasoning105.length).toBeGreaterThan(85);

      const mergedResult = runCreateSymbol('M0 A0', reasoning105)!;
      expect(mergedResult).toContain(';');
      expect(mergedResult.length).toBeLessThanOrEqual(85);
      expect(mergedResult.split(/\s+/).length).toBeLessThanOrEqual(14);
      // Should keep more than 10 words (single-badge limit)
      expect(mergedResult.split(/\s+/).length).toBeGreaterThan(10);
    });

    it('keeps 72-char / 10-word ceiling for single-badge notes while not splitting on semicolons', () => {
      // 81 chars, 13 words — exceeds 72-char single-badge limit, so it truncates to <= 72 chars and <= 10 words
      const reasoning81 = 'Used wrong formula for area; substituted radius instead of diameter at final step';
      const singleResult = runCreateSymbol('M0', reasoning81)!;

      expect(singleResult.length).toBeLessThanOrEqual(72);
      expect(singleResult.split(/\s+/).length).toBeLessThanOrEqual(10);
      expect(singleResult).toContain(';');
    });

    it('keeps 62-char / 7-word ceiling for English AO badges even when badge text contains a space', () => {
      const reasoning = 'Perceptive analysis of structural shifts; strong textual evidence throughout the response';
      const aoResult = runCreateSymbol('[AO2 L3]', reasoning, '✓')!;

      expect(aoResult.length).toBeLessThanOrEqual(62);
      expect(aoResult.split(/\s+/).length).toBeLessThanOrEqual(7);
    });

    it('preserves both semicolon-joined clauses in firstClause when a sentence period follows later', () => {
      const reasoning =
        'Used wrong formula for area; substituted radius instead of diameter. Check the diagram carefully';
      const mergedResult = runCreateSymbol('M0 A0', reasoning)!;

      expect(mergedResult).toBe('Used wrong formula for area; substituted radius instead of diameter');
    });

    it('preserves full 81-char semicolon-joined reasoning end-to-end in createSVGOverlay for merged M0 A0', () => {
      const annotations: any[] = [
        {
          action: 'cross',
          text: 'A0',
          line_id: 'p0_q3_line_5',
          reasoning: 'substituted radius instead of diameter at final step',
          bbox: [200, 600, 420, 42]
        },
        {
          action: 'cross',
          text: 'M0',
          line_id: 'p0_q3_line_5',
          reasoning: 'Used wrong formula for area',
          bbox: [200, 600, 420, 42]
        }
      ];

      const svg = (SVGOverlayService as any).createSVGOverlay(annotations, 1650, 2339, { width: 1650, height: 2339 });
      expect(svg).toContain('M0 A0');
      const textContents = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]);
      const joinedText = textContents.join(' ');
      expect(joinedText).toContain('substituted radius instead of diameter at final step;');
      expect(joinedText).toContain('Used wrong formula for area');
    });
  });
});
