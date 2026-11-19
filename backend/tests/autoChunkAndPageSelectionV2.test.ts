import {
    MarkingPipelineService,
    filterPagesBySelectedRawIndices,
    buildPreRasterizationPlan,
    assertNoEarlyMultiCoverPdf,
    buildDetectedPaperGroupsHelper,
    buildFreePageLimitExceededMessage,
    buildOverdraftLimitExceededMessage,
    buildRawCombinedPageLimitError
} from '../services/marking/MarkingPipelineService.js';
import { PdfProcessingService } from '../services/pdf/PdfProcessingService.js';
import { PDFDocument } from 'pdf-lib';
import { PaperSplitterService, type PaperBucket } from '../services/marking/PaperSplitterService.js';
import { UserFacingError } from '../utils/UserFacingError.js';
import type { StandardizedPage } from '../types/markingRouter.js';

function makeStdPage(overrides: Partial<StandardizedPage> & Record<string, any>): StandardizedPage {
    return {
        pageIndex: 0,
        originalPageIndex: 0,
        imageData: 'data:image/jpeg;base64,abc',
        originalFileName: 'workbook.pdf',
        width: 1000,
        height: 1400,
        fileSize: 100,
        ...overrides
    } as StandardizedPage;
}

function makeMulterFile(originalname: string, mimetype = 'application/pdf'): Express.Multer.File {
    return {
        fieldname: 'files',
        originalname,
        encoding: '7bit',
        mimetype,
        size: 1024,
        buffer: Buffer.from('%PDF-1.4'),
        destination: '',
        filename: originalname,
        path: '',
        stream: null as any
    };
}

describe('V2 Auto-Chunking & selectedRawPageIndices Suite', () => {
    describe('filterPagesBySelectedRawIndices', () => {
        const isExplicitMs = (f: Express.Multer.File) =>
            f.mimetype === 'application/pdf' && /(^|[-_\s.])(rms|ms|mark[-_\s]?scheme|marking[-_\s]?scheme)([-_\s.]|$)/i.test(f.originalname.replace(/\.pdf$/i, ''));

        it('filters to selected raw page indices and keeps explicit Mark Scheme PDF pages', () => {
            const files = [
                makeMulterFile('workbook.pdf'),
                makeMulterFile('workbook-MS.pdf')
            ];
            const pages = [
                makeStdPage({ pageIndex: 0, _rawPageIndex: 0, _sourceIndex: 0, originalFileName: 'workbook.pdf' }),
                makeStdPage({ pageIndex: 1, _rawPageIndex: 1, _sourceIndex: 0, originalFileName: 'workbook.pdf' }),
                makeStdPage({ pageIndex: 2, _rawPageIndex: 2, _sourceIndex: 0, originalFileName: 'workbook.pdf' }),
                makeStdPage({ pageIndex: 3, _rawPageIndex: 3, _sourceIndex: 1, originalFileName: 'workbook-MS.pdf' })
            ];

            const res = filterPagesBySelectedRawIndices({
                standardizedPages: pages,
                selectedRawPageIndices: [1, 2],
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs
            });

            expect(res.isUserSelectedPageChunk).toBe(true);
            expect(res.standardizedPages.map(p => (p as any)._rawPageIndex)).toEqual([1, 2, 3]);
        });

        it('keeps isUserSelectedPageChunk false when filteredPages is empty', () => {
            const files = [makeMulterFile('workbook.pdf')];
            const pages = [
                makeStdPage({ pageIndex: 0, _rawPageIndex: 0, _sourceIndex: 0 }),
                makeStdPage({ pageIndex: 1, _rawPageIndex: 1, _sourceIndex: 0 })
            ];

            const res = filterPagesBySelectedRawIndices({
                standardizedPages: pages,
                selectedRawPageIndices: [99, 100],
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs
            });

            expect(res.isUserSelectedPageChunk).toBe(false);
            expect(res.standardizedPages).toHaveLength(2);
        });

        it('keeps isUserSelectedPageChunk false when selectedRawPageIndices is empty or undefined', () => {
            const files = [makeMulterFile('workbook.pdf')];
            const pages = [makeStdPage({ pageIndex: 0, _rawPageIndex: 0, _sourceIndex: 0 })];

            expect(filterPagesBySelectedRawIndices({
                standardizedPages: pages,
                selectedRawPageIndices: undefined,
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs
            }).isUserSelectedPageChunk).toBe(false);

            expect(filterPagesBySelectedRawIndices({
                standardizedPages: pages,
                selectedRawPageIndices: [],
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs
            }).isUserSelectedPageChunk).toBe(false);
        });
    });

    describe('PaperSplitterService.assertSinglePaperClassification with isUserSelectedPageChunk', () => {
        const conflictingClassification = [
            {
                pageIndex: 0,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: 'Work out the value of 3x + 5 when x = 4 in the equation shown below.' },
                        { questionNumber: '2', text: 'Factorise completely the quadratic expression x^2 - 9x + 14.' }
                    ]
                }
            },
            {
                pageIndex: 5,
                result: {
                    category: 'questionAnswer',
                    questions: [
                        { questionNumber: '1', text: 'Calculate the circumference of a circle with diameter 12 centimetres.' },
                        { questionNumber: '2', text: 'Solve the simultaneous equations 2y + x = 10 and y - 3x = 1.' }
                    ]
                }
            }
        ];

        it('throws COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED when isPdf: true and isUserSelectedPageChunk: true (25-page chunk with duplicate question numbers)', () => {
            let caught: any;
            try {
                PaperSplitterService.assertSinglePaperClassification(conflictingClassification, {
                    isPdf: true,
                    pageCount: 25,
                    fileName: 'workbook.pdf',
                    isUserSelectedPageChunk: true
                });
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED');
            expect(caught.userMessage).toMatch(/duplicate question numbers/i);
            expect(caught.userMessage).toMatch(/not currently supported/i);
            expect(caught.userMessage).toMatch(/single unique exam paper/i);
        });

        it('passes when isPdf: true and isUserSelectedPageChunk: true with unique question numbers', () => {
            const uniqueChunkClassification = [
                {
                    pageIndex: 0,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            { questionNumber: '15', text: 'Work out the value of 3x + 5 when x = 4 in the equation shown below.' },
                            { questionNumber: '16', text: 'Factorise completely the quadratic expression x^2 - 9x + 14.' }
                        ]
                    }
                },
                {
                    pageIndex: 5,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            { questionNumber: '17', text: 'Calculate the circumference of a circle with diameter 12 centimetres.' },
                            { questionNumber: '18', text: 'Solve the simultaneous equations 2y + x = 10 and y - 3x = 1.' }
                        ]
                    }
                }
            ];

            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(uniqueChunkClassification, {
                    isPdf: true,
                    pageCount: 25,
                    fileName: 'single-paper.pdf',
                    isUserSelectedPageChunk: true
                })
            ).not.toThrow();
        });

        it('throws UserFacingError when >= 2 base questions appear twice on the SAME page with different stems', () => {
            const samePageDuplicate = [
                {
                    pageIndex: 0,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            { questionNumber: '1', text: 'Work out the value of 3x + 5 when x = 4 in the equation shown below.' },
                            { questionNumber: '1', text: 'Calculate the circumference of a circle with diameter 12 centimetres.' },
                            { questionNumber: '2', text: 'Factorise completely the quadratic expression x^2 - 9x + 14.' },
                            { questionNumber: '2', text: 'Solve the simultaneous equations 2y + x = 10 and y - 3x = 1.' }
                        ]
                    }
                }
            ];

            let caught: any;
            try {
                PaperSplitterService.assertSinglePaperClassification(samePageDuplicate, {
                    isPdf: true,
                    pageCount: 1,
                    fileName: 'topic-pack.pdf'
                });
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED');
            expect(caught.userMessage).toMatch(/duplicate question numbers/i);
            expect(caught.userMessage).toMatch(/not currently supported/i);
        });

        it('does NOT throw when only 1 base question has a same-page stem difference', () => {
            const singleSamePageConflict = [
                {
                    pageIndex: 0,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            { questionNumber: '1', text: 'Work out the value of 3x + 5 when x = 4 in the equation shown below.' },
                            { questionNumber: '1', text: 'Calculate the circumference of a circle with diameter 12 centimetres.' }
                        ]
                    }
                }
            ];

            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(singleSamePageConflict, {
                    isPdf: true,
                    pageCount: 1,
                    fileName: 'single-page.pdf'
                })
            ).not.toThrow();
        });

        it('does NOT false-positive when Q1 (scenario stem) and Q1a (first sub-part) appear on the same page', () => {
            const normalParentAndSubPart = [
                {
                    pageIndex: 0,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            { questionNumber: '1', text: 'A bag contains 5 red balls, 3 blue balls, and 2 green balls.' },
                            { questionNumber: '1a', text: 'Calculate the probability of selecting a red ball at random from the bag.' }
                        ]
                    }
                }
            ];

            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(normalParentAndSubPart, {
                    isPdf: true,
                    pageCount: 1,
                    fileName: 'normal-paper.pdf'
                })
            ).not.toThrow();
        });

        it('throws COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED when isPdf: true and isUserSelectedPageChunk: false', () => {
            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(conflictingClassification, {
                    isPdf: true,
                    pageCount: 25,
                    fileName: 'workbook.pdf',
                    isUserSelectedPageChunk: false
                })
            ).toThrow(UserFacingError);

            try {
                PaperSplitterService.assertSinglePaperClassification(conflictingClassification, {
                    isPdf: true,
                    pageCount: 25,
                    fileName: 'workbook.pdf'
                });
            } catch (err: any) {
                expect(err.code).toBe('COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED');
            }
        });
    });

    describe('assertNoEarlyMultiCoverPdf', () => {
        it('throws COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED for a single student PDF with >=2 non-scheme cover pages >=3 pages apart', () => {
            const pages = Array.from({ length: 10 }, (_, idx) =>
                makeStdPage({ pageIndex: idx, _sourceIndex: 0, originalFileName: 'combined.pdf' })
            );
            const geos = pages.map((_, idx) => ({
                is_cover_page: idx === 0 || idx === 5,
                is_marking_scheme: false
            }));

            let caught: any;
            try {
                assertNoEarlyMultiCoverPdf({ standardizedPages: pages, geometryResults: geos });
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED');
        });

        it('does not throw when cover pages are < 3 pages apart or only 1 cover page exists', () => {
            const pages = Array.from({ length: 10 }, (_, idx) =>
                makeStdPage({ pageIndex: idx, _sourceIndex: 0, originalFileName: 'workbook.pdf' })
            );
            const adjacentGeos = pages.map((_, idx) => ({
                is_cover_page: idx === 0 || idx === 1,
                is_marking_scheme: false
            }));
            expect(() =>
                assertNoEarlyMultiCoverPdf({ standardizedPages: pages, geometryResults: adjacentGeos })
            ).not.toThrow();

            const singleCoverGeos = pages.map((_, idx) => ({
                is_cover_page: idx === 0,
                is_marking_scheme: false
            }));
            expect(() =>
                assertNoEarlyMultiCoverPdf({ standardizedPages: pages, geometryResults: singleCoverGeos })
            ).not.toThrow();
        });

        it('does not throw when multiple student PDFs exist (handled by multi-PDF bucketing)', () => {
            const pages = [
                makeStdPage({ pageIndex: 0, _sourceIndex: 0, originalFileName: 'p1.pdf' }),
                makeStdPage({ pageIndex: 1, _sourceIndex: 0, originalFileName: 'p1.pdf' }),
                makeStdPage({ pageIndex: 2, _sourceIndex: 0, originalFileName: 'p1.pdf' }),
                makeStdPage({ pageIndex: 3, _sourceIndex: 1, originalFileName: 'p2.pdf' })
            ];
            const geos = [
                { is_cover_page: true, is_marking_scheme: false },
                { is_cover_page: false, is_marking_scheme: false },
                { is_cover_page: false, is_marking_scheme: false },
                { is_cover_page: true, is_marking_scheme: false }
            ];
            expect(() =>
                assertNoEarlyMultiCoverPdf({ standardizedPages: pages, geometryResults: geos })
            ).not.toThrow();
        });
    });

    describe('PaperSplitterService sub-question reset & cross-page bare parent guards', () => {
        it('rejects a topic pack where 2(a)(i) appears on Page 4 and 2(a)(i) appears on Page 6', () => {
            const topicPack = [
                {
                    pageIndex: 4,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            {
                                questionNumber: '2',
                                subQuestions: [
                                    { part: 'a', subQuestions: [{ part: 'i', text: 'Find the gradient of line L.' }] }
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
                                questionNumber: '2',
                                subQuestions: [
                                    { part: 'a', subQuestions: [{ part: 'i', text: 'Differentiate y = 3x^2 + 2x.' }] }
                                ]
                            }
                        ]
                    }
                }
            ];

            let caught: any;
            try {
                PaperSplitterService.assertSinglePaperClassification(topicPack, {
                    isPdf: true,
                    pageCount: 10,
                    fileName: 'topic-pack.pdf'
                });
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED');
            expect(caught.userMessage).toContain('Q2');
        });

        it('does NOT falsely reject Q1 when subQuestions echoes parent part "1" across two pages (clean === baseQ)', () => {
            const q1Echoed = [
                {
                    pageIndex: 0,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            {
                                questionNumber: '1',
                                subQuestions: [{ part: '1' }]
                            }
                        ]
                    }
                },
                {
                    pageIndex: 1,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            {
                                questionNumber: '1',
                                subQuestions: [{ part: '1' }]
                            }
                        ]
                    }
                }
            ];

            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(q1Echoed, {
                    isPdf: true,
                    pageCount: 2,
                    fileName: 'single-q1.pdf'
                })
            ).not.toThrow();
        });

        it('rejects loose images when 2(a) appears on two distinct pages (MULTI_PAPER_LOOSE_IMAGES_NOT_SUPPORTED)', () => {
            const looseMultiPaper = [
                {
                    pageIndex: 0,
                    result: {
                        category: 'questionAnswer',
                        questions: [{ questionNumber: '2a', text: 'Solve the equation 2x + 3 = 11.' }]
                    }
                },
                {
                    pageIndex: 3,
                    result: {
                        category: 'questionAnswer',
                        questions: [{ questionNumber: '2a', text: 'Expand and simplify (x + 4)(x - 2).' }]
                    }
                }
            ];

            let caught: any;
            try {
                PaperSplitterService.assertSinglePaperClassification(looseMultiPaper, {
                    isPdf: false,
                    pageCount: 4
                });
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('MULTI_PAPER_LOOSE_IMAGES_NOT_SUPPORTED');
            expect(caught.userMessage).toContain('Q2');
        });

        it('does NOT reject 2(a)(i) on Page 1 continuing to 2(a)(ii) and 2(a)(iii) on Page 2 (Guard A)', () => {
            const normalNestedContinuation = [
                {
                    pageIndex: 1,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            {
                                questionNumber: '2',
                                subQuestions: [
                                    { part: 'a', subQuestions: [{ part: 'i', text: 'Write down the coordinates of A.' }] }
                                ]
                            }
                        ]
                    }
                },
                {
                    pageIndex: 2,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            {
                                questionNumber: '2',
                                subQuestions: [
                                    {
                                        part: 'a',
                                        subQuestions: [
                                            { part: 'ii', text: 'Find the length of AB.' },
                                            { part: 'iii', text: 'Hence find the area of triangle OAB.' }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                }
            ];

            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(normalNestedContinuation, {
                    isPdf: true,
                    pageCount: 5,
                    fileName: 'single-paper.pdf'
                })
            ).not.toThrow();
        });

        it('does NOT reject 2(b)(i) on Page 1 followed by 2(c)(i) on Page 2', () => {
            const nestedRomanParts = [
                {
                    pageIndex: 1,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            {
                                questionNumber: '2',
                                subQuestions: [
                                    { part: 'b', subQuestions: [{ part: 'i', text: 'Show that p = 4.' }] }
                                ]
                            }
                        ]
                    }
                },
                {
                    pageIndex: 2,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            {
                                questionNumber: '2',
                                subQuestions: [
                                    { part: 'c', subQuestions: [{ part: 'i', text: 'State the range of f(x).' }] }
                                ]
                            }
                        ]
                    }
                }
            ];

            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(nestedRomanParts, {
                    isPdf: true,
                    pageCount: 5,
                    fileName: 'single-paper.pdf'
                })
            ).not.toThrow();
        });

        it('does NOT reject an out-of-order scan where 2(b) is on Page 0 and a single 2(a) is on Page 1', () => {
            const outOfOrder = [
                {
                    pageIndex: 0,
                    result: {
                        category: 'questionAnswer',
                        questions: [{ questionNumber: '2', subQuestions: [{ part: 'b', text: 'Find the value of k.' }] }]
                    }
                },
                {
                    pageIndex: 1,
                    result: {
                        category: 'questionAnswer',
                        questions: [{ questionNumber: '2', subQuestions: [{ part: 'a', text: 'Sketch the curve y = f(x).' }] }]
                    }
                }
            ];

            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(outOfOrder, {
                    isPdf: false,
                    pageCount: 2
                })
            ).not.toThrow();
        });

        it('does NOT reject a handwritten continuation of 2(a) + 2(b) on Page 2 after 2(a) on Page 1', () => {
            const continuationWithB = [
                {
                    pageIndex: 1,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            {
                                questionNumber: '2',
                                subQuestions: [{ part: 'a', text: 'Prove that the triangles ABC and DEF are congruent.' }]
                            }
                        ]
                    }
                },
                {
                    pageIndex: 2,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            {
                                questionNumber: '2',
                                subQuestions: [
                                    { part: 'a', text: 'continued' },
                                    { part: 'b', text: 'Calculate the length of side DF.' }
                                ]
                            }
                        ]
                    }
                }
            ];

            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(continuationWithB, {
                    isPdf: true,
                    pageCount: 4,
                    fileName: 'single-paper.pdf'
                })
            ).not.toThrow();
        });

        it('does NOT reject cross-page bare parent stem Q2 on Page 0 and Q2a sub-part on Page 1', () => {
            const crossPageBareAndSub = [
                {
                    pageIndex: 0,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            { questionNumber: '2', text: 'A particle P moves along a straight horizontal track with constant acceleration.' }
                        ]
                    }
                },
                {
                    pageIndex: 1,
                    result: {
                        category: 'questionAnswer',
                        questions: [
                            { questionNumber: '2a', text: 'Calculate the total distance travelled during the first eight seconds.' }
                        ]
                    }
                }
            ];

            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(crossPageBareAndSub, {
                    isPdf: true,
                    pageCount: 2,
                    fileName: 'single-paper.pdf'
                })
            ).not.toThrow();
        });
    });

    describe('PaperSplitterService.assertNoDuplicateQuestionsInMapperResults', () => {
        it('deduplicates by pageIndex so ClassificationMapper 2-page overlap (pages 8..9) is never counted twice', () => {
            const mapperResultsWithOverlap = [
                { pageIndex: 0, category: 'questionAnswer', flatQuestions: ['1a', '1b'] },
                { pageIndex: 8, category: 'questionAnswer', flatQuestions: ['5a', '5b'] },
                { pageIndex: 9, category: 'questionAnswer', flatQuestions: ['6a'] },
                // Duplicate pageIndex 8 & 9 from overlapping bucket
                { pageIndex: 8, category: 'questionAnswer', flatQuestions: ['5a', '5b'] },
                { pageIndex: 9, category: 'questionAnswer', flatQuestions: ['6a'] },
                { pageIndex: 30, category: 'questionAnswer', flatQuestions: ['12a'] }
            ];

            expect(() =>
                PaperSplitterService.assertNoDuplicateQuestionsInMapperResults(mapperResultsWithOverlap, {
                    isPdf: true,
                    pageCount: 60,
                    fileName: 'single-60p.pdf'
                })
            ).not.toThrow();
        });

        it('rejects 2a.i on Page 0 and 2a.i on Page 5 (Guard B) but does NOT reject 2a.i -> 2a.ii', () => {
            const validContinuation = [
                { pageIndex: 0, category: 'questionAnswer', flatQuestions: ['2a.i'] },
                { pageIndex: 1, category: 'questionAnswer', flatQuestions: ['2a.ii', '2a.iii'] }
            ];
            expect(() =>
                PaperSplitterService.assertNoDuplicateQuestionsInMapperResults(validContinuation, {
                    isPdf: true,
                    pageCount: 55,
                    fileName: 'valid.pdf'
                })
            ).not.toThrow();

            const duplicateOpening = [
                { pageIndex: 0, category: 'questionAnswer', flatQuestions: ['2a.i'] },
                { pageIndex: 5, category: 'questionAnswer', flatQuestions: ['2a.i'] }
            ];
            let caught: any;
            try {
                PaperSplitterService.assertNoDuplicateQuestionsInMapperResults(duplicateOpening, {
                    isPdf: true,
                    pageCount: 55,
                    fileName: 'topic-pack.pdf'
                });
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED');
            expect(caught.userMessage).toContain('Q2');
        });

        it('rejects a 60-page combined multi-paper PDF when Q1 and Q2 reappear in the middle window after Q15', () => {
            const combinedMapperResults = [
                { pageIndex: 0, category: 'questionAnswer', flatQuestions: ['1'] },
                { pageIndex: 1, category: 'questionAnswer', flatQuestions: ['2'] },
                { pageIndex: 8, category: 'questionAnswer', flatQuestions: ['15'] },
                { pageIndex: 30, category: 'questionAnswer', flatQuestions: ['1'] },
                { pageIndex: 31, category: 'questionAnswer', flatQuestions: ['2'] }
            ];

            let caught: any;
            try {
                PaperSplitterService.assertNoDuplicateQuestionsInMapperResults(combinedMapperResults, {
                    isPdf: true,
                    pageCount: 60,
                    fileName: 'combined-2x30p.pdf'
                });
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED');
        });

        it('does NOT reject out-of-order scans where Q1 and Q2 were not seen before Q5 and Q6', () => {
            const outOfOrderMapper = [
                { pageIndex: 0, category: 'questionAnswer', flatQuestions: ['5', '6'] },
                { pageIndex: 1, category: 'questionAnswer', flatQuestions: ['1', '2'] }
            ];

            expect(() =>
                PaperSplitterService.assertNoDuplicateQuestionsInMapperResults(outOfOrderMapper, {
                    isPdf: false,
                    pageCount: 55
                })
            ).not.toThrow();
        });

        it('does NOT reject a normal monotonic paper with multi-page questions', () => {
            const normalPaper = [
                { pageIndex: 0, category: 'questionAnswer', flatQuestions: ['1'] },
                { pageIndex: 1, category: 'questionAnswer', flatQuestions: ['2'] },
                { pageIndex: 2, category: 'questionAnswer', flatQuestions: ['2', '3'] },
                { pageIndex: 3, category: 'questionAnswer', flatQuestions: ['3', '4'] }
            ];

            expect(() =>
                PaperSplitterService.assertNoDuplicateQuestionsInMapperResults(normalPaper, {
                    isPdf: true,
                    pageCount: 55,
                    fileName: 'normal.pdf'
                })
            ).not.toThrow();
        });
    });

    describe('buildDetectedPaperGroupsHelper', () => {
        it('auto-chunks single bucket > MAX_FREE_PAGES into 25-page chunks with ejected scheme raw/file indices', () => {
            const files = [makeMulterFile('big-workbook.pdf')];
            const stdPages = Array.from({ length: 60 }, (_, idx) =>
                makeStdPage({ pageIndex: idx, _rawPageIndex: idx, _sourceIndex: 0, originalFileName: 'big-workbook.pdf' })
            );
            const bucket: PaperBucket = {
                paperIndex: 0,
                paperLabel: 'Paper 1',
                subjectHint: 'MATHS',
                standardizedPages: stdPages,
                lightweightPages: stdPages,
                geometryResults: stdPages.map(() => ({
                    is_acceptable_quality: true,
                    needs_rotation: 0,
                    is_two_page_spread: false,
                    is_marking_scheme: false,
                    is_supported_doc: true,
                    subject: 'MATHS'
                })),
                interceptedSchemeImages: ['img1'],
                deferredSchemePdfFiles: []
            };

            const groups = buildDetectedPaperGroupsHelper({
                paperBuckets: [bucket],
                studentRawPageCount: 60,
                maxFreePages: 50,
                files,
                interceptedSchemeMeta: [
                    { imageData: 'img1', sourceIndex: 1, rawPageIndex: 60, originalFileName: 'scheme.pdf' }
                ],
                computeSubjectVote: () => 'MATHS'
            });

            expect(groups).toHaveLength(3);
            expect(groups![0]).toMatchObject({
                paperIndex: 0,
                label: 'Pages 1–25',
                subject: 'Mathematics',
                pageCount: 25,
                canGradeOnFree: true,
                hasMarkScheme: true,
                markSchemeCount: 1,
                isPageChunk: true,
                fileIndices: [0, 1]
            });
            expect(groups![0].rawPageIndices).toHaveLength(26);
            expect(groups![0].rawPageIndices).toContain(60);

            expect(groups![1]).toMatchObject({
                paperIndex: 1,
                label: 'Pages 26–50',
                pageCount: 25,
                canGradeOnFree: true,
                isPageChunk: true
            });
            expect(groups![2]).toMatchObject({
                paperIndex: 2,
                label: 'Pages 51–60',
                pageCount: 10,
                canGradeOnFree: true,
                isPageChunk: true
            });
        });

        it('labels chunks using 1-based student page numbers when Mark Scheme PDF is uploaded before student workbook', () => {
            const files = [makeMulterFile('mark-scheme.pdf'), makeMulterFile('student-workbook.pdf')];
            const schemePageCount = 39;
            const studentPageCount = 65;

            const interceptedSchemeMeta = Array.from({ length: schemePageCount }, (_, idx) => ({
                imageData: `ms-${idx}`,
                sourceIndex: 0,
                rawPageIndex: idx,
                originalFileName: 'mark-scheme.pdf'
            }));

            const stdPages = Array.from({ length: studentPageCount }, (_, idx) =>
                makeStdPage({
                    pageIndex: idx,
                    _rawPageIndex: schemePageCount + idx,
                    _sourceIndex: 1,
                    originalFileName: 'student-workbook.pdf'
                })
            );

            const bucket: PaperBucket = {
                paperIndex: 0,
                paperLabel: 'Paper 1',
                subjectHint: 'MATHS',
                standardizedPages: stdPages,
                lightweightPages: stdPages,
                geometryResults: stdPages.map(() => ({
                    is_acceptable_quality: true,
                    needs_rotation: 0,
                    is_two_page_spread: false,
                    is_marking_scheme: false,
                    is_supported_doc: true,
                    subject: 'MATHS'
                })),
                interceptedSchemeImages: interceptedSchemeMeta.map(m => m.imageData),
                deferredSchemePdfFiles: []
            };

            const groups = buildDetectedPaperGroupsHelper({
                paperBuckets: [bucket],
                studentRawPageCount: studentPageCount,
                maxFreePages: 50,
                files,
                interceptedSchemeMeta,
                computeSubjectVote: () => 'MATHS'
            });

            expect(groups).toHaveLength(3);
            expect(groups![0]).toMatchObject({
                paperIndex: 0,
                label: 'Pages 1–25',
                pageCount: 25,
                fileIndices: [0, 1],
                isPageChunk: true
            });
            expect(groups![1]).toMatchObject({
                paperIndex: 1,
                label: 'Pages 26–50',
                pageCount: 25,
                fileIndices: [0, 1],
                isPageChunk: true
            });
            expect(groups![2]).toMatchObject({
                paperIndex: 2,
                label: 'Pages 51–65',
                pageCount: 15,
                fileIndices: [0, 1],
                isPageChunk: true
            });

            // rawPageIndices must still retain the global raw indices (0..38 scheme + student slice 39..103)
            const expectedSchemeIndices = Array.from({ length: schemePageCount }, (_, i) => i);
            expect(groups![0].rawPageIndices).toEqual([
                ...expectedSchemeIndices,
                ...Array.from({ length: 25 }, (_, i) => 39 + i)
            ]);
            expect(groups![1].rawPageIndices).toEqual([
                ...expectedSchemeIndices,
                ...Array.from({ length: 25 }, (_, i) => 64 + i)
            ]);
            expect(groups![2].rawPageIndices).toEqual([
                ...expectedSchemeIndices,
                ...Array.from({ length: 15 }, (_, i) => 89 + i)
            ]);
        });

        it('in multi-bucket mode, includes ejectedSchemeFileIndices only when length === 1', () => {
            const files = [makeMulterFile('p1.pdf'), makeMulterFile('p2.pdf'), makeMulterFile('ms.pdf')];
            const b1: PaperBucket = {
                paperIndex: 0,
                paperLabel: 'Paper 1',
                standardizedPages: [makeStdPage({ pageIndex: 0, _rawPageIndex: 0, _sourceIndex: 0 })],
                lightweightPages: [],
                geometryResults: [],
                interceptedSchemeImages: [],
                deferredSchemePdfFiles: []
            };
            const b2: PaperBucket = {
                paperIndex: 1,
                paperLabel: 'Paper 2',
                standardizedPages: [makeStdPage({ pageIndex: 0, _rawPageIndex: 1, _sourceIndex: 1 })],
                lightweightPages: [],
                geometryResults: [],
                interceptedSchemeImages: [],
                deferredSchemePdfFiles: []
            };

            const singleEjectedGroups = buildDetectedPaperGroupsHelper({
                paperBuckets: [b1, b2],
                studentRawPageCount: 2,
                maxFreePages: 50,
                files,
                interceptedSchemeMeta: [{ imageData: 'ms1', sourceIndex: 2, rawPageIndex: 2 }],
                computeSubjectVote: () => undefined
            });
            expect(singleEjectedGroups![0].fileIndices).toEqual([0, 2]);
            expect(singleEjectedGroups![1].fileIndices).toEqual([1, 2]);

            const multiEjectedGroups = buildDetectedPaperGroupsHelper({
                paperBuckets: [b1, b2],
                studentRawPageCount: 2,
                maxFreePages: 50,
                files,
                interceptedSchemeMeta: [
                    { imageData: 'ms1', sourceIndex: 2, rawPageIndex: 2 },
                    { imageData: 'ms2', sourceIndex: 3, rawPageIndex: 3 }
                ],
                computeSubjectVote: () => undefined
            });
            expect(multiEjectedGroups![0].fileIndices).toEqual([0]);
            expect(multiEjectedGroups![1].fileIndices).toEqual([1]);
        });
    });

    describe('FREE_PAGE_LIMIT_EXCEEDED & OVERDRAFT_LIMIT_EXCEEDED messages', () => {
        const chunkGroups = [
            {
                paperIndex: 0,
                label: 'Pages 1–25',
                pageCount: 25,
                fileIndices: [0],
                rawPageIndices: Array.from({ length: 25 }, (_, i) => i),
                canGradeOnFree: true,
                isPageChunk: true
            },
            {
                paperIndex: 1,
                label: 'Pages 26–50',
                pageCount: 25,
                fileIndices: [0],
                rawPageIndices: Array.from({ length: 25 }, (_, i) => i + 25),
                canGradeOnFree: true,
                isPageChunk: true
            },
            {
                paperIndex: 2,
                label: 'Pages 51–60',
                pageCount: 10,
                fileIndices: [0],
                rawPageIndices: Array.from({ length: 10 }, (_, i) => i + 50),
                canGradeOnFree: true,
                isPageChunk: true
            }
        ];

        it('formats chunked workbook copy for FREE_PAGE_LIMIT_EXCEEDED and OVERDRAFT_LIMIT_EXCEEDED', () => {
            const freeMsg = buildFreePageLimitExceededMessage({
                studentRawPageCount: 60,
                maxFreePages: 50,
                detectedPaperGroups: chunkGroups
            });
            expect(freeMsg).toContain('split your **60-page** upload into **3 sections**');
            expect(freeMsg).toContain('Grade 1 section now for free');
            expect(freeMsg).toContain('Select a page range below');

            const overdraftMsg = buildOverdraftLimitExceededMessage({
                studentRawPageCount: 60,
                creditsNeeded: 120,
                remainingCredits: 10,
                detectedPaperGroups: chunkGroups
            });
            expect(overdraftMsg).toContain('split your **60-page** upload into **3 sections**');
            expect(overdraftMsg).toContain('Select **1 section** below');
        });

        it('keeps multi-paper copy when isPageChunk is not set', () => {
            const paperGroups = [
                { ...chunkGroups[0], label: 'Paper 1', isPageChunk: false },
                { ...chunkGroups[1], label: 'Paper 2', isPageChunk: false }
            ];
            const freeMsg = buildFreePageLimitExceededMessage({
                studentRawPageCount: 55,
                maxFreePages: 50,
                detectedPaperGroups: paperGroups
            });
            expect(freeMsg).toContain('We detected **2 papers** in your upload');
            expect(freeMsg).toContain('Select a paper below');

            const overdraftMsg = buildOverdraftLimitExceededMessage({
                studentRawPageCount: 55,
                creditsNeeded: 110,
                remainingCredits: 5,
                detectedPaperGroups: paperGroups
            });
            expect(overdraftMsg).toContain('We detected **2 papers** in your upload');
            expect(overdraftMsg).toContain('Select **1 paper** below');
        });
    });

    describe('buildPreRasterizationPlan (Pre-Rasterization Chunk Selection & Fast Page-Count Gate)', () => {
        const isExplicitMs = (f: Express.Multer.File) =>
            f.mimetype === 'application/pdf' && /(^|[-_\s.])(rms|ms|mark[-_\s]?scheme|marking[-_\s]?scheme)([-_\s.]|$)/i.test(f.originalname.replace(/\.pdf$/i, ''));

        it('maps selectedRawPageIndices for a 104-page single workbook PDF', async () => {
            const files = [makeMulterFile('workbook-104p.pdf')];
            const plan = await buildPreRasterizationPlan({
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs,
                hasNonSchemeStudentFiles: true,
                selectedRawPageIndices: [25, 26, 27, 49],
                getPdfPageCountFn: async () => 104
            });

            expect(plan.totalKnownRawPages).toBe(104);
            expect(plan.hasUnknownPageCount).toBe(false);
            expect(plan.hasValidSelectedRawPages).toBe(true);
            expect(plan.plans[0]).toMatchObject({
                fileIndex: 0,
                rawPageCount: 104,
                globalRawOffset: 0,
                selectedLocalPageIndices: [25, 26, 27, 49]
            });
        });

        it('maps multi-PDF selectedRawPageIndices across file boundaries while keeping deferred MS PDF intact', async () => {
            const files = [
                makeMulterFile('part1.pdf'),
                makeMulterFile('workbook-MS.pdf'),
                makeMulterFile('part2.pdf')
            ];
            const counts: Record<number, number> = { 0: 60, 2: 50 };
            let callIdx = 0;
            const plan = await buildPreRasterizationPlan({
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs,
                hasNonSchemeStudentFiles: true,
                selectedRawPageIndices: [58, 59, 60, 61],
                getPdfPageCountFn: async (buf) => {
                    // part1 is index 0, part2 is index 2
                    const idx = files.findIndex(f => f.buffer === buf);
                    callIdx++;
                    return counts[idx] ?? 0;
                }
            });

            expect(callIdx).toBe(2); // MS PDF was deferred and not even counted
            expect(plan.totalKnownRawPages).toBe(110);
            expect(plan.plans[0]).toMatchObject({
                fileIndex: 0,
                isDeferredMarkScheme: false,
                rawPageCount: 60,
                globalRawOffset: 0,
                selectedLocalPageIndices: [58, 59]
            });
            expect(plan.plans[1]).toMatchObject({
                fileIndex: 1,
                isDeferredMarkScheme: true,
                rawPageCount: 0
            });
            expect(plan.plans[2]).toMatchObject({
                fileIndex: 2,
                isDeferredMarkScheme: false,
                rawPageCount: 50,
                globalRawOffset: 60,
                selectedLocalPageIndices: [0, 1]
            });
        });

        it('marks PDFs with 0 selected pages as empty selectedLocalPageIndices so rasterization is skipped', async () => {
            const files = [
                makeMulterFile('part1.pdf'),
                makeMulterFile('part2.pdf')
            ];
            const plan = await buildPreRasterizationPlan({
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs,
                hasNonSchemeStudentFiles: true,
                selectedRawPageIndices: [0, 1, 2],
                getPdfPageCountFn: async (buf) => (buf === files[0].buffer ? 40 : 40)
            });

            expect(plan.plans[0].selectedLocalPageIndices).toEqual([0, 1, 2]);
            expect(plan.plans[1].selectedLocalPageIndices).toEqual([]);
        });

        it('computes accurate global offsets for mixed uploads (images + PDFs + deferred MS PDF)', async () => {
            const files = [
                makeMulterFile('cover.jpg', 'image/jpeg'),
                makeMulterFile('workbook.pdf', 'application/pdf'),
                makeMulterFile('mark-scheme.pdf', 'application/pdf'),
                makeMulterFile('extra.png', 'image/png')
            ];
            const plan = await buildPreRasterizationPlan({
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs,
                hasNonSchemeStudentFiles: true,
                selectedRawPageIndices: [0, 1, 80, 81],
                getPdfPageCountFn: async () => 80
            });

            expect(plan.totalKnownRawPages).toBe(82);
            expect(plan.plans[0]).toMatchObject({ globalRawOffset: 0, rawPageCount: 1, selectedLocalPageIndices: [0] });
            expect(plan.plans[1]).toMatchObject({ globalRawOffset: 1, rawPageCount: 80, selectedLocalPageIndices: [0, 79] });
            expect(plan.plans[2]).toMatchObject({ isDeferredMarkScheme: true, rawPageCount: 0 });
            expect(plan.plans[3]).toMatchObject({ globalRawOffset: 81, rawPageCount: 1, selectedLocalPageIndices: [0] });
        });

        it('keeps explicit Mark Scheme PDFs intact when all uploaded files are Mark Scheme PDFs', async () => {
            const files = [makeMulterFile('paper-MS.pdf')];
            const plan = await buildPreRasterizationPlan({
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs,
                hasNonSchemeStudentFiles: false,
                selectedRawPageIndices: [0, 1],
                getPdfPageCountFn: async () => 20
            });

            expect(plan.plans[0].isExplicitMarkScheme).toBe(true);
            expect(plan.plans[0].selectedLocalPageIndices).toBeUndefined();
        });

        it('falls back cleanly when selectedRawPageIndices are all out of range or a PDF is unparseable', async () => {
            const files = [makeMulterFile('workbook.pdf')];
            const outOfRange = await buildPreRasterizationPlan({
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs,
                hasNonSchemeStudentFiles: true,
                selectedRawPageIndices: [999, 1000],
                getPdfPageCountFn: async () => 10
            });
            expect(outOfRange.hasValidSelectedRawPages).toBe(false);
            expect(outOfRange.plans[0].selectedLocalPageIndices).toBeUndefined();

            const unknownCount = await buildPreRasterizationPlan({
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs,
                hasNonSchemeStudentFiles: true,
                selectedRawPageIndices: [0, 1],
                getPdfPageCountFn: async () => null
            });
            expect(unknownCount.hasUnknownPageCount).toBe(true);
            expect(unknownCount.plans[0].selectedLocalPageIndices).toBeUndefined();
        });

        it('sums combined pages > 150 for fast pre-rasterization rejection of multi-PDF uploads', async () => {
            const files = [
                makeMulterFile('part1.pdf'),
                makeMulterFile('part2.pdf')
            ];
            const plan = await buildPreRasterizationPlan({
                files,
                isExplicitMarkSchemePdfFile: isExplicitMs,
                hasNonSchemeStudentFiles: true,
                getPdfPageCountFn: async (buf) => (buf === files[0].buffer ? 80 : 75)
            });

            expect(plan.totalKnownRawPages).toBe(155);
        });
    });

    describe('PdfProcessingService.getPdfPageCount & pre-rasterization selection', () => {
        it('returns exact page count for valid PDFs (even with leading junk bytes) and null for invalid buffers', async () => {
            const doc = await PDFDocument.create();
            for (let i = 0; i < 12; i++) {
                doc.addPage([595, 842]);
            }
            const pdfBytes = Buffer.from(await doc.save());

            expect(await PdfProcessingService.getPdfPageCount(pdfBytes)).toBe(12);

            const withLeadingJunk = Buffer.concat([Buffer.from('   \n\r'), pdfBytes]);
            expect(await PdfProcessingService.getPdfPageCount(withLeadingJunk)).toBe(12);

            expect(await PdfProcessingService.getPdfPageCount(Buffer.from('not-a-pdf'))).toBeNull();
        });

        it('returns [] immediately when selectedPageIndices has no valid in-range pages', async () => {
            const doc = await PDFDocument.create();
            doc.addPage([595, 842]);
            doc.addPage([595, 842]);
            const pdfBytes = Buffer.from(await doc.save());

            const pages = await PdfProcessingService.convertPdfToImages(pdfBytes, {
                selectedPageIndices: [50, 99]
            });
            expect(pages).toEqual([]);
        });

        it('rasterizes only selectedPageIndices via Ghostscript while preserving original 0-based pageIndex', async () => {
            const doc = await PDFDocument.create();
            for (let i = 0; i < 5; i++) {
                const page = doc.addPage([595, 842]);
                page.drawText(`Page ${i + 1}`, { x: 100, y: 700, size: 24 });
            }
            const pdfBytes = Buffer.from(await doc.save());

            const pages = await PdfProcessingService.convertPdfToImages(pdfBytes, {
                selectedPageIndices: [3, 1, 3, 99]
            });

            expect(pages).toHaveLength(2);
            expect(pages.map(p => p.pageIndex)).toEqual([1, 3]);
            pages.forEach(p => {
                expect(p.imageData).toMatch(/^data:image\/jpeg;base64,/);
                expect(p.width).toBeGreaterThan(0);
                expect(p.height).toBeGreaterThan(0);
            });
        }, 30000);

        it('rejects PDFs exceeding maxPages before rasterization with custom maxPagesErrorMessage', async () => {
            const doc = await PDFDocument.create();
            for (let i = 0; i < 5; i++) {
                doc.addPage([595, 842]);
            }
            const pdfBytes = Buffer.from(await doc.save());

            await expect(
                PdfProcessingService.convertPdfToImages(pdfBytes, {
                    maxPages: 3,
                    maxPagesErrorMessage: (count: number) =>
                        `PDF_PAGE_LIMIT_EXCEEDED: Upload exceeds the maximum limit of 3 pages/images (uploaded ${count} pages).`
                })
            ).rejects.toThrow('Upload exceeds the maximum limit of 3 pages/images (uploaded 5 pages).');
        });
    });

    describe('Raw combined >100-page UserFacingError & selectedRawPageIndices pre-rasterization gating', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        it('buildRawCombinedPageLimitError returns UserFacingError with PDF_PAGE_LIMIT_EXCEEDED, requiresUpgrade: false, and no Upgrade to Pro CTA', () => {
            const err = buildRawCombinedPageLimitError(125, 100);
            expect(err).toBeInstanceOf(UserFacingError);
            expect(err.code).toBe('PDF_PAGE_LIMIT_EXCEEDED');
            expect(err.category).toBe('user_fixable');
            expect(err.shouldAlertAdmin).toBe(false);
            expect(err.requiresUpgrade).toBe(false);
            expect(err.userMessage).toContain('125 pages');
            expect(err.userMessage).toContain('100 pages/images');
            expect(err.userMessage).toMatch(/1 paper at a time/i);
            expect(err.userMessage).toMatch(/unique question numbers/i);
            expect(err.userMessage).not.toMatch(/upgrade to pro/i);
            expect(err.message).toContain('Upload exceeds the maximum limit of 100 pages/images (uploaded 125 pages).');
        });

        it('gates >100-page single PDF before rasterization with UserFacingError (PDF_PAGE_LIMIT_EXCEEDED, requiresUpgrade: false)', async () => {
            jest.spyOn(PdfProcessingService, 'getPdfPageCount').mockResolvedValue(120);
            const convertSpy = jest.spyOn(PdfProcessingService, 'convertPdfToImages');

            const req = { userPlan: 'free' } as any;
            const files = [makeMulterFile('huge-workbook.pdf')];
            const usageTracker = { recordUsage: jest.fn(), getSummary: jest.fn() } as any;

            let caught: any;
            try {
                await MarkingPipelineService.executePipeline(
                    req,
                    files,
                    'sub-over-100-pdf',
                    { model: 'auto' },
                    () => {},
                    usageTracker
                );
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('PDF_PAGE_LIMIT_EXCEEDED');
            expect(caught.requiresUpgrade).toBe(false);
            expect(caught.userMessage).toContain('120 pages');
            expect(caught.userMessage).not.toMatch(/upgrade to pro/i);
            expect(convertSpy).not.toHaveBeenCalled();
        });

        it('allows a 25-page selectedRawPageIndices chunk from a >100-page single PDF and omits maxPages on convertPdfToImages', async () => {
            jest.spyOn(PdfProcessingService, 'getPdfPageCount').mockResolvedValue(120);
            const sentinel = new Error('RASTER_CALLED_WITH_CHUNK');
            const convertSpy = jest.spyOn(PdfProcessingService, 'convertPdfToImages').mockRejectedValue(sentinel);

            const req = { userPlan: 'free' } as any;
            const files = [makeMulterFile('huge-workbook.pdf')];
            const usageTracker = { recordUsage: jest.fn(), getSummary: jest.fn() } as any;
            const selectedIndices = Array.from({ length: 25 }, (_, i) => i + 25);

            await expect(
                MarkingPipelineService.executePipeline(
                    req,
                    files,
                    'sub-chunk-120-pdf',
                    { model: 'auto', selectedRawPageIndices: selectedIndices },
                    () => {},
                    usageTracker
                )
            ).rejects.toThrow('RASTER_CALLED_WITH_CHUNK');

            expect(convertSpy).toHaveBeenCalledTimes(1);
            const callOptions = convertSpy.mock.calls[0][1] || {};
            expect(callOptions.maxPages).toBeUndefined();
            expect(callOptions.selectedPageIndices).toEqual(selectedIndices);
        });

        it('gates >100-page multi-PDF upload before rasterization and allows selectedRawPageIndices subset without maxPages', async () => {
            jest.spyOn(PdfProcessingService, 'getPdfPageCount').mockResolvedValue(60);
            const convertSpy = jest.spyOn(PdfProcessingService, 'convertPdfToImages');

            const req = { userPlan: 'free' } as any;
            const files = [makeMulterFile('part1.pdf'), makeMulterFile('part2.pdf')];
            const usageTracker = { recordUsage: jest.fn(), getSummary: jest.fn() } as any;

            let caught: any;
            try {
                await MarkingPipelineService.executePipeline(
                    req,
                    files,
                    'sub-over-100-multipdf',
                    { model: 'auto' },
                    () => {},
                    usageTracker
                );
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('PDF_PAGE_LIMIT_EXCEEDED');
            expect(caught.requiresUpgrade).toBe(false);
            expect(caught.userMessage).toContain('120 pages');
            expect(convertSpy).not.toHaveBeenCalled();

            // Now with selectedRawPageIndices selecting only pages from part1.pdf
            const sentinel = new UserFacingError({
                code: 'SYSTEM_ERROR',
                category: 'system',
                userMessage: 'MULTI_PDF_CHUNK_REACHED'
            });
            convertSpy.mockRejectedValue(sentinel);
            await expect(
                MarkingPipelineService.executePipeline(
                    req,
                    files,
                    'sub-chunk-multipdf',
                    { model: 'auto', selectedRawPageIndices: [0, 1, 2] },
                    () => {},
                    usageTracker
                )
            ).rejects.toThrow('MULTI_PDF_CHUNK_REACHED');

            expect(convertSpy).toHaveBeenCalledTimes(1);
            const callOptions = convertSpy.mock.calls[0][1] || {};
            expect(callOptions.maxPages).toBeUndefined();
            expect(callOptions.selectedPageIndices).toEqual([0, 1, 2]);
        });

        it('gates >100-image upload before normalization with UserFacingError (PDF_PAGE_LIMIT_EXCEEDED, requiresUpgrade: false)', async () => {
            const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
            const files = Array.from({ length: 105 }, (_, i) => ({
                ...makeMulterFile(`page-${i + 1}.png`, 'image/png'),
                buffer: pngHeader
            }));
            const req = { userPlan: 'free' } as any;
            const usageTracker = { recordUsage: jest.fn(), getSummary: jest.fn() } as any;

            let caught: any;
            try {
                await MarkingPipelineService.executePipeline(
                    req,
                    files,
                    'sub-over-100-images',
                    { model: 'auto' },
                    () => {},
                    usageTracker
                );
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('PDF_PAGE_LIMIT_EXCEEDED');
            expect(caught.requiresUpgrade).toBe(false);
            expect(caught.userMessage).toContain('105 pages');
            expect(caught.userMessage).not.toMatch(/upgrade to pro/i);
        });

        it('gates >100-page mixed upload before rasterization and allows selectedRawPageIndices subset without maxPages', async () => {
            jest.spyOn(PdfProcessingService, 'getPdfPageCount').mockResolvedValue(105);
            const convertSpy = jest.spyOn(PdfProcessingService, 'convertPdfToImages');

            // Valid 1x1 transparent PNG so sharp / ImageUtils does not log corrupt-header async warnings
            const valid1x1Png = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
                'base64'
            );
            const files = [
                { ...makeMulterFile('cover.png', 'image/png'), buffer: valid1x1Png },
                makeMulterFile('workbook.pdf', 'application/pdf')
            ];
            const req = { userPlan: 'free' } as any;
            const usageTracker = { recordUsage: jest.fn(), getSummary: jest.fn() } as any;

            let caught: any;
            try {
                await MarkingPipelineService.executePipeline(
                    req,
                    files,
                    'sub-over-100-mixed',
                    { model: 'auto' },
                    () => {},
                    usageTracker
                );
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('PDF_PAGE_LIMIT_EXCEEDED');
            expect(caught.requiresUpgrade).toBe(false);
            expect(caught.userMessage).toContain('106 pages');
            expect(convertSpy).not.toHaveBeenCalled();

            const sentinel = new UserFacingError({
                code: 'SYSTEM_ERROR',
                category: 'system',
                userMessage: 'MIXED_CHUNK_REACHED'
            });
            convertSpy.mockRejectedValue(sentinel);
            await expect(
                MarkingPipelineService.executePipeline(
                    req,
                    files,
                    'sub-chunk-mixed',
                    { model: 'auto', selectedRawPageIndices: [0, 1, 2] },
                    () => {},
                    usageTracker
                )
            ).rejects.toThrow('MIXED_CHUNK_REACHED');

            expect(convertSpy).toHaveBeenCalledTimes(1);
            const callOptions = convertSpy.mock.calls[0][1] || {};
            expect(callOptions.maxPages).toBeUndefined();
            expect(callOptions.selectedPageIndices).toEqual([0, 1]);
        });

        it('gates >100 selectedRawPageIndices pages before rasterization on Free plan', async () => {
            jest.spyOn(PdfProcessingService, 'getPdfPageCount').mockResolvedValue(120);
            const convertSpy = jest.spyOn(PdfProcessingService, 'convertPdfToImages');

            const req = { userPlan: 'free' } as any;
            const files = [makeMulterFile('huge-workbook.pdf')];
            const usageTracker = { recordUsage: jest.fn(), getSummary: jest.fn() } as any;
            const over100Selected = Array.from({ length: 105 }, (_, i) => i);

            let caught: any;
            try {
                await MarkingPipelineService.executePipeline(
                    req,
                    files,
                    'sub-over-100-selected-chunk',
                    { model: 'auto', selectedRawPageIndices: over100Selected },
                    () => {},
                    usageTracker
                );
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('PDF_PAGE_LIMIT_EXCEEDED');
            expect(caught.requiresUpgrade).toBe(false);
            expect(caught.userMessage).toContain('105 pages');
            expect(convertSpy).not.toHaveBeenCalled();
        });

        it('enforces post-raster >100-page UserFacingError fallback when getPdfPageCount returns null (unparseable PDF)', async () => {
            jest.spyOn(PdfProcessingService, 'getPdfPageCount').mockResolvedValue(null);
            const fakePages = Array.from({ length: 105 }, (_, i) => ({
                pageIndex: i,
                imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
                width: 100,
                height: 100
            }));
            const convertSpy = jest.spyOn(PdfProcessingService, 'convertPdfToImages').mockResolvedValue(fakePages as any);

            const req = { userPlan: 'free' } as any;
            const files = [makeMulterFile('unparseable-huge.pdf')];
            const usageTracker = { recordUsage: jest.fn(), getSummary: jest.fn() } as any;

            let caught: any;
            try {
                await MarkingPipelineService.executePipeline(
                    req,
                    files,
                    'sub-unparseable-105',
                    { model: 'auto' },
                    () => {},
                    usageTracker
                );
            } catch (err) {
                caught = err;
            }

            expect(convertSpy).toHaveBeenCalledTimes(1);
            const callOptions = convertSpy.mock.calls[0][1] || {};
            expect(callOptions.maxPages).toBe(100);
            expect(typeof callOptions.maxPagesErrorMessage).toBe('function');
            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('PDF_PAGE_LIMIT_EXCEEDED');
            expect(caught.requiresUpgrade).toBe(false);
            expect(caught.userMessage).toContain('105 pages');
        });

        it('formats PdfProcessingService maxPagesErrorMessage via buildRawCombinedPageLimitError without leaking prefix', async () => {
            const doc = await PDFDocument.create();
            for (let i = 0; i < 5; i++) {
                doc.addPage([595, 842]);
            }
            const pdfBytes = Buffer.from(await doc.save());

            let caught: any;
            try {
                await PdfProcessingService.convertPdfToImages(pdfBytes, {
                    maxPages: 3,
                    maxPagesErrorMessage: (count?: number) => buildRawCombinedPageLimitError(count || 4, 3).userMessage
                });
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(UserFacingError);
            expect(caught.code).toBe('PDF_PAGE_LIMIT_EXCEEDED');
            expect(caught.requiresUpgrade).toBe(false);
            expect(caught.userMessage).toContain('5 pages');
            expect(caught.userMessage).toContain('3 pages/images');
            expect(caught.userMessage).not.toContain('PDF_PAGE_LIMIT_EXCEEDED:');
            expect(caught.userMessage).not.toMatch(/upgrade to pro/i);
        });
    });
});
