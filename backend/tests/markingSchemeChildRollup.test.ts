import { jest } from '@jest/globals';
import {
    AUTO_PERSIST_SCHEMA_VERSION,
    MarkingSchemeParserService,
    resolveSubQuestionTextWithChildRollup
} from '../services/marking/MarkingSchemeParserService.js';
import * as firebaseConfig from '../config/firebase.js';
import { QuestionDetectionService } from '../services/marking/questionDetectionService.js';

describe('MarkingSchemeParserService child sub-question text rollup', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('bumps AUTO_PERSIST_SCHEMA_VERSION to 6', () => {
        expect(AUTO_PERSIST_SCHEMA_VERSION).toBe(6);
    });

    describe('resolveSubQuestionTextWithChildRollup', () => {
        it('returns trimmed direct match when present', () => {
            const textMap = new Map<string, string>([
                ['7b', '  Direct 7b text  '],
                ['7bi', 'Child 7bi'],
                ['7bii', 'Child 7bii']
            ]);
            const schemeKeys = new Set(['7b']);

            expect(resolveSubQuestionTextWithChildRollup('7b', '7', textMap, schemeKeys)).toBe('Direct 7b text');
        });

        it('rolls up child sub-questions (e.g. 7bi + 7bii -> 7b) in order', () => {
            const textMap = new Map<string, string>([
                ['7bii', '  Hence find the value of k.  '],
                ['7bi', '  Show that f(x) = 0.  '],
                ['7a', 'Find the gradient.']
            ]);
            const schemeKeys = new Set(['7a', '7b']);

            expect(resolveSubQuestionTextWithChildRollup('7b', '7', textMap, schemeKeys)).toBe(
                'Show that f(x) = 0.\nHence find the value of k.'
            );
        });

        it('excludes child keys that have their own standalone entry in schemeKeys', () => {
            const textMap = new Map<string, string>([
                ['7bi', 'Standalone part i'],
                ['7bii', 'Unlisted part ii']
            ]);
            const schemeKeys = new Set(['7b', '7bi']);

            expect(resolveSubQuestionTextWithChildRollup('7b', '7', textMap, schemeKeys)).toBe('Unlisted part ii');
        });

        it('does not roll up keys from a different base question (e.g. 10a into 1)', () => {
            const textMap = new Map<string, string>([
                ['10a', 'Question 10a text'],
                ['11a', 'Question 11a text']
            ]);
            const schemeKeys = new Set(['1', '10a', '11a']);

            expect(resolveSubQuestionTextWithChildRollup('1', '1', textMap, schemeKeys)).toBe('');
        });

        it('ignores empty or whitespace-only child entries', () => {
            const textMap = new Map<string, string>([
                ['13ci', '   '],
                ['13cii', '']
            ]);
            const schemeKeys = new Set(['13c']);

            expect(resolveSubQuestionTextWithChildRollup('13c', '13', textMap, schemeKeys)).toBe('');
        });
    });

    describe('assessQuestionPaperCompleteness', () => {
        it('accepts leaf child texts (7bi+7bii, 13ci+13cii) for grouped scheme keys (7b, 13c)', () => {
            const parsedScheme = {
                subQuestionMaxScores: {
                    '7a': 2,
                    '7b': 5,
                    '13a': 3,
                    '13b': 2,
                    '13c': 4
                }
            };
            const extractedQuestions = [
                { questionNumber: '7a', text: '7a stem' },
                { questionNumber: '7bi', text: '7bi stem' },
                { questionNumber: '7bii', text: '7bii stem' },
                { questionNumber: '13a', text: '13a stem' },
                { questionNumber: '13b', text: '13b stem' },
                { questionNumber: '13ci', text: '13ci stem' },
                { questionNumber: '13cii', text: '13cii stem' }
            ];

            const report = MarkingSchemeParserService.assessQuestionPaperCompleteness(parsedScheme, extractedQuestions);
            expect(report.isComplete).toBe(true);
            expect(report.reasons).toEqual([]);
        });

        it('reports missing text when neither direct key nor any child key has text', () => {
            const parsedScheme = {
                subQuestionMaxScores: {
                    '7a': 2,
                    '7b': 5
                }
            };
            const extractedQuestions = [
                { questionNumber: '7a', text: '7a stem' }
            ];

            const report = MarkingSchemeParserService.assessQuestionPaperCompleteness(parsedScheme, extractedQuestions);
            expect(report.isComplete).toBe(false);
            expect(report.reasons).toContain('No question text extracted for: 7b');
        });
    });

    describe('saveOfficialExamPaperQuestionsToDatabase', () => {
        it('persists rolled-up child texts on grouped sub_questions without duplicating into parent stem', async () => {
            const setMock = jest.fn(async () => undefined);
            const docMock = jest.fn(() => ({
                get: jest.fn(async () => ({ exists: false })),
                set: setMock
            }));
            const collectionMock = jest.fn(() => ({ doc: docMock }));

            jest.spyOn(firebaseConfig, 'getFirestore').mockReturnValue({ collection: collectionMock } as any);
            jest.spyOn(QuestionDetectionService, 'invalidatePapersCache').mockImplementation(() => {});

            const parsedScheme = {
                examDetails: {
                    board: 'Edexcel',
                    subject: 'Mathematics',
                    qualification: 'A-Level',
                    paperCode: '8MA0/01',
                    exam_series: 'Summer 2023'
                },
                subQuestionMaxScores: {
                    '1': 4,
                    '7a': 2,
                    '7b': 5,
                    '13a': 3,
                    '13c': 4
                },
                questions: {
                    '1': { answer: 'a1', marks: [{ mark: 'B4', answer: '4' }] },
                    '7a': { answer: 'a7a', marks: [{ mark: 'B2', answer: '2' }] },
                    '7b': { answer: 'a7b', marks: [{ mark: 'B5', answer: '5' }] },
                    '13a': { answer: 'a13a', marks: [{ mark: 'B3', answer: '3' }] },
                    '13c': { answer: 'a13c', marks: [{ mark: 'B4', answer: '4' }] }
                }
            };

            const extractedQuestions = [
                { questionNumber: '1', text: 'Solve x + 1 = 5.' },
                { questionNumber: '7', text: 'A curve has equation y = x^2.' },
                { questionNumber: '7', text: 'Part bi text' }, // should be filtered out by subTextValues
                { questionNumber: '7a', text: 'Find dy/dx.' },
                { questionNumber: '7bi', text: 'Part bi text' },
                { questionNumber: '7bii', text: 'Part bii text' },
                { questionNumber: '13a', text: 'Part 13a text' },
                { questionNumber: '13ci', text: 'Part 13ci text' },
                { questionNumber: '13cii', text: 'Part 13cii text' }
            ];

            await MarkingSchemeParserService.saveOfficialExamPaperQuestionsToDatabase(parsedScheme, extractedQuestions);

            expect(setMock).toHaveBeenCalledTimes(1);
            const savedPayload = (setMock.mock.calls[0] as any[])[0];
            expect(savedPayload.autoPersistVersion).toBe(6);

            const q7 = savedPayload.questions.find((q: any) => q.question_number === '7');
            expect(q7.question_text).toBe('A curve has equation y = x^2.');
            const q7b = q7.sub_questions.find((sq: any) => sq.question_part === 'b');
            expect(q7b.question_text).toBe('Part bi text\nPart bii text');
            expect(q7b.text_missing).toBeUndefined();

            const q13 = savedPayload.questions.find((q: any) => q.question_number === '13');
            const q13c = q13.sub_questions.find((sq: any) => sq.question_part === 'c');
            expect(q13c.question_text).toBe('Part 13ci text\nPart 13cii text');
            expect(q13c.text_missing).toBeUndefined();
        });
    });
});
