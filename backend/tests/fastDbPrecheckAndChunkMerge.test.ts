import { jest } from '@jest/globals';
import {
    isValidExamPaperHint,
    extractCoverPaperMetadata,
    runFastDbPreCheck
} from '../services/marking/MarkingPipelineService.js';
import {
    MarkingSchemeParserService,
    mergeParsedSchemeChunks
} from '../services/marking/MarkingSchemeParserService.js';
import { ModelProvider } from '../utils/ModelProvider.js';
import { ImageUtils } from '../utils/ImageUtils.js';
import * as firebaseConfig from '../config/firebase.js';

describe('isValidExamPaperHint', () => {
    it('rejects conversational prompts and invalid hints', () => {
        expect(isValidExamPaperHint('Make my paper')).toBe(false);
        expect(isValidExamPaperHint('Mark this please')).toBe(false);
        expect(isValidExamPaperHint('Grade my test')).toBe(false);
        expect(isValidExamPaperHint('')).toBe(false);
        expect(isValidExamPaperHint('  ')).toBe(false);
        expect(isValidExamPaperHint(null)).toBe(false);
        expect(isValidExamPaperHint(undefined)).toBe(false);
        expect(isValidExamPaperHint('ab')).toBe(false);
        expect(isValidExamPaperHint('AQA ' + 'x'.repeat(120))).toBe(false);
        expect(isValidExamPaperHint('non-calc')).toBe(false);
        expect(isValidExamPaperHint('mark-this')).toBe(false);
    });

    it('accepts valid paper codes, boards, qualifications, and General Rubric sentinel strings', () => {
        expect(isValidExamPaperHint('8MA0/01')).toBe(true);
        expect(isValidExamPaperHint('GCSE AQA')).toBe(true);
        expect(isValidExamPaperHint('Edexcel 1MA1/1H')).toBe(true);
        expect(isValidExamPaperHint('9ma0')).toBe(true);
        expect(isValidExamPaperHint('A-Level Maths')).toBe(true);
        expect(isValidExamPaperHint('OCR J560')).toBe(true);
        expect(isValidExamPaperHint('CCEA 1BI0')).toBe(true);
        expect(isValidExamPaperHint('J247')).toBe(true);
        expect(isValidExamPaperHint('H446')).toBe(true);
        expect(
            isValidExamPaperHint('Marking with AI using General Rubric (No official marking scheme attached).')
        ).toBe(true);
    });
});

describe('mergeParsedSchemeChunks', () => {
    it('returns null when given empty or all-null chunks', () => {
        expect(mergeParsedSchemeChunks([])).toBeNull();
        expect(mergeParsedSchemeChunks([null, undefined])).toBeNull();
    });

    it('merges 4 overlapping chunks while preserving examDetails, paperTotalMarks, subQuestionMaxScores, and documentCompleteness', () => {
        const chunk0 = {
            examDetails: {
                board: 'Edexcel',
                subject: 'Mathematics',
                qualification: 'A-Level',
                paperCode: '8MA0/01',
                tier: 'N/A',
                exam_series: 'Summer 2023',
                paperTotalMarks: 100
            },
            subQuestionMaxScores: { '1a': 2, '1b': 3, '2': 4 },
            questions: {
                '1a': {
                    paradigm: 'CALCULATION_STEP',
                    answer: 'x = 3',
                    marks: [{ mark: 'M1', answer: 'step' }, { mark: 'A1', answer: '3' }]
                },
                '1b': {
                    paradigm: 'CALCULATION_STEP',
                    answer: 'y = 5',
                    marks: [{ mark: 'M1', answer: 'partial at boundary' }] // incomplete at boundary
                }
            },
            generalMarkingGuidance: 'General instructions: standard Edexcel rules apply for all questions.'
        };

        const chunk1 = {
            examDetails: {
                board: 'N/A',
                paperCode: 'Uploaded',
                paperTotalMarks: null
            },
            subQuestionMaxScores: { '1b': 3, '2': 4, '3': 5 },
            questions: {
                '1b': {
                    paradigm: 'CALCULATION_STEP',
                    answer: 'y = 5',
                    marks: [
                        { mark: 'M1', answer: 'sub' },
                        { mark: 'M1', answer: 'rearrange' },
                        { mark: 'A1', answer: '5' }
                    ] // complete 3/3 marks
                },
                '2': {
                    paradigm: 'CALCULATION_STEP',
                    answer: '42',
                    marks: [{ mark: 'M2', answer: 'method' }, { mark: 'A2', answer: '42' }]
                },
                '3': {
                    paradigm: 'CALCULATION_STEP',
                    answer: '10',
                    marks: [{ mark: 'M1', answer: 'partial' }]
                }
            },
            generalMarkingGuidance: 'Short'
        };

        const chunk2 = {
            examDetails: {},
            subQuestionMaxScores: { '3': 5, '4': 6 },
            questions: {
                '3': {
                    paradigm: 'CALCULATION_STEP',
                    answer: '10',
                    marks: [
                        { mark: 'M1', answer: 's1' },
                        { mark: 'M1', answer: 's2' },
                        { mark: 'M1', answer: 's3' },
                        { mark: 'M1', answer: 's4' },
                        { mark: 'A1', answer: '10' }
                    ]
                },
                '4': {
                    paradigm: 'CALCULATION_STEP',
                    answer: '12',
                    marks: [{ mark: 'B6', answer: 'full' }]
                }
            }
        };

        const chunk3 = {
            examDetails: {},
            subQuestionMaxScores: { '5': 4 },
            questions: {
                '5': {
                    paradigm: 'CALCULATION_STEP',
                    answer: '99',
                    marks: [{ mark: 'M2', answer: 'm' }, { mark: 'A2', answer: '99' }]
                }
            }
        };

        const merged = mergeParsedSchemeChunks([chunk0, chunk1, chunk2, chunk3]);

        expect(merged).toBeTruthy();
        expect(merged.examDetails).toEqual({
            board: 'Edexcel',
            subject: 'Mathematics',
            qualification: 'A-Level',
            paperCode: '8MA0/01',
            tier: 'N/A',
            exam_series: 'Summer 2023',
            paperTotalMarks: 100
        });
        expect(merged.subQuestionMaxScores).toEqual({
            '1a': 2,
            '1b': 3,
            '2': 4,
            '3': 5,
            '4': 6,
            '5': 4
        });
        // Boundary overlaps should pick the complete 3-mark entry for 1b and 5-mark entry for 3
        expect(merged.questions['1b'].marks).toHaveLength(3);
        expect(merged.questions['3'].marks).toHaveLength(5);
        expect(merged.generalMarkingGuidance).toBe(
            'General instructions: standard Edexcel rules apply for all questions.'
        );
        expect(merged.documentCompleteness).toEqual({
            isComplete: true,
            firstQuestion: '1',
            lastQuestion: '5',
            reason: ''
        });
    });

    it('marks documentCompleteness.isComplete = false when a base question is missing', () => {
        const merged = mergeParsedSchemeChunks([
            {
                examDetails: { board: 'AQA', paperTotalMarks: 80 },
                subQuestionMaxScores: { '1': 2, '3': 4 },
                questions: {
                    '1': { marks: [{ mark: 'B2', answer: 'a' }] },
                    '3': { marks: [{ mark: 'B4', answer: 'b' }] }
                }
            }
        ]);

        expect(merged.documentCompleteness.isComplete).toBe(false);
        expect(merged.documentCompleteness.firstQuestion).toBe('1');
        expect(merged.documentCompleteness.lastQuestion).toBe('3');
    });
});

describe('MarkingSchemeParserService.parseImagesToObject chunking', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('uses single-batch call for <= 12 pages and 4 overlapped batches (CHUNK_SIZE=12, max 3 concurrent) for 35 pages', async () => {
        jest.spyOn(firebaseConfig, 'getFirestore').mockReturnValue(null as any);
        jest.spyOn(ImageUtils, 'createLightweightCopy').mockImplementation(async (img: string) => img);

        const callSpy = jest.spyOn(ModelProvider, 'callGeminiChat').mockImplementation(
            async (_sys, userMsg, images) => {
                const batchMatch = userMsg.match(/batch (\d+) of (\d+)/);
                const idx = batchMatch ? Number(batchMatch[1]) : 1;
                return {
                    content: JSON.stringify({
                        examDetails: {
                            board: 'Edexcel',
                            subject: 'Mathematics',
                            qualification: 'A-Level',
                            paperCode: '8MA0/01',
                            exam_series: 'Summer 2023',
                            paperTotalMarks: 100
                        },
                        subQuestionMaxScores: { [String(idx)]: 2 },
                        questions: {
                            [String(idx)]: {
                                paradigm: 'CALCULATION_STEP',
                                answer: '1',
                                marks: [{ mark: 'M1', answer: 'm' }, { mark: 'A1', answer: '1' }]
                            }
                        },
                        generalMarkingGuidance: 'Guidance'
                    }),
                    usageTokens: 100
                } as any;
            }
        );

        // 1) Small scheme (5 pages) -> 1 call
        const smallPages = Array.from({ length: 5 }, (_, i) => `data:image/png;base64,SMALL_${i}_${'A'.repeat(600)}`);
        const smallRes = await MarkingSchemeParserService.parseImagesToObject(smallPages);
        expect(callSpy).toHaveBeenCalledTimes(1);
        expect(smallRes?.questions['1']).toBeDefined();

        callSpy.mockClear();

        // 2) Large scheme (35 pages) -> 4 overlapped batches (max 3 concurrent) of [12, 12, 12, 2] pages: 0..11, 11..22, 22..33, 33..34
        const largePages = Array.from({ length: 35 }, (_, i) => `data:image/png;base64,LARGE_${i}_${'B'.repeat(600)}`);
        const largeRes = await MarkingSchemeParserService.parseImagesToObject(largePages);
        expect(callSpy).toHaveBeenCalledTimes(4);
        expect(callSpy.mock.calls[0][2]).toHaveLength(12);
        expect(callSpy.mock.calls[1][2]).toHaveLength(12);
        expect(callSpy.mock.calls[2][2]).toHaveLength(12);
        expect(callSpy.mock.calls[3][2]).toHaveLength(2);
        expect(largeRes?.documentCompleteness?.isComplete).toBe(true);
        expect(Object.keys(largeRes?.questions || {})).toEqual(['1', '2', '3', '4']);
    });

    it('retries a failed chunk once and skips cache writes + sets isComplete=false if a batch still fails', async () => {
        const setMock = jest.fn<any>().mockResolvedValue(undefined);
        jest.spyOn(firebaseConfig, 'getFirestore').mockReturnValue({
            collection: () => ({ doc: () => ({ set: setMock }) })
        } as any);
        jest.spyOn(ImageUtils, 'createLightweightCopy').mockImplementation(async (img: string) => img);

        jest.spyOn(ModelProvider, 'callGeminiChat').mockImplementation(
            async (_sys, userMsg) => {
                const batchMatch = userMsg.match(/batch (\d+) of (\d+)/);
                const idx = batchMatch ? Number(batchMatch[1]) : 1;
                if (idx === 2) {
                    return { content: '{not valid json', usageTokens: 10 } as any;
                }
                return {
                    content: JSON.stringify({
                        examDetails: {
                            board: 'Edexcel',
                            paperCode: '8MA0/01',
                            exam_series: 'Summer 2023',
                            paperTotalMarks: 100
                        },
                        subQuestionMaxScores: { [String(idx)]: 2 },
                        questions: {
                            [String(idx)]: {
                                paradigm: 'CALCULATION_STEP',
                                answer: '1',
                                marks: [{ mark: 'M1', answer: 'm' }, { mark: 'A1', answer: '1' }]
                            }
                        }
                    }),
                    usageTokens: 100
                } as any;
            }
        );

        const pages = Array.from({ length: 25 }, (_, i) => `data:image/png;base64,PARTIAL_${i}_${'C'.repeat(600)}`);
        const res = await MarkingSchemeParserService.parseImagesToObject(pages);
        expect(res).toBeTruthy();
        expect(Object.keys(res?.questions || {})).toEqual(['1', '3']);
        expect(res?.documentCompleteness?.isComplete).toBe(false);
        expect(setMock).not.toHaveBeenCalled();
    });
});

describe('extractCoverPaperMetadata & runFastDbPreCheck', () => {
    it('does not treat board/qualification-only hints as a paperCode and ignores ISO dates and bare years', () => {
        const meta = extractCoverPaperMetadata({
            geometryResults: [{ is_marking_scheme: false, visual_observations: 'AQA GCSE Mathematics non-calc © 2025' }],
            uploadedFileNames: ['2026-11-17-scan.pdf'],
            effectiveExamPaperHint: 'AQA GCSE'
        });

        expect(meta.detectedBoard).toBe('AQA');
        expect(meta.detectedPaperCode).toBeUndefined();
        expect(meta.detectedExamSeries).toBeUndefined();
        expect(meta.hasFourDigitYear).toBe(false);
    });

    it('fast-fails immediately via paperExistsInDatabase when board + paperCode + year are known and not in DB', async () => {
        const paperExistsMock = jest.fn<any>().mockResolvedValue(false);
        const orchestrateMock = jest.fn<any>();

        const questions = Array.from({ length: 17 }, (_, i) => ({ questionNumber: String(i + 1) }));
        const result = await runFastDbPreCheck({
            individualQuestions: questions,
            classificationResult: { reasoning: 'Edexcel 8MA0/01 Summer 2023' },
            effectiveExamPaperHint: '8MA0/01',
            geometryResults: [{ is_marking_scheme: false, paper_code_hint: '8MA0/01' }],
            uploadedFileNames: ['8MA0_01_2023.pdf'],
            extractedGeoPaperCode: '8MA0/01',
            cleanGeoPaperHint: '8MA0/01',
            paperExistsInDatabaseFn: paperExistsMock,
            orchestrateLookupFn: orchestrateMock
        });

        expect(result).toBeNull();
        expect(paperExistsMock).toHaveBeenCalledTimes(1);
        expect(paperExistsMock).toHaveBeenCalledWith('Edexcel', '8MA0/01', 'Summer 2023');
        expect(orchestrateMock).not.toHaveBeenCalled();
    });

    it('probes at most 3 questions when examSeries is unknown and aborts on 0/3 match', async () => {
        const paperExistsMock = jest.fn<any>();
        const orchestrateMock = jest.fn<any>().mockResolvedValue({
            markingSchemesMap: new Map([
                ['1', { isGeneric: true, questionDetection: { found: false } }],
                ['2', { isGeneric: true, questionDetection: { found: false } }],
                ['3', { isGeneric: true, questionDetection: { found: false } }]
            ])
        });

        const questions = Array.from({ length: 17 }, (_, i) => ({ questionNumber: String(i + 1) }));
        const result = await runFastDbPreCheck({
            individualQuestions: questions,
            classificationResult: { reasoning: 'Edexcel 8MA0/01' },
            effectiveExamPaperHint: '8MA0/01',
            extractedGeoPaperCode: '8MA0/01',
            cleanGeoPaperHint: '8MA0/01',
            paperExistsInDatabaseFn: paperExistsMock,
            orchestrateLookupFn: orchestrateMock
        });

        expect(result).toBeNull();
        expect(paperExistsMock).not.toHaveBeenCalled();
        expect(orchestrateMock).toHaveBeenCalledTimes(1);
        expect(orchestrateMock.mock.calls[0][0]).toHaveLength(3);
    });

    it('reuses 3-question probe results and queries only remaining questions when probe finds a DB match', async () => {
        const paperExistsMock = jest.fn<any>();
        const orchestrateMock = jest.fn<any>()
            .mockResolvedValueOnce({
                markingSchemesMap: new Map([
                    ['1', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'M1 A1', paperTitle: '8MA0/01' } } }],
                    ['2', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'B1', paperTitle: '8MA0/01' } } }],
                    ['3', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'M1', paperTitle: '8MA0/01' } } }]
                ])
            })
            .mockResolvedValueOnce({
                markingSchemesMap: new Map([
                    ['4', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'A1', paperTitle: '8MA0/01' } } }]
                ])
            });

        const questions = Array.from({ length: 4 }, (_, i) => ({ questionNumber: String(i + 1) }));
        const result = await runFastDbPreCheck({
            individualQuestions: questions,
            classificationResult: { reasoning: 'Edexcel 8MA0/01' },
            effectiveExamPaperHint: '8MA0/01',
            paperExistsInDatabaseFn: paperExistsMock,
            orchestrateLookupFn: orchestrateMock
        });

        expect(result).toBeTruthy();
        expect(result?.markingSchemesMap.size).toBe(4);
        expect(orchestrateMock).toHaveBeenCalledTimes(2);
        expect(orchestrateMock.mock.calls[0][0]).toHaveLength(3);
        expect(orchestrateMock.mock.calls[1][0]).toHaveLength(1);
        expect(orchestrateMock.mock.calls[1][0][0].questionNumber).toBe('4');
    });

    it('handles underscore-delimited filenames for ISO date stripping and board/paperCode/examSeries extraction', () => {
        const isoUnderscore = extractCoverPaperMetadata({
            uploadedFileNames: ['scan-2026-11-17_final.pdf', 'scan_2026_11_17_backup.pdf']
        });
        expect(isoUnderscore.detectedBoard).toBeUndefined();
        expect(isoUnderscore.detectedPaperCode).toBeUndefined();
        expect(isoUnderscore.detectedExamSeries).toBeUndefined();
        expect(isoUnderscore.hasFourDigitYear).toBe(false);

        const paperMeta = extractCoverPaperMetadata({
            uploadedFileNames: ['Edexcel_8MA0_01_Summer_2023.pdf']
        });
        expect(paperMeta.detectedBoard).toBe('Edexcel');
        expect(paperMeta.detectedPaperCode).toBe('8MA0_01');
        expect(paperMeta.detectedExamSeries).toBe('Summer 2023');
        expect(paperMeta.hasFourDigitYear).toBe(true);
    });

    it('merges detectionResults, detectionStats, and updatedClassificationResult when 3-question probe hits', async () => {
        const paperExistsMock = jest.fn<any>();
        const orchestrateMock = jest.fn<any>()
            .mockResolvedValueOnce({
                markingSchemesMap: new Map([
                    ['1_Edexcel_8MA0/01', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'M1', paperTitle: '8MA0/01' } } }],
                    ['2_Edexcel_8MA0/01', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'B1', paperTitle: '8MA0/01' } } }],
                    ['3_Edexcel_8MA0/01', { isGeneric: false, questionDetection: { found: false } }]
                ]),
                detectionResults: [
                    { question: { questionNumber: '1', text: 'Q1' }, detectionResult: { found: true, match: { paperTitle: '8MA0/01' } } },
                    { question: { questionNumber: '2', text: 'Q2' }, detectionResult: { found: true, match: { paperTitle: '8MA0/01' } } },
                    { question: { questionNumber: '3', text: 'Q3' }, detectionResult: { found: false, match: null } }
                ],
                detectionStats: {
                    totalQuestions: 3,
                    detected: 2,
                    notDetected: 1,
                    withMarkingScheme: 2,
                    withoutMarkingScheme: 1,
                    bySimilarityRange: { high: 2, medium: 0, low: 1 },
                    questionDetails: [
                        { questionNumber: '1', detected: true, similarity: 0.95, hasMarkingScheme: true, matchedPaperTitle: '8MA0/01' },
                        { questionNumber: '2', detected: true, similarity: 0.91, hasMarkingScheme: true, matchedPaperTitle: '8MA0/01' },
                        { questionNumber: '3', detected: false, similarity: 0.1, hasMarkingScheme: false }
                    ],
                    hintInfo: { hintUsed: '8MA0/01', matchedPapersCount: 1, matchedPaperTitle: '8MA0/01', thresholdRelaxed: false }
                },
                updatedClassificationResult: {
                    reasoning: 'Edexcel 8MA0/01',
                    questions: [{ questionNumber: '1' }, { questionNumber: '2' }, { questionNumber: '3' }]
                }
            })
            .mockResolvedValueOnce({
                markingSchemesMap: new Map([
                    ['4_Edexcel_8MA0/01', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'A1', paperTitle: '8MA0/01' } } }],
                    ['5_Edexcel_8MA0/01', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'B2', paperTitle: '8MA0/01' } } }]
                ]),
                detectionResults: [
                    { question: { questionNumber: '4', text: 'Q4' }, detectionResult: { found: true, match: { paperTitle: '8MA0/01' } } },
                    { question: { questionNumber: '5', text: 'Q5' }, detectionResult: { found: true, match: { paperTitle: '8MA0/01' } } }
                ],
                detectionStats: {
                    totalQuestions: 2,
                    detected: 2,
                    notDetected: 0,
                    withMarkingScheme: 2,
                    withoutMarkingScheme: 0,
                    bySimilarityRange: { high: 1, medium: 1, low: 0 },
                    questionDetails: [
                        { questionNumber: '4', detected: true, similarity: 0.92, hasMarkingScheme: true, matchedPaperTitle: '8MA0/01' },
                        { questionNumber: '5', detected: true, similarity: 0.85, hasMarkingScheme: true, matchedPaperTitle: '8MA0/01' }
                    ],
                    hintInfo: { hintUsed: '8MA0/01', matchedPapersCount: 1, matchedPaperTitle: '8MA0/01', thresholdRelaxed: true }
                },
                updatedClassificationResult: {
                    reasoning: 'Edexcel 8MA0/01',
                    questions: [{ questionNumber: '4' }, { questionNumber: '5' }]
                }
            });

        const questions = ['1', '2', '3', '4', '5'].map(q => ({ questionNumber: q, text: `Q${q}` }));
        const result = await runFastDbPreCheck({
            individualQuestions: questions,
            classificationResult: { reasoning: 'Edexcel 8MA0/01' },
            effectiveExamPaperHint: '8MA0/01',
            paperExistsInDatabaseFn: paperExistsMock,
            orchestrateLookupFn: orchestrateMock
        });

        expect(result).toBeTruthy();
        expect(result?.detectionResults?.map((d: any) => d.question.questionNumber)).toEqual(['1', '2', '3', '4', '5']);
        expect(result?.detectionStats).toEqual({
            totalQuestions: 5,
            detected: 4,
            notDetected: 1,
            withMarkingScheme: 4,
            withoutMarkingScheme: 1,
            bySimilarityRange: { high: 3, medium: 1, low: 1 },
            questionDetails: [
                { questionNumber: '1', detected: true, similarity: 0.95, hasMarkingScheme: true, matchedPaperTitle: '8MA0/01' },
                { questionNumber: '2', detected: true, similarity: 0.91, hasMarkingScheme: true, matchedPaperTitle: '8MA0/01' },
                { questionNumber: '3', detected: false, similarity: 0.1, hasMarkingScheme: false },
                { questionNumber: '4', detected: true, similarity: 0.92, hasMarkingScheme: true, matchedPaperTitle: '8MA0/01' },
                { questionNumber: '5', detected: true, similarity: 0.85, hasMarkingScheme: true, matchedPaperTitle: '8MA0/01' }
            ],
            hintInfo: {
                hintUsed: '8MA0/01',
                matchedPapersCount: 1,
                matchedPaperTitle: '8MA0/01',
                thresholdRelaxed: true
            }
        });
        expect(result?.updatedClassificationResult?.questions.map((q: any) => q.questionNumber)).toEqual(['1', '2', '3', '4', '5']);
    });

    it('merges shared base-question keys across slice(0, 3) and slice(3) without dropping sub-questions', async () => {
        const paperExistsMock = jest.fn<any>();
        const orchestrateMock = jest.fn<any>()
            .mockResolvedValueOnce({
                markingSchemesMap: new Map([
                    [
                        '1_Edexcel_8MA0/01',
                        {
                            isGeneric: false,
                            questionNumber: '1',
                            totalMarks: 6,
                            parentQuestionMarks: 6,
                            subQuestionNumbers: ['1a', '1b', '1c'],
                            subQuestionMaxScores: { '1a': 2, '1b': 2, '1c': 2 },
                            subQuestionAnswers: ['(1a) 1', '(1b) 2', '(1c) 3'],
                            questionMarks: {
                                subQuestionMarks: {
                                    '1a': [{ mark: 'B2' }],
                                    '1b': [{ mark: 'M1' }, { mark: 'A1' }],
                                    '1c': [{ mark: 'B2' }]
                                }
                            },
                            questionDetection: { found: true, match: { markingScheme: 'M1 A1', paperTitle: '8MA0/01' } }
                        }
                    ]
                ])
            })
            .mockResolvedValueOnce({
                markingSchemesMap: new Map([
                    [
                        '1_Edexcel_8MA0/01',
                        {
                            isGeneric: false,
                            questionNumber: '1',
                            totalMarks: 4,
                            parentQuestionMarks: 4,
                            subQuestionNumbers: ['1d'],
                            subQuestionMaxScores: { '1d': 4 },
                            subQuestionAnswers: ['(1d) 4'],
                            questionMarks: {
                                subQuestionMarks: {
                                    '1d': [{ mark: 'M2' }, { mark: 'A2' }]
                                }
                            },
                            questionDetection: { found: true, match: { markingScheme: 'M2 A2', paperTitle: '8MA0/01' } }
                        }
                    ],
                    [
                        '2_Edexcel_8MA0/01',
                        {
                            isGeneric: false,
                            questionNumber: '2',
                            totalMarks: 5,
                            questionDetection: { found: true, match: { markingScheme: 'B5', paperTitle: '8MA0/01' } }
                        }
                    ]
                ])
            });

        const questions = [
            { questionNumber: '1a' },
            { questionNumber: '1b' },
            { questionNumber: '1c' },
            { questionNumber: '1d' },
            { questionNumber: '2' }
        ];
        const result = await runFastDbPreCheck({
            individualQuestions: questions,
            classificationResult: { reasoning: 'Edexcel 8MA0/01' },
            effectiveExamPaperHint: '8MA0/01',
            paperExistsInDatabaseFn: paperExistsMock,
            orchestrateLookupFn: orchestrateMock
        });

        expect(result).toBeTruthy();
        expect(result?.markingSchemesMap.size).toBe(2);
        const q1Entry = result?.markingSchemesMap.get('1_Edexcel_8MA0/01');
        expect(q1Entry.subQuestionNumbers).toEqual(['1a', '1b', '1c', '1d']);
        expect(q1Entry.subQuestionMaxScores).toEqual({ '1a': 2, '1b': 2, '1c': 2, '1d': 4 });
        expect(Object.keys(q1Entry.questionMarks.subQuestionMarks)).toEqual(['1a', '1b', '1c', '1d']);
        expect(q1Entry.totalMarks).toBe(10);
        expect(q1Entry.parentQuestionMarks).toBe(10);
    });
});
