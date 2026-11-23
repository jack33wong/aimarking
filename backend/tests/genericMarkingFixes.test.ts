import { enrichAnnotationsWithPositions } from '../services/marking/AnnotationEnrichmentService.js';
import { SVGOverlayService } from '../services/marking/svgOverlayService.js';
import { ClassificationService } from '../services/marking/ClassificationService.js';
import { MarkingSchemeOrchestrationService } from '../services/marking/MarkingSchemeOrchestrationService.js';
import { questionDetectionService } from '../services/marking/questionDetectionService.js';

describe('Generic AI Marking & Annotation Placement Fixes', () => {
  describe('1. Same-line partial-credit cross preservation (applyPositiveDominance)', () => {
    const pageDims = new Map([[4, { width: 1650, height: 2339 }]]);
    const stepsData = [
      {
        line_id: 'p4_q10_line_1',
        globalBlockId: 'p4_ocr_13',
        pageIndex: 4,
        text: '11',
        bbox: [1000, 1600, 120, 50],
        unit: 'pixels',
        isHandwritten: true,
        subQuestionLabel: '10a'
      }
    ];

    it('preserves a 0-mark cross with distinct error reasoning alongside a tick on the same line (partial credit)', () => {
      const annotations: any[] = [
        {
          action: 'tick',
          text: 'B1',
          line_id: 'p4_q10_line_1',
          linked_ocr_id: 'p4_ocr_13',
          ocr_match_status: 'MATCHED',
          reasoning: 'Identifies 11 as a prime',
          subQuestion: '10a',
          pageIndex: 4,
          isPhysicalPage: true
        },
        {
          action: 'cross',
          text: 'B0',
          line_id: 'p4_q10_line_1',
          linked_ocr_id: 'p4_ocr_13',
          ocr_match_status: 'MATCHED',
          reasoning: 'Missing 13, 17, 19; Ans: 11, 13, 17, 19',
          subQuestion: '10a',
          pageIndex: 4,
          isPhysicalPage: true
        }
      ];

      const enriched = enrichAnnotationsWithPositions(annotations, stepsData, '10', 4, pageDims);
      expect(enriched).toHaveLength(2);
      expect(enriched.some(a => a.action === 'tick' && a.text === 'B1')).toBe(true);
      expect(enriched.some(a => a.action === 'cross' && a.text === 'B0')).toBe(true);
    });

    it('still hides strict duplicate codes and crosses without distinct reasoning on the same line', () => {
      const annotations: any[] = [
        {
          action: 'tick',
          text: 'B1',
          line_id: 'p4_q10_line_1',
          linked_ocr_id: 'p4_ocr_13',
          ocr_match_status: 'MATCHED',
          reasoning: 'Correct',
          subQuestion: '10a',
          pageIndex: 4,
          isPhysicalPage: true
        },
        {
          action: 'cross',
          text: 'B1',
          line_id: 'p4_q10_line_1',
          linked_ocr_id: 'p4_ocr_13',
          ocr_match_status: 'MATCHED',
          reasoning: 'Contradictory duplicate',
          subQuestion: '10a',
          pageIndex: 4,
          isPhysicalPage: true
        },
        {
          action: 'cross',
          text: 'B0',
          line_id: 'p4_q10_line_1',
          linked_ocr_id: 'p4_ocr_13',
          ocr_match_status: 'MATCHED',
          reasoning: '',
          subQuestion: '10a',
          pageIndex: 4,
          isPhysicalPage: true
        }
      ];

      const enriched = enrichAnnotationsWithPositions(annotations, stepsData, '10', 4, pageDims);
      expect(enriched).toHaveLength(1);
      expect(enriched[0].action).toBe('tick');
    });
  });

  describe('2. Neutral not_attempted pill must never snap onto another sub-question diagram', () => {
    it('keeps not_attempted on its own page and visual_position instead of teleporting to a drawing on another page', () => {
      const pageDims = new Map([
        [18, { width: 1875, height: 2500 }],
        [19, { width: 1875, height: 2500 }]
      ]);

      const stepsData = [
        {
          line_id: 'p18_visual_drawing_24_7',
          pageIndex: 18,
          text: '[DRAWING]',
          bbox: [394, 935, 900, 1100],
          unit: 'pixels',
          isHandwritten: true,
          subQuestionLabel: '24b'
        }
      ];

      const task: any = {
        questionNumber: '24',
        sourcePages: [19, 18],
        pageMap: { 19: 0, 18: 1 }
      };

      const annotations: any[] = [
        {
          action: 'tick',
          text: 'M1',
          line_id: 'p18_visual_drawing_24_7',
          ocr_match_status: 'VISUAL',
          linked_ocr_id: null,
          subQuestion: '24b',
          pageIndex: 1
        },
        {
          action: 'not_attempted',
          text: 'Not attempted',
          line_id: null,
          ocr_match_status: 'UNMATCHED',
          linked_ocr_id: null,
          subQuestion: '24c',
          pageIndex: 0,
          visual_position: { x: 60, y: 21, width: 10, height: 3 }
        }
      ];

      const enriched = enrichAnnotationsWithPositions(annotations, stepsData, '24', 19, pageDims, undefined, task);
      const pill = enriched.find(a => a.action === 'not_attempted');
      expect(pill).toBeDefined();
      expect(pill!.pageIndex).toBe(19);
      expect(pill!.bbox![0]).toBeGreaterThan(900); // ~60% of 1875
      expect(pill!.bbox![1]).toBeLessThan(700); // ~21% of 2500 (NOT 935!)
    });
  });

  describe('3. Contiguous multi-line expansion prevents comment jumping across sub-questions', () => {
    it('keeps sub-question (a) comment anchored near (a) instead of pulling it down to (b)', () => {
      const annotations: any[] = [
        {
          action: 'cross',
          text: 'B0',
          subQuestion: '15a',
          reasoning: 'Incorrect explanation; base angles not 63',
          bbox: [1450, 1050, 100, 45]
        },
        {
          action: 'cross',
          text: 'B0',
          subQuestion: '15b',
          reasoning: "Missing 'alternate angles'",
          bbox: [425, 2090, 200, 45]
        }
      ];

      const allPageStudentRects = [
        { x: 380, y: 980, w: 1000, h: 45 }, // 15a line 1
        { x: 380, y: 1045, w: 600, h: 45 }, // 15a line 2
        { x: 400, y: 2010, w: 1100, h: 45 }, // 15b line 1 (far below across diagram/table)
        { x: 400, y: 2085, w: 300, h: 45 }  // 15b line 2
      ];

      const svg = (SVGOverlayService as any).createSVGOverlay(
        annotations,
        1875,
        2500,
        { width: 1875, height: 2500 },
        undefined,
        undefined,
        false,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        allPageStudentRects
      ) as string;

      const match15a = svg.match(/<text[^>]*\sy="([^"]+)"[^>]*>Incorrect explanation[^<]*<\/text>/);
      expect(match15a).not.toBeNull();
      const y15a = Number(match15a![1]);
      // Must stay anchored near 15a (y ~ 1050), never pulled down to 15b (y ~ 2100)
      expect(y15a).toBeLessThan(1450);
    });
  });

  describe('4. Per-axis coordinate normalization in ClassificationService', () => {
    it('normalizes mixed-scale coordinates per axis without shrinking already-percentage axes by 10x', () => {
      const rawQuestions = [
        {
          questionNumber: '25',
          studentWorkLines: [
            // Mixed scale: x/width in 0-100, y/height in 0-1000
            { t: 'she is wrong', p: [68, 774, 26, 40] }
          ]
        },
        {
          questionNumber: '26',
          studentWorkLines: [
            // Mixed scale: x/width in 0-1000, y/height in 0-100
            { t: '376', p: [520, 70, 65, 4] }
          ]
        },
        {
          questionNumber: '1',
          studentWorkLines: [
            // Uniform 0-1000
            { t: '12', p: [680, 290, 80, 40] },
            // Uniform 0-100
            { t: '2.9', p: [65, 45, 10, 4] }
          ]
        }
      ];

      const parsed = (ClassificationService as any).parseQuestionsFromResponse({ questions: rawQuestions }, 0.9);
      const q25Line = parsed[0].studentWorkLines[0].position;
      expect(q25Line.x).toBeCloseTo(68, 1);
      expect(q25Line.width).toBeCloseTo(26, 1);
      expect(q25Line.y).toBeCloseTo(77.4, 1);
      expect(q25Line.height).toBeCloseTo(4, 1);

      const q26Line = parsed[1].studentWorkLines[0].position;
      expect(q26Line.x).toBeCloseTo(52, 1);
      expect(q26Line.width).toBeCloseTo(6.5, 1);
      expect(q26Line.y).toBeCloseTo(70, 1);
      expect(q26Line.height).toBeCloseTo(4, 1);

      const q1Uniform1000 = parsed[2].studentWorkLines[0].position;
      expect(q1Uniform1000).toEqual({ x: 68, y: 29, width: 8, height: 4 });

      const q1Uniform100 = parsed[2].studentWorkLines[1].position;
      expect(q1Uniform100).toEqual({ x: 65, y: 45, width: 10, height: 4 });
    });
  });

  describe('5. Generic Global Search fail-fast circuit breaker', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('caps Global Search lookups at 6 consecutive misses on a large non-DB paper', async () => {
      const detectSpy = jest.spyOn(questionDetectionService, 'detectQuestion').mockResolvedValue({
        found: false,
        message: 'No match',
        hintMetadata: {
          hintUsed: 'Global Search',
          matchedPapersCount: 222,
          thresholdRelaxed: false,
          deepSearchActive: true,
          poolSize: 5114,
          auditTrail: []
        }
      });

      const individualQuestions = Array.from({ length: 20 }, (_, i) => ({
        questionNumber: String(i + 1),
        text: `Sample practice question number ${i + 1} with unique wording`,
        sourceImageIndex: i
      }));

      const result = await MarkingSchemeOrchestrationService.orchestrateMarkingSchemeLookup(
        individualQuestions,
        { questions: individualQuestions },
        undefined
      );

      expect(detectSpy).toHaveBeenCalledTimes(6);
      expect(result.detectionStats.detected).toBe(0);
      expect(result.detectionStats.notDetected).toBe(20);
    });
  });
});
