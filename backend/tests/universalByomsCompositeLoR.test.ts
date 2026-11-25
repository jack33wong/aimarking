import { describe, it, expect } from '@jest/globals';
import { resolveSubjectFamily, hasLevelOfResponseSubQuestion } from '../config/subjectProfiles.js';
import { UNIVERSAL_BYOMS_MARKING_SYSTEM_PROMPT } from '../config/prompts/universal_byoms_marking_prompt.js';
import { MarkingPromptService } from '../services/marking/MarkingPromptService.js';
import { MarkingSchemeParserService } from '../services/marking/MarkingSchemeParserService.js';
import { ScoreAuditor } from '../services/marking/core/ScoreAuditor.js';
import { MarkingResultParser } from '../services/marking/MarkingResultParser.js';
import { latexToPlainText } from '../utils/TextNormalizationUtils.js';
import { generateSessionTitleFromDetectionResults } from '../services/marking/questionDetectionService.js';
import { normalizeUnattemptedSubQuestionAnnotations } from '../services/marking/MarkingExecutor.js';

describe('Universal BYOMS Composite LoR, SPaG, Subject Family & Summary Safeguards', () => {
  describe('resolveSubjectFamily & hasLevelOfResponseSubQuestion', () => {
    it('classifies subjects across exam boards and levels into coarse marking families', () => {
      expect(resolveSubjectFamily('Religious Studies A', '8062/13')).toBe('HUMANITIES_ESSAY');
      expect(resolveSubjectFamily('History', '8145')).toBe('HUMANITIES_ESSAY');
      expect(resolveSubjectFamily('Economics HL', 'IB')).toBe('HUMANITIES_ESSAY');
      expect(resolveSubjectFamily('Biology', '8461')).toBe('SCIENCE_DATA');
      expect(resolveSubjectFamily('Combined Science: Trilogy', '8464')).toBe('SCIENCE_DATA');
      expect(resolveSubjectFamily('Calculus AB', 'AP')).toBe('QUANTITATIVE');
      expect(resolveSubjectFamily('Mathematics', '1MA1')).toBe('QUANTITATIVE');
      expect(resolveSubjectFamily('English Literature', '8702')).toBe('ENGLISH_WRITING');
      expect(resolveSubjectFamily('Music Technology', 'CUSTOM')).toBe('GENERAL');
    });

    it('detects when a composite scheme contains a LEVEL_OF_RESPONSE sub-question >= 6 marks', () => {
      expect(
        hasLevelOfResponseSubQuestion({
          subQuestionMaxScores: { '1.1': 1, '1.2': 2, '1.5': 15 },
          subQuestionMetadata: {
            '1.1': { paradigm: 'KEYWORD_POINT' },
            '1.5': { paradigm: 'LEVEL_OF_RESPONSE' }
          }
        })
      ).toBe(true);

      expect(
        hasLevelOfResponseSubQuestion({
          subQuestionMaxScores: { '1.1': 1, '1.2': 2 },
          subQuestionMetadata: {
            '1.1': { paradigm: 'KEYWORD_POINT' },
            '1.2': { paradigm: 'KEYWORD_POINT' }
          }
        })
      ).toBe(false);
    });
  });

  describe('Composable Prompts & SPaG Rubric Injection', () => {
    it('uses dynamic exam persona, native notation, and subQuestionRubrics for Humanities essays', () => {
      const prompt = UNIVERSAL_BYOMS_MARKING_SYSTEM_PROMPT('Religious Studies A', {
        examBoard: 'AQA',
        qualification: 'GCSE',
        subjectFamily: 'HUMANITIES_ESSAY'
      });

      expect(prompt).toContain('AQA GCSE **Religious Studies A**');
      expect(prompt).toContain('NATIVE MARK NOTATION (NON-MATHS SUBJECT)');
      expect(prompt).toContain('subQuestionRubrics');
      expect(prompt).toContain('CONSISTENCY CAP (CRITICAL)');
    });

    it('injects Humanities tie-breakers + SPaG rubric and excludes Mitosis/Meiosis for RS', () => {
      const formatted = MarkingPromptService.formatMarkingSchemeForPrompt(
        {
          questionNumber: '1',
          totalMarks: 27,
          marks: [],
          subQuestionMarks: {
            '1.1': [{ mark: 'B1', answer: 'D Sinful' }],
            '1.5': [{ mark: 'B12', answer: 'Level of response evaluation' }]
          },
          subQuestionMaxScores: { '1.1': 1, '1.5': 15 },
          subQuestionMetadata: {
            '1.1': { paradigm: 'KEYWORD_POINT' },
            '1.5': {
              paradigm: 'LEVEL_OF_RESPONSE',
              contentMaxMarks: 12,
              spagMaxMarks: 3,
              levels: [{ level: 4, markRange: '10-12', descriptor: 'Well-argued response.' }]
            }
          }
        } as any,
        { subjectFamily: 'HUMANITIES_ESSAY' }
      );

      expect(formatted).toContain('HUMANITIES & ESSAY EXAMINER TIE-BREAKER RULES');
      expect(formatted).not.toContain('Mitosis vs. Meiosis');
      expect(formatted).toContain('[MAX SCORE: 15 (Content: 12 + SPaG: 3)]');
      expect(formatted).toContain('[SPaG RUBRIC (Separate 3 marks)]');
    });

    it('preserves Science tie-breakers for SCIENCE_DATA schemes', () => {
      const formatted = MarkingPromptService.formatMarkingSchemeForPrompt(
        {
          questionNumber: '1',
          totalMarks: 2,
          marks: [{ mark: 'B1', answer: 'Nucleus' }, { mark: 'B1', answer: 'Ribosome' }]
        } as any,
        { subjectFamily: 'SCIENCE_DATA' }
      );

      expect(formatted).toContain('Mitosis vs. Meiosis');
      expect(formatted).not.toContain('HUMANITIES & ESSAY EXAMINER TIE-BREAKER RULES');
    });
  });

  describe('Deterministic SPaG Promotion in MarkingSchemeParserService', () => {
    it('promotes [SPaG 3 marks] from comments into spagMaxMarks and updates subQuestionMaxScores to 15', () => {
      const rawParsed = {
        examDetails: { board: 'AQA', subject: 'Religious Studies A', qualification: 'GCSE' },
        subQuestionMaxScores: { '01.1': 1, '01.5': 12 },
        questions: {
          '01.1': { paradigm: 'KEYWORD_POINT', marks: [{ mark: 'B1', answer: 'D Sinful' }] },
          '01.5': {
            paradigm: 'LEVEL_OF_RESPONSE',
            levels: [{ level: 4, markRange: '10-12', descriptor: 'Well-argued response' }],
            marks: [{ mark: 'B12', answer: 'Evaluation', comments: 'Target AO2. [SPaG 3 marks assessed separately].' }]
          }
        }
      };

      const canonical = (MarkingSchemeParserService as any).canonicalizeParsedScheme(rawParsed);
      expect(canonical.questions['1.5'].spagMaxMarks).toBe(3);
      expect(canonical.questions['1.5'].contentMaxMarks).toBe(12);
      expect(canonical.subQuestionMaxScores['1.5']).toBe(15);
    });
  });

  describe('Composite subQuestionRubrics Reconciliation (ScoreAuditor & MarkingResultParser)', () => {
    const scheme = {
      questionNumber: '1',
      totalMarks: 27,
      marks: [],
      subQuestionMaxScores: { '1.1': 1, '1.2': 2, '1.3': 4, '1.4': 5, '1.5': 15 }
    };

    const annotations = [
      { subQuestion: '1.1', action: 'tick', text: 'AO1 +1', reasoning: 'Correct option D' },
      { subQuestion: '1.2', action: 'tick', text: '+1', reasoning: 'Saved from sin' },
      { subQuestion: '1.2', action: 'tick', text: '+1', reasoning: 'Gift of grace' },
      { subQuestion: '1.3', action: 'tick', text: 'AO2', reasoning: 'Hope of heaven' },
      { subQuestion: '1.3', action: 'tick', text: 'AO2', reasoning: 'Reassurance developed' },
      { subQuestion: '1.3', action: 'tick', text: 'AO2', reasoning: 'Holy Spirit guidance' },
      { subQuestion: '1.3', action: 'tick', text: 'AO2', reasoning: 'Influence developed' },
      { subQuestion: '1.4', action: 'tick', text: 'AO1 +1', reasoning: 'Genesis disobedience' },
      { subQuestion: '1.4', action: 'tick', text: 'AO1 +1', reasoning: 'Tendency to sin' },
      { subQuestion: '1.4', action: 'tick', text: 'AO1 +1', reasoning: 'Barrier to God' },
      { subQuestion: '1.4', action: 'tick', text: 'AO1 +1', reasoning: 'Romans 6:23 quote' },
      { subQuestion: '1.4', action: 'tick', text: 'AO1 +1', reasoning: 'Atonement and baptism' },
      // Paragraph-level qualitative + flaw + SPaG annotations for 1.5
      { subQuestion: '1.5', action: 'circle', text: '[Flaw]', reasoning: 'Opening contradicts prompt' },
      { subQuestion: '1.5', action: 'tick', text: '[AO2 L3]', reasoning: 'Clear resurrection argument' },
      { subQuestion: '1.5', action: 'tick', text: '[AO2 L3]', reasoning: 'Clear crucifixion counter-argument' },
      { subQuestion: '1.5', action: 'circle', text: '[SPaG]', reasoning: 'Capitalise Christians and apostrophes' },
      { subQuestion: '1.5', action: 'tick', text: 'L3 (8/12)', reasoning: 'Generic conclusion caps at L3' }
    ];

    const subQuestionRubrics = {
      '1.5': {
        audit: {
          strengths: ['Includes two sides and Luke 23:46'],
          flaws: ['Opening sentence contradicts prompt', 'Generic conclusion'],
          conclusionQuality: 'generic',
          bandJustification: 'Level 3 due to single point per side and generic conclusion'
        },
        awardedLevel: 3,
        levelLabel: 'Level 3',
        awardedMarks: 8,
        maxMarks: 12,
        spag: { awardedMarks: 2, maxMarks: 3, feedback: 'Minor capitalisation and apostrophe errors' },
        rubricStamp: '[L3 · 8/12 + SPaG 2/3]',
        coaching: {
          rationale: '**Clear counter-argument**: Good use of Luke 23:46 for crucifixion.',
          nextLevelGap: '**Weigh arguments in conclusion**: Explain why one belief outweighs the other.'
        }
      }
    };

    it('scores 1.1–1.4 accurately without misreading AO2 as 2 marks, scores 1.5 from subQuestionRubrics, and preserves all paragraph annotations', () => {
      const reconciled = ScoreAuditor.reconcilePointBasedScore({
        enrichedAnnotations: annotations,
        scheme,
        studentScore: { awardedMarks: 22, totalMarks: 27, scoreText: '22/27' },
        subQuestionRubrics
      });

      // 1 + 2 + 4 + 5 + (8 + 2) = 22 / 27
      expect(reconciled.awardedMarks).toBe(22);
      expect(reconciled.totalMarks).toBe(27);
      expect(reconciled.scoreText).toBe('22/27');
      // All 5 annotations on 1.5 (including circles and paragraph badges) must survive
      const sub15Annos = reconciled.annotations.filter(a => a.subQuestion === '1.5');
      expect(sub15Annos).toHaveLength(5);
    });

    it('MarkingResultParser also computes composite + subQuestionRubrics score cleanly', () => {
      const parsed = MarkingResultParser.postProcessMarkingResponse(
        {
          annotations: annotations.map((a, idx) => ({ ...a, line_id: `p0_q1_line_${idx + 1}`, pageIndex: 0 })),
          studentScore: { awardedMarks: 22, totalMarks: 27, scoreText: '22/27' },
          subQuestionRubrics,
          rubricEvaluation: null
        },
        scheme,
        {},
        '1'
      );

      expect(parsed.studentScore.awardedMarks).toBe(22);
      expect(parsed.studentScore.totalMarks).toBe(27);
    });
  });

  describe('Title Generation, Mixed Numbers & Cross-Page Not Attempted Placement', () => {
    it('preserves space in mixed numbers instead of mashing 2\\frac{4}{5} into 24/5', () => {
      expect(latexToPlainText('Work out $2\\frac{4}{5} + 1\\frac{3}{4}$')).toBe('Work out 2 4/5 + 1 3/4');
    });

    it('uses a clean paper-level title for unmatched multi-question papers instead of Q1 prose', () => {
      const mockResults = [1, 2, 3, 4, 22].map(n => ({
        question: { questionNumber: String(n), text: n === 1 ? 'Work out $2\\frac{4}{5} + 1\\frac{3}{4}$' : `Question ${n}` },
        detectionResult: {
          found: false,
          match: {
            board: 'Unknown',
            paperCode: 'Generic Question',
            subject: 'Mathematics',
            questionNumber: String(n)
          }
        }
      }));
      const title = generateSessionTitleFromDetectionResults(mockResults, 'Marking');
      expect(title).toBe('Maths Paper · Q1–Q22');
      expect(title).not.toContain('24/5');
    });

    it('anchors unattempted Q11c pill to Q11c zone on page 10 instead of Q11a box plot on page 9', () => {
      const normalized = normalizeUnattemptedSubQuestionAnnotations(
        [
          {
            action: 'not_attempted',
            text: 'Not attempted',
            subQuestion: '11c',
            pageIndex: 9,
            bbox: [701, 1804, 150, 40] // erroneously landed on page 9
          }
        ],
        [],
        {
          '11a': [{ pageIndex: 9, startY: 1400, endY: 2000, x: 200, width: 1200 }],
          '11c': [{ pageIndex: 10, startY: 1600, endY: 2100, x: 200, width: 1200 }]
        },
        { subQuestionMaxScores: { '11a': 3, '11b': 2, '11c': 1 } },
        new Map([
          [9, { width: 1650, height: 2339 }],
          [10, { width: 1650, height: 2339 }]
        ]),
        9
      );

      expect(normalized).toHaveLength(1);
      expect(normalized[0].pageIndex).toBe(10);
      expect(normalized[0].scoreBadgeText).toBe('0/1');
      expect(normalized[0].bbox[1]).toBeGreaterThanOrEqual(1600);
    });
  });
});
