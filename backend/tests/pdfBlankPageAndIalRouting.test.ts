import { resolveSubjectProfile } from '../config/subjectProfiles.js';
import { PaperSplitterService } from '../services/marking/PaperSplitterService.js';
import {
    computeGeoSubjectVote,
    detectIsFrontCover,
    computeIsScrambledPdf,
    recoverGenericTotalMarks
} from '../services/marking/MarkingPipelineService.js';
import type { StandardizedPage } from '../types/markingRouter.js';
import type { GeometryAnalysisResult } from '../services/marking/ImageGeometryService.js';

function makeMockPage(pageIndex: number, fileName = `img_${pageIndex}.jpg`): StandardizedPage {
    return {
        pageIndex,
        originalPageIndex: pageIndex,
        imageData: `data:image/jpeg;base64,mock_${pageIndex}`,
        originalFileName: fileName,
        width: 800,
        height: 1100
    };
}

describe('Edexcel IAL Maths Routing & PaperSplitter Code Extraction', () => {
    it('routes Edexcel IAL Maths paper codes to MATHS even when detectedSubject has noise', () => {
        const ialCodes = ['WMA14/01', 'WMA11/01', 'WMA12/01', 'WMA13/01', 'WME01/01', 'WST02/01', 'WFM01/01', 'WDM11/01', 'WDM01/01'];
        for (const paperCode of ialCodes) {
            const profile = resolveSubjectProfile({
                detectedSubject: 'ENGLISH_LANGUAGE',
                paperCode
            });
            expect(profile.key).toBe('MATHS');
            expect(profile.paradigm).toBe('POINT_BASED');
            expect(profile.ocrStrategy).toBe('MATHPIX_LATEX');
        }
    });

    it('routes ENGLISH_LANGUAGE when detectedSubject is ENGLISH_LANGUAGE and paperCode is not Maths', () => {
        const profile = resolveSubjectProfile({
            detectedSubject: 'ENGLISH_LANGUAGE',
            paperCode: '8700/1'
        });
        expect(profile.key).toBe('ENGLISH_LANGUAGE');
        expect(profile.paradigm).toBe('LEVEL_OF_RESPONSE');
    });

    it('extracts WMA14/01 from filename in PaperSplitterService.splitIntoPaperBuckets', () => {
        const pages = [0, 1, 2].map(idx => makeMockPage(idx, 'WMA14-01-que-20230613.pdf'));
        const geo: GeometryAnalysisResult[] = pages.map((_, idx) => ({
            is_acceptable_quality: true,
            needs_rotation: 0,
            is_two_page_spread: false,
            is_marking_scheme: false,
            is_supported_doc: true,
            detected_subject: idx === 0 ? 'ENGLISH_LANGUAGE' : 'MATHS',
            is_cover_page: idx === 0,
            booklet_page_number: idx + 1,
            first_question_number: idx === 0 ? undefined : idx
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
        expect(buckets[0].paperCodeHint).toBe('WMA14/01');
    });

    it('routes IAL Maths codes in fileNames or paperTitle (including underscores) to MATHS even when paperCode is empty and detectedSubject has noise', () => {
        const fromFileName = resolveSubjectProfile({
            detectedSubject: 'ENGLISH_LANGUAGE',
            fileNames: ['WMA14_01_que_20230613.pdf']
        });
        expect(fromFileName.key).toBe('MATHS');

        const fromTitle = resolveSubjectProfile({
            detectedSubject: 'ENGLISH_LANGUAGE',
            paperTitle: 'Edexcel IAL Pure Mathematics P4 (WMA14/01)'
        });
        expect(fromTitle.key).toBe('MATHS');
    });
});

describe('MarkingPipelineService PDF Blank-Page Ordering, Majority Subject Vote & Generic Maths Budget', () => {
    it('computeGeoSubjectVote uses majority vote across non-scheme pages so 1 ENGLISH_LANGUAGE cover cannot override 27 MATHS pages', () => {
        const geoResults = [
            { is_marking_scheme: false, detected_subject: 'ENGLISH_LANGUAGE' },
            ...Array.from({ length: 27 }, () => ({ is_marking_scheme: false, detected_subject: 'MATHS' })),
            // Marking scheme pages voting ENGLISH_LANGUAGE should be ignored
            ...Array.from({ length: 30 }, () => ({ is_marking_scheme: true, detected_subject: 'ENGLISH_LANGUAGE' }))
        ];

        expect(computeGeoSubjectVote(geoResults)).toBe('MATHS');
        expect(computeGeoSubjectVote([])).toBeUndefined();
    });

    it('detectIsFrontCover + computeIsScrambledPdf keep sequential 28-page WMA14/01 PDF with interior blank pages unscrambled', () => {
        // Simulate 28-page PDF where Page 0 is cover, Pages 3,4,15,16,19,20 (1-indexed: 4,5,16,17,20,21) are interior blank pages
        const blankIndices = new Set([3, 4, 15, 16, 19, 20]);
        const questionStartByIdx: Record<number, number> = {
            6: 1, 7: 1, 8: 2, 9: 2, 10: 3, 11: 3, 12: 4, 13: 4, 14: 5,
            17: 6, 18: 6, 21: 7, 22: 7, 23: 7, 24: 8, 25: 8, 26: 8, 27: 8
        };

        const pageSortMap = Array.from({ length: 28 }, (_, idx) => {
            const isCover = idx === 0;
            const isBlank = blankIndices.has(idx);
            const isMeta = isCover || isBlank || idx === 1 || idx === 2 || idx === 5;
            const pageOcrText = isCover
                ? 'Pearson Edexcel International Advanced Level Candidate Surname Centre Number Instructions to Candidates Total mark for this paper is 75'
                : isBlank
                    ? 'Leave blank'
                    : '';
            const isFrontCover = detectIsFrontCover({
                isGeoCover: isCover,
                originalIdx: idx,
                isMeta,
                pageOcrText
            });
            return {
                originalIdx: idx,
                minQ: questionStartByIdx[idx] ?? 999999,
                isMeta,
                isFrontCover
            };
        });

        // All 6 interior blank pages must NOT be marked as front covers
        for (const bIdx of blankIndices) {
            expect(pageSortMap[bIdx].isFrontCover).toBe(false);
        }
        expect(pageSortMap[0].isFrontCover).toBe(true);

        // Run Orphan & Interior Booklet Page Rescue loop (same condition as MarkingPipelineService)
        for (let i = 1; i < pageSortMap.length; i++) {
            const current = pageSortMap[i];
            const prev = pageSortMap[i - 1];
            if (current.minQ === 999999 && prev.minQ !== 999999 && !current.isFrontCover) {
                current.minQ = prev.minQ + 0.0001;
            }
        }

        const { majorQuestionInversions, hasDisplacedFrontCover, isScrambledPdf } = computeIsScrambledPdf({
            pageSortMap,
            isPdf: true,
            isMultiplePdfs: false
        });

        expect(majorQuestionInversions).toBe(0);
        expect(hasDisplacedFrontCover).toBe(false);
        expect(isScrambledPdf).toBe(false);
    });

    it('computeIsScrambledPdf triggers Straightener when PDF has >= 2 inversions or 1 inversion + displaced front cover', () => {
        const scrambledTwoInversions = computeIsScrambledPdf({
            pageSortMap: [
                { minQ: 999999, isFrontCover: true },
                { minQ: 5, isFrontCover: false },
                { minQ: 2, isFrontCover: false },
                { minQ: 1, isFrontCover: false }
            ],
            isPdf: true,
            isMultiplePdfs: false
        });
        expect(scrambledTwoInversions.majorQuestionInversions).toBe(2);
        expect(scrambledTwoInversions.isScrambledPdf).toBe(true);

        const displacedCoverOneInversion = computeIsScrambledPdf({
            pageSortMap: [
                { minQ: 3, isFrontCover: false },
                { minQ: 1, isFrontCover: false },
                { minQ: 999999, isFrontCover: true }
            ],
            isPdf: true,
            isMultiplePdfs: false
        });
        expect(displacedCoverOneInversion.majorQuestionInversions).toBe(1);
        expect(displacedCoverOneInversion.hasDisplacedFrontCover).toBe(true);
        expect(displacedCoverOneInversion.isScrambledPdf).toBe(true);
    });

    it('recoverGenericTotalMarks preserves AI-stated printed question budgets (summing to 75 for WMA14/01) in Generic Maths mode', () => {
        const printedBudgets = [9, 6, 11, 7, 9, 10, 13, 10]; // sum = 75
        let totalRecovered = 0;

        for (const budget of printedBudgets) {
            const task: any = {
                questionNumber: '1',
                markingScheme: { isGeneric: true, totalMarks: 0 }
            };
            const result: any = {
                score: { awardedMarks: 2, totalMarks: budget, scoreText: `2/${budget}` }
            };
            // Only 2 annotations emitted, which would otherwise shrink denominator from `budget` to 2!
            const finalizedAnnotations = [
                { action: 'tick', text: 'M1' },
                { action: 'tick', text: 'A1' }
            ];

            recoverGenericTotalMarks({
                task,
                result,
                finalizedAnnotations,
                newAwarded: 2,
                aiStatedTotalMarks: budget
            });

            expect(result.score.totalMarks).toBe(budget);
            expect(task.markingScheme.totalMarks).toBe(budget);
            totalRecovered += result.score.totalMarks;
        }

        expect(totalRecovered).toBe(75);
    });
});
