import { jest } from '@jest/globals';
import {
    collapseCompatibleSubjectAliases,
    hasUnofficialPaperIndicators,
    areSubjectsCompatible,
    isWhitelistedOfficialExamBoard,
    isArchiveHostWatermarkOnly,
    sanitizeUnofficialPaperFlag,
    hasVerifiedUnofficialGeometryFlag
} from '../services/marking/MarkingHelpers.js';
import { MarkingSchemeParserService, mergeParsedSchemeChunks } from '../services/marking/MarkingSchemeParserService.js';
import { QuestionDetectionService } from '../services/marking/questionDetectionService.js';
import * as firebaseConfig from '../config/firebase.js';

function makeOfficialScheme(overrides: Record<string, any> = {}) {
    return {
        examDetails: {
            board: 'AQA',
            paperCode: '8464/B/1F',
            subject: 'Combined Science: Trilogy',
            qualification: 'GCSE',
            tier: 'Foundation',
            exam_series: 'June 2024',
            paperTotalMarks: 70,
            ...(overrides.examDetails || {})
        },
        subQuestionMaxScores: overrides.subQuestionMaxScores || { '1.1': 2, '2.1': 3, '3.1': 4 },
        questions: overrides.questions || {
            '1.1': { answer: 'Mitosis', marks: [{ mark: 'B1', answer: 'Mitosis', comments: '' }, { mark: 'B1', answer: 'Cell division', comments: '' }] },
            '2.1': { answer: 'Osmosis', marks: [{ mark: 'B1', answer: 'Water movement', comments: '' }] },
            '3.1': { answer: 'Photosynthesis', marks: [{ mark: 'B1', answer: 'Light energy', comments: '' }] }
        },
        generalMarkingGuidance: overrides.generalMarkingGuidance || '',
        ...overrides
    };
}

describe('Official scheme guards, subject alias collapsing, and 3-segment paper lookup', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('collapseCompatibleSubjectAliases', () => {
        it('collapses Combined Science aliases emitted across pages into a single canonical subject', () => {
            expect(
                collapseCompatibleSubjectAliases(['Combined Science: Trilogy', 'Biology', 'Combined Science'])
            ).toEqual(['Combined Science: Trilogy']);

            expect(
                collapseCompatibleSubjectAliases(['Biology', 'Combined Science', 'Chemistry'])
            ).toEqual(['Combined Science']);
        });

        it('collapses bare Science with a single specific science', () => {
            expect(collapseCompatibleSubjectAliases(['Science', 'Biology'])).toEqual(['Biology']);
        });

        it('keeps genuinely distinct subjects separate', () => {
            expect(collapseCompatibleSubjectAliases(['Biology', 'Chemistry'])).toEqual(['Biology', 'Chemistry']);
            expect(collapseCompatibleSubjectAliases(['Combined Science: Trilogy', 'History'])).toEqual([
                'Combined Science: Trilogy',
                'History'
            ]);
        });
    });

    describe('areSubjectsCompatible', () => {
        it('treats Combined Science and Biology/Chemistry/Physics as compatible', () => {
            expect(areSubjectsCompatible('Biology', 'Combined Science: Trilogy')).toBe(true);
            expect(areSubjectsCompatible('Combined Science', 'Physics')).toBe(true);
            expect(areSubjectsCompatible('History', 'Biology')).toBe(false);
        });
    });

    describe('hasUnofficialPaperIndicators', () => {
        it('detects practice/mock/rewritten/MarkMe indicators', () => {
            expect(hasUnofficialPaperIndicators('AQA 8464/B/1F Practice Paper June 2024 Format')).toBe(true);
            expect(hasUnofficialPaperIndicators('Rewritten questions modelled on AQA past paper')).toBe(true);
            expect(hasUnofficialPaperIndicators('Not produced or endorsed by AQA')).toBe(true);
            expect(hasUnofficialPaperIndicators('Not affiliated with AQA')).toBe(true);
            expect(hasUnofficialPaperIndicators('Not endorsed or produced by Edexcel')).toBe(true);
            expect(hasUnofficialPaperIndicators('MarkMe GCSE Biology Mock Paper')).toBe(true);
        });

        it('does not false-positive on genuine official past paper text or archive host watermarks (PapaCambridge, GCE Guide, PMT)', () => {
            expect(
                hasUnofficialPaperIndicators(
                    'AQA GCSE COMBINED SCIENCE: TRILOGY 8464/B/1F Foundation Tier Biology Paper 1F June 2024'
                )
            ).toBe(false);
            expect(hasUnofficialPaperIndicators('Based on Table 1, describe good farming practice.')).toBe(false);
            expect(
                hasUnofficialPaperIndicators(
                    'PapaCambridge · papacambridge.com | 0610/41 Question Paper June 2026 © Cambridge University Press & Assessment 2026'
                )
            ).toBe(false);
            expect(hasUnofficialPaperIndicators('Downloaded from GCE Guide (gceguide.com) / Dynamic Papers')).toBe(false);
            expect(hasUnofficialPaperIndicators('Physics & Maths Tutor (pmt.education) — AQA 8461/1H')).toBe(false);
            // However, if an archive host distributes a Predicted / Guess / Practice paper, it MUST be blocked:
            expect(hasUnofficialPaperIndicators('PapaCambridge Guess Paper June 2026 0610/41')).toBe(true);
            expect(hasUnofficialPaperIndicators('Physics & Maths Tutor Predicted Paper June 2025')).toBe(true);
        });

        it('whitelists official exam boards and exempts archive-host watermarks from unofficial flags', () => {
            expect(isWhitelistedOfficialExamBoard('CIE')).toBe(true);
            expect(isWhitelistedOfficialExamBoard('Cambridge Assessment International Education')).toBe(true);
            expect(isWhitelistedOfficialExamBoard('AQA')).toBe(true);
            expect(isWhitelistedOfficialExamBoard('Pearson Edexcel')).toBe(true);
            expect(isWhitelistedOfficialExamBoard('OCR')).toBe(true);
            expect(isWhitelistedOfficialExamBoard('Custom')).toBe(false);

            expect(isArchiveHostWatermarkOnly('PapaCambridge · papacambridge.com')).toBe(true);
            expect(isArchiveHostWatermarkOnly('GCE Guide')).toBe(true);
            expect(isArchiveHostWatermarkOnly('Physics & Maths Tutor')).toBe(true);
            expect(isArchiveHostWatermarkOnly('MarkMe Practice Paper')).toBe(false);
            expect(isArchiveHostWatermarkOnly('PapaCambridge Guess Paper')).toBe(false);

            expect(
                sanitizeUnofficialPaperFlag(true, 'PapaCambridge · papacambridge.com')
            ).toEqual({ isUnofficial: false, reason: undefined });
            expect(
                sanitizeUnofficialPaperFlag(true, 'MarkMe Practice Paper')
            ).toEqual({ isUnofficial: true, reason: 'MarkMe Practice Paper' });

            // 20-page official CIE paper where 3 pages were flagged by LLM due to PapaCambridge watermark
            // and 1 page had an empty-reason false positive -> should NOT be flagged as unofficial
            const twentyPagesWithPapaCambridge = [
                { is_unofficial_or_practice_paper: true, unofficial_reason: 'PapaCambridge · papacambridge.com' },
                { is_unofficial_or_practice_paper: true, unofficial_reason: 'papacambridge.com' },
                { is_unofficial_or_practice_paper: true, unofficial_reason: '' },
                ...Array.from({ length: 17 }, () => ({ is_unofficial_or_practice_paper: false, unofficial_reason: '' }))
            ];
            expect(hasVerifiedUnofficialGeometryFlag(twentyPagesWithPapaCambridge)).toBe(false);

            // Real practice paper with explicit non-archive reason -> flagged as unofficial
            expect(
                hasVerifiedUnofficialGeometryFlag([
                    { is_unofficial_or_practice_paper: true, unofficial_reason: '13.1 Applied Test' },
                    { is_unofficial_or_practice_paper: false, unofficial_reason: '' }
                ])
            ).toBe(true);
        });
    });

    describe('MarkingSchemeParserService.isOfficialPastPaperScheme', () => {
        it('accepts a genuine official past paper scheme', () => {
            expect(MarkingSchemeParserService.isOfficialPastPaperScheme(makeOfficialScheme())).toBe(true);
        });

        it('rejects schemes with unofficial indicators in metadata, guidance, or questions', () => {
            expect(
                MarkingSchemeParserService.isOfficialPastPaperScheme(
                    makeOfficialScheme({ examDetails: { exam_series: 'June 2024 Format' } })
                )
            ).toBe(false);

            expect(
                MarkingSchemeParserService.isOfficialPastPaperScheme(
                    makeOfficialScheme({ generalMarkingGuidance: 'Practice paper modelled on AQA 8464/B/1F' })
                )
            ).toBe(false);

            expect(
                MarkingSchemeParserService.isOfficialPastPaperScheme(
                    makeOfficialScheme({
                        questions: {
                            '1.1': { answer: 'A', guidance: 'Rewritten questions — not produced or endorsed by AQA' },
                            '2.1': { answer: 'B' },
                            '3.1': { answer: 'C' }
                        }
                    })
                )
            ).toBe(false);

            expect(
                MarkingSchemeParserService.isOfficialPastPaperScheme(
                    makeOfficialScheme({ examDetails: { isPractice: true } })
                )
            ).toBe(false);
        });
    });

    describe('MarkingSchemeParserService.persistOfficialPastPaperIfComplete', () => {
        it('refuses to persist when extractedQuestions indicate an unofficial practice paper, and ignores unreliable filenames', async () => {
            const firestoreSpy = jest.spyOn(firebaseConfig, 'getFirestore').mockReturnValue(null as any);
            const scheme = makeOfficialScheme();

            const resByQuestionText = await MarkingSchemeParserService.persistOfficialPastPaperIfComplete({
                parsedScheme: scheme,
                extractedQuestions: [
                    { questionNumber: '1.1', text: 'Practice Paper — Rewritten Questions modelled on AQA' },
                    { questionNumber: '2.1', text: 'Q2' },
                    { questionNumber: '3.1', text: 'Q3' }
                ],
                paperStatedTotal: 9,
                auditContext: { sourceFileName: 'student_upload.pdf' }
            });
            expect(resByQuestionText.persisted).toBe(false);
            expect(firestoreSpy).not.toHaveBeenCalled();

            // Unreliable filename alone should NOT block an otherwise official paper
            const resByFilenameOnly = await MarkingSchemeParserService.persistOfficialPastPaperIfComplete({
                parsedScheme: scheme,
                extractedQuestions: [
                    { questionNumber: '1.1', text: 'Q1' },
                    { questionNumber: '2.1', text: 'Q2' },
                    { questionNumber: '3.1', text: 'Q3' }
                ],
                paperStatedTotal: 9,
                auditContext: { sourceFileName: 'MarkMe_8464_B_1F_Practice_Paper.pdf' }
            });
            expect(resByFilenameOnly.persisted).toBe(true);
        });
    });

    describe('MarkingSchemeParserService.findCatalogedSchemeByPaperHint', () => {
        it('matches 3-segment paper codes (8464/B/1F) even when 2-segment 8464/B appears earlier in hints', async () => {
            const scheme1F = makeOfficialScheme({ examDetails: { paperCode: '8464/B/1F', exam_series: 'June 2024' } });
            const scheme1H = makeOfficialScheme({ examDetails: { paperCode: '8464/B/1H', exam_series: 'June 2024' } });

            jest.spyOn(QuestionDetectionService, 'getInstance').mockReturnValue({
                getMarkingSchemesList: jest.fn(async () => [scheme1H, scheme1F])
            } as any);

            const found = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                'Page 1: 8464/B Biology ... Cover: AQA 8464/B/1F June 2024',
                'Biology',
                'June 2024'
            );
            expect(found).not.toBeNull();
            expect(found.examDetails.paperCode).toBe('8464/B/1F');
        });

        it('does not dangerously match 2-segment 8464/B to 8464/B/1H via substring inclusion', async () => {
            const scheme1H = makeOfficialScheme({ examDetails: { paperCode: '8464/B/1H', exam_series: 'June 2024' } });

            jest.spyOn(QuestionDetectionService, 'getInstance').mockReturnValue({
                getMarkingSchemesList: jest.fn(async () => [scheme1H])
            } as any);

            const found = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                '8464/B',
                'Combined Science: Trilogy',
                'June 2024'
            );
            expect(found).toBeNull();
        });

        it('enforces examSeriesHint year and season even when only 1 scheme matches the paper code', async () => {
            const scheme2023 = makeOfficialScheme({ examDetails: { paperCode: '8464/B/1F', exam_series: 'June 2023' } });

            jest.spyOn(QuestionDetectionService, 'getInstance').mockReturnValue({
                getMarkingSchemesList: jest.fn(async () => [scheme2023])
            } as any);

            const wrongYear = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                '8464/B/1F',
                'Combined Science: Trilogy',
                'June 2024'
            );
            expect(wrongYear).toBeNull();

            const wrongSeason = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                '8464/B/1F',
                'Combined Science: Trilogy',
                'November 2023'
            );
            expect(wrongSeason).toBeNull();

            const exactSeries = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                '8464/B/1F',
                'Combined Science: Trilogy',
                'June 2023'
            );
            expect(exactSeries).not.toBeNull();
            expect(exactSeries.examDetails.exam_series).toBe('June 2023');
        });

        it('uses subjectHint to reject incompatible subjects and tie-break compatible ones', async () => {
            const combinedScheme = makeOfficialScheme({
                examDetails: { paperCode: '8464/B/1F', subject: 'Combined Science: Trilogy', exam_series: 'June 2024' }
            });

            jest.spyOn(QuestionDetectionService, 'getInstance').mockReturnValue({
                getMarkingSchemesList: jest.fn(async () => [combinedScheme])
            } as any);

            const incompatible = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                '8464/B/1F',
                'History',
                'June 2024'
            );
            expect(incompatible).toBeNull();

            const compatibleAlias = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                '8464/B/1F',
                'Biology',
                'June 2024'
            );
            expect(compatibleAlias).not.toBeNull();
        });

        it('extracts 3-segment paper codes from underscore filenames and space-separated hints', async () => {
            const scheme1F = makeOfficialScheme({ examDetails: { paperCode: '8464/B/1F', exam_series: 'June 2023' } });

            jest.spyOn(QuestionDetectionService, 'getInstance').mockReturnValue({
                getMarkingSchemesList: jest.fn(async () => [scheme1F])
            } as any);

            const fromFilename = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                'AQA_8464_B_1F_June_2023.pdf',
                'Combined Science: Trilogy',
                'June 2023'
            );
            expect(fromFilename).not.toBeNull();
            expect(fromFilename.examDetails.paperCode).toBe('8464/B/1F');

            const fromSpaces = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                'AQA 8464 B 1F June 2023',
                'Combined Science: Trilogy',
                'June 2023'
            );
            expect(fromSpaces).not.toBeNull();
            expect(fromSpaces.examDetails.paperCode).toBe('8464/B/1F');
        });

        it('never returns cataloged schemes flagged as unofficial or containing unofficial disclaimer/notes', async () => {
            const unofficialFlagged = makeOfficialScheme({
                examDetails: { paperCode: '8464/B/1F', exam_series: 'June 2024', isOfficial: false }
            });
            const unofficialPracticeFlagged = makeOfficialScheme({
                examDetails: { paperCode: '8464/B/1F', exam_series: 'June 2024', isUnofficialOrPractice: true }
            });
            const unofficialDisclaimer = makeOfficialScheme({
                examDetails: { paperCode: '8464/B/1F', exam_series: 'June 2024', disclaimer: 'Not affiliated with AQA' }
            });
            const unofficialSourceDisclaimer = makeOfficialScheme({
                examDetails: { paperCode: '8464/B/1F', exam_series: 'June 2024', sourceDisclaimer: 'MarkMe Practice Paper' }
            });

            jest.spyOn(QuestionDetectionService, 'getInstance').mockReturnValue({
                getMarkingSchemesList: jest.fn(async () => [
                    unofficialFlagged,
                    unofficialPracticeFlagged,
                    unofficialDisclaimer,
                    unofficialSourceDisclaimer
                ])
            } as any);

            const found = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
                '8464/B/1F',
                'Combined Science: Trilogy',
                'June 2024'
            );
            expect(found).toBeNull();
        });
    });

    describe('Content-based unofficial/practice guards (V2)', () => {
        it('mergeParsedSchemeChunks preserves isUnofficialOrPractice and sourceDisclaimer across parallel batches', () => {
            const merged = mergeParsedSchemeChunks([
                makeOfficialScheme({
                    examDetails: { isUnofficialOrPractice: false, sourceDisclaimer: '' },
                    subQuestionMaxScores: { '1.1': 3 },
                    questions: { '1.1': { answer: 'A' } }
                }),
                makeOfficialScheme({
                    examDetails: { isUnofficialOrPractice: true, sourceDisclaimer: 'Not produced or endorsed by AQA' },
                    subQuestionMaxScores: { '2.1': 3, '3.1': 3 },
                    questions: { '2.1': { answer: 'B' }, '3.1': { answer: 'C' } }
                })
            ]);
            expect(merged.examDetails.isUnofficialOrPractice).toBe(true);
            expect(merged.examDetails.sourceDisclaimer).toContain('Not produced or endorsed by AQA');
            expect(MarkingSchemeParserService.isOfficialPastPaperScheme(merged)).toBe(false);
        });

        it('persistOfficialPastPaperIfComplete blocks persistence via geometry flag or OCR footer text even with generic filenames', async () => {
            const firestoreSpy = jest.spyOn(firebaseConfig, 'getFirestore').mockReturnValue(null as any);
            const scheme = makeOfficialScheme();
            const cleanQuestions = [
                { questionNumber: '1.1', text: 'Label Figure 1 with the names of parts A, B and C.' },
                { questionNumber: '2.1', text: 'Why did the student include a test with the fan switched off?' },
                { questionNumber: '3.1', text: 'What was the independent variable in this investigation?' }
            ];

            const resByGeoFlag = await MarkingSchemeParserService.persistOfficialPastPaperIfComplete({
                parsedScheme: scheme,
                extractedQuestions: cleanQuestions,
                paperStatedTotal: 9,
                isUnofficialOrPracticePaper: true,
                auditContext: { sourceFileName: 'document.pdf' }
            });
            expect(resByGeoFlag.persisted).toBe(false);

            const resByOcrFooter = await MarkingSchemeParserService.persistOfficialPastPaperIfComplete({
                parsedScheme: scheme,
                extractedQuestions: cleanQuestions,
                paperStatedTotal: 9,
                isUnofficialOrPracticePaper: false,
                documentEvidenceText: '01.1 Label Figure 1 ... * markme\n07.1 What was the independent variable?',
                auditContext: { sourceFileName: 'scan_1.pdf' }
            });
            expect(resByOcrFooter.persisted).toBe(false);
            expect(firestoreSpy).not.toHaveBeenCalled();

            // Genuine official paper containing "independent variable" still passes
            const resGenuineOfficial = await MarkingSchemeParserService.persistOfficialPastPaperIfComplete({
                parsedScheme: scheme,
                extractedQuestions: cleanQuestions,
                paperStatedTotal: 9,
                isUnofficialOrPracticePaper: false,
                documentEvidenceText: 'AQA GCSE Combined Science: Trilogy 8464/B/1F June 2024\n07.1 What was the independent variable?',
                auditContext: { sourceFileName: 'scan_official.pdf' }
            });
            expect(resGenuineOfficial.persisted).toBe(true);
        });
    });
});
