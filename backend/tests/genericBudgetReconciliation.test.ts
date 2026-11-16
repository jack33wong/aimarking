import { MarkingPromptService } from '../services/marking/MarkingPromptService.js';
import { recoverGenericTotalMarks } from '../services/marking/MarkingPipelineService.js';

describe('Generic Mode Partial Sub-Question Budget & Guillotine Score Reconciliation', () => {
  it('omits [MAX SCORE] in prompt header when hasIncompleteSubQuestionBudgets is true', () => {
    const prompt = MarkingPromptService.formatMarkingSchemeForPrompt({
      questionNumber: '2',
      marks: [],
      totalMarks: 4,
      isGeneric: true,
      hasIncompleteSubQuestionBudgets: true,
      subQuestionNumbers: ['2i', '2ii', '2iii'],
      subQuestionMaxScores: { '2i': 4 }
    } as any);

    expect(prompt).toContain('[GENERIC_GCSE_LOGIC]');
    expect(prompt).not.toContain('[GENERIC_GCSE_LOGIC] [MAX SCORE: 4]');
    expect(prompt).toContain('[2i] [MAX SCORE: 4]');
    expect(prompt).toContain('[2ii] — Determine max marks');
  });

  it('reconciles awardedMarks and totalMarks to 15/15 on concise multi-mark generic questions with 0 crosses', () => {
    const task: any = {
      questionNumber: '2',
      markingScheme: {
        isGeneric: true,
        hasIncompleteSubQuestionBudgets: true,
        totalMarks: 0,
        parentQuestionMarks: 0
      }
    };
    const result: any = {
      score: {
        awardedMarks: 9,
        totalMarks: 15,
        scoreText: '9/15'
      }
    };
    const finalizedAnnotations = Array.from({ length: 9 }, () => ({
      action: 'tick',
      text: 'M1'
    }));

    recoverGenericTotalMarks({
      task,
      result,
      finalizedAnnotations,
      newAwarded: 9,
      aiStatedTotalMarks: 15,
      isGenericScheme: true,
      hasIncompleteBudgets: true,
      aiReportedTotalMarks: 15,
      aiReportedAwardedMarks: 15
    });

    expect(result.score.totalMarks).toBe(15);
    expect(result.score.awardedMarks).toBe(15);
    expect(task.markingScheme.totalMarks).toBe(15);
    expect(task.markingScheme.parentQuestionMarks).toBe(15);
  });

  it('respects explicit cross/zero-mark annotations when reconciling awardedMarks', () => {
    const task: any = {
      questionNumber: '3',
      markingScheme: {
        isGeneric: true,
        hasIncompleteSubQuestionBudgets: true,
        totalMarks: 10,
        parentQuestionMarks: 10
      }
    };
    const result: any = {
      score: {
        awardedMarks: 10,
        totalMarks: 15
      }
    };
    const finalizedAnnotations = [
      ...Array.from({ length: 10 }, () => ({ action: 'tick', text: 'M1' })),
      { action: 'cross', text: 'A0' },
      { action: 'cross', text: 'M0' }
    ];

    recoverGenericTotalMarks({
      task,
      result,
      finalizedAnnotations,
      newAwarded: 10,
      aiStatedTotalMarks: 15,
      isGenericScheme: true,
      hasIncompleteBudgets: true,
      aiReportedTotalMarks: 15,
      aiReportedAwardedMarks: 14
    });

    expect(result.score.totalMarks).toBe(15);
    expect(result.score.awardedMarks).toBe(13);
  });
});
