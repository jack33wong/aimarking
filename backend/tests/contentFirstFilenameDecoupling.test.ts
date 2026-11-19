import { PDFDocument, StandardFonts } from 'pdf-lib';
import PdfProcessingService from '../services/pdf/PdfProcessingService.js';
import { PaperSplitterService } from '../services/marking/PaperSplitterService.js';
import { resolveSubjectProfile } from '../config/subjectProfiles.js';
import { extractCoverPaperMetadata, runFastDbPreCheck } from '../services/marking/MarkingPipelineService.js';
import type { StandardizedPage } from '../types/markingRouter.js';
import type { GeometryAnalysisResult } from '../services/marking/ImageGeometryService.js';

async function createTextPdfBuffer(lines: string[]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, idx) => {
    page.drawText(line, {
      x: 50,
      y: 780 - idx * 24,
      size: 12,
      font
    });
  });
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

function makeMockPage(pageIndex: number, fileName: string, sourceIndex: number): StandardizedPage {
  const page: any = {
    pageIndex,
    originalPageIndex: pageIndex,
    imageData: `data:image/jpeg;base64,mock_${pageIndex}`,
    originalFileName: fileName,
    width: 800,
    height: 1100,
    _sourceIndex: sourceIndex
  };
  return page as StandardizedPage;
}

function makeMockPdfFile(name: string, headerText?: string): Express.Multer.File {
  const f: any = {
    fieldname: 'files',
    originalname: name,
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('%PDF-1.4\n%%EOF')
  };
  if (headerText) {
    f._pdfHeaderText = headerText;
  }
  return f as Express.Multer.File;
}

describe('Content-first PDF peeking & filename decoupling', () => {
  it('detects a digital Mark Scheme PDF via Ghostscript even when filename has no MS hint (e.g. answers.pdf)', async () => {
    const msBuf = await createTextPdfBuffer([
      'Mark Scheme (Results)',
      'Summer 2023',
      'Pearson Edexcel GCSE Mathematics 1MA1/1H',
      'General Marking Guidance: All candidates must receive the same treatment.'
    ]);

    const peek = await PdfProcessingService.peekPdfMarkSchemeMetadata(msBuf);
    expect(peek.hasTextLayer).toBe(true);
    expect(peek.isDigitalMarkScheme).toBe(true);
    expect(peek.isStudentPaper).toBe(false);
    expect(peek.headerText).toContain('1MA1/1H');
  });

  it('does NOT misclassify a student question paper as a mark scheme even if filename starts with ms_', async () => {
    const studentBuf = await createTextPdfBuffer([
      'Pearson Edexcel Level 1/Level 2 GCSE (9-1)',
      'Candidate surname: Smith   Other names: Alex',
      'Centre Number   Candidate Number',
      'Write your answers in the spaces provided.',
      'Time allowed: 1 hour 30 minutes'
    ]);

    const peek = await PdfProcessingService.peekPdfMarkSchemeMetadata(studentBuf);
    expect(peek.hasTextLayer).toBe(true);
    expect(peek.isDigitalMarkScheme).toBe(false);
    expect(peek.isStudentPaper).toBe(true);
  });

  it('reports hasTextLayer=false on a blank/scanned PDF with no text layer', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    const blankBuf = Buffer.from(await pdfDoc.save());

    const peek = await PdfProcessingService.peekPdfMarkSchemeMetadata(blankBuf);
    expect(peek.hasTextLayer).toBe(false);
    expect(peek.isDigitalMarkScheme).toBe(false);
  });

  it('pairs generically named deferred scheme PDFs using decompressed _pdfHeaderText instead of filename', () => {
    const p1 = Array.from({ length: 3 }, (_, i) => makeMockPage(i, 'paper_one.pdf', 0));
    const p2 = Array.from({ length: 3 }, (_, i) => makeMockPage(3 + i, 'paper_two.pdf', 1));
    const geo: GeometryAnalysisResult[] = [
      ...p1.map((_, idx) => ({
        is_acceptable_quality: true,
        needs_rotation: 0,
        is_two_page_spread: false,
        is_marking_scheme: false,
        is_supported_doc: true,
        detected_subject: 'MATHS' as const,
        is_cover_page: idx === 0,
        paper_code_hint: idx === 0 ? '1MA1/1H' : undefined
      })),
      ...p2.map((_, idx) => ({
        is_acceptable_quality: true,
        needs_rotation: 0,
        is_two_page_spread: false,
        is_marking_scheme: false,
        is_supported_doc: true,
        detected_subject: 'MATHS' as const,
        is_cover_page: idx === 0,
        paper_code_hint: idx === 0 ? '1MA1/2H' : undefined
      }))
    ];

    const ms2 = makeMockPdfFile('answers_first_uploaded.pdf', 'Mark Scheme Pearson Edexcel 1MA1/2H Summer 2023');
    const ms1 = makeMockPdfFile('answers_second_uploaded.pdf', 'Mark Scheme Pearson Edexcel 1MA1/1H Summer 2023');

    const buckets = PaperSplitterService.splitIntoPaperBuckets({
      standardizedPages: [...p1, ...p2],
      lightweightPages: [...p1, ...p2],
      geometryResults: geo,
      interceptedSchemeImages: [],
      deferredSchemePdfFiles: [ms2, ms1],
      files: [makeMockPdfFile('paper_one.pdf'), makeMockPdfFile('paper_two.pdf'), ms2, ms1]
    });

    expect(buckets).toHaveLength(2);
    expect(buckets[0].paperCodeHint).toBe('1MA1/1H');
    expect(buckets[0].deferredSchemePdfFiles.map(f => f.originalname)).toEqual(['answers_second_uploaded.pdf']);
    expect(buckets[1].paperCodeHint).toBe('1MA1/2H');
    expect(buckets[1].deferredSchemePdfFiles.map(f => f.originalname)).toEqual(['answers_first_uploaded.pdf']);
  });

  it('pairs generically named Stage-2 intercepted scheme images using geometry paperCodeHint/evidenceText', () => {
    const p1 = Array.from({ length: 3 }, (_, i) => makeMockPage(i, '1MA1-1H.pdf', 0));
    const p2 = Array.from({ length: 3 }, (_, i) => makeMockPage(3 + i, '1MA1-2H.pdf', 1));
    const geo: GeometryAnalysisResult[] = [...p1, ...p2].map(() => ({
      is_acceptable_quality: true,
      needs_rotation: 0,
      is_two_page_spread: false,
      is_marking_scheme: false,
      is_supported_doc: true,
      detected_subject: 'MATHS' as const
    }));

    const buckets = PaperSplitterService.splitIntoPaperBuckets({
      standardizedPages: [...p1, ...p2],
      lightweightPages: [...p1, ...p2],
      geometryResults: geo,
      interceptedSchemeImages: [
        {
          imageData: 'data:image/jpeg;base64,ms_2h',
          sourceIndex: 99,
          originalFileName: 'photo_001.jpg',
          paperCodeHint: '1MA1/2H',
          evidenceText: 'Mark Scheme 1MA1/2H'
        }
      ],
      deferredSchemePdfFiles: [],
      files: [makeMockPdfFile('1MA1-1H.pdf'), makeMockPdfFile('1MA1-2H.pdf')]
    });

    expect(buckets).toHaveLength(2);
    expect(buckets[0].interceptedSchemeImages).toHaveLength(0);
    expect(buckets[1].interceptedSchemeImages).toEqual(['data:image/jpeg;base64,ms_2h']);
  });

  it('does not let a misleading Maths filename override an explicit non-Maths visual paperCode in resolveSubjectProfile', () => {
    const profile = resolveSubjectProfile({
      detectedSubject: 'ENGLISH_LANGUAGE',
      paperCode: '8700/1',
      fileNames: ['1MA1_wrongly_named_scan.pdf']
    });
    expect(profile.key).toBe('ENGLISH_LANGUAGE');
    expect(profile.ocrStrategy).toBe('VISION_VERBATIM');
  });

  it('does not zero-probe fast-fail runFastDbPreCheck when board/code/series come only from filename', async () => {
    const paperExistsMock = jest.fn().mockResolvedValue(false) as any;
    const orchestrateMock = jest.fn().mockResolvedValue({
      markingSchemesMap: new Map([
        ['1', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'M1', paperTitle: '8MA0/01' } } }],
        ['2', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'B1', paperTitle: '8MA0/01' } } }],
        ['3', { isGeneric: false, questionDetection: { found: true, match: { markingScheme: 'A1', paperTitle: '8MA0/01' } } }]
      ])
    }) as any;

    const meta = extractCoverPaperMetadata({
      uploadedFileNames: ['Edexcel_8MA0_01_May_2023.pdf']
    });
    expect(meta.hasCoverVerifiedMetadata).toBe(false);

    const questions = Array.from({ length: 3 }, (_, i) => ({ questionNumber: String(i + 1) }));
    const result = await runFastDbPreCheck({
      individualQuestions: questions,
      classificationResult: { reasoning: 'Question 1' },
      uploadedFileNames: ['Edexcel_8MA0_01_May_2023.pdf'],
      paperExistsInDatabaseFn: paperExistsMock,
      orchestrateLookupFn: orchestrateMock
    });

    expect(paperExistsMock).not.toHaveBeenCalled();
    expect(orchestrateMock).toHaveBeenCalledTimes(1);
    expect(result).toBeTruthy();
  });
});
