import {
  parseMarkingScope,
  applyScopeAndBlankPageHandling
} from '../services/marking/MarkingScopeUtils.js';
import { calculateOverallScore, extractQuestionsFromClassification } from '../services/marking/MarkingHelpers.js';
import {
  buildUnattemptedQuestionResult,
  normalizeUnattemptedSubQuestionAnnotations,
  executeMarkingForQuestion
} from '../services/marking/MarkingExecutor.js';
import { AnnotationLinker } from '../services/marking/core/AnnotationLinker.js';
import { enrichAnnotationsWithPositions } from '../services/marking/AnnotationEnrichmentService.js';
import { SVGOverlayService } from '../services/marking/svgOverlayService.js';
import markingSchemePrompt from '../config/prompts/marking_scheme_system_prompt.js';
import { UNIVERSAL_BYOMS_MARKING_SYSTEM_PROMPT } from '../config/prompts/universal_byoms_marking_prompt.js';
import markingBasicPrompt from '../config/prompts/marking_basic_system_prompt.js';
import markingFallbackPrompt from '../config/prompts/marking_fallback_system_prompt.js';

describe('1. Scope-Aware Blank Question Page Handling', () => {
  it('parses explicit page and question scopes from Student Input', () => {
    expect(parseMarkingScope('only mark to page 8')).toEqual({
      type: 'pages',
      minPage: 1,
      maxPage: 8,
      label: 'Pages 1–8'
    });

    expect(parseMarkingScope('Please mark Q1-Q12')).toEqual({
      type: 'questions',
      minQuestion: 1,
      maxQuestion: 12,
      label: 'Q1–Q12'
    });

    expect(parseMarkingScope('mark pages 3 to 7')).toEqual({
      type: 'pages',
      minPage: 3,
      maxPage: 7,
      label: 'Pages 3–7'
    });

    expect(parseMarkingScope('only mark Q3, Q5, Q7')).toEqual({
      type: 'questions',
      questionNumbers: new Set([3, 5, 7]),
      label: 'Q3, Q5, Q7'
    });

    // Paper codes or generic input without scope cues return null
    expect(parseMarkingScope('Edexcel 1MA1/1F June 2023')).toBeNull();
    expect(parseMarkingScope('')).toBeNull();
    expect(parseMarkingScope(undefined)).toBeNull();
  });

  it('unscoped partial paper keeps blank mapped question pages in Marking Mode (never [PIPELINE-META])', () => {
    const allClassificationResults: any[] = [
      { pageIndex: 0, result: { category: 'frontPage', questions: [] } },
      { pageIndex: 1, result: { category: 'questionAnswer', questions: [{ questionNumber: '1', studentWork: '2+2=4' }] } },
      { pageIndex: 2, result: { category: 'questionOnly', questions: [{ questionNumber: '2', text: 'Find x' }] } },
      { pageIndex: 3, result: { category: 'questionOnly', questions: [] } } // genuine blank filler page
    ];

    const { excludedPageIndices, preservedBlankQuestionPageIndices } = applyScopeAndBlankPageHandling({
      allClassificationResults,
      markingScope: null,
      hasAnyStudentWork: true,
      ejectedPureReferenceFiles: false
    });

    expect(excludedPageIndices).toEqual([]);
    expect(preservedBlankQuestionPageIndices).toEqual([2]);
    // Page 2 stays in Marking Mode with isUnattempted=true
    expect(allClassificationResults[2].result.category).toBe('questionAnswer');
    expect(allClassificationResults[2].result.questions).toHaveLength(1);
    expect(allClassificationResults[2].result.questions[0].isUnattempted).toBe(true);
    // Page 3 (no mapped questions) safely becomes metadata
    expect(allClassificationResults[3].result.category).toBe('metadata');
  });

  it('scoped partial paper excludes out-of-scope pages and labels overallScoreText with scope', () => {
    const scope = parseMarkingScope('only mark to page 8')!;
    const allClassificationResults: any[] = Array.from({ length: 10 }, (_, idx) => ({
      pageIndex: idx,
      result: {
        category: idx < 8 ? 'questionAnswer' : 'questionOnly',
        questions: [{ questionNumber: String(idx + 1), text: `Question ${idx + 1}` }]
      }
    }));

    const { excludedPageIndices } = applyScopeAndBlankPageHandling({
      allClassificationResults,
      markingScope: scope,
      hasAnyStudentWork: true,
      ejectedPureReferenceFiles: false
    });

    // Pages 9 and 10 (0-based indices 8, 9) are excluded
    expect(excludedPageIndices).toEqual([8, 9]);
    expect(allClassificationResults[8].result.category).toBe('metadata');
    expect(allClassificationResults[8].result._excludedByScope).toBe(true);
    expect(allClassificationResults[8].result.questions).toEqual([]);
    expect(allClassificationResults[7].result.category).toBe('questionAnswer');

    const mockResults: any[] = [
      { questionNumber: '1', score: { awardedMarks: 14, totalMarks: 20 } },
      { questionNumber: '2', score: { awardedMarks: 12, totalMarks: 18 } }
    ];
    const overall = calculateOverallScore(mockResults, scope.label);
    expect(overall.overallScoreText).toBe('26/38 (Pages 1–8)');
  });

  it('100% blank paper preserves questionOnly routing without promoting to Marking Mode', () => {
    const allClassificationResults: any[] = [
      { pageIndex: 0, result: { category: 'questionOnly', questions: [{ questionNumber: '1', text: 'Solve x' }] } },
      { pageIndex: 1, result: { category: 'questionOnly', questions: [{ questionNumber: '2', text: 'Solve y' }] } }
    ];

    const { preservedBlankQuestionPageIndices } = applyScopeAndBlankPageHandling({
      allClassificationResults,
      markingScope: null,
      hasAnyStudentWork: false,
      ejectedPureReferenceFiles: false
    });

    expect(preservedBlankQuestionPageIndices).toEqual([]);
    expect(allClassificationResults.every(r => r.result.category === 'questionOnly')).toBe(true);
  });
});

describe('2. Neutral UX for Unattempted Questions', () => {
  it('buildUnattemptedQuestionResult short-circuits to 0/max with neutral not_attempted pill and no cross', () => {
    const task: any = {
      questionNumber: '15',
      sourcePages: [10],
      pageDimensions: new Map([[10, { width: 1650, height: 2339 }]]),
      markingScheme: {
        totalMarks: 5,
        subQuestionMaxScores: { '15a': 2, '15b': 3 }
      }
    };
    const zones = {
      '15a': [{ pageIndex: 10, x: 150, startY: 300, width: 1200, endY: 700 }],
      '15b': [{ pageIndex: 10, x: 150, startY: 800, width: 1200, endY: 1200 }]
    };

    const res = buildUnattemptedQuestionResult(task, zones, 5);
    expect(res.score.awardedMarks).toBe(0);
    expect(res.score.totalMarks).toBe(5);
    expect(res.score.scoreText).toBe('0/5');
    expect(res.annotations).toHaveLength(2);
    expect(res.annotations.every((a: any) => a.action === 'not_attempted' && a.isUnattempted)).toBe(true);
    expect((res.annotations[0] as any).scoreBadgeText).toBe('0/2');
    expect((res.annotations[1] as any).scoreBadgeText).toBe('0/3');

    const svg = (SVGOverlayService as any).createSVGOverlay(
      res.annotations,
      1650,
      2339,
      { width: 1650, height: 2339 },
      [{ scoreText: '0/5' }]
    ) as string;

    expect(svg).toContain('Not attempted');
    expect(svg).toContain('0/2');
    expect(svg).toContain('0/5');
    expect(svg).not.toContain('✗');
  });

  it('normalizeUnattemptedSubQuestionAnnotations converts blank sub-question crosses into neutral pills', () => {
    const rawAnnos: any[] = [
      { action: 'tick', text: 'M1', subQuestion: '5a', pageIndex: 2, bbox: [200, 400, 300, 40] },
      { action: 'cross', text: 'M0', subQuestion: '5b', pageIndex: 2, reasoning: 'Not attempted', bbox: [0, 0, 0, 0] },
      { action: 'cross', text: 'A0', subQuestion: '5b', pageIndex: 2, reasoning: 'No attempt', bbox: [0, 0, 0, 0] }
    ];
    const stepsData = [
      { line_id: 'p2_q5_line_1', subQuestionLabel: '5a', text: '2x = 10' }
    ];
    const zones = {
      '5b': [{ pageIndex: 2, x: 150, startY: 900, width: 1200, endY: 1300 }]
    };
    const scheme = { totalMarks: 4, subQuestionMaxScores: { '5a': 2, '5b': 2 } };
    const dims = new Map([[2, { width: 1650, height: 2339 }]]);

    const normalized = normalizeUnattemptedSubQuestionAnnotations(rawAnnos, stepsData, zones, scheme, dims, 2);
    expect(normalized).toHaveLength(2);
    expect(normalized[0].action).toBe('tick');
    expect(normalized[1].action).toBe('not_attempted');
    expect(normalized[1].text).toBe('Not attempted');
    expect(normalized[1].scoreBadgeText).toBe('0/2');
  });
});

describe('3. PATH 3 Right-Edge Recovery, Shared line_id Stacking & VISUAL Diagram Anchoring', () => {
  it('PATH 3 anchors UNMATCHED lines to box.x + box.width + padding (never box center)', () => {
    const annotations: any[] = [
      {
        action: 'tick',
        text: 'M1',
        subQuestion: '3a',
        line_id: 'p0_q3_line_1',
        ocr_match_status: 'UNMATCHED',
        pageIndex: 0
      }
    ];
    const stepsData = [
      {
        line_id: 'p0_q3_line_1',
        pageIndex: 0,
        text: '3x + 5 = 20',
        bbox: [10, 30, 25, 4], // percentage: x=10, w=25 -> right edge = 35
        unit: 'percentage',
        isHandwritten: true
      }
    ];

    const out = AnnotationLinker.postProcess(annotations, stepsData, { questionNumber: '3', sourcePages: [0] }, {});
    // Must be to the right of box.x + box.width (35), NOT center (22.5)
    expect(out[0].visual_position.x).toBeGreaterThan(35);
    expect(out[0]._path3Recovered).toBe(true);
  });

  it('horizontally stacks marks targeting the same line_id with different actions without overlap', () => {
    const annotations: any[] = [
      { action: 'tick', text: 'M1', line_id: 'p0_q4_line_2', bbox: [200, 600, 300, 42] },
      { action: 'cross', text: 'A0', line_id: 'p0_q4_line_2', bbox: [200, 600, 300, 42] }
    ];

    const svg = (SVGOverlayService as any).createSVGOverlay(
      annotations,
      1650,
      2339,
      { width: 1650, height: 2339 }
    ) as string;

    const tickX = Number(svg.match(/<text x="([^"]+)"[^>]*>✓<\/text>/)![1]);
    const crossX = Number(svg.match(/<text x="([^"]+)"[^>]*>✗<\/text>/)![1]);
    // Cross must be placed strictly to the right of the tick + M1 badge
    expect(crossX).toBeGreaterThan(tickX + 80);
  });

  it('anchors VISUAL annotations to the diagram bounding box rather than nearby arithmetic working', () => {
    const annotations: any[] = [
      {
        action: 'tick',
        text: 'B1',
        subQuestion: '6a',
        line_id: 'p0_ocr_arith',
        linked_ocr_id: 'p0_ocr_arith',
        ocr_match_status: 'VISUAL',
        pageIndex: 0
      }
    ];
    const combinedBlocks: any[] = [
      {
        line_id: 'p0_ocr_arith',
        pageIndex: 0,
        text: '4 × 5 = 20',
        bbox: [150, 200, 220, 40],
        unit: 'pixels',
        isHandwritten: true
      },
      {
        line_id: 'p0_visual_drawing_6_1',
        pageIndex: 0,
        subQuestionLabel: '6a',
        text: '[DRAWING]',
        bbox: [20, 45, 50, 30], // percentage -> x=330, y=1052.55, w=825, h=701.7
        unit: 'percentage',
        isHandwritten: true
      }
    ];

    const enriched = enrichAnnotationsWithPositions(
      annotations,
      combinedBlocks,
      '6',
      0,
      new Map([[0, { width: 1650, height: 2339 }]])
    );

    expect(enriched[0].bbox[0]).toBeCloseTo(330, 0);
    expect(enriched[0].bbox[1]).toBeCloseTo(1052.55, 0);
    expect(enriched[0].bbox[2]).toBeCloseTo(825, 0);
  });
});

describe('4. Margin Clamping, Cover-Page Offset & Row-End Anchoring', () => {
  it('clamps all symbol X coordinates inside pageWidth * 0.90', () => {
    const annotations: any[] = [
      { action: 'tick', text: 'M1 A1', bbox: [1300, 500, 280, 42] } // right edge = 1580 > 1485
    ];

    const svg = (SVGOverlayService as any).createSVGOverlay(
      annotations,
      1650,
      2339,
      { width: 1650, height: 2339 }
    ) as string;

    const tickX = Number(svg.match(/<text x="([^"]+)"[^>]*>✓<\/text>/)![1]);
    expect(tickX).toBeLessThan(1650 * 0.90);
  });

  it('offsets cover-page total score upward and leftward away from candidate info box border', () => {
    const svg = (SVGOverlayService as any).createSVGOverlay(
      [],
      1650,
      2339,
      { width: 1650, height: 2339 },
      undefined,
      '68/80',
      true // cover/meta page
    ) as string;

    const match = svg.match(/<text x="([^"]+)" y="([^"]+)"[^>]*>68\/80<\/text>/);
    expect(match).not.toBeNull();
    const x = Number(match![1]);
    const y = Number(match![2]);
    // Leftward of 90% width (away from right border) and high in the header
    expect(x).toBeLessThanOrEqual(Math.round(1650 * 0.90));
    expect(y).toBeLessThan(130);
  });

  it('anchors tick/cross to the rightmost student work block sharing the same horizontal y-band', () => {
    const annotations: any[] = [
      { action: 'tick', text: 'M1', bbox: [200, 700, 160, 40] } // left block ends at 360
    ];
    const allPageStudentRects = [
      { x: 200, y: 700, w: 160, h: 40 },
      { x: 400, y: 704, w: 280, h: 38 } // rightmost block on same y-band ends at 680
    ];

    const svg = (SVGOverlayService as any).createSVGOverlay(
      annotations,
      1650,
      2339,
      { width: 1650, height: 2339 },
      undefined,
      undefined,
      false,
      [],
      false,
      undefined,
      undefined,
      undefined,
      allPageStudentRects
    ) as string;

    const tickX = Number(svg.match(/<text x="([^"]+)"[^>]*>✓<\/text>/)![1]);
    // Must anchor to the right of 680 (rightmost block), NOT 360
    expect(tickX).toBeGreaterThanOrEqual(680);
  });
});

describe('5. Annotation Comment Readability', () => {
  it('renders comments at 1.2%-1.4% page height, on rgba(255, 255, 255, 0.88) pill, wrapped within <= 30% page width', () => {
    const actualWidth = 1650;
    const actualHeight = 2339;
    const annotations: any[] = [
      {
        action: 'cross',
        text: 'A0',
        reasoning: 'Divide by 1000 to convert grams to kilograms; Ans: 56',
        bbox: [200, 900, 400, 42]
      }
    ];

    const svg = (SVGOverlayService as any).createSVGOverlay(
      annotations,
      actualWidth,
      actualHeight,
      { width: actualWidth, height: actualHeight }
    ) as string;

    // White semi-transparent pill backdrop
    const pillMatch = svg.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" rx="[^"]+" fill="rgba\(255, 255, 255, 0\.88\)" \/>/);
    expect(pillMatch).not.toBeNull();
    const pillX = Number(pillMatch![1]);
    const pillW = Number(pillMatch![3]);
    expect(pillW).toBeLessThanOrEqual(Math.round(actualWidth * 0.30));
    expect(pillX + pillW).toBeLessThanOrEqual(Math.round(actualWidth * 0.90));

    // Font size within 1.2%–1.4% of page height
    const textFontMatch = svg.match(/font-size="(\d+)" font-weight="bold">Divide by 1000/);
    expect(textFontMatch).not.toBeNull();
    const fontSize = Number(textFontMatch![1]);
    const pctHeight = fontSize / actualHeight;
    expect(pctHeight).toBeGreaterThanOrEqual(0.012);
    expect(pctHeight).toBeLessThanOrEqual(0.0141);
  });
});

describe('6. Marking Prompt Comment Rules', () => {
  it('all marking system prompts enforce Missing: for omitted steps and reason + Ans: for standalone A0', () => {
    const rawPrompts: any[] = [
      markingSchemePrompt(false),
      markingSchemePrompt(true),
      UNIVERSAL_BYOMS_MARKING_SYSTEM_PROMPT('Mathematics'),
      markingBasicPrompt,
      markingFallbackPrompt
    ];
    const prompts: string[] = rawPrompts.map(p => (typeof p === 'function' ? p() : p));

    for (const prompt of prompts) {
      expect(prompt).toContain('Missing:');
      expect(prompt).toContain('Divide by 1000; Ans: 56');
      expect(prompt).toContain('not_attempted');
    }
  });
});

describe('7. Blank Trailing Stubs (Q22-Q24) & Shared-Page Blank Short-Circuit (Q13)', () => {
  it('extractQuestionsFromClassification preserves isUnattempted blank question stubs with empty text', () => {
    const classification = {
      questions: [
        { questionNumber: '21', text: 'Solve equation', studentWork: 'x = 2', sourceImageIndex: 19 },
        { questionNumber: '22', text: '', studentWork: '', sourceImageIndex: 20, isUnattempted: true },
        { questionNumber: '23', text: '', studentWork: '', sourceImageIndex: 21, isUnattempted: true },
        { questionNumber: '24', text: '', studentWork: '', sourceImageIndex: 22, isUnattempted: true }
      ]
    };

    const extracted = extractQuestionsFromClassification(classification);
    expect(extracted.map(q => q.questionNumber)).toEqual(['21', '22', '23', '24']);
  });

  it('executeMarkingForQuestion short-circuits blank Q13 to 0/3 even when sibling Q12 has handwritten OCR on the same page', async () => {
    const task: any = {
      questionNumber: '13',
      questionText: 'Prove that the sum of any two consecutive triangular numbers is a square number.',
      sourcePages: [12],
      pageDimensions: new Map([[12, { width: 1650, height: 2339 }]]),
      classificationStudentWork: "Student's Work:\n",
      aiSegmentationResults: [],
      // Sibling Q12 handwritten OCR block is at y=400 (outside Q13's zone [1150..2100])
      mathBlocks: [
        { text: 'x^3 - 3x^2 - 13x - 15', isHandwritten: true, pageIndex: 12, coordinates: { x: 200, y: 400, width: 400, height: 40 } }
      ],
      semanticZones: {
        '13': [{ pageIndex: 12, x: 150, startY: 1150, width: 1300, endY: 2100 }]
      },
      markingScheme: {
        totalMarks: 3,
        questionNumber: '13'
      }
    };

    const mockRes = { write: () => {}, flush: () => {} };
    const result = await executeMarkingForQuestion(task, mockRes, 'sub-test-q13', 'fast');
    expect(result.score.awardedMarks).toBe(0);
    expect(result.score.totalMarks).toBe(3);
    expect(result.score.scoreText).toBe('0/3');
    expect(result.usageTokens).toBe(0);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0].action).toBe('not_attempted');
  });
});
