import {
  HandwritingQualityService,
  buildHandwritingOcrLinks
} from '../services/marking/HandwritingQualityService.js';
import { SessionManagementService } from '../services/sessionManagementService.js';

describe('HandwritingQualityService (LLM ID-linked, zero spatial matching)', () => {
  it('builds ID-linked pairs directly from Marking LLM line_id and linked_ocr_id', () => {
    const ocrTextForPrompt = [
      '[SUB-QUESTION 1b]',
      '[ID: p0_q1_line_2] - each casts are independent',
      '[ID: p0_q1_line_3] \\mathbb{P}(\\text{catching a fish}) \\text{ is constant}',
      '[ID: p0_q1_line_4] \\mathbb{P}(X=3) = (0.2)(1-0.2)^2'
    ].join('\n');

    const rawOcrBlocks = [
      { id: 'p0_ocr_27', text: 'b) - each custs are independent', mathpixConfidenceRate: 0.89, isPrinted: false },
      { id: 'p0_ocr_29', text: 'IPl castching a tigh) is con itant', mathpixConfidenceRate: 0.74, isPrinted: false }
    ];

    const rawAnnotations = [
      { action: 'tick', line_id: 'p0_q1_line_2', linked_ocr_id: 'p0_ocr_27', ocr_match_status: 'MATCHED', subQuestion: '1b', pageIndex: 2 },
      { action: 'tick', line_id: 'p0_q1_line_3', linked_ocr_id: 'p0_ocr_29', ocr_match_status: 'MATCHED', subQuestion: '1b', pageIndex: 2 },
      { action: 'tick', line_id: 'p0_q1_line_4', linked_ocr_id: null, ocr_match_status: 'UNMATCHED', subQuestion: '1ci', pageIndex: 3 }
    ];

    const links = buildHandwritingOcrLinks(rawAnnotations, ocrTextForPrompt, rawOcrBlocks);
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({
      lineId: 'p0_q1_line_2',
      linkedOcrId: 'p0_ocr_27',
      ocrText: 'b) - each custs are independent',
      ocrMatchStatus: 'MATCHED',
      confidenceRate: 0.89,
      subQuestion: '1b',
      pageIndex: 2
    });
    expect(links[1]).toMatchObject({
      lineId: 'p0_q1_line_3',
      linkedOcrId: 'p0_ocr_29',
      ocrText: 'IPl castching a tigh) is con itant',
      ocrMatchStatus: 'MATCHED',
      confidenceRate: 0.74
    });
    expect(links[2]).toMatchObject({
      lineId: 'p0_q1_line_4',
      ocrMatchStatus: 'UNMATCHED'
    });
  });

  it('rates clean matched handwriting as Clear with no issues', () => {
    const analysis = HandwritingQualityService.analyze([
      {
        questionNumber: '1',
        score: { awardedMarks: 4, totalMarks: 4 },
        handwritingOcrLinks: [
          { lineId: 'p0_q1_line_1', classificationText: 'x = 5', linkedOcrId: 'p0_ocr_1', ocrText: 'x = 5', ocrMatchStatus: 'MATCHED', confidenceRate: 0.97, isPrinted: false },
          { lineId: 'p0_q1_line_2', classificationText: 'y = 12', linkedOcrId: 'p0_ocr_2', ocrText: 'y = 12', ocrMatchStatus: 'MATCHED', confidenceRate: 0.95, isPrinted: false }
        ]
      }
    ]);

    expect(analysis).not.toBeNull();
    expect(analysis!.summary.rating).toBe('clear');
    expect(analysis!.summary.label).toBe('Clear');
    expect(analysis!.summary.issues).toEqual([]);
    expect(analysis!.summary.isTyped).toBeUndefined();
  });

  it('detects Fair/Needs Care and surfaces Mathpix vs Classification mismatches on LLM-linked pairs', () => {
    const analysis = HandwritingQualityService.analyze([
      {
        questionNumber: '1',
        score: { awardedMarks: 4, totalMarks: 4 },
        handwritingOcrLinks: [
          { lineId: 'p0_q1_line_1', classificationText: 'x = 5', linkedOcrId: 'p0_ocr_1', ocrText: 'x = 5', ocrMatchStatus: 'MATCHED', confidenceRate: 0.96, isPrinted: false }
        ]
      },
      {
        questionNumber: '6',
        score: { awardedMarks: 2, totalMarks: 8 },
        handwritingOcrLinks: [
          { lineId: 'p0_q6_line_1', classificationText: 'alkene', linkedOcrId: 'p0_ocr_7', ocrText: 'alkane', ocrMatchStatus: 'MATCHED', confidenceRate: 0.74, isPrinted: false, isWrongStep: true, subQuestion: '6c', pageIndex: 6 }
        ]
      }
    ]);

    expect(analysis).not.toBeNull();
    expect(analysis!.summary.rating).toBe('fair');
    expect(analysis!.summary.label).toBe('Fair');
    expect(analysis!.summary.issues).toHaveLength(1);
    expect(analysis!.summary.issues[0]).toMatchObject({
      q: '6',
      subQ: '6c',
      pageIndex: 6,
      ocrText: 'alkane',
      intendedText: 'alkene'
    });

    const promptBlock = HandwritingQualityService.formatForSummaryPrompt(analysis);
    expect(promptBlock).toContain('HANDWRITING OCR SIGNALS');
    expect(promptBlock).toContain('Q6c');
    expect(promptBlock).toContain('alkane');
    expect(promptBlock).toContain('alkene');
  });

  it('marks uniformly printed high-confidence submissions as isTyped', () => {
    const analysis = HandwritingQualityService.analyze([
      {
        questionNumber: '1',
        score: { awardedMarks: 3, totalMarks: 3 },
        handwritingOcrLinks: [
          { lineId: 'p0_q1_line_1', classificationText: '2x + 1 = 7', linkedOcrId: 'p0_ocr_1', ocrText: '2x + 1 = 7', ocrMatchStatus: 'MATCHED', confidenceRate: 0.999, isPrinted: true }
        ]
      }
    ]);

    expect(analysis).not.toBeNull();
    expect(analysis!.summary.isTyped).toBe(true);
    expect(HandwritingQualityService.formatForSummaryPrompt(analysis)).toBe('');
  });

  it('attaches handwriting summary on the fast deterministic 1-question summary path', async () => {
    const analysis = HandwritingQualityService.analyze([
      {
        questionNumber: '1',
        score: { awardedMarks: 1, totalMarks: 3 },
        handwritingOcrLinks: [
          { lineId: 'p0_q1_line_1', classificationText: '5x + 2', linkedOcrId: 'p0_ocr_1', ocrText: 'Sx + z', ocrMatchStatus: 'MATCHED', confidenceRate: 0.65, isPrinted: false, isWrongStep: true }
        ]
      }
    ]);

    const raw = await SessionManagementService.generateMasterPerformanceSummary(
      [{ questionNumber: '1', score: { awardedMarks: 1, totalMarks: 3 }, annotations: [] }],
      'fast',
      undefined,
      undefined,
      undefined,
      undefined,
      { awardedMarks: 1, totalMarks: 3 },
      undefined,
      undefined,
      analysis
    );

    const parsed = JSON.parse(raw!);
    expect(parsed.handwriting).toBeDefined();
    expect(parsed.handwriting.rating).toBe('needs_care');
    expect(parsed.handwriting.issues[0]).toMatchObject({ q: '1', ocrText: 'Sx + z', intendedText: '5x + 2' });
  });

  it('ignores stray single-superscript OCR artifacts like 0.28^2 vs 0.28 on high-confidence correct steps', () => {
    const analysis = HandwritingQualityService.analyze([
      {
        questionNumber: '3',
        score: { awardedMarks: 15, totalMarks: 15 },
        handwritingOcrLinks: [
          {
            lineId: 'p3_q3_line_31',
            classificationText: '= \\frac{0.28}{1 - 0.54}',
            linkedOcrId: 'p3_ocr_8',
            ocrText: '=\\frac{0.28^{2}}{1-0.54}',
            ocrMatchStatus: 'MATCHED',
            confidenceRate: 0.94,
            isPrinted: false,
            isWrongStep: false,
            subQuestion: '3iva',
            pageIndex: 8
          }
        ]
      }
    ]);

    expect(analysis).not.toBeNull();
    expect(analysis!.summary.rating).toBe('clear');
    expect(analysis!.summary.issues).toEqual([]);
  });
});
