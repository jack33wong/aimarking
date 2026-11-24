import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import PerformanceSummaryPanel from './PerformanceSummaryPanel';

jest.mock('../../contexts/MarkingPageContext', () => ({
  useMarkingPage: () => ({ activeQuestionId: null }),
}));

const MockMarkdown: React.FC<{ content: string }> = ({ content }) => <div>{content}</div>;

describe('PerformanceSummaryPanel 3-tier layout & provenance', () => {
  it('renders Compact tier for 1-question upload without radar chart or redundant KPI boxes', () => {
    const payload = {
      _type: 'AI_SUMMARY_V2',
      level: 'GCSE',
      headline: 'Apply isosceles triangle rules in circle theorems.',
      markingSource: { type: 'general', label: 'General Mark Scheme' },
      score: {
        awardedMarks: 1,
        totalMarks: 3,
        percentage: 33,
        questionsTotal: 1,
        questionsFullMarks: 0,
        questionsAttempted: 1,
      },
      radar: [
        { axis: 'Geometry', score: 33, awarded: 1, total: 3, assessed: true },
        { axis: 'Algebra', score: 50, awarded: 0, total: 0, assessed: false },
        { axis: 'Number', score: 50, awarded: 0, total: 0, assessed: false },
      ],
      mastered: [],
      focusNext: [{ q: 'Q1', marksLost: 2, text: 'Apply isosceles triangle rules' }],
    };

    render(
      <PerformanceSummaryPanel
        rawSummary={JSON.stringify(payload)}
        MarkdownMathRenderer={MockMarkdown}
      />
    );

    expect(screen.getByText('General Scheme')).toBeInTheDocument();
    expect(screen.getByText('Apply isosceles triangle rules in circle theorems.')).toBeInTheDocument();
    expect(screen.queryByText('MASTERY BY TOPIC')).not.toBeInTheDocument();
    expect(screen.queryByText('Questions marked')).not.toBeInTheDocument();
    expect(screen.queryByText('Marks to Recover')).not.toBeInTheDocument();
  });

  it('renders Full tier with Official Mark Scheme badge, View Scheme modal, Next Grade Gap, and boundary provenance', () => {
    const payload = {
      _type: 'AI_SUMMARY_V2',
      level: 'GCSE',
      headline: 'Strong core biology understanding.',
      examInfo: {
        examBoard: 'CIE',
        subject: 'Biology',
        examCode: '0610/41',
        examSeries: 'May/June 2026',
        tier: 'Higher',
      },
      markingSource: { type: 'official', label: 'CIE 0610/41 (May/June 2026)' },
      score: {
        awardedMarks: 58,
        totalMarks: 80,
        percentage: 73,
        questionsTotal: 6,
        questionsFullMarks: 1,
        questionsAttempted: 5,
      },
      grading: {
        grade: '8',
        predictedGrade: '8',
        boundaries: { '9': 65, '8': 58, '7': 51 },
        boundariesSource: 'estimated',
      },
      radar: [
        { axis: 'Cell Transport', score: 70, awarded: 7, total: 10, assessed: true },
        { axis: 'Enzymes', score: 90, awarded: 9, total: 10, assessed: true },
        { axis: 'Ecology', score: 20, awarded: 2, total: 10, assessed: true },
      ],
      mastered: [{ q: 'Q4', text: 'Circulatory physiology' }],
      focusNext: [{ q: 'Q5', marksLost: 8, text: 'Attempt all parts of ecology questions' }],
    };

    const detectedQuestion = {
      found: true,
      examPapers: [
        {
          examBoard: 'CIE',
          examCode: '0610/41',
          examSeries: 'May/June 2026',
          questions: [
            { questionNumber: '5', marks: 8, markingScheme: '- M1: Identify trophic level\n- A1: Correct pyramid of biomass' },
          ],
        },
      ],
    };

    render(
      <PerformanceSummaryPanel
        rawSummary={JSON.stringify(payload)}
        MarkdownMathRenderer={MockMarkdown}
        detectedQuestion={detectedQuestion}
      />
    );

    // Single-line merged clickable provenance badge + boundary caption
    expect(screen.getByText('Official Scheme · CIE 0610/41')).toBeInTheDocument();
    expect(screen.getByText(/Estimated boundaries/i)).toBeInTheDocument();

    // Non-duplicate KPIs: Next Grade Gap (+7 to Grade 9) instead of duplicate Grade Achieved / Predicted Grade
    expect(screen.getByText('+7')).toBeInTheDocument();
    expect(screen.getByText('Marks to Grade 9')).toBeInTheDocument();
    expect(screen.queryByText('Grade Achieved')).not.toBeInTheDocument();

    // Marks to Recover with marks lost badge
    expect(screen.getByText('Marks to Recover')).toBeInTheDocument();
    expect(screen.getByText('-8')).toBeInTheDocument();

    // Radar shown because >= 3 assessed axes
    expect(screen.getByText('MASTERY BY TOPIC')).toBeInTheDocument();

    // 1-Click View Scheme modal opened directly from the merged pill (showing full exam meta in modal header)
    fireEvent.click(screen.getByText('View'));
    expect(screen.getByText('Mark Scheme Used')).toBeInTheDocument();
    expect(screen.getByText('CIE Biology 0610/41 (May/June 2026)')).toBeInTheDocument();
    expect(screen.getByText(/Identify trophic level/i)).toBeInTheDocument();
    expect(screen.getByText('M1')).toHaveClass('tmua-scheme-point-code');
    expect(screen.getByText('A1')).toHaveClass('tmua-scheme-point-code');
  });

  it('sanitizes raw filename-like examCode (9MA0_02_2606_MS) into clean exam meta info', () => {
    const payload = {
      _type: 'AI_SUMMARY_V2',
      level: 'ALEVEL',
      headline: 'Outstanding performance.',
      examInfo: {
        examBoard: 'Edexcel',
        subject: 'Mathematics',
        examCode: '9MA0_02_2606_MS',
        examSeries: 'Summer 2026',
      },
      score: {
        awardedMarks: 98,
        totalMarks: 100,
        percentage: 98,
        questionsTotal: 15,
        questionsFullMarks: 13,
        questionsAttempted: 15,
      },
      radar: [],
      mastered: [],
      focusNext: [],
    };

    render(
      <PerformanceSummaryPanel
        rawSummary={JSON.stringify(payload)}
        MarkdownMathRenderer={MockMarkdown}
      />
    );

    expect(screen.getByText('Official Scheme · Edexcel 9MA0/02')).toBeInTheDocument();
  });

  it('shows user-uploaded mark scheme filename badge', () => {
    const payload = {
      _type: 'AI_SUMMARY_V2',
      level: 'ALEVEL',
      headline: 'Full marks achieved.',
      markingSource: { type: 'user_uploaded', label: '9MA0_02_MS.pdf', fileName: '9MA0_02_MS.pdf' },
      score: {
        awardedMarks: 4,
        totalMarks: 4,
        percentage: 100,
        questionsTotal: 1,
        questionsFullMarks: 1,
        questionsAttempted: 1,
      },
      radar: [],
      mastered: [],
      focusNext: [],
    };

    render(
      <PerformanceSummaryPanel
        rawSummary={JSON.stringify(payload)}
        MarkdownMathRenderer={MockMarkdown}
      />
    );

    expect(screen.getByText('Your Scheme · 9MA0_02_MS.pdf')).toBeInTheDocument();
    expect(screen.getByText('Full Marks')).toBeInTheDocument();
  });
});
