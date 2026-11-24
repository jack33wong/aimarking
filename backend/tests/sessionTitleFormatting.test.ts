import {
  formatRejectionTitle,
  generateGenericTitleFromText,
  sanitizePaperCodeForTitle,
  stripLatexAndMathForTitle
} from '../utils/TextNormalizationUtils.js';
import { generateSessionTitleFromDetectionResults } from '../services/marking/questionDetectionService.js';

describe('Session Title & Canonical Formatting', () => {
  it('preserves readable inline math while rejecting pure-math-only stems without date fallback', () => {
    expect(stripLatexAndMathForTitle('\\mathrm{f}(x) = \\frac{2 + 11x}{(1 + x)(2 + 5x)}')).toBe('');
    expect(generateGenericTitleFromText('\\mathrm{f}(x) = \\frac{2 + 11x}{(1 + x)(2 + 5x)}', 'Marking'))
      .toBe('Untitled Paper');
    expect(generateGenericTitleFromText('\\mathrm{f}(x) = \\frac{2 + 11x}{(1 + x)(2 + 5x)}', 'Marking', 48, { subject: 'Maths' }))
      .toBe('Maths Practice');

    expect(stripLatexAndMathForTitle('$A$ and $B$ are points on the circumference of a circle.'))
      .toBe('A and B are points on the circumference of a circle');
    expect(generateGenericTitleFromText('$A$ and $B$ are points on the circumference of a circle.', 'Marking'))
      .toBe('A and B are points on the circumference of a…');

    expect(stripLatexAndMathForTitle('Write \\mathrm{f}(x) in partial fraction form.'))
      .toBe('Write f(x) in partial fraction form');
    expect(generateGenericTitleFromText('Write \\mathrm{f}(x) in partial fraction form.', 'Marking'))
      .toBe('Write f(x) in partial fraction form');
  });

  it('sanitizes raw paper codes and filename artifacts', () => {
    expect(sanitizePaperCodeForTitle('9MA0_02_2606_MS |')).toBe('9MA0/02');
    expect(sanitizePaperCodeForTitle('WMA14_01_2406_QP.pdf')).toBe('WMA14/01');
    expect(sanitizePaperCodeForTitle('1MA1/1H')).toBe('1MA1/1H');
  });

  it('formats canonical front-loaded past paper titles (Board Subject Code · Series Tier QRange)', () => {
    const detectionResults = [
      {
        question: { questionNumber: '1', text: 'Work out...' },
        detectionResult: {
          found: true,
          match: {
            board: 'OCR',
            qualification: 'GCSE',
            paperCode: 'J560/04',
            examSeries: 'May 2023',
            tier: 'Higher',
            subject: 'Mathematics',
            questionNumber: '1',
            marks: 4
          }
        }
      },
      {
        question: { questionNumber: '4', text: 'Solve...' },
        detectionResult: {
          found: true,
          match: {
            board: 'OCR',
            qualification: 'GCSE',
            paperCode: 'J560/04',
            examSeries: 'May 2023',
            tier: 'Higher',
            subject: 'Mathematics',
            questionNumber: '4',
            marks: 6
          }
        }
      }
    ];

    expect(generateSessionTitleFromDetectionResults(detectionResults, 'Marking'))
      .toBe('OCR Maths J560/04 · May 2023 Higher Q1–Q4');
  });

  it('uses canonical front-loaded meta info for unmatched papers with examPaperHint (e.g. WMA14/01)', () => {
    const detectionResults = Array.from({ length: 8 }, (_, idx) => ({
      question: {
        questionNumber: String(idx + 1),
        text: idx === 0 ? '\\mathrm{f}(x) = \\frac{2 + 11x}{(1 + x)(2 + 5x)}' : `Question ${idx + 1}`
      },
      detectionResult: {
        found: false,
        match: {
          board: 'Edexcel',
          qualification: 'General',
          paperCode: 'WMA14/01',
          examSeries: 'N/A',
          tier: 'N/A',
          subject: 'Mathematics',
          questionNumber: String(idx + 1),
          marks: idx === 0 ? 9 : 0,
          isGeneric: true
        }
      }
    }));

    expect(generateSessionTitleFromDetectionResults(detectionResults, 'Marking'))
      .toBe('Edexcel Maths WMA14/01 · Q1–Q8');
  });

  it('skips pure-math Q1 stem and picks first natural-language prose when no meta info exists', () => {
    const detectionResults = [
      {
        question: {
          questionNumber: '1',
          text: '\\mathrm{f}(x) = \\frac{2 + 11x}{(1 + x)(2 + 5x)}',
          subQuestions: [
            { part: 'a', text: 'Write \\mathrm{f}(x) in partial fraction form.' }
          ]
        },
        detectionResult: {
          found: false,
          match: {
            board: 'Unknown',
            qualification: 'General',
            paperCode: 'Generic Question',
            examSeries: 'N/A',
            tier: 'N/A',
            subject: 'General',
            questionNumber: '1',
            marks: 0,
            isGeneric: true
          }
        }
      }
    ];

    expect(generateSessionTitleFromDetectionResults(detectionResults, 'Marking'))
      .toBe('Write f(x) in partial fraction form');
  });

  it('formats descriptive rejection titles instead of bare dates', () => {
    expect(formatRejectionTitle('### Unsupported Page Layout Detected\n\nPlease re-upload')).toBe('Unsupported Page Layout');
    expect(formatRejectionTitle('', 'History', true)).toBe('History · Mark Scheme Needed');
    expect(formatRejectionTitle('The uploaded image is blurry or unreadable')).toBe('Unreadable Upload');
  });
});
