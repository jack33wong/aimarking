import { MarkingOutputService } from '../services/marking/MarkingOutputService.js';
import { SVGOverlayService } from '../services/marking/svgOverlayService.js';

describe('MarkingOutputService.generateOutput (Fix 1: extraStudentRects)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('collects extraStudentRects from allClassificationResults (pageIndex + originalPageIndex fallback) and passes them as 11th arg', async () => {
    const burnSpy = jest
      .spyOn(SVGOverlayService, 'burnSVGOverlayServerSide')
      .mockImplementation(async (imageData: string) => imageData);

    const standardizedPages: any[] = [
      { pageIndex: 0, width: 1000, height: 2000, imageData: 'data:image/png;base64,AAA' },
      { pageIndex: 1, originalPageIndex: 5, width: 1000, height: 2000, imageData: 'data:image/png;base64,BBB' }
    ];

    const allClassificationResults: any[] = [
      {
        pageIndex: 0,
        result: {
          questions: [
            {
              questionNumber: '1',
              studentWorkLines: [{ position: { x: 10, y: 20, width: 30, height: 5 } }],
              studentDrawingPosition: { x: 50, y: 60, width: 20, height: 10 }
            }
          ]
        }
      },
      {
        pageIndex: 5,
        result: {
          questions: [
            {
              questionNumber: '2',
              subQuestions: [
                {
                  subQuestion: '2a',
                  studentWorkLines: [{ position: { x: 15, y: 25, w: 40, h: 4 } }],
                  studentDrawingPosition: { x: null, y: 10, width: 20, height: 5 } // should be ignored
                }
              ]
            }
          ]
        }
      }
    ];

    const markingResults: any[] = [
      {
        questionNumber: '1',
        pageIndex: 0,
        score: { awardedMarks: 1, totalMarks: 1 },
        annotations: [{ pageIndex: 0, action: 'tick', text: 'B1', bbox: [100, 400, 300, 100] }]
      },
      {
        questionNumber: '2',
        pageIndex: 1,
        score: { awardedMarks: 0, totalMarks: 1 },
        annotations: [{ pageIndex: 1, action: 'cross', text: 'B0', bbox: [150, 500, 400, 80] }]
      }
    ];

    await MarkingOutputService.generateOutput(
      standardizedPages,
      markingResults,
      {},
      allClassificationResults,
      [],
      [],
      'sub-1',
      {},
      new Map(),
      () => {},
      ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5']
    );

    expect(burnSpy).toHaveBeenCalledTimes(2);

    // Page 0: exact pageIndex match
    const page0ExtraRects = burnSpy.mock.calls[0][10];
    expect(page0ExtraRects).toEqual([
      { x: 100, y: 400, w: 300, h: 100 },
      { x: 500, y: 1200, w: 200, h: 200 }
    ]);

    // Page 1: originalPageIndex (5) fallback, null x ignored
    const page1ExtraRects = burnSpy.mock.calls[1][10];
    expect(page1ExtraRects).toEqual([
      { x: 150, y: 500, w: 400, h: 80 }
    ]);
  });
});
