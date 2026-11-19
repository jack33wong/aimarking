import { jest } from '@jest/globals';
import { ImageGeometryService, isRecognizedAcademicSubject } from '../services/marking/ImageGeometryService.js';
import { ModelProvider } from '../utils/ModelProvider.js';

describe('Non-academic check & universal academic subject alignment', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isRecognizedAcademicSubject', () => {
    it('accepts all common and specialized academic subjects without false positives', () => {
      const validSubjects = [
        'Biology',
        'Combined Science: Trilogy',
        'GCSE Accounting',
        'A-Level Economics',
        'Religious Education',
        'ICT',
        'Food Preparation and Nutrition',
        'Arabic',
        'Engineering',
        'Health and Social Care',
        'Classical Civilisation',
        'PE',
        'DT',
        'Astrophysics',
        'Microbiology',
      ];
      for (const subject of validSubjects) {
        expect(isRecognizedAcademicSubject(subject)).toBe(true);
      }
    });

    it('rejects non-academic and placeholder labels', () => {
      const invalidLabels = [
        '',
        'other',
        'unknown',
        'none',
        'N/A',
        'not educational',
        'non-academic',
        'Parking',
        'Venue Rules',
        'Receipt',
        'Invoice',
        'Selfie',
        'Restaurant Menu',
        'Exam Info',
      ];
      for (const label of invalidLabels) {
        expect(isRecognizedAcademicSubject(label)).toBe(false);
      }
    });
  });

  describe('ImageGeometryService.analyze', () => {
    const mockGeminiJson = (payload: Record<string, any>) => {
      jest.spyOn(ModelProvider, 'callGeminiChat').mockResolvedValue({
        content: JSON.stringify({
          visual_observations: 'Clear exam page',
          is_acceptable_quality: true,
          rejection_reason: '',
          is_two_page_spread: false,
          is_marking_scheme: false,
          is_supported_doc: true,
          evidence_text_snippet: '',
          ...payload,
        }),
        usageTokens: 100,
      } as any);
    };

    it('marks Maths and English Language as supported without requiring a mark scheme', async () => {
      mockGeminiJson({
        detected_subject: 'MATHS',
        is_supported_doc: true,
      });
      const mathsRes = await ImageGeometryService.analyze('base64', 1000, 1400);
      expect(mathsRes.detected_subject).toBe('MATHS');
      expect(mathsRes.is_supported_doc).toBe(true);

      mockGeminiJson({
        detected_subject: 'ENGLISH_LANGUAGE',
        is_supported_doc: true,
      });
      const engRes = await ImageGeometryService.analyze('base64', 1000, 1400);
      expect(engRes.detected_subject).toBe('ENGLISH_LANGUAGE');
      expect(engRes.is_supported_doc).toBe(true);
    });

    it('keeps Accounting exam with an invoice context as academic (requires mark scheme), NOT NON_ACADEMIC', async () => {
      mockGeminiJson({
        visual_observations: 'GCSE Accounting exam question showing a mock invoice table',
        evidence_text_snippet: 'Question 2: Complete the sales invoice below',
        detected_subject: 'UNSUPPORTED_SUBJECT',
        unsupported_subject_name: 'Accounting',
        is_supported_doc: false,
        rejection_reason: 'Unsupported subject (Accounting): Marking scheme required for this subject.',
      });

      const res = await ImageGeometryService.analyze('base64', 1000, 1400);
      expect(res.detected_subject).toBe('UNSUPPORTED_SUBJECT');
      expect(res.unsupported_subject_name).toBe('Accounting');
      expect(res.is_supported_doc).toBe(false);
    });

    it('classifies genuine non-academic uploads (e.g. parking notice / receipt) as NON_ACADEMIC', async () => {
      mockGeminiJson({
        visual_observations: 'Supermarket receipt for groceries',
        evidence_text_snippet: 'TESCO EXTRA TOTAL £14.50',
        detected_subject: 'NON_ACADEMIC',
        unsupported_subject_name: '',
        is_supported_doc: false,
        rejection_reason: 'Not educational exam content: Please upload an academic exam question or student homework.',
      });

      const res = await ImageGeometryService.analyze('base64', 1000, 1400);
      expect(res.detected_subject).toBe('NON_ACADEMIC');
      expect(res.is_supported_doc).toBe(false);
      expect(res.rejection_reason).toContain('Not educational exam content');
    });
  });
});
