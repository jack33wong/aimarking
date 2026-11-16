import { generateGenericTitleFromText, stripLatexAndMathForTitle } from '../utils/TextNormalizationUtils.js';
import { generateSessionTitleFromDetectionResults } from '../services/marking/questionDetectionService.js';

describe('Session Title & LaTeX-Free Formatting', () => {
  it('strips LaTeX and pure math expressions cleanly in stripLatexAndMathForTitle / generateGenericTitleFromText', () => {
    expect(stripLatexAndMathForTitle('\\mathrm{f}(x) = \\frac{2 + 11x}{(1 + x)(2 + 5x)}')).toBe('');
    expect(generateGenericTitleFromText('\\mathrm{f}(x) = \\frac{2 + 11x}{(1 + x)(2 + 5x)}', 'Marking'))
      .toMatch(/^Marking - \d/);

    expect(stripLatexAndMathForTitle('Write \\mathrm{f}(x) in partial fraction form.'))
      .toBe('Write in partial fraction form');
    expect(generateGenericTitleFromText('Write \\mathrm{f}(x) in partial fraction form.', 'Marking'))
      .toBe('Marking - Write in partial fraction form');
  });

  it('uses meta info (paperCode + inferred board + subject + QRange) for unmatched papers with examPaperHint (e.g. WMA14/01)', () => {
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
      .toBe('WMA14/01 Edexcel Maths Q1 to Q8 9 marks');

    detectionResults[0].detectionResult.match.marks = 0;
    expect(generateSessionTitleFromDetectionResults(detectionResults, 'Marking'))
      .toBe('WMA14/01 Edexcel Maths Q1 to Q8');
  });

  it('skips pure-math Q1 stem and picks first natural-language prose without LaTeX when no meta info exists', () => {
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
      .toBe('Marking - Write in partial fraction form');
  });
});
