import {
    filterPagesBySelectedRawIndices,
    assertNoEarlyMultiCoverPdf,
    buildDetectedPaperGroupsHelper,
    buildFreePageLimitExceededMessage,
    buildOverdraftLimitExceededMessage
} from '../services/marking/MarkingPipelineService.js';
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

        it('skips throwing COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED when isPdf: true and isUserSelectedPageChunk: true', () => {
            expect(() =>
                PaperSplitterService.assertSinglePaperClassification(conflictingClassification, {
                    isPdf: true,
                    pageCount: 25,
                    fileName: 'workbook.pdf',
                    isUserSelectedPageChunk: true
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
});
