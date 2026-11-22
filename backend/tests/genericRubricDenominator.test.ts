import { ScoreAuditor } from '../services/marking/core/ScoreAuditor.js';
import { MarkingResultParser } from '../services/marking/MarkingResultParser.js';
import { recoverGenericTotalMarks } from '../services/marking/MarkingPipelineService.js';
import {
  calculateOverallScore,
  calculateQuestionFirstPageScores,
  calculatePerPageScores
} from '../services/marking/MarkingHelpers.js';

describe('Generic Rubric Mode Denominator Preservation (totalMarks vs annotation count)', () => {
  it('1. Single blank question: meta.question_total_marks = 4, 1 not_attempted annotation -> 0/4 (not 0/1)', () => {
    const scheme = { isGeneric: true, questionNumber: '8', totalMarks: 0 };
    const annotations = [
      { action: 'not_attempted', text: 'Not attempted', isUnattempted: true, subQuestion: '8', pageIndex: 2 }
    ];
    const meta = { question_total_marks: 4 };
    const studentScore = { awardedMarks: 0, totalMarks: 4, scoreText: '0/4' };

    const parsed = MarkingResultParser.postProcessMarkingResponse(
      { annotations: [...annotations], studentScore: { ...studentScore }, meta },
      scheme as any,
      {},
      '8'
    );
    expect(parsed.studentScore).toEqual({ awardedMarks: 0, totalMarks: 4, scoreText: '0/4' });

    const reconciled = ScoreAuditor.reconcilePointBasedScore({
      enrichedAnnotations: annotations,
      scheme,
      studentScore: parsed.studentScore,
      meta
    });
    expect(reconciled.awardedMarks).toBe(0);
    expect(reconciled.totalMarks).toBe(4);
    expect(reconciled.scoreText).toBe('0/4');

    const task: any = { questionNumber: '8', markingScheme: { ...scheme } };
    const result: any = {
      score: { awardedMarks: reconciled.awardedMarks, totalMarks: reconciled.totalMarks, scoreText: reconciled.scoreText },
      meta
    };
    recoverGenericTotalMarks({
      task,
      result,
      finalizedAnnotations: reconciled.annotations,
      newAwarded: 0,
      aiStatedTotalMarks: 4,
      isGenericScheme: true,
      hasIncompleteBudgets: true,
      aiReportedTotalMarks: 4,
      aiReportedAwardedMarks: 0
    });
    expect(result.score.awardedMarks).toBe(0);
    expect(result.score.totalMarks).toBe(4);
    expect(result.totalMarks).toBe(4);
  });

  it('2. Multi-part blank question: meta.question_total_marks = 5, 2 not_attempted annotations -> 0/5 (not 0/2)', () => {
    const scheme = { isGeneric: true, questionNumber: '24', totalMarks: 0 };
    const annotations = [
      { action: 'not_attempted', text: 'Not attempted', isUnattempted: true, subQuestion: '24a', pageIndex: 8 },
      { action: 'not_attempted', text: 'Not attempted', isUnattempted: true, subQuestion: '24b', pageIndex: 8 }
    ];
    const meta = { question_total_marks: 5 };
    const studentScore = { awardedMarks: 0, totalMarks: 5, scoreText: '0/5' };

    const reconciled = ScoreAuditor.reconcilePointBasedScore({
      enrichedAnnotations: annotations,
      scheme,
      studentScore,
      meta
    });
    expect(reconciled.awardedMarks).toBe(0);
    expect(reconciled.totalMarks).toBe(5);
    expect(reconciled.scoreText).toBe('0/5');

    const task: any = { questionNumber: '24', markingScheme: { ...scheme } };
    const result: any = {
      score: { awardedMarks: reconciled.awardedMarks, totalMarks: reconciled.totalMarks, scoreText: reconciled.scoreText },
      meta
    };
    recoverGenericTotalMarks({
      task,
      result,
      finalizedAnnotations: reconciled.annotations,
      newAwarded: 0,
      aiStatedTotalMarks: 5,
      isGenericScheme: true,
      hasIncompleteBudgets: true,
      aiReportedTotalMarks: 5,
      aiReportedAwardedMarks: 0
    });
    expect(result.score.awardedMarks).toBe(0);
    expect(result.score.totalMarks).toBe(5);
  });

  it('3. Wrong attempted question: meta.question_total_marks = 3, 2 crosses (M0, A0) -> 0/3 (not 0/2)', () => {
    const scheme = { isGeneric: true, questionNumber: '9', totalMarks: 0 };
    const annotations = [
      { action: 'cross', text: 'M0', subQuestion: '9', pageIndex: 3 },
      { action: 'cross', text: 'A0', subQuestion: '9', pageIndex: 3 }
    ];
    const meta = { question_total_marks: 3 };
    const studentScore = { awardedMarks: 0, totalMarks: 3, scoreText: '0/3' };

    const reconciled = ScoreAuditor.reconcilePointBasedScore({
      enrichedAnnotations: annotations,
      scheme,
      studentScore,
      meta
    });
    expect(reconciled.awardedMarks).toBe(0);
    expect(reconciled.totalMarks).toBe(3);
    expect(reconciled.scoreText).toBe('0/3');

    const task: any = { questionNumber: '9', markingScheme: { ...scheme } };
    const result: any = {
      score: { awardedMarks: reconciled.awardedMarks, totalMarks: reconciled.totalMarks, scoreText: reconciled.scoreText },
      meta
    };
    recoverGenericTotalMarks({
      task,
      result,
      finalizedAnnotations: reconciled.annotations,
      newAwarded: 0,
      aiStatedTotalMarks: 3,
      isGenericScheme: true,
      hasIncompleteBudgets: true,
      aiReportedTotalMarks: 3,
      aiReportedAwardedMarks: 0
    });
    expect(result.score.awardedMarks).toBe(0);
    expect(result.score.totalMarks).toBe(3);
  });

  it('4. Partially correct question: meta.question_total_marks = 4, 3 annotations (M1, M1, A0) -> 2/4 (not 2/3)', () => {
    const scheme = { isGeneric: true, questionNumber: '12', totalMarks: 0 };
    const annotations = [
      { action: 'tick', text: 'M1', subQuestion: '12', pageIndex: 4 },
      { action: 'tick', text: 'M1', subQuestion: '12', pageIndex: 4 },
      { action: 'cross', text: 'A0', subQuestion: '12', pageIndex: 4 }
    ];
    const meta = { question_total_marks: 4 };
    const studentScore = { awardedMarks: 2, totalMarks: 4, scoreText: '2/4' };

    const reconciled = ScoreAuditor.reconcilePointBasedScore({
      enrichedAnnotations: annotations,
      scheme,
      studentScore,
      meta
    });
    expect(reconciled.awardedMarks).toBe(2);
    expect(reconciled.totalMarks).toBe(4);
    expect(reconciled.scoreText).toBe('2/4');

    const task: any = { questionNumber: '12', markingScheme: { ...scheme } };
    const result: any = {
      score: { awardedMarks: reconciled.awardedMarks, totalMarks: reconciled.totalMarks, scoreText: reconciled.scoreText },
      meta
    };
    recoverGenericTotalMarks({
      task,
      result,
      finalizedAnnotations: reconciled.annotations,
      newAwarded: 2,
      aiStatedTotalMarks: 4,
      isGenericScheme: true,
      hasIncompleteBudgets: true,
      aiReportedTotalMarks: 4,
      aiReportedAwardedMarks: 2
    });
    expect(result.score.awardedMarks).toBe(2);
    expect(result.score.totalMarks).toBe(4);
  });

  it('5. Official mark scheme regression check: official DB / BYOMS papers still use official scheme totalMarks', () => {
    const officialScheme = {
      isGeneric: false,
      questionNumber: '5',
      totalMarks: 6,
      subQuestionMaxScores: { '5a': 2, '5b': 4 }
    };
    const annotations = [
      { action: 'tick', text: 'M1', subQuestion: '5a', pageIndex: 1 },
      { action: 'cross', text: 'A0', subQuestion: '5a', pageIndex: 1 },
      { action: 'tick', text: 'M1', subQuestion: '5b', pageIndex: 1 },
      { action: 'tick', text: 'A1', subQuestion: '5b', pageIndex: 1 }
    ];
    // Even if AI meta/studentScore disagrees with the official scheme
    const meta = { question_total_marks: 4 };
    const studentScore = { awardedMarks: 3, totalMarks: 4, scoreText: '3/4' };

    const reconciled = ScoreAuditor.reconcilePointBasedScore({
      enrichedAnnotations: annotations,
      scheme: officialScheme,
      studentScore,
      meta
    });
    expect(reconciled.awardedMarks).toBe(3);
    expect(reconciled.totalMarks).toBe(6);
    expect(reconciled.scoreText).toBe('3/6');
    expect(reconciled._authoritativeGenericScore).toBeUndefined();

    const task: any = { questionNumber: '5', markingScheme: { ...officialScheme } };
    const result: any = {
      score: { awardedMarks: 3, totalMarks: 6, scoreText: '3/6' },
      meta
    };
    recoverGenericTotalMarks({
      task,
      result,
      finalizedAnnotations: reconciled.annotations,
      newAwarded: 3,
      aiStatedTotalMarks: 4,
      isGenericScheme: false,
      hasIncompleteBudgets: false,
      aiReportedTotalMarks: 4,
      aiReportedAwardedMarks: 3
    });
    expect(result.score.awardedMarks).toBe(3);
    expect(result.score.totalMarks).toBe(6);
  });

  it('falls back to studentScore.totalMarks when meta.question_total_marks is missing, and to annotation count only when both are missing/<=0', () => {
    const scheme = { isGeneric: true, questionNumber: '7', totalMarks: 0 };
    const annotations = [
      { action: 'cross', text: 'M0', subQuestion: '7', pageIndex: 1 },
      { action: 'cross', text: 'A0', subQuestion: '7', pageIndex: 1 }
    ];

    // Fallback to studentScore.totalMarks when meta is missing
    const fromStudentScore = ScoreAuditor.reconcilePointBasedScore({
      enrichedAnnotations: annotations,
      scheme,
      studentScore: { awardedMarks: 0, totalMarks: 4, scoreText: '0/4' },
      meta: undefined
    });
    expect(fromStudentScore.totalMarks).toBe(4);
    expect(fromStudentScore.scoreText).toBe('0/4');

    // Fallback to Math.max(awardedMarks, annotations.length) when both meta and studentScore.totalMarks are missing/0
    const fromFallback = ScoreAuditor.reconcilePointBasedScore({
      enrichedAnnotations: annotations,
      scheme,
      studentScore: { awardedMarks: 0, totalMarks: 0, scoreText: '0/0' },
      meta: {}
    });
    expect(fromFallback.totalMarks).toBe(2);
    expect(fromFallback.scoreText).toBe('0/2');
  });

  it('clamps awardedMarks to <= totalMarks when ticks exceed authoritative totalMarks in Generic Mode', () => {
    const scheme = { isGeneric: true, questionNumber: '11', totalMarks: 0 };
    const annotations = [
      { action: 'tick', text: 'M1', subQuestion: '11', pageIndex: 3 },
      { action: 'tick', text: 'M1', subQuestion: '11', pageIndex: 3 },
      { action: 'tick', text: 'M1', subQuestion: '11', pageIndex: 3 },
      { action: 'tick', text: 'A1', subQuestion: '11', pageIndex: 3 }
    ];
    const reconciled = ScoreAuditor.reconcilePointBasedScore({
      enrichedAnnotations: annotations,
      scheme,
      studentScore: { awardedMarks: 4, totalMarks: 3 },
      meta: { question_total_marks: 3 }
    });
    expect(reconciled.totalMarks).toBe(3);
    expect(reconciled.awardedMarks).toBe(3);
    expect(reconciled.scoreText).toBe('3/3');
  });

  it('propagates preserved totalMarks identically to page-level badges and overall paper total', () => {
    const q9: any = {
      questionNumber: '9',
      pageIndex: 3,
      score: { awardedMarks: 0, totalMarks: 3, scoreText: '0/3', _authoritativeGenericScore: true },
      awardedMarks: 0,
      totalMarks: 3,
      markingScheme: JSON.stringify({ isGeneric: true, totalMarks: 0 }),
      annotations: [
        { action: 'cross', text: 'M0', pageIndex: 3 },
        { action: 'cross', text: 'A0', pageIndex: 3 }
      ]
    };
    const q10: any = {
      questionNumber: '10',
      pageIndex: 3,
      score: { awardedMarks: 4, totalMarks: 4, scoreText: '4/4', _authoritativeGenericScore: true },
      awardedMarks: 4,
      totalMarks: 4,
      markingScheme: JSON.stringify({ isGeneric: true, totalMarks: 0 }),
      annotations: [
        { action: 'tick', text: 'M1', pageIndex: 3 },
        { action: 'tick', text: 'M1', pageIndex: 3 },
        { action: 'tick', text: 'A1', pageIndex: 3 },
        { action: 'tick', text: 'A1', pageIndex: 3 }
      ]
    };
    const q24: any = {
      questionNumber: '24',
      pageIndex: 8,
      score: { awardedMarks: 0, totalMarks: 5, scoreText: '0/5', _authoritativeGenericScore: true },
      awardedMarks: 0,
      totalMarks: 5,
      markingScheme: JSON.stringify({ isGeneric: true, totalMarks: 0 }),
      annotations: [
        { action: 'not_attempted', text: 'Not attempted', isUnattempted: true, subQuestion: '24a', pageIndex: 8 },
        { action: 'not_attempted', text: 'Not attempted', isUnattempted: true, subQuestion: '24b', pageIndex: 8 }
      ]
    };

    const allResults = [q9, q10, q24];
    const classificationResult = { questions: [] };

    const overall = calculateOverallScore(allResults);
    expect(overall.overallScore).toBe(4);
    expect(overall.totalPossibleScore).toBe(12); // 3 + 4 + 5 (not 2 + 4 + 2 = 8)
    expect(overall.overallScoreText).toBe('4/12');

    const firstPageScores = calculateQuestionFirstPageScores(allResults, classificationResult);
    expect(firstPageScores.get(3)?.[0].scoreText).toBe('4/7'); // Q9 (0/3) + Q10 (4/4) = 4/7 (not 4/6)
    expect(firstPageScores.get(8)?.[0].scoreText).toBe('0/5'); // Q24 (0/5) (not 0/2)

    const perPageScores = calculatePerPageScores(allResults, classificationResult);
    expect(perPageScores[3].scoreText).toBe('4/7');
    expect(perPageScores[8].scoreText).toBe('0/5');
  });
});
