import {
    extractLeadingBaseQNum,
    resolvePageMinSortWeight,
    computeIsScrambledPdf,
    detectIsFrontCover,
    getInstanceMinWeight,
    getAnnotationMarkVal,
    applyPointBasedGuillotine
} from '../services/marking/MarkingPipelineService.js';
import { ScoreAuditor } from '../services/marking/core/ScoreAuditor.js';

describe('MarkingPipelineService V2 5-Fix Suite', () => {
    describe('Fix 1: resolvePageMinSortWeight (decimal sub-parts & intro stems)', () => {
        it('never lets decimal sub-parts (1.1, 1.2, 2.1) overwrite parent question numbers in checkWeightRecursive', () => {
            const { minSortWeight, pageWeights } = resolvePageMinSortWeight({
                questions: [
                    {
                        questionNumber: '11',
                        subQuestions: [
                            { part: '1.1' },
                            { part: '1.2' },
                            { part: '2.1' }
                        ]
                    }
                ],
                isIntroStem: false
            });

            expect(minSortWeight).toBeGreaterThanOrEqual(11);
            expect(minSortWeight).toBeLessThan(12);
            expect(pageWeights.some(pw => pw.w < 11)).toBe(false);
        });

        it('never lets decimal sub-parts (1.1, 1.2, 2.1) overwrite parent question numbers in mapperHints fallback', () => {
            const { minSortWeight, pageWeights } = resolvePageMinSortWeight({
                questions: [],
                mapperHints: ['5', '1.1', '1.2', '2.1'],
                isIntroStem: true
            });

            expect(minSortWeight).toBeGreaterThanOrEqual(5);
            expect(minSortWeight).toBeLessThan(6);
            expect(pageWeights.some(pw => pw.w < 5)).toBe(false);
        });

        it('uses baseWeight + 0.00005 for generic intro stems and baseWeight + 0.9 for continuations', () => {
            const intro = resolvePageMinSortWeight({
                questions: [{ questionNumber: '11' }],
                isIntroStem: true
            });
            const subI = resolvePageMinSortWeight({
                questions: [{ questionNumber: '11', subQuestions: [{ part: '(i)' }] }],
                isIntroStem: false
            });
            const subA = resolvePageMinSortWeight({
                questions: [{ questionNumber: '11', subQuestions: [{ part: 'a' }] }],
                isIntroStem: false
            });
            const continuation = resolvePageMinSortWeight({
                questions: [{ questionNumber: '11' }],
                isIntroStem: false
            });

            expect(intro.minSortWeight).toBeCloseTo(11.00005, 6);
            expect(continuation.minSortWeight).toBeCloseTo(11.9, 6);
            expect(intro.minSortWeight).toBeLessThan(subI.minSortWeight);
            expect(subI.minSortWeight).toBeLessThan(subA.minSortWeight);
            expect(subA.minSortWeight).toBeLessThan(continuation.minSortWeight);
        });
    });

    describe('Fix 2: extractLeadingBaseQNum', () => {
        it('extracts leading integer without concatenating sub-part digits', () => {
            expect(extractLeadingBaseQNum('11a')).toBe('11');
            expect(extractLeadingBaseQNum('2.1')).toBe('2');
            expect(extractLeadingBaseQNum('10(1)')).toBe('10');
            expect(extractLeadingBaseQNum('Q3b')).toBe('3');
            expect(extractLeadingBaseQNum('Q.3b')).toBe('3');
            expect(extractLeadingBaseQNum('Question: 4a')).toBe('4');
            expect(extractLeadingBaseQNum('Question 15.2')).toBe('15');
            expect(extractLeadingBaseQNum('')).toBe('');
            expect(extractLeadingBaseQNum(null)).toBe('');
            expect(extractLeadingBaseQNum(undefined)).toBe('');
            expect(extractLeadingBaseQNum('abc')).toBe('');
        });
    });

    describe('Fix 3: computeIsScrambledPdf with bookletPage guard', () => {
        it('does not mark a single PDF as scrambled when bookletPages are strictly increasing (>= max(3, floor(len * 0.5)))', () => {
            const pageSortMap = [
                { minQ: 999999, isFrontCover: true, bookletPage: 1 },
                { minQ: 5, isFrontCover: false, bookletPage: 2 },
                { minQ: 2, isFrontCover: false, bookletPage: 3 }, // inversion 1
                { minQ: 4, isFrontCover: false, bookletPage: 4 },
                { minQ: 1, isFrontCover: false, bookletPage: 5 }  // inversion 2
            ];

            const res = computeIsScrambledPdf({
                pageSortMap,
                isPdf: true,
                isMultiplePdfs: false
            });

            expect(res.majorQuestionInversions).toBe(2);
            expect(res.hasDisplacedFrontCover).toBe(false);
            expect(res.isScrambledPdf).toBe(false);
        });

        it('still marks as scrambled when bookletPages are non-strictly increasing (<=), multiple PDFs, or displaced front cover', () => {
            const duplicateBookletPage = [
                { minQ: 5, isFrontCover: false, bookletPage: 2 },
                { minQ: 2, isFrontCover: false, bookletPage: 2 }, // <= triggers failure
                { minQ: 4, isFrontCover: false, bookletPage: 3 },
                { minQ: 1, isFrontCover: false, bookletPage: 4 }
            ];
            expect(computeIsScrambledPdf({
                pageSortMap: duplicateBookletPage,
                isPdf: true,
                isMultiplePdfs: false
            }).isScrambledPdf).toBe(true);

            const multiPdf = [
                { minQ: 5, isFrontCover: false, bookletPage: 1 },
                { minQ: 2, isFrontCover: false, bookletPage: 2 },
                { minQ: 1, isFrontCover: false, bookletPage: 3 }
            ];
            expect(computeIsScrambledPdf({
                pageSortMap: multiPdf,
                isPdf: true,
                isMultiplePdfs: true
            }).isScrambledPdf).toBe(true);

            const displacedCover = [
                { minQ: 5, isFrontCover: false, bookletPage: 1 },
                { minQ: 2, isFrontCover: false, bookletPage: 2 },
                { minQ: 999999, isFrontCover: true, bookletPage: 3 }
            ];
            expect(computeIsScrambledPdf({
                pageSortMap: displacedCover,
                isPdf: true,
                isMultiplePdfs: false
            }).isScrambledPdf).toBe(true);
        });
    });

    describe('Fix 4: getInstanceMinWeight', () => {
        it('handles letter, roman, numeric, and already-prefixed sub-question parts accurately', () => {
            const wA = getInstanceMinWeight({ subQuestions: [{ part: 'a' }] }, '11');
            const wB = getInstanceMinWeight({ subQuestions: [{ part: '(b)' }] }, '11');
            const wRomanI = getInstanceMinWeight({ subQuestions: [{ part: '(i)' }] }, '11');
            const wNumeric = getInstanceMinWeight({ subQuestions: [{ part: '1' }] }, '11');
            const wDecimal = getInstanceMinWeight({ subQuestions: [{ part: '1.2' }] }, '11');
            const wPrefixed = getInstanceMinWeight({ subQuestions: [{ part: '11c' }] }, '11');

            expect(wA).toBeCloseTo(11.01, 5);
            expect(wB).toBeCloseTo(11.02, 5);
            expect(wRomanI).toBeCloseTo(11.0001, 5);
            expect(wNumeric).toBeCloseTo(11.1, 5);
            expect(wDecimal).toBeCloseTo(11.1002, 5);
            expect(wPrefixed).toBeCloseTo(11.03, 5);
            expect(wA).toBeLessThan(wB);
            expect(wB).toBeLessThan(wPrefixed);
        });
    });

    describe('Fix 5: Generic Rubric Mode guillotine & cross exclusion', () => {
        it('excludes cross annotations with digits from getAnnotationMarkVal', () => {
            expect(getAnnotationMarkVal({ action: 'cross', text: 'M1' })).toBe(0);
            expect(getAnnotationMarkVal({ action: 'cross', text: 'A0' })).toBe(0);
            expect(getAnnotationMarkVal({ action: 'cross', text: 'X2' })).toBe(0);
            expect(getAnnotationMarkVal({ action: 'tick', text: 'B2' })).toBe(2);
            expect(getAnnotationMarkVal({ action: 'tick', text: '\\sqrt{27}' })).toBe(1);
            expect(getAnnotationMarkVal({ action: 'tick', text: 'M0' })).toBe(0);
            expect(getAnnotationMarkVal({ action: 'note', text: 'Check units' })).toBe(0);
        });

        it('bypasses Sub-Question Guillotine in Generic Rubric Mode when rawTotalAwardedMarks <= totalBudget', () => {
            const annotations = [
                { action: 'tick', text: 'B3', subQuestion: '2a' },
                { action: 'tick', text: 'M2', subQuestion: '2b' },
                { action: 'cross', text: 'A0 (1)', subQuestion: '2b' }
            ];

            const res = applyPointBasedGuillotine({
                annotations,
                questionNumber: '2',
                subQuestionBudgets: { '2a': 1, '2b': 2 }, // noisy OCR sub-budgets
                totalBudget: 5,
                isGenericScheme: true,
                hasIncompleteBudgets: false
            });

            expect(res.rawTotalAwardedMarks).toBe(5);
            expect(res.hasAnyCrossOrZero).toBe(true);
            expect(res.bypassSubGuillotineForGeneric).toBe(true);
            expect(res.finalizedAnnotations).toHaveLength(3);
        });

        it('still enforces totalBudget via Global Guillotine in Generic Mode if rawTotalAwardedMarks > totalBudget', () => {
            const annotations = [
                { action: 'tick', text: 'A2', subQuestion: '2a' },
                { action: 'tick', text: 'B2', subQuestion: '2b' },
                { action: 'tick', text: 'M2', subQuestion: '2b' }
            ];

            const res = applyPointBasedGuillotine({
                annotations,
                questionNumber: '2',
                subQuestionBudgets: {},
                totalBudget: 4,
                isGenericScheme: true,
                hasIncompleteBudgets: true
            });

            expect(res.rawTotalAwardedMarks).toBe(6);
            expect(res.bypassSubGuillotineForGeneric).toBe(true);
            // Global guillotine keeps A2 (2) + B2 (2) = 4, cuts M2
            expect(res.finalizedAnnotations).toHaveLength(2);
        });

        it('does NOT bypass Sub-Question Guillotine for official (non-generic) schemes', () => {
            const annotations = [
                { action: 'tick', text: 'B2', subQuestion: '2a' },
                { action: 'tick', text: 'M1', subQuestion: '2b' }
            ];

            const res = applyPointBasedGuillotine({
                annotations,
                questionNumber: '2',
                subQuestionBudgets: { '2a': 1, '2b': 2 },
                totalBudget: 5,
                isGenericScheme: false,
                hasIncompleteBudgets: false
            });

            expect(res.bypassSubGuillotineForGeneric).toBe(false);
            // B2 (2 marks) exceeds 2a budget (1 mark) and is cut
            expect(res.finalizedAnnotations).toHaveLength(1);
            expect(res.finalizedAnnotations[0].text).toBe('M1');
        });

        it('ScoreAuditor.enforceStrictBudget preserves all 15/15 marks in Generic Mode when OCR swaps sub-question budgets (3i=3, 3ii=2 instead of 2 and 3)', () => {
            const annotations = [
                { action: 'tick', text: 'M1', subQuestion: '3i' },
                { action: 'tick', text: 'A1', subQuestion: '3i' },
                { action: 'tick', text: 'M1', subQuestion: '3ii' },
                { action: 'tick', text: 'M1', subQuestion: '3ii' },
                { action: 'tick', text: 'A1', subQuestion: '3ii' },
                { action: 'tick', text: 'M1', subQuestion: '3iii' },
                { action: 'tick', text: 'M1', subQuestion: '3iii' },
                { action: 'tick', text: 'M1', subQuestion: '3iii' },
                { action: 'tick', text: 'A1', subQuestion: '3iii' },
                { action: 'tick', text: 'A1', subQuestion: '3iii' },
                { action: 'tick', text: 'M1', subQuestion: '3iva' },
                { action: 'tick', text: 'M1', subQuestion: '3iva' },
                { action: 'tick', text: 'A1', subQuestion: '3iva' },
                { action: 'tick', text: 'M1', subQuestion: '3ivb' },
                { action: 'tick', text: 'A1', subQuestion: '3ivb' }
            ];

            const scheme = {
                isGeneric: true,
                questionNumber: '3',
                totalMarks: 0,
                hasIncompleteSubQuestionBudgets: true,
                subQuestionMaxScores: {
                    '3b': 2,
                    '3i': 3,  // OCR swapped 3i (2 marks) and 3ii (3 marks)
                    '3ii': 2,
                    '3iva': 3
                }
            };

            const strictResult = ScoreAuditor.enforceStrictBudget(annotations, scheme);
            expect(strictResult.awardedMarks).toBe(15);
            expect(strictResult.inferredTotalMarks).toBe(15);
            expect(strictResult.annotations).toHaveLength(15);
            expect(strictResult.annotations.filter(a => a.subQuestion === '3ii')).toHaveLength(3);
        });
    });

    describe('Multi-page ordering integration (Fixes 1–4)', () => {
        it('orders hybrid donor intro stem, sub-parts, and continuation pages without false scrambled-PDF trigger', () => {
            const pages = [
                { id: 'cover', isFrontCover: true, bookletPage: 1, questions: [], mapperHints: [], _isIntroStemPage: false },
                { id: 'q11_cont', isFrontCover: false, bookletPage: 5, questions: [{ questionNumber: '11' }], mapperHints: [], _isIntroStemPage: false },
                { id: 'q11b', isFrontCover: false, bookletPage: 4, questions: [{ questionNumber: '11', subQuestions: [{ part: '(b)' }] }], mapperHints: [], _isIntroStemPage: false },
                { id: 'q11a', isFrontCover: false, bookletPage: 3, questions: [{ questionNumber: '11', subQuestions: [{ part: '(a)' }] }], mapperHints: [], _isIntroStemPage: false },
                { id: 'q11_intro', isFrontCover: false, bookletPage: 2, questions: [], mapperHints: ['11'], _isIntroStemPage: true }
            ];

            const weights = pages.map(p => ({
                id: p.id,
                minQ: p.isFrontCover ? 999999 : resolvePageMinSortWeight({
                    questions: p.questions,
                    mapperHints: p.mapperHints,
                    isIntroStem: p._isIntroStemPage
                }).minSortWeight,
                isFrontCover: p.isFrontCover,
                bookletPage: p.bookletPage
            }));

            const sortedByWeight = [...weights].sort((a, b) => {
                if (a.isFrontCover !== b.isFrontCover) return a.isFrontCover ? -1 : 1;
                return a.minQ - b.minQ;
            });

            expect(sortedByWeight.map(p => p.id)).toEqual([
                'cover',
                'q11_intro',
                'q11a',
                'q11b',
                'q11_cont'
            ]);

            // When pages arrive in physical booklet order (bookletPage 1..5) despite question inversions,
            // computeIsScrambledPdf must NOT flag the single PDF as scrambled.
            const physicalOrder = [...weights].sort((a, b) => a.bookletPage - b.bookletPage);
            const scrambledCheck = computeIsScrambledPdf({
                pageSortMap: physicalOrder,
                isPdf: true,
                isMultiplePdfs: false
            });
            expect(scrambledCheck.isScrambledPdf).toBe(false);

            // getInstanceMinWeight ranks 11a before 11b
            expect(getInstanceMinWeight(pages[3].questions[0], '11')).toBeLessThan(
                getInstanceMinWeight(pages[2].questions[0], '11')
            );
        });

        it('detects a displaced front cover uploaded at the end of a batch (originalIdx > 0) even when Surgical OCR skips frontPage', () => {
            // Unofficial test title cover uploaded at index 8 (e.g., removed and re-attached at the end),
            // where Surgical OCR skipped it (pageOcrText is empty) and Mapper classified it as frontPage
            expect(detectIsFrontCover({
                isGeoCover: false,
                originalIdx: 8,
                isMeta: true,
                pageOcrText: '',
                mapperCategory: 'frontPage'
            })).toBe(true);

            // Official cover flagged by Geometry at index 8 with empty OCR text
            expect(detectIsFrontCover({
                isGeoCover: true,
                originalIdx: 8,
                isMeta: true,
                pageOcrText: '',
                mapperCategory: 'metadata'
            })).toBe(true);

            // Interior blank filler page at index 5 must NOT be treated as a front cover
            expect(detectIsFrontCover({
                isGeoCover: false,
                originalIdx: 5,
                isMeta: true,
                pageOcrText: '',
                mapperCategory: 'metadata',
                geoTextSnippet: 'There are no questions printed on this page'
            })).toBe(false);
        });
    });
});
