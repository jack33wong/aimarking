import { jest } from '@jest/globals';
import {
  PreInspectService,
  selectStrategicPdfPageIndices,
} from '../services/marking/PreInspectService.js';
import { ImageGeometryService } from '../services/marking/ImageGeometryService.js';
import { UsageTracker } from '../utils/UsageTracker.js';
import { AdminAlertService } from '../services/AdminAlertService.js';

describe('PreInspectService: strategic page selection, usage tracking, digest merge, and geometry reuse', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('picks 1-3 strategic PDF page indices cleanly', () => {
    expect(selectStrategicPdfPageIndices(1)).toEqual([0]);
    expect(selectStrategicPdfPageIndices(2)).toEqual([0, 1]);
    expect(selectStrategicPdfPageIndices(3)).toEqual([0, 1, 2]);
    expect(selectStrategicPdfPageIndices(24)).toEqual([0, 2, 12]);
    expect(selectStrategicPdfPageIndices(4)).toEqual([0, 2]);
  });

  it('tracks preInspect usage in UsageTracker, caches geometry, and reuses it on Send without duplicate LLM calls', async () => {
    const fakeBuffer = Buffer.from('fake-image-bytes-for-test');
    const mockFile = {
      fieldname: 'files',
      originalname: 'q19.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      buffer: fakeBuffer,
      size: fakeBuffer.length,
    } as Express.Multer.File;

    jest.spyOn(ImageGeometryService, 'analyze').mockImplementation(
      async (_img, _w, _h, _model, tracker, phase) => {
        expect(phase).toBe('preInspect');
        tracker?.recordPhaseUsage?.('preInspect', 1200, 180, 0, 'gemini-3.5-flash-lite', 0.00042);
        return {
          is_acceptable_quality: true,
          needs_rotation: 0,
          is_two_page_spread: false,
          is_marking_scheme: false,
          is_supported_doc: true,
          detected_subject: 'MATHS',
          paper_code_hint: '1MA1/2H',
          is_cover_page: false,
          has_handwriting: true,
        };
      }
    );

    const preInspectTracker = new UsageTracker();
    const res = await PreInspectService.inspectFiles({
      files: [mockFile],
      userId: 'user-123',
      digestSessionId: 'pre-inspect-sess-1',
      usageTracker: preInspectTracker,
    });

    expect(res.overallStatus).toBe('ready');
    expect(res.docType).toBe('student_work');
    expect(res.paperCode).toBe('1MA1/2H');
    expect(res.hasHandwriting).toBe(true);
    expect(res.usage.requestCount).toBe(1);
    expect(res.usage.costUsd).toBeCloseTo(0.00042, 6);
    expect(preInspectTracker.getSummary('fast')).toContain('Pre-Inspect');

    // Now simulate Send: marking pipeline consumes the cached geometry and merges usage + digest
    const mergeSpy = jest.spyOn(AdminAlertService, 'mergePreInspectDigestIntoSession').mockImplementation(() => {});
    const markingTracker = new UsageTracker();

    const reused = PreInspectService.consumeCachedGeometry({
      preInspectToken: res.preInspectToken,
      userId: 'user-123',
      files: [mockFile],
      usageTracker: markingTracker,
      targetSessionId: 'sub-real-session-1',
    });

    expect(reused.reusedPageCount).toBe(1);
    expect(reused.reusedByFileAndPage.get('0:0')?.paper_code_hint).toBe('1MA1/2H');
    expect(markingTracker.getBreakdown().preInspect.inputTokens).toBe(1200);
    expect(markingTracker.calculateCost('fast').preInspect).toBeCloseTo(0.00042, 6);
    expect(mergeSpy).toHaveBeenCalledWith('pre-inspect-sess-1', 'sub-real-session-1');
  });

  it('prompts for Mark Scheme or AI General Rubric when a non-Maths/English academic subject is uploaded alone', async () => {
    const fakeBuffer = Buffer.from('fake-bio-page');
    const mockFile = {
      fieldname: 'files',
      originalname: 'bio-q1.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      buffer: fakeBuffer,
      size: fakeBuffer.length,
    } as Express.Multer.File;

    jest.spyOn(ImageGeometryService, 'analyze').mockResolvedValue({
      is_acceptable_quality: true,
      needs_rotation: 0,
      is_two_page_spread: false,
      is_marking_scheme: false,
      is_supported_doc: false,
      detected_subject: 'UNSUPPORTED_SUBJECT',
      unsupported_subject_name: 'Biology',
      is_cover_page: false,
      has_handwriting: true,
    });

    const tracker = new UsageTracker();
    const res = await PreInspectService.inspectFiles({
      files: [mockFile],
      userId: 'user-bio',
      digestSessionId: 'pre-inspect-bio-1',
      usageTracker: tracker,
    });

    expect(res.overallStatus).toBe('action_needed');
    expect(res.docType).toBe('missing_mark_scheme');
    expect(res.requiresMarkScheme).toBe(true);
    expect(res.suggestions.map((s) => s.action)).toEqual(['attach_file', 'submit_generic_rubric']);
  });

  it('warns when English Language upload has answers only without printed questions or mark scheme', async () => {
    const fakeBuffer = Buffer.from('fake-eng-answers-only');
    const mockFile = {
      fieldname: 'files',
      originalname: 'eng-answers.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      buffer: fakeBuffer,
      size: fakeBuffer.length,
    } as Express.Multer.File;

    jest.spyOn(ImageGeometryService, 'analyze').mockResolvedValue({
      is_acceptable_quality: true,
      needs_rotation: 0,
      is_two_page_spread: false,
      is_marking_scheme: false,
      is_supported_doc: true,
      detected_subject: 'ENGLISH_LANGUAGE',
      exam_board: 'AQA',
      paper_code_hint: '8700/1',
      is_cover_page: false,
      has_handwriting: true,
      has_printed_questions: false,
    });

    const res = await PreInspectService.inspectFiles({
      files: [mockFile],
      userId: 'user-eng',
      digestSessionId: 'pre-inspect-eng-1',
      usageTracker: new UsageTracker(),
    });

    expect(res.overallStatus).toBe('action_needed');
    expect(res.docType).toBe('answers_without_questions');
    expect(res.isWarning).toBe(true);
    expect(res.examBoard).toBe('AQA');
    expect(res.bannerTitle).toContain('AQA');
    expect(res.bannerTitle).toContain('generic mark scheme');
  });

  it('detects paper vs mark scheme mismatch in advance (e.g. OCR J560/01 vs Pearson 1MA1/3H)', async () => {
    const paperFile = {
      fieldname: 'files',
      originalname: 'ocr-paper.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('ocr-paper-bytes'),
      size: 15,
    } as Express.Multer.File;

    const msFile = {
      fieldname: 'files',
      originalname: 'edexcel-ms.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('edexcel-ms-bytes'),
      size: 16,
    } as Express.Multer.File;

    const analyzeSpy = jest.spyOn(ImageGeometryService, 'analyze')
      .mockResolvedValueOnce({
        is_acceptable_quality: true,
        needs_rotation: 0,
        is_two_page_spread: false,
        is_marking_scheme: false,
        is_supported_doc: true,
        detected_subject: 'MATHS',
        exam_board: 'OCR',
        paper_code_hint: 'J560/01',
        has_handwriting: true,
        has_printed_questions: true,
      })
      .mockResolvedValueOnce({
        is_acceptable_quality: true,
        needs_rotation: 0,
        is_two_page_spread: false,
        is_marking_scheme: true,
        is_supported_doc: true,
        detected_subject: 'MATHS',
        exam_board: 'Pearson Edexcel',
        paper_code_hint: '1MA1/3H',
      });

    const res = await PreInspectService.inspectFiles({
      files: [paperFile, msFile],
      userId: 'user-mismatch',
      digestSessionId: 'pre-inspect-mismatch-1',
      usageTracker: new UsageTracker(),
    });

    expect(res.overallStatus).toBe('action_needed');
    expect(res.docType).toBe('paper_mismatch');
    expect(res.isWarning).toBe(true);
    expect(res.bannerTitle).toContain('J560/01');
    expect(res.bannerTitle).toContain('1MA1/3H');

    // Second inspect of the same paper file hits per-file SHA-256 cache (0 new LLM calls!)
    analyzeSpy.mockClear();
    const res2 = await PreInspectService.inspectFiles({
      files: [paperFile],
      userId: 'user-mismatch',
      digestSessionId: 'pre-inspect-mismatch-2',
      usageTracker: new UsageTracker(),
    });
    expect(analyzeSpy).not.toHaveBeenCalled();
    expect(res2.examBoard).toBe('OCR');
    expect(res2.paperCode).toBe('J560/01');
  });
});
