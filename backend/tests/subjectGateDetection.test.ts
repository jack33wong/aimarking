import { SimilarityService } from '../services/marking/SimilarityService.js';
import { QuestionDetectionService } from '../services/marking/questionDetectionService.js';
import {
  MarkingSchemeOrchestrationService,
  SINGLE_MATCH_MIN_TEXT_SIMILARITY
} from '../services/marking/MarkingSchemeOrchestrationService.js';
import {
  computeSubjectGate,
  resolvePaperSubjectKey,
  isPaperAllowedBySubjectGate
} from '../config/subjectProfiles.js';

// Real-world regression: Maths mechanics Q2 ("13.1 Applied Test") falsely matched
// AQA English Language 8700/1 Nov 2021 Q2 (Ugwu extract) with score 0.848.
const MECHANICS_Q2_UPLOAD = `A block of mass 5 kg is on a plane which is at an angle of 40° to the horizontal. The block is connected by light, inextensible strings to objects A and D which hang vertically and have masses of 4 kg and 15 kg respectively, as shown in the diagram. Between B and C the strings are parallel to the line of greatest slope of the inclined plane and pass over smooth pegs B and C. The object D, which slides in a groove, is initially 1.5 m above a floor. You may assume that A never reaches the peg B and that the block never reaches the peg C. Calculate the change in gravitational potential energy of the whole system when D moves from its initial position to the floor. Your answer should specify whether this is a loss or a gain. The frictional force against the motion of the block is 10 N. The object at D slides in the groove against a constant frictional force of 15 N. You may assume that air resistance is negligible. The system is released from rest from its initial position. Show that D hits the floor with a speed of about 2.53 m s⁻¹. After the impact of D with the floor, how much further does the block move up the plane? You may assume that the string connecting the block to object A remains taut.`;

const UGWU_Q2_DB = `Look in detail at this extract, from lines 5 to 15 of the source: Ugwu did not believe that anybody, not even this master he was going to live with, ate meat every day. He did not disagree with his aunty, though, because he was too choked with expectation, too busy imagining his new life away from the village. They had been walking for a while now, since they got off the lorry at the motor park, and the afternoon sun burned the back of his neck. But he did not mind. He was prepared to walk hours more in even hotter sun. He had never seen anything like the streets that appeared after they went past the university gates, streets so smooth and tarred that he itched to lay his cheek down on them. He would never be able to describe to his sister Anulika how the bungalows here were painted the colour of the sky and sat side by side like polite well-dressed men, how the hedges separating them were trimmed so flat on top that they looked like tables wrapped with leaves. How does the writer use language here to describe Ugwu's impression of the city? You could include the writer's choice of: words and phrases, language features and techniques, sentence forms.`;

const ENGLISH_PAPER = {
  id: 'aqa-8700-1-nov2021',
  metadata: {
    exam_board: 'AQA',
    qualification: 'GCSE',
    subject: 'English Language',
    exam_code: '8700/1',
    exam_series: 'November 2021',
  },
  questions: { '2': { question_number: '2', question_text: UGWU_Q2_DB, marks: 8 } },
};

describe('Subject gate & false cross-subject detection', () => {
  it('numeric overlap no longer scores 1.0 against a DB question with only line-reference numbers', () => {
    const d = SimilarityService.calculateQuestionHybridScore(MECHANICS_Q2_UPLOAD, UGWU_Q2_DB, false);
    expect(d.numeric).toBeLessThanOrEqual(0.5);
    // Final detection score with a matching question number (structure = 1.0) must stay below the 0.80 strict threshold
    const finalWithStructure = d.total * 0.7 + 0.3;
    expect(finalWithStructure).toBeLessThan(0.8);
  });

  it('still scores a genuine identical Maths question highly', () => {
    const q = 'A particle of mass 2 kg is projected at 12 m s^-1 up a rough plane inclined at 30 degrees. The coefficient of friction is 0.25. Find the distance travelled before it comes to rest.';
    const d = SimilarityService.calculateQuestionHybridScore(q, q, false);
    expect(d.total).toBeGreaterThan(0.9);
  });

  it('maps DB paper metadata to subject families', () => {
    expect(resolvePaperSubjectKey({ subject: 'English Language', exam_code: '8700/1' })).toBe('ENGLISH_LANGUAGE');
    expect(resolvePaperSubjectKey({ subject: 'English Literature' })).toBe('ENGLISH_LITERATURE');
    expect(resolvePaperSubjectKey({ subject: 'Mathematics', exam_code: '1MA1/2H' })).toBe('MATHS');
    expect(resolvePaperSubjectKey({ subject: 'Further Mathematics', exam_code: '9FM0/01' })).toBe('MATHS');
    expect(resolvePaperSubjectKey({ subject: '', exam_code: '9MA0/32' })).toBe('MATHS');
    expect(resolvePaperSubjectKey({ subject: 'Biology', exam_code: '8461/1H' })).toBe('OTHER');
    // Real Firestore metadata samples
    expect(resolvePaperSubjectKey({
      subject: 'Mathematics',
      paper_title: 'PAPER 1 (Non-Calculator)',
      exam_code: '1MA1/1H',
      qualification: 'GCSE'
    })).toBe('MATHS');
    expect(resolvePaperSubjectKey({
      subject: 'COMBINED SCIENCE: TRILOGY',
      paper_title: 'AQA GCSE COMBINED SCIENCE: TRILOGY Paper 2 (Foundation)',
      exam_code: '8464/C/2F',
      qualification: 'GCSE'
    })).toBe('OTHER');
    // Code-only & paper_title-only fallbacks when metadata.subject is absent
    expect(resolvePaperSubjectKey({ exam_code: '8464/C/2F' })).toBe('OTHER');
    expect(resolvePaperSubjectKey({
      subject: '',
      paper_title: 'AQA GCSE COMBINED SCIENCE: TRILOGY Paper 2 (Foundation)'
    })).toBe('OTHER');
    expect(isPaperAllowedBySubjectGate({
      subject: 'COMBINED SCIENCE: TRILOGY',
      exam_code: '8464/C/2F'
    }, 'MATHS')).toBe(false);
    expect(resolvePaperSubjectKey({ subject: '', exam_code: 'XYZ1' })).toBeNull();
    expect(isPaperAllowedBySubjectGate({ subject: '', exam_code: 'XYZ1' }, 'MATHS')).toBe(true);
    expect(isPaperAllowedBySubjectGate(ENGLISH_PAPER.metadata, 'MATHS')).toBe(false);
  });

  it('is confident only with explicit, agreeing page votes', () => {
    const maths = { detected_subject: 'MATHS' };
    expect(computeSubjectGate({ geometryResults: [maths, maths, maths, maths, maths], resolvedProfileKey: 'MATHS' }))
      .toMatchObject({ confident: true, key: 'MATHS', explicitVotes: 5, topVotes: 5 });

    // Pages without detected_subject are NOT implicit Maths votes
    expect(computeSubjectGate({ geometryResults: [{}, {}], resolvedProfileKey: 'MATHS' }).confident).toBe(false);

    // Split vote
    expect(computeSubjectGate({
      geometryResults: [maths, maths, { detected_subject: 'ENGLISH_LANGUAGE' }],
      resolvedProfileKey: 'MATHS'
    }).confident).toBe(false);

    // Router disagrees
    expect(computeSubjectGate({ geometryResults: [maths], resolvedProfileKey: 'ENGLISH_LANGUAGE' }).confident).toBe(false);

    // Printed paper code points to a different subject (English or Science)
    expect(computeSubjectGate({ geometryResults: [maths, maths], resolvedProfileKey: 'MATHS', paperCodeHint: '8700/1' }).confident).toBe(false);
    expect(computeSubjectGate({ geometryResults: [maths, maths], resolvedProfileKey: 'MATHS', paperCodeHint: '8464/C/2F' }).confident).toBe(false);

    // Uploaded marking scheme bypasses DB detection entirely
    expect(computeSubjectGate({ geometryResults: [maths], resolvedProfileKey: 'MATHS', hasUploadedMarkingScheme: true }).confident).toBe(false);

    // Mark scheme pages are excluded from the vote
    expect(computeSubjectGate({
      geometryResults: [maths, { detected_subject: 'ENGLISH_LANGUAGE', is_marking_scheme: true }],
      resolvedProfileKey: 'MATHS'
    })).toMatchObject({ confident: true, key: 'MATHS' });
  });

  it('detectQuestion never matches a Maths upload to an English paper when the gate is MATHS', async () => {
    const service = QuestionDetectionService.getInstance();
    const originalGetAllExamPapers = (service as any).getAllExamPapers;
    const originalFindMarkingScheme = (service as any).findCorrespondingMarkingScheme;
    (service as any).findCorrespondingMarkingScheme = async () => null;
    (service as any).getAllExamPapers = async () => [ENGLISH_PAPER];

    try {
      const gated = await service.detectQuestion(MECHANICS_Q2_UPLOAD, '2', undefined, { subjectGateKey: 'MATHS' });
      expect(gated.found).toBe(false);

      const ungated = await service.detectQuestion(MECHANICS_Q2_UPLOAD, '2', undefined);
      // Without the gate, a lone-paper pool can still produce a weak "relative winner"; its raw text
      // similarity must stay below the single-match consensus floor so the orchestrator tears it down.
      if (ungated.found) {
        expect(ungated.match?.textSimilarity ?? 1).toBeLessThan(SINGLE_MATCH_MIN_TEXT_SIMILARITY);
      }
      // Documented: this lone-pool case IS a raw relative-winner match, so the orchestrator test below exercises the consensus floor.
      expect(ungated.found).toBe(true);

      // The real English question still matches when gated to ENGLISH_LANGUAGE
      const english = await service.detectQuestion(UGWU_Q2_DB, '2', undefined, { subjectGateKey: 'ENGLISH_LANGUAGE' });
      expect(english.found).toBe(true);
      expect(english.match?.paperCode).toBe('8700/1');
    } finally {
      (service as any).getAllExamPapers = originalGetAllExamPapers;
      (service as any).findCorrespondingMarkingScheme = originalFindMarkingScheme;
    }
  });

  const runOrchestration = async (subjectGate: any) => {
    const service = QuestionDetectionService.getInstance();
    const originalGetAllExamPapers = (service as any).getAllExamPapers;
    const originalFindMarkingScheme = (service as any).findCorrespondingMarkingScheme;
    (service as any).findCorrespondingMarkingScheme = async () => null;
    (service as any).getAllExamPapers = async () => [ENGLISH_PAPER];
    try {
      return await MarkingSchemeOrchestrationService.orchestrateMarkingSchemeLookup(
        [
          { text: 'Steve is a keen fisherman. The probability that he catches a fish each time he casts his line is 0.2.', questionNumber: '1' },
          { text: MECHANICS_Q2_UPLOAD, questionNumber: '2' }
        ],
        { questions: [] },
        undefined,
        undefined,
        false,
        undefined,
        subjectGate
      );
    } finally {
      (service as any).getAllExamPapers = originalGetAllExamPapers;
      (service as any).findCorrespondingMarkingScheme = originalFindMarkingScheme;
    }
  };

  const hasEnglishMatch = (result: any) =>
    result.detectionResults.some((dr: any) => dr.detectionResult?.found && dr.detectionResult?.match?.paperCode === '8700/1');

  it('orchestrator: confident MATHS gate yields no English match (title/subject fall back to generic Maths)', async () => {
    const result = await runOrchestration({ key: 'MATHS', confident: true, explicitVotes: 5, topVotes: 5, reason: 'test' });
    expect(hasEnglishMatch(result)).toBe(false);
  });

  it('orchestrator: without a gate, the weak single cross-subject match fails consensus and is torn down', async () => {
    const result = await runOrchestration(null);
    expect(hasEnglishMatch(result)).toBe(false);
  });
});
