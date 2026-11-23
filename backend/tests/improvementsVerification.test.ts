import { MarkingSchemeParserService } from '../services/marking/MarkingSchemeParserService.js';
import { CompletionNotificationService } from '../services/CompletionNotificationService.js';
import { PROCESSING_CONSTANTS } from '../config/constants.js';
import * as firebaseConfig from '../config/firebase.js';
import { QuestionDetectionService } from '../services/marking/QuestionDetectionService.js';
import { FirestoreService } from '../services/firestoreService.js';

function makeOfficialScheme(overrides: any = {}) {
    return {
        examDetails: {
            board: 'AQA',
            subject: 'Biology',
            qualification: 'GCSE',
            paperCode: '8464/B/1F',
            tier: 'Foundation',
            exam_series: 'June 2024',
            paperTotalMarks: 6,
            ...(overrides.examDetails || {})
        },
        questions: {
            '1.1': { answer: 'Nucleus', marks: [{ mark: 'B1', reason: 'Nucleus' }] },
            '2.1': { answer: 'Control', marks: [{ mark: 'B1', reason: 'Control' }, { mark: 'B1', reason: 'Comparison' }] },
            '3.1': { answer: 'Light intensity', marks: [{ mark: 'B1', reason: 'Light' }, { mark: 'B1', reason: 'Intensity' }, { mark: 'B1', reason: 'Correct unit' }] },
            ...(overrides.questions || {})
        },
        subQuestionMaxScores: {
            '1.1': 1,
            '2.1': 2,
            '3.1': 3,
            ...(overrides.subQuestionMaxScores || {})
        },
        documentCompleteness: {
            isComplete: true,
            statedTotalMarks: 6,
            ...(overrides.documentCompleteness || {})
        }
    };
}

describe('Improvements Verification', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        CompletionNotificationService.resetForTesting();
    });

    describe('Speed & Concurrency Constants', () => {
        it('sets PROCESSING_CONSTANTS.CONCURRENCY_LIMIT to 10', () => {
            expect(PROCESSING_CONSTANTS.CONCURRENCY_LIMIT).toBe(10);
        });
    });

    describe('Pre-rasterization SHA-256 Mark Scheme PDF cache', () => {
        it('returns a deterministic SHA-256 key and hits memory/Firestore cache without rasterization', async () => {
            const pdfBuf = Buffer.from('%PDF-1.4\n%test-mark-scheme-pdf-bytes\n%%EOF');
            const key1 = MarkingSchemeParserService.computePdfBufferCacheKey([pdfBuf]);
            const key2 = MarkingSchemeParserService.computePdfBufferCacheKey([Buffer.from(pdfBuf)]);
            expect(key1).toBe(key2);
            expect(key1).toHaveLength(64);

            const store = new Map<string, any>();
            const mockDb = {
                collection: (colName: string) => ({
                    doc: (docId: string) => ({
                        get: async () => ({
                            exists: store.has(`${colName}/${docId}`),
                            data: () => store.get(`${colName}/${docId}`)
                        }),
                        set: async (data: any) => {
                            store.set(`${colName}/${docId}`, data);
                        }
                    })
                })
            };
            jest.spyOn(firebaseConfig, 'getFirestore').mockReturnValue(mockDb as any);

            const sampleScheme = makeOfficialScheme();
            await MarkingSchemeParserService.cacheSchemeByPdfBuffers(key1, sampleScheme, 14);
            expect(store.has(`parsedMarkingSchemesCache/${key1}`)).toBe(true);
            expect(store.get(`parsedMarkingSchemesCache/${key1}`).cacheType).toBe('raw_pdf_sha256');

            // Hit from in-memory cache
            const memHit = await MarkingSchemeParserService.getCachedSchemeByPdfBuffers([pdfBuf]);
            expect(memHit.cacheKey).toBe(key1);
            expect(memHit.parsedScheme?.examDetails?.paperCode).toBe('8464/B/1F');

            // Clear memory cache and verify Firestore fallback hit
            (MarkingSchemeParserService as any).memoryCache.delete(key1);
            const fsHit = await MarkingSchemeParserService.getCachedSchemeByPdfBuffers([pdfBuf]);
            expect(fsHit.parsedScheme?.examDetails?.paperCode).toBe('8464/B/1F');
        });
    });

    describe('Decoupled Official Mark Scheme Auto-Catalog', () => {
        it('persists a complete official mark scheme to markingSchemes even on lined-paper uploads without question text', async () => {
            const saveSchemeSpy = jest
                .spyOn(MarkingSchemeParserService, 'saveOfficialSchemeToDatabase')
                .mockResolvedValue('official_aqa_8464_b_1f_june_2024');
            const savePaperSpy = jest
                .spyOn(MarkingSchemeParserService, 'saveOfficialExamPaperQuestionsToDatabase')
                .mockResolvedValue();

            const scheme = makeOfficialScheme();
            // Lined-paper upload: only 1 student question extracted, no printed question text for Q2/Q3
            const res = await MarkingSchemeParserService.persistOfficialPastPaperIfComplete({
                parsedScheme: scheme,
                extractedQuestions: [{ questionNumber: '1.1', text: '' }],
                paperStatedTotal: null,
                isUnofficialOrPracticePaper: false
            });

            expect(res.persisted).toBe(true);
            expect(res.schemePersisted).toBe(true);
            expect(res.paperPersisted).toBe(false);
            expect(saveSchemeSpy).toHaveBeenCalledTimes(1);
            expect(savePaperSpy).not.toHaveBeenCalled();
        });

        it('splits schemeExistsInDatabase vs examPaperExistsInDatabase so a later Question Paper upload still enriches fullExamPapers', async () => {
            const mathScheme = makeOfficialScheme({
                examDetails: {
                    board: 'AQA',
                    subject: 'Mathematics',
                    qualification: 'GCSE',
                    paperCode: '8300/1F',
                    tier: 'Foundation',
                    exam_series: 'June 2024',
                    totalMarks: 6
                }
            });

            // Simulate: markingSchemes ALREADY has 8300/1F (from earlier lined-paper upload),
            // but fullExamPapers does NOT have it yet.
            jest.spyOn(firebaseConfig, 'getFirestore').mockReturnValue(null as any);
            jest.spyOn(QuestionDetectionService, 'getInstance').mockReturnValue({
                getMarkingSchemesList: jest.fn(async () => [mathScheme]),
                getExamPapersList: jest.fn(async () => [])
            } as any);

            expect(await MarkingSchemeParserService.schemeExistsInDatabase('AQA', '8300/1F', 'June 2024')).toBe(true);
            expect(await MarkingSchemeParserService.examPaperExistsInDatabase('AQA', '8300/1F', 'June 2024')).toBe(false);
            expect(await MarkingSchemeParserService.paperExistsInDatabase('AQA', '8300/1F', 'June 2024')).toBe(true);

            const saveSchemeSpy = jest
                .spyOn(MarkingSchemeParserService, 'saveOfficialSchemeToDatabase')
                .mockResolvedValue('official_aqa_8300_1f_june_2024');
            const savePaperSpy = jest
                .spyOn(MarkingSchemeParserService, 'saveOfficialExamPaperQuestionsToDatabase')
                .mockResolvedValue();

            const res = await MarkingSchemeParserService.persistOfficialPastPaperIfComplete({
                parsedScheme: mathScheme,
                extractedQuestions: [
                    { questionNumber: '1.1', text: 'Work out 2 + 3.' },
                    { questionNumber: '2.1', text: 'Solve 2x = 10.' },
                    { questionNumber: '3.1', text: 'Find the area of a square of side 4 cm.' }
                ],
                paperStatedTotal: 6,
                isUnofficialOrPracticePaper: false
            });

            expect(res.persisted).toBe(true);
            expect(res.schemePersisted).toBe(false);
            expect(res.paperPersisted).toBe(true);
            expect(saveSchemeSpy).not.toHaveBeenCalled();
            expect(savePaperSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('CompletionNotificationService (delayed email notification)', () => {
        it('skips short jobs, sends score summary & session URL if unviewed, and cancels when viewed', async () => {
            const prevDelay = process.env.COMPLETION_EMAIL_DELAY_MS;
            const prevMin = process.env.COMPLETION_EMAIL_MIN_JOB_DURATION_MS;
            const prevFrontend = process.env.FRONTEND_URL;

            process.env.COMPLETION_EMAIL_DELAY_MS = '40';
            process.env.COMPLETION_EMAIL_MIN_JOB_DURATION_MS = '30000';
            process.env.FRONTEND_URL = 'https://aimarking.ai';

            const sentMails: any[] = [];
            CompletionNotificationService.setTransporterForTesting({
                sendMail: async (opts: any) => {
                    sentMails.push(opts);
                    return { messageId: 'mock-id' };
                }
            } as any);
            jest.spyOn(FirestoreService, 'getMarkingJob').mockResolvedValue(null);
            jest.spyOn(FirestoreService, 'upsertMarkingJob').mockResolvedValue();

            try {
                // 1. Short job (< 30s) is skipped
                const shortScheduled = CompletionNotificationService.scheduleCompletionEmail({
                    sessionId: 'sess-short',
                    userEmail: 'student@example.com',
                    sessionTitle: 'Quick Question',
                    durationMs: 5000,
                    awardedMarks: 4,
                    totalMarks: 5
                });
                expect(shortScheduled).toBe(false);

                // 2. Long job that gets viewed before delay is cancelled
                const viewedScheduled = CompletionNotificationService.scheduleCompletionEmail({
                    sessionId: 'sess-viewed',
                    userEmail: 'student@example.com',
                    sessionTitle: 'AQA Paper 1',
                    durationMs: 65000,
                    awardedMarks: 50,
                    totalMarks: 80
                });
                expect(viewedScheduled).toBe(true);
                expect(CompletionNotificationService.markSessionViewed('sess-viewed')).toBe(true);

                // 3. Long job left unviewed sends email with score summary & session URL
                const unviewedScheduled = CompletionNotificationService.scheduleCompletionEmail({
                    sessionId: 'sess-unviewed',
                    userEmail: 'student@example.com',
                    userName: 'Alex Smith',
                    sessionTitle: 'AQA 8464/B/1F June 2024',
                    durationMs: 92000,
                    awardedMarks: 42,
                    totalMarks: 60,
                    questionCount: 12,
                    grade: '7'
                });
                expect(unviewedScheduled).toBe(true);

                await new Promise(resolve => setTimeout(resolve, 100));

                expect(sentMails).toHaveLength(1);
                expect(sentMails[0].to).toBe('student@example.com');
                expect(sentMails[0].subject).toContain('AI Marking');
                expect(sentMails[0].text).toContain('42 / 60 (70%)');
                expect(sentMails[0].text).toContain('Grade 7');
                expect(sentMails[0].text).toContain('https://aimarking.ai/app/sess-unviewed');
                expect(sentMails[0].html).toContain('https://aimarking.ai/app/sess-unviewed');
            } finally {
                if (prevDelay === undefined) delete process.env.COMPLETION_EMAIL_DELAY_MS;
                else process.env.COMPLETION_EMAIL_DELAY_MS = prevDelay;
                if (prevMin === undefined) delete process.env.COMPLETION_EMAIL_MIN_JOB_DURATION_MS;
                else process.env.COMPLETION_EMAIL_MIN_JOB_DURATION_MS = prevMin;
                if (prevFrontend === undefined) delete process.env.FRONTEND_URL;
                else process.env.FRONTEND_URL = prevFrontend;
            }
        });
    });
});
