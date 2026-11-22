import { PaperSplitterService } from '../services/marking/PaperSplitterService.js';
import { UserFacingError } from '../utils/UserFacingError.js';
import { getQuestionSortValue } from '../services/marking/MarkingHelpers.js';
import { getBaseQuestionNumber } from '../utils/TextNormalizationUtils.js';
import type { StandardizedPage } from '../types/markingRouter.js';
import type { GeometryAnalysisResult } from '../services/marking/ImageGeometryService.js';

function makeMockPage(pageIndex: number, fileName = `img_${pageIndex}.jpg`, sourceIndex?: number): StandardizedPage {
    const p: StandardizedPage = {
        pageIndex,
        originalPageIndex: pageIndex,
        imageData: `data:image/jpeg;base64,mock_${pageIndex}`,
        originalFileName: fileName,
        width: 800,
        height: 1100
    };
    if (sourceIndex !== undefined) {
        (p as any)._sourceIndex = sourceIndex;
    }
    (p as any)._rawPageIndex = pageIndex;
    return p;
}

function makeMockPdfFile(name: string, content = ''): Express.Multer.File {
    return {
        fieldname: 'files',
        originalname: name,
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: content.length || 128,
        buffer: Buffer.from(content || `%PDF-1.4 ${name}`, 'latin1'),
        destination: '',
        filename: name,
        path: '',
        stream: null as any
    };
}

describe('PaperSplitterService & Multi-PDF Aggregation', () => {
    it('Zero-Regression 1-Paper Fast Path: 23 loose images of 1MA1/1H with out-of-order Qs and noisy hints stay in 1 bucket', () => {
        const qOrder = [21, 19, 15, 12, 8, 4, 2, 1, 3, 5, 6, 7, 9, 10, 11, 13, 14, 16, 17, 18, 20, 22, 0];
        const pages = qOrder.map((_, idx) => makeMockPage(idx, `scan_${idx}.jpg`));
        const geo: GeometryAnalysisResult[] = qOrder.map((q, idx) => ({
            is_acceptable_quality: true,
            needs_rotation: 0,
            is_two_page_spread: false,
            is_marking_scheme: false,
            is_supported_doc: true,
            detected_subject: idx === 5 ? 'UNSUPPORTED_SUBJECT' : 'MATHS',
            unsupported_subject_name: idx === 5 ? 'Physics' : undefined,
            paper_code_hint: q === 0 ? '1MA1/1H' : (idx === 10 ? '1MA1/2H' : 'P74082A0224'),
            is_cover_page: q === 0,
            booklet_page_number: q === 0 ? 1 : q + 1,
            first_question_number: q === 0 ? undefined : q
        }));

        const buckets = PaperSplitterService.splitIntoPaperBuckets({
            standardizedPages: pages,
            lightweightPages: pages,
            geometryResults: geo,
            interceptedSchemeImages: [],
            deferredSchemePdfFiles: [],
            files: []
        });

        expect(buckets).toHaveLength(1);
        expect(buckets[0].standardizedPages).toHaveLength(23);
        expect(buckets[0].paperLabel).toBe('1MA1/1H');
    });

    it('Zero-Regression 1-Paper Fast Path: 1 student PDF (24p) + 1 mark scheme PDF stay in 1 bucket with MS attached', () => {
        const pages = Array.from({ length: 24 }, (_, i) => makeMockPage(i, 'edexcel-1ma1-1h.pdf', 0));
        const geo: GeometryAnalysisResult[] = pages.map((_, i) => ({
            is_acceptable_quality: true,
            needs_rotation: 0,
            is_two_page_spread: false,
            is_marking_scheme: false,
            is_supported_doc: true,
            detected_subject: 'MATHS',
            paper_code_hint: i === 0 ? '1MA1/1H' : 'P74082A0224',
            is_cover_page: i === 0
        }));
        const msFile = makeMockPdfFile('1MA1-1H-MS.pdf');

        const buckets = PaperSplitterService.splitIntoPaperBuckets({
            standardizedPages: pages,
            lightweightPages: pages,
            geometryResults: geo,
            interceptedSchemeImages: [],
            deferredSchemePdfFiles: [msFile],
            files: [makeMockPdfFile('edexcel-1ma1-1h.pdf'), msFile]
        });

        expect(buckets).toHaveLength(1);
        expect(buckets[0].standardizedPages).toHaveLength(24);
        expect(buckets[0].deferredSchemePdfFiles).toHaveLength(1);
        expect(buckets[0].deferredSchemePdfFiles[0].originalname).toBe('1MA1-1H-MS.pdf');
    });

    it('splitIntoPaperBuckets never rejects loose images (even 65 loose images or noisy barcodes/covers/filenames)', () => {
        const pages = Array.from({ length: 65 }, (_, i) => makeMockPage(i, i < 30 ? `1MA1-1H-${i}.jpg` : `1MA1-2H-${i}.jpg`));
        const geo: GeometryAnalysisResult[] = pages.map((_, i) => ({
            is_acceptable_quality: true,
            needs_rotation: 0,
            is_two_page_spread: false,
            is_marking_scheme: false,
            is_supported_doc: true,
            detected_subject: 'MATHS',
            paper_code_hint: i === 0 ? '1MA1/1H' : (i === 30 ? '1MA1/2H' : 'P74082A0224'),
            is_cover_page: i === 0 || i === 30
        }));

        const buckets = PaperSplitterService.splitIntoPaperBuckets({
            standardizedPages: pages,
            lightweightPages: pages,
            geometryResults: geo,
            interceptedSchemeImages: [],
            deferredSchemePdfFiles: [],
            files: []
        });
        expect(buckets).toHaveLength(1);
        expect(buckets[0].standardizedPages).toHaveLength(65);
    });

    it('assertSinglePaperClassification passes on a single 23-page 1MA1/1H paper including multi-page Q3a/Q3b and Q11a-b/Q11c-d', () => {
        const classificationResults = [
            {
                pageIndex: 2,
                result: {
                    category: 'questionAnswer',
                    questions: [{
                        questionNumber: '3',
                        text: 'A shop sells apples in bags of 6 and oranges in bags of 8. Sam buys the same total number of apples and oranges.',
                        subQuestions: [{ part: 'a', text: 'Work out the smallest number of bags of apples Sam can buy.' }]
                    }]
                }
            },
            {
                pageIndex: 3,
                result: {
                    category: 'questionAnswer',
                    questions: [{
                        questionNumber: '3',
                        text: 'Question 3 continued. Each bag of apples costs £1.80 and each bag of oranges costs £2.10.',
                        subQuestions: [{ part: 'b', text: 'Work out the total cost of the fruit Sam buys.' }]
                    }]
                }
            },
            {
                pageIndex: 11,
                result: {
                    category: 'questionAnswer',
                    questions: [{
                        questionNumber: '11',
                        text: 'The cumulative frequency graph shows information about the weights of 80 parcels delivered by a courier.',
                        subQuestions: [{ part: 'a', text: 'Find an estimate for the median weight.' }, { part: 'b', text: 'Find the interquartile range.' }]
                    }]
                }
            },
            {
                pageIndex: 12,
                result: {
                    category: 'questionAnswer',
                    questions: [{
                        questionNumber: '11',
                        text: 'Question 11 continued. A box plot is drawn for the weights of the 80 parcels.',
                        subQuestions: [{ part: 'c', text: 'Compare the distribution of parcel weights.' }, { part: 'd', text: 'State one assumption you made.' }]
                    }]
                }
            }
        ];

        expect(() => PaperSplitterService.assertSinglePaperClassification(classificationResults, { isPdf: false, pageCount: 23 })).not.toThrow();
    });

    it('assertSinglePaperClassification passes when duplicate question numbers have empty text (handwritten continuation sheet)', () => {
        const classificationResults = [
            {
                pageIndex: 0,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: 'Solve the simultaneous equations 3x + 2y = 12 and 5x - y = 7 algebraically.' },
                        { questionNumber: '2', text: 'A triangle ABC has sides AB = 8 cm, BC = 11 cm and angle ABC = 42 degrees.' }
                    ]
                }
            },
            {
                pageIndex: 1,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: '' },
                        { questionNumber: '2', text: '   ' }
                    ]
                }
            }
        ];

        expect(() => PaperSplitterService.assertSinglePaperClassification(classificationResults, { isPdf: false, pageCount: 2 })).not.toThrow();
    });

    it('assertSinglePaperClassification throws MULTI_PAPER_LOOSE_IMAGES_NOT_SUPPORTED when loose images contain 1MA1/1H and 1MA1/2H (different Q1 & Q2 stems)', () => {
        const classificationResults = [
            {
                pageIndex: 0,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: 'Write 84 as a product of its prime factors in index form.' },
                        { questionNumber: '2', text: 'Reflect triangle T in the line x = -1 and label the new triangle R.' }
                    ]
                }
            },
            {
                pageIndex: 23,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: 'Expand and simplify the expression 4(2x - 3) + 5(x + 2) completely.' },
                        { questionNumber: '2', text: 'A train travels 240 kilometres in 3 hours and 20 minutes. Calculate its average speed.' }
                    ]
                }
            }
        ];

        let caught: any;
        try {
            PaperSplitterService.assertSinglePaperClassification(classificationResults, { isPdf: false, pageCount: 47 });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(UserFacingError);
        expect(caught.code).toBe('MULTI_PAPER_LOOSE_IMAGES_NOT_SUPPORTED');
    });

    it('assertSinglePaperClassification throws COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED when isPdf: true and Q1 & Q2 have different stems', () => {
        const classificationResults = [
            {
                pageIndex: 0,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: 'Write 84 as a product of its prime factors in index form.' },
                        { questionNumber: '2', text: 'Reflect triangle T in the line x = -1 and label the new triangle R.' }
                    ]
                }
            },
            {
                pageIndex: 24,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: 'Expand and simplify the expression 4(2x - 3) + 5(x + 2) completely.' },
                        { questionNumber: '2', text: 'A train travels 240 kilometres in 3 hours and 20 minutes. Calculate its average speed.' }
                    ]
                }
            }
        ];

        let caught: any;
        try {
            PaperSplitterService.assertSinglePaperClassification(classificationResults, { isPdf: true, pageCount: 48, fileName: 'combined-maths.pdf' });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(UserFacingError);
        expect(caught.code).toBe('COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED');
    });

    it('assertSinglePaperClassification catches multi-paper uploads when q.text is null and prompts live inside subQuestions[0].text (e.g. Q2a and Q17a)', () => {
        const classificationResults = [
            {
                pageIndex: 1,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        {
                            questionNumber: '2',
                            text: null,
                            subQuestions: [{ part: 'a', text: 'Write the ratio 18 : 24 : 30 in its simplest whole number form.' }]
                        },
                        {
                            questionNumber: '17',
                            text: null,
                            subQuestions: [{ part: 'a', text: 'Prove algebraically that the straight line x + 2y = 10 is a tangent to the circle.' }]
                        }
                    ]
                }
            },
            {
                pageIndex: 24,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        {
                            questionNumber: '2',
                            text: null,
                            subQuestions: [{ part: 'a', text: 'Convert 4.5 kilometres per hour into metres per minute accurately.' }]
                        },
                        {
                            questionNumber: '17',
                            text: null,
                            subQuestions: [{ part: 'a', text: 'A pyramid has a square base of side 12 cm and perpendicular height 15 cm. Calculate its volume.' }]
                        }
                    ]
                }
            }
        ];

        let caught: any;
        try {
            PaperSplitterService.assertSinglePaperClassification(classificationResults, { isPdf: false, pageCount: 47 });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(UserFacingError);
        expect(caught.code).toBe('MULTI_PAPER_LOOSE_IMAGES_NOT_SUPPORTED');
    });

    it('assertSinglePaperClassification ignores continuation pages with subQuestions: [] and "Question N continued" text', () => {
        const classificationResults = [
            {
                pageIndex: 4,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        {
                            questionNumber: '5',
                            text: 'A regular pentagon and a regular hexagon share a common side AB. Calculate the interior angle.',
                            subQuestions: []
                        },
                        {
                            questionNumber: '6',
                            text: 'The scatter graph shows the height and shoe size of 15 students in Year 11.',
                            subQuestions: []
                        }
                    ]
                }
            },
            {
                pageIndex: 5,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        {
                            questionNumber: '5',
                            text: 'Question 5 continued. Complete the rest of the proof using angles on a straight line.',
                            subQuestions: []
                        },
                        {
                            questionNumber: '6',
                            text: '(b) Draw a line of best fit on the scatter graph and estimate the shoe size for height 172 cm.',
                            subQuestions: []
                        }
                    ]
                }
            }
        ];

        expect(() => PaperSplitterService.assertSinglePaperClassification(classificationResults, { isPdf: false, pageCount: 23 })).not.toThrow();
    });

    it('Deterministic Multi-PDF Bucketing: 3 student PDFs produce 3 buckets in exact PDF order', () => {
        const specs = [
            { src: 0, name: '1MA1-1H.pdf', code: '1MA1/1H', count: 22 },
            { src: 1, name: '1MA1-2H.pdf', code: '1MA1/2H', count: 22 },
            { src: 2, name: '1MA1-3H.pdf', code: '1MA1/3H', count: 21 }
        ];
        const pages: StandardizedPage[] = [];
        const geo: GeometryAnalysisResult[] = [];
        specs.forEach(s => {
            for (let i = 0; i < s.count; i++) {
                pages.push(makeMockPage(pages.length, s.name, s.src));
                geo.push({
                    is_acceptable_quality: true,
                    needs_rotation: 0,
                    is_two_page_spread: false,
                    is_marking_scheme: false,
                    is_supported_doc: true,
                    detected_subject: 'MATHS',
                    paper_code_hint: i === 0 ? s.code : undefined,
                    is_cover_page: i === 0
                });
            }
        });

        const buckets = PaperSplitterService.splitIntoPaperBuckets({
            standardizedPages: pages,
            lightweightPages: pages,
            geometryResults: geo,
            interceptedSchemeImages: [],
            deferredSchemePdfFiles: [],
            files: specs.map(s => makeMockPdfFile(s.name))
        });

        expect(buckets).toHaveLength(3);
        expect(buckets[0].paperLabel).toBe('1MA1/1H');
        expect(buckets[0].standardizedPages).toHaveLength(22);
        expect(buckets[1].paperLabel).toBe('1MA1/2H');
        expect(buckets[1].standardizedPages).toHaveLength(22);
        expect(buckets[2].paperLabel).toBe('1MA1/3H');
        expect(buckets[2].standardizedPages).toHaveLength(21);
    });

    it('Order-Independent Mark Scheme Pairing: 3 student PDFs + 3 out-of-order MS PDFs pair by paper code', () => {
        const pdfNames = ['1MA1-1H.pdf', '1MA1-2H.pdf', '1MA1-3H.pdf'];
        const pages: StandardizedPage[] = [];
        const geo: GeometryAnalysisResult[] = [];
        pdfNames.forEach((name, srcIdx) => {
            for (let i = 0; i < 4; i++) {
                pages.push(makeMockPage(pages.length, name, srcIdx));
                geo.push({
                    is_acceptable_quality: true,
                    needs_rotation: 0,
                    is_two_page_spread: false,
                    is_marking_scheme: false,
                    is_supported_doc: true,
                    detected_subject: 'MATHS',
                    is_cover_page: i === 0
                });
            }
        });

        const msFiles = [
            makeMockPdfFile('1MA1-3H-MS.pdf'),
            makeMockPdfFile('1MA1-1H-MS.pdf'),
            makeMockPdfFile('1MA1-2H-MS.pdf')
        ];

        const buckets = PaperSplitterService.splitIntoPaperBuckets({
            standardizedPages: pages,
            lightweightPages: pages,
            geometryResults: geo,
            interceptedSchemeImages: [],
            deferredSchemePdfFiles: msFiles,
            files: [...pdfNames.map(n => makeMockPdfFile(n)), ...msFiles]
        });

        expect(buckets).toHaveLength(3);
        expect(buckets[0].deferredSchemePdfFiles.map(f => f.originalname).join(',')).toBe('1MA1-1H-MS.pdf');
        expect(buckets[1].deferredSchemePdfFiles.map(f => f.originalname).join(',')).toBe('1MA1-2H-MS.pdf');
        expect(buckets[2].deferredSchemePdfFiles.map(f => f.originalname).join(',')).toBe('1MA1-3H-MS.pdf');
    });

    it('Partial Mark Scheme Pairing: 3 student PDFs + 1 MS PDF (1MA1-2H-MS.pdf) pairs ONLY to Bucket 1', () => {
        const pdfNames = ['1MA1-1H.pdf', '1MA1-2H.pdf', '1MA1-3H.pdf'];
        const pages: StandardizedPage[] = [];
        const geo: GeometryAnalysisResult[] = [];
        pdfNames.forEach((name, srcIdx) => {
            for (let i = 0; i < 4; i++) {
                pages.push(makeMockPage(pages.length, name, srcIdx));
                geo.push({
                    is_acceptable_quality: true,
                    needs_rotation: 0,
                    is_two_page_spread: false,
                    is_marking_scheme: false,
                    is_supported_doc: true,
                    detected_subject: 'MATHS',
                    is_cover_page: i === 0
                });
            }
        });

        const ms2 = makeMockPdfFile('1MA1-2H-MS.pdf');
        const buckets = PaperSplitterService.splitIntoPaperBuckets({
            standardizedPages: pages,
            lightweightPages: pages,
            geometryResults: geo,
            interceptedSchemeImages: [],
            deferredSchemePdfFiles: [ms2],
            files: [...pdfNames.map(n => makeMockPdfFile(n)), ms2]
        });

        expect(buckets).toHaveLength(3);
        expect(buckets[0].deferredSchemePdfFiles).toHaveLength(0);
        expect(buckets[1].deferredSchemePdfFiles).toHaveLength(1);
        expect(buckets[1].deferredSchemePdfFiles[0].originalname).toBe('1MA1-2H-MS.pdf');
        expect(buckets[2].deferredSchemePdfFiles).toHaveLength(0);
    });

    it('aggregateMultiPaperResults offsets page indices, prefixes Q numbers, and differentiates Same-Subject vs Cross-Subject/Year/Tier summaries', async () => {
        const makeSubResult = (
            idx: number,
            code: string,
            subjectKey: string,
            subjectName: string,
            awarded: number,
            total: number,
            pageCount: number,
            examSeries: string = 'Nov 2026',
            tier: string = 'Higher'
        ) => ({
            paperIndex: idx,
            paperLabel: code,
            sortedStandardizedPages: Array.from({ length: pageCount }, (_, i) => makeMockPage(i)),
            updatedQuestionResults: [
                {
                    questionNumber: '1',
                    pageIndex: 1,
                    sourceImageIndices: [1],
                    score: { awardedMarks: awarded, totalMarks: total, scoreText: `${awarded}/${total}` },
                    marks: total,
                    awardedMarks: awarded,
                    totalMarks: total,
                    annotations: [{ text: 'M1', pageIndex: 1, subQuestion: '1a' }]
                } as any
            ],
            classificationResult: { questions: [{ questionNumber: '1', pageIndex: 1, sourceImageIndex: 1 }] },
            allClassificationResults: [{ pageIndex: 1, result: { questions: [] } }],
            markingSchemesMap: new Map([['1_Edexcel', { totalMarks: total }]]),
            reindexedDetectionResults: [
                {
                    question: { questionNumber: '1', sourceImageIndex: 1 },
                    detectionResult: {
                        found: true,
                        match: { board: 'Edexcel', paperCode: code, subject: subjectName, examSeries, tier }
                    }
                }
            ],
            finalAnnotatedOutput: Array.from({ length: pageCount }, (_, i) => `annotated_${code}_${i}`),
            overallScore: awarded,
            totalPossibleScore: total,
            overallScoreText: `${awarded}/${total}`,
            allPagesOcrData: [{ pageIndex: 0, ocrData: { mathBlocks: [] } } as any],
            combinedQuestionResponses: [],
            subjectProfile: { key: subjectKey, displayName: subjectName },
            precomputedPerformanceSummaryPromise: Promise.resolve({
                summary: JSON.stringify({
                    _type: 'AI_SUMMARY_V2',
                    level: 'GCSE',
                    subjectKey,
                    examInfo: { examBoard: 'Edexcel', subject: subjectName, examCode: code, examSeries, tier },
                    score: { awardedMarks: awarded, totalMarks: total, percentage: Math.round((awarded / total) * 100), questionsTotal: 20, questionsFullMarks: 15, questionsAttempted: 20 },
                    grading: { grade: 'Grade 8', predictedGrade: 'Grade 8', boundaries: { '9': 68, '8': 58, '7': 48 } },
                    radar: [
                        { axis: 'Number', score: 80, awarded: 16, total: 20, assessed: true },
                        { axis: 'Algebra', score: 75, awarded: 15, total: 20, assessed: true },
                        { axis: 'Geometry', score: 70, awarded: 14, total: 20, assessed: true }
                    ],
                    mastered: [{ q: '1', text: `Mastered in ${code}` }],
                    focusNext: [{ q: '2', text: `Focus in ${code}` }],
                    questionCoaching: [{ q: '1', awardedMarks: awarded, maxMarks: total, rubricStamp: '', awardedLevel: 0, levelLabel: '', coaching: { rationale: 'ok', nextLevelGap: 'gap' } }]
                }),
                durationMs: 10,
                startTime: Date.now()
            })
        });

        const mathSubs = [
            makeSubResult(0, '1MA1/1H', 'MATHS', 'Mathematics', 68, 80, 22, 'Nov 2026', 'Higher'),
            makeSubResult(1, '1MA1/2H', 'MATHS', 'Mathematics', 62, 80, 22, 'November 2026', 'Higher'),
            makeSubResult(2, '1MA1/3H', 'MATHS', 'Mathematics', 65, 80, 21, 'Nov 2026', 'Higher')
        ];

        const mathAgg = await PaperSplitterService.aggregateMultiPaperResults(mathSubs);
        expect(mathAgg.sortedStandardizedPages).toHaveLength(65);
        expect(mathAgg.overallScore).toBe(195);
        expect(mathAgg.totalPossibleScore).toBe(240);
        expect(mathAgg.updatedQuestionResults[0].questionNumber).toBe('P1·1');
        expect(mathAgg.updatedQuestionResults[0].pageIndex).toBe(1);
        expect(mathAgg.updatedQuestionResults[1].questionNumber).toBe('P2·1');
        expect(mathAgg.updatedQuestionResults[1].pageIndex).toBe(23);
        expect(mathAgg.updatedQuestionResults[2].questionNumber).toBe('P3·1');
        expect(mathAgg.updatedQuestionResults[2].pageIndex).toBe(45);

        const mathSummary = JSON.parse((await mathAgg.precomputedPerformanceSummaryPromise).summary);
        expect(mathSummary.hasCombinedOverview).toBe(true);
        expect(mathSummary.score.awardedMarks).toBe(195);
        expect(mathSummary.score.totalMarks).toBe(240);
        expect(mathSummary.grading.boundaries['9']).toBe(204);
        expect(mathSummary.grading.boundaries['8']).toBe(174);
        expect(mathSummary.grading.grade).toBe('Grade 8');
        expect(mathSummary.paperSummaries).toHaveLength(3);
        expect(mathSummary.mastered[0].q).toBe('P1·1');

        const sciSubs = [
            makeSubResult(0, '8461/1H', 'BIOLOGY', 'Biology', 54, 100, 10),
            makeSubResult(1, '8462/1H', 'CHEMISTRY', 'Chemistry', 72, 100, 10)
        ];
        const sciAgg = await PaperSplitterService.aggregateMultiPaperResults(sciSubs);
        const sciSummary = JSON.parse((await sciAgg.precomputedPerformanceSummaryPromise).summary);
        expect(sciSummary.hasCombinedOverview).toBe(false);
        expect(sciSummary.paperSummaries).toHaveLength(2);

        const diffYearSubs = [
            makeSubResult(0, '1MA1/1H', 'MATHS', 'Mathematics', 68, 80, 22, 'Nov 2025', 'Higher'),
            makeSubResult(1, '1MA1/2H', 'MATHS', 'Mathematics', 62, 80, 22, 'Nov 2026', 'Higher')
        ];
        const diffYearAgg = await PaperSplitterService.aggregateMultiPaperResults(diffYearSubs);
        const diffYearSummary = JSON.parse((await diffYearAgg.precomputedPerformanceSummaryPromise).summary);
        expect(diffYearSummary.hasCombinedOverview).toBe(false);
        expect(diffYearSummary.paperSummaries).toHaveLength(2);

        const diffTierSubs = [
            makeSubResult(0, '1MA1/1H', 'MATHS', 'Mathematics', 68, 80, 22, 'Nov 2026', 'Higher'),
            makeSubResult(1, '1MA1/2F', 'MATHS', 'Mathematics', 62, 80, 22, 'Nov 2026', 'Foundation')
        ];
        const diffTierAgg = await PaperSplitterService.aggregateMultiPaperResults(diffTierSubs);
        const diffTierSummary = JSON.parse((await diffTierAgg.precomputedPerformanceSummaryPromise).summary);
        expect(diffTierSummary.hasCombinedOverview).toBe(false);
        expect(diffTierSummary.paperSummaries).toHaveLength(2);
    });

    it('Subject-Aware Disambiguation: pairs Biology_MS.pdf (no token) and Chemistry_P1_MS.pdf (shared P1 token) accurately', () => {
        const bioPages = Array.from({ length: 4 }, (_, i) => makeMockPage(i, 'Biology_Paper_1.pdf', 0));
        const chemPages = Array.from({ length: 4 }, (_, i) => makeMockPage(4 + i, 'Chemistry_Paper_1.pdf', 1));
        const bioGeo: GeometryAnalysisResult[] = bioPages.map((_, i) => ({
            is_acceptable_quality: true,
            needs_rotation: 0,
            is_two_page_spread: false,
            is_marking_scheme: false,
            is_supported_doc: true,
            detected_subject: 'UNSUPPORTED_SUBJECT',
            unsupported_subject_name: 'Biology',
            is_cover_page: i === 0
        }));
        const chemGeo: GeometryAnalysisResult[] = chemPages.map((_, i) => ({
            is_acceptable_quality: true,
            needs_rotation: 0,
            is_two_page_spread: false,
            is_marking_scheme: false,
            is_supported_doc: true,
            detected_subject: 'UNSUPPORTED_SUBJECT',
            unsupported_subject_name: 'Chemistry',
            is_cover_page: i === 0
        }));

        const chemMs = makeMockPdfFile('Chemistry_P1_MS.pdf');
        const bioMs = makeMockPdfFile('Biology_MS.pdf');

        const buckets = PaperSplitterService.splitIntoPaperBuckets({
            standardizedPages: [...bioPages, ...chemPages],
            lightweightPages: [...bioPages, ...chemPages],
            geometryResults: [...bioGeo, ...chemGeo],
            interceptedSchemeImages: [],
            deferredSchemePdfFiles: [chemMs, bioMs],
            files: [
                makeMockPdfFile('Biology_Paper_1.pdf'),
                makeMockPdfFile('Chemistry_Paper_1.pdf'),
                chemMs,
                bioMs
            ]
        });

        expect(buckets).toHaveLength(2);
        expect(buckets[0].subjectHint).toBe('BIOLOGY');
        expect(buckets[0].deferredSchemePdfFiles.map(f => f.originalname)).toEqual(['Biology_MS.pdf']);
        expect(buckets[1].subjectHint).toBe('CHEMISTRY');
        expect(buckets[1].deferredSchemePdfFiles.map(f => f.originalname)).toEqual(['Chemistry_P1_MS.pdf']);
    });

    it('Stage-2 Intercepted Scheme Ambiguity Guard: throws AMBIGUOUS_MARK_SCHEME_PAIRING when scheme image cannot be uniquely paired', () => {
        const p1 = Array.from({ length: 3 }, (_, i) => makeMockPage(i, '1MA1-1H.pdf', 0));
        const p2 = Array.from({ length: 3 }, (_, i) => makeMockPage(3 + i, '1MA1-2H.pdf', 1));
        const geo: GeometryAnalysisResult[] = [...p1, ...p2].map(() => ({
            is_acceptable_quality: true,
            needs_rotation: 0,
            is_two_page_spread: false,
            is_marking_scheme: false,
            is_supported_doc: true,
            detected_subject: 'MATHS'
        }));

        let caught: any;
        try {
            PaperSplitterService.splitIntoPaperBuckets({
                standardizedPages: [...p1, ...p2],
                lightweightPages: [...p1, ...p2],
                geometryResults: geo,
                interceptedSchemeImages: [
                    { imageData: 'data:image/jpeg;base64,ms', sourceIndex: 99, originalFileName: 'generic_markscheme_page1.jpg' }
                ],
                deferredSchemePdfFiles: [],
                files: [makeMockPdfFile('1MA1-1H.pdf'), makeMockPdfFile('1MA1-2H.pdf')]
            });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(UserFacingError);
        expect(caught.code).toBe('AMBIGUOUS_MARK_SCHEME_PAIRING');
    });

    it('Canonical Multi-PDF Bucket Ordering: reverse upload order (3H, 2H, 1H) + 1ma1-1h-rms.pdf returns [1H(ms=1), 2H(ms=0), 3H(ms=0)]', () => {
        const specs = [
            { src: 0, name: '1MA1-3H.pdf', code: '1MA1/3H', count: 5 },
            { src: 1, name: '1MA1-2H.pdf', code: '1MA1/2H', count: 5 },
            { src: 2, name: '1MA1-1H.pdf', code: '1MA1/1H', count: 5 }
        ];
        const pages: StandardizedPage[] = [];
        const geo: GeometryAnalysisResult[] = [];
        specs.forEach(s => {
            for (let i = 0; i < s.count; i++) {
                pages.push(makeMockPage(pages.length, s.name, s.src));
                geo.push({
                    is_acceptable_quality: true,
                    needs_rotation: 0,
                    is_two_page_spread: false,
                    is_marking_scheme: false,
                    is_supported_doc: true,
                    detected_subject: 'MATHS',
                    paper_code_hint: i === 0 ? s.code : undefined,
                    is_cover_page: i === 0
                });
            }
        });

        const rms1 = makeMockPdfFile('1ma1-1h-rms.pdf');
        const buckets = PaperSplitterService.splitIntoPaperBuckets({
            standardizedPages: pages,
            lightweightPages: pages,
            geometryResults: geo,
            interceptedSchemeImages: [],
            deferredSchemePdfFiles: [rms1],
            files: [...specs.map(s => makeMockPdfFile(s.name)), rms1]
        });

        expect(buckets).toHaveLength(3);
        expect(buckets.map(b => b.paperIndex)).toEqual([0, 1, 2]);
        expect(buckets.map(b => b.paperLabel)).toEqual(['1MA1/1H', '1MA1/2H', '1MA1/3H']);
        expect(buckets[0].deferredSchemePdfFiles.map(f => f.originalname)).toEqual(['1ma1-1h-rms.pdf']);
        expect(buckets[1].deferredSchemePdfFiles).toHaveLength(0);
        expect(buckets[2].deferredSchemePdfFiles).toHaveLength(0);
    });

    it('getQuestionSortValue and getBaseQuestionNumber handle P{n}· question prefixes correctly', () => {
        expect(getQuestionSortValue('P1·1')).toBeLessThan(getQuestionSortValue('P1·4'));
        expect(getQuestionSortValue('P1·4')).toBeLessThan(getQuestionSortValue('P1·23'));
        expect(getQuestionSortValue('P1·23')).toBeLessThan(getQuestionSortValue('P2·1'));
        expect(getQuestionSortValue('P1.4a')).toBeLessThan(getQuestionSortValue('P1.4b'));
        expect(getBaseQuestionNumber('P1·12a')).toBe('12');
        expect(getBaseQuestionNumber('P2·4')).toBe('4');
    });

    it('Cambridge IGCSE 0610_s26_qp_41 Q3 reproduction: 3(a) intro/diagram on Page 5 continuing to 3(a)(i), 3(a)(ii) on Page 6 does NOT trigger duplicate-question rejection', () => {
        const classificationResults = [
            {
                pageIndex: 5,
                result: {
                    category: 'questionOnly',
                    questions: [
                        {
                            questionNumber: '3',
                            text: 'Ringing involves removing a circle of the outer tissues from a plant stem. This removes the phloem but not the xylem.',
                            subQuestions: [
                                {
                                    part: 'a',
                                    text: 'A scientist investigated the effect of ringing in one species of plant. Plant A was ringed and plant B was not ringed. Figure 3.1 is a diagram of the investigation and shows the results.'
                                }
                            ]
                        }
                    ]
                }
            },
            {
                pageIndex: 6,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        {
                            questionNumber: '3',
                            text: null,
                            subQuestions: [
                                {
                                    part: 'a',
                                    subQuestions: [
                                        {
                                            part: 'i',
                                            text: 'Explain why radioactive carbon (14C) was found in the roots but not in the top of the stem in plant A.'
                                        },
                                        {
                                            part: 'ii',
                                            text: 'Explain the purpose of plant B in Figure 3.1.'
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            },
            {
                pageIndex: 7,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        {
                            questionNumber: '3',
                            text: null,
                            subQuestions: [
                                { part: 'b', text: 'Explain the effect on the rate of transpiration of removing leaves from a plant.' },
                                { part: 'c', text: 'Suggest the effect on the rate of transpiration of ringing a plant.' }
                            ]
                        }
                    ]
                }
            }
        ];

        expect(() =>
            PaperSplitterService.assertSinglePaperClassification(classificationResults, {
                isPdf: true,
                pageCount: 20,
                fileName: '0610_s26_qp_41.pdf'
            })
        ).not.toThrow();

        // Also test when Page 6 emits part: "i" and "ii" directly under questionNumber: "3" or "3a"
        const flattenedVariant = [
            classificationResults[0],
            {
                pageIndex: 6,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        {
                            questionNumber: '3',
                            text: null,
                            subQuestions: [
                                {
                                    part: 'i',
                                    text: 'Explain why radioactive carbon (14C) was found in the roots but not in the top of the stem in plant A.'
                                },
                                {
                                    part: 'ii',
                                    text: 'Explain the purpose of plant B in Figure 3.1.'
                                }
                            ]
                        }
                    ]
                }
            }
        ];

        expect(() =>
            PaperSplitterService.assertSinglePaperClassification(flattenedVariant, {
                isPdf: true,
                pageCount: 20,
                fileName: '0610_s26_qp_41.pdf'
            })
        ).not.toThrow();
    });

    it('Auto-proceeds on low-risk isolated single-question reset inside a multi-question paper or when hasUploadedMarkingScheme is true, and respects bypassDuplicateQuestionGuard', () => {
        const multiQuestionWithOneReset = [
            {
                pageIndex: 1,
                result: {
                    category: 'questionAnswer',
                    questions: [{ questionNumber: '1', subQuestions: [{ part: 'a', text: 'State the name of the process shown in Figure 1.1.' }] }]
                }
            },
            {
                pageIndex: 3,
                result: {
                    category: 'questionAnswer',
                    questions: [{ questionNumber: '2', subQuestions: [{ part: 'a', text: 'Complete Table 2.1 about enzymes and substrates.' }] }]
                }
            },
            {
                pageIndex: 5,
                result: {
                    category: 'questionAnswer',
                    questions: [{ questionNumber: '3', subQuestions: [{ part: 'a', text: 'First page of question three with opening part a stem.' }] }]
                }
            },
            {
                pageIndex: 6,
                result: {
                    category: 'questionAnswer',
                    questions: [{ questionNumber: '3', subQuestions: [{ part: 'a', text: 'Second page of question three where AI repeated part a label.' }] }]
                }
            },
            {
                pageIndex: 9,
                result: {
                    category: 'questionAnswer',
                    questions: [{ questionNumber: '4', subQuestions: [{ part: 'a', text: 'Describe the adaptations of veins in mammals.' }] }]
                }
            }
        ];

        // 1. Multi-question paper (>= 3 distinct base questions) with 1 isolated question conflict auto-proceeds
        expect(() =>
            PaperSplitterService.assertSinglePaperClassification(multiQuestionWithOneReset, {
                isPdf: true,
                pageCount: 20,
                fileName: '0610_s26_qp_41.pdf'
            })
        ).not.toThrow();

        // 2. Single-question conflict with hasUploadedMarkingScheme: true auto-proceeds even if < 3 questions
        const twoPageWithMs = multiQuestionWithOneReset.slice(2, 4);
        expect(() =>
            PaperSplitterService.assertSinglePaperClassification(twoPageWithMs, {
                isPdf: true,
                pageCount: 2,
                fileName: '0610_s26_qp_41.pdf',
                hasUploadedMarkingScheme: true
            })
        ).not.toThrow();

        // 3. True multi-paper pack (conflicts on Q1 AND Q2) still throws unless bypassDuplicateQuestionGuard is true
        const trueMultiPaper = [
            {
                pageIndex: 0,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: 'Write 84 as a product of its prime factors in index form.' },
                        { questionNumber: '2', text: 'Reflect triangle T in the line x = -1 and label the new triangle R.' }
                    ]
                }
            },
            {
                pageIndex: 20,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: 'Expand and simplify the expression 4(2x - 3) + 5(x + 2) completely.' },
                        { questionNumber: '2', text: 'A train travels 240 kilometres in 3 hours and 20 minutes. Calculate its average speed.' }
                    ]
                }
            }
        ];

        expect(() =>
            PaperSplitterService.assertSinglePaperClassification(trueMultiPaper, {
                isPdf: true,
                pageCount: 40,
                fileName: 'combined.pdf',
                hasUploadedMarkingScheme: true
            })
        ).toThrow(UserFacingError);

        expect(() =>
            PaperSplitterService.assertSinglePaperClassification(trueMultiPaper, {
                isPdf: true,
                pageCount: 40,
                fileName: 'combined.pdf',
                bypassDuplicateQuestionGuard: true
            })
        ).not.toThrow();
    });
});
