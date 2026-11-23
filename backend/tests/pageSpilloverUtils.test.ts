import { rescueOrphanTopLineSpillover } from '../services/marking/PageSpilloverUtils.js';

describe('rescueOrphanTopLineSpillover', () => {
    const makeBaseSetup = (overrides?: {
        q3Text?: string;
        q2SourceIndices?: number[];
        q2bSourceIndices?: number[];
        page1Blocks?: any[];
    }) => {
        const classificationResult = {
            questions: [
                {
                    questionNumber: '1',
                    text: 'June 2026 paper 2',
                    sourceImageIndex: 0,
                    sourceImageIndices: [0],
                    studentWorkLines: [
                        { id: 'p0_q1_line_1', text: 'k = -3', pageIndex: 0, position: { x: 100, y: 800, width: 200, height: 40, pageIndex: 0 } }
                    ]
                },
                {
                    questionNumber: '2',
                    text: '',
                    sourceImageIndex: 0,
                    sourceImageIndices: overrides?.q2SourceIndices ?? [0],
                    subQuestions: [
                        {
                            part: 'a',
                            text: '',
                            sourceImageIndex: 0,
                            sourceImageIndices: [0],
                            studentWorkLines: [
                                { id: 'p0_q2_line_1', text: '= 3.39', pageIndex: 0, position: { x: 100, y: 1300, width: 200, height: 40, pageIndex: 0 } }
                            ]
                        },
                        {
                            part: 'b',
                            text: '',
                            sourceImageIndex: 0,
                            sourceImageIndices: overrides?.q2bSourceIndices ?? [0],
                            studentWorkLines: [
                                { id: 'p0_q2_line_6', text: '= 3.39 + (3.545 - 2.358)', pageIndex: 0, position: { x: 100, y: 1950, width: 500, height: 40, pageIndex: 0 } }
                            ]
                        }
                    ]
                },
                {
                    questionNumber: '3',
                    text: overrides?.q3Text ?? '',
                    sourceImageIndex: 1,
                    sourceImageIndices: [1],
                    subQuestions: [
                        {
                            part: 'a',
                            text: '',
                            sourceImageIndex: 1,
                            sourceImageIndices: [1],
                            studentWorkLines: [
                                { id: 'p1_q3_line_1', text: 'S_{65} = 4940', pageIndex: 1, position: { x: 100, y: 360, width: 300, height: 40, pageIndex: 1 } }
                            ]
                        }
                    ]
                }
            ]
        };

        const allPagesOcrData = [
            {
                pageIndex: 0,
                ocrData: {
                    mathBlocks: [
                        { globalBlockId: 'p0_ocr_12', mathpixLatex: '=3.39+(3.545-2.358)', coordinates: { x: 100, y: 1950, width: 500, height: 40 } }
                    ]
                }
            },
            {
                pageIndex: 1,
                ocrData: {
                    mathBlocks: overrides?.page1Blocks ?? [
                        { globalBlockId: 'p1_ocr_1', mathpixLatex: '=4.58', coordinates: { x: 180, y: 180, width: 160, height: 45 } },
                        { globalBlockId: 'p1_ocr_2', mathpixLatex: '(3) [PRINTED_INSTRUCTION [Q3]]', coordinates: { x: 120, y: 310, width: 60, height: 45 } },
                        { globalBlockId: 'p1_ocr_3', mathpixLatex: 'a) S_{65} = 4940', coordinates: { x: 200, y: 320, width: 300, height: 45 } }
                    ]
                }
            }
        ];

        const pageDimensionsMap = new Map<number, { width: number; height: number }>([
            [0, { width: 1700, height: 2200 }],
            [1, { width: 1700, height: 2200 }]
        ]);

        return { classificationResult, allPagesOcrData, pageDimensionsMap };
    };

    it('attaches Page 2 orphan continuation line (=4.58) to Q2b on lined notebook pages', () => {
        const { classificationResult, allPagesOcrData, pageDimensionsMap } = makeBaseSetup();

        const rescues = rescueOrphanTopLineSpillover({
            classificationResult,
            allPagesOcrData,
            pageDimensionsMap
        });

        expect(rescues).toHaveLength(1);
        expect(rescues[0]).toEqual({
            fromPageIndex: 1,
            toPageIndex: 0,
            questionNumber: '2',
            subQuestionPart: 'b',
            rescuedTexts: ['=4.58']
        });

        const q2 = classificationResult.questions[1];
        const q2b = q2.subQuestions![1];
        expect(q2.sourceImageIndices).toEqual([0, 1]);
        expect(q2b.sourceImageIndices).toEqual([0, 1]);
        expect(q2b.studentWorkLines).toHaveLength(2);
        expect(q2b.studentWorkLines[1]).toMatchObject({
            id: 'p1_q2_line_7',
            text: '=4.58',
            pageIndex: 1,
            globalBlockId: 'p1_ocr_1'
        });
    });

    it('does NOT attach Page 2 when only a page number or boilerplate appears above (3)', () => {
        const { classificationResult, allPagesOcrData, pageDimensionsMap } = makeBaseSetup({
            page1Blocks: [
                { globalBlockId: 'p1_ocr_1', mathpixLatex: '2', coordinates: { x: 800, y: 80, width: 30, height: 30 } },
                { globalBlockId: 'p1_ocr_2', mathpixLatex: 'DO NOT WRITE IN THIS AREA', coordinates: { x: 100, y: 120, width: 400, height: 30 } },
                { globalBlockId: 'p1_ocr_3', mathpixLatex: '(3) [PRINTED_INSTRUCTION [Q3]]', coordinates: { x: 120, y: 310, width: 60, height: 45 } }
            ]
        });

        const rescues = rescueOrphanTopLineSpillover({
            classificationResult,
            allPagesOcrData,
            pageDimensionsMap
        });

        expect(rescues).toHaveLength(0);
        expect(classificationResult.questions[1].sourceImageIndices).toEqual([0]);
    });

    it('does NOT touch printed exam papers where the next question has a printed question stem', () => {
        const { classificationResult, allPagesOcrData, pageDimensionsMap } = makeBaseSetup({
            q3Text: 'The sum of the first 65 terms of an arithmetic series is 4940. Show that a + 32d = 76.'
        });

        const rescues = rescueOrphanTopLineSpillover({
            classificationResult,
            allPagesOcrData,
            pageDimensionsMap
        });

        expect(rescues).toHaveLength(0);
        expect(classificationResult.questions[1].sourceImageIndices).toEqual([0]);
    });

    it('skips when the Mapper already mapped Q2 onto Page 2', () => {
        const { classificationResult, allPagesOcrData, pageDimensionsMap } = makeBaseSetup({
            q2SourceIndices: [0, 1],
            q2bSourceIndices: [0, 1]
        });

        const rescues = rescueOrphanTopLineSpillover({
            classificationResult,
            allPagesOcrData,
            pageDimensionsMap
        });

        expect(rescues).toHaveLength(0);
        expect(classificationResult.questions[1].subQuestions![1].studentWorkLines).toHaveLength(1);
    });
});
