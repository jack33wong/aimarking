import { SessionManagementService } from '../services/sessionManagementService.js';

describe('Performance Summary Tiering & Provenance', () => {
  it('skips LLM and builds a fast deterministic summary for 1-question uploads with marksLost & general source', async () => {
    const start = Date.now();
    const raw = await SessionManagementService.generateMasterPerformanceSummary(
      [
        {
          questionNumber: '1',
          score: { awardedMarks: 1, totalMarks: 3 },
          annotations: [
            { text: 'M1', action: 'tick', reasoning: 'Correctly found angle AOB = 140' },
            { text: '0', action: 'cross', reasoning: 'Apply isosceles triangle rules in circle theorems' }
          ]
        }
      ],
      'fast'
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed._type).toBe('AI_SUMMARY_V2');
    expect(parsed.markingSource).toEqual({ type: 'general', label: 'General Mark Scheme' });
    expect(parsed.radar).toEqual([]);
    expect(parsed.mastered).toEqual([]);
    expect(parsed.focusNext).toHaveLength(1);
    expect(parsed.focusNext[0].q).toBe('Q1');
    expect(parsed.focusNext[0].marksLost).toBe(2);
    expect(parsed.headline).toContain('isosceles triangle');
  });

  it('omits Focus Next on 100% score and preserves user-uploaded mark scheme filename', async () => {
    const raw = await SessionManagementService.generateMasterPerformanceSummary(
      [
        {
          questionNumber: '2',
          score: { awardedMarks: 4, totalMarks: 4 },
          annotations: [{ text: 'A1', action: 'tick', reasoning: 'Correct final answer' }]
        }
      ],
      'fast',
      undefined,
      undefined,
      undefined,
      undefined,
      { awardedMarks: 4, totalMarks: 4 },
      undefined,
      { type: 'user_uploaded', label: '9MA0_02_MS.pdf', fileName: '9MA0_02_MS.pdf' }
    );

    const parsed = JSON.parse(raw!);
    expect(parsed.focusNext).toEqual([]);
    expect(parsed.markingSource).toEqual({
      type: 'user_uploaded',
      label: '9MA0_02_MS.pdf',
      fileName: '9MA0_02_MS.pdf'
    });
    expect(parsed.headline).toContain('Full marks achieved');
  });

  it('tags official DB mark scheme provenance and official boundariesSource on 2-question official partial paper', async () => {
    const raw = await SessionManagementService.generateMasterPerformanceSummary(
      [
        { questionNumber: '1', score: { awardedMarks: 3, totalMarks: 3 }, annotations: [] },
        { questionNumber: '2', score: { awardedMarks: 1, totalMarks: 4 }, annotations: [] }
      ],
      'fast',
      undefined,
      'Partial Paper',
      '~Grade 6',
      { '9': 65, '8': 58, '7': 51 },
      { awardedMarks: 4, totalMarks: 7 },
      { examBoard: 'CIE', examCode: '0610/41', examSeries: 'May/June 2026', subject: 'Biology', tier: 'Higher' }
    );

    const parsed = JSON.parse(raw!);
    expect(parsed.markingSource).toEqual({
      type: 'official',
      label: 'CIE Biology 0610/41 (May/June 2026)'
    });
    expect(parsed.grading.boundariesSource).toBe('official');
    expect(parsed.questionBreakdown).toHaveLength(2);
    expect(parsed.focusNext).toHaveLength(1);
    expect(parsed.focusNext[0]).toMatchObject({ q: 'Q2', marksLost: 3 });
  });
});
