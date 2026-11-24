import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import SessionHeader from './SessionHeader';

let mockMarkingPageState: any = {};

jest.mock('../../contexts/MarkingPageContext', () => ({
  useMarkingPage: () => mockMarkingPageState,
}));

jest.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'user-1' },
    isAdmin: () => false,
    getAuthToken: jest.fn(),
  }),
}));

describe('SessionHeader', () => {
  beforeEach(() => {
    mockMarkingPageState = {
      sessionTitle: 'Processing...',
      isFavorite: false,
      onFavoriteToggle: jest.fn(),
      rating: 0,
      onRatingChange: jest.fn(),
      onTitleUpdate: jest.fn(),
      hoveredRating: 0,
      setHoveredRating: jest.fn(),
      showInfoDropdown: false,
      onToggleInfoDropdown: jest.fn(),
      currentSession: {
        id: 'sub-123',
        title: 'Processing...',
        messages: [],
      },
      isProcessing: true,
      setSidebarOpen: jest.fn(),
      selectedModel: 'fast',
    };
  });

  it('renders "Processing" with processing-dots while processing without a detected question', () => {
    const { rerender } = render(<SessionHeader />);
    const titleSpan = screen.getByText('Processing');
    expect(titleSpan).toBeInTheDocument();
    expect(titleSpan).toHaveClass('processing-dots');

    // Once completed with real title and detectedQuestion, displays real title
    mockMarkingPageState = {
      ...mockMarkingPageState,
      isProcessing: false,
      sessionTitle: 'Edexcel Mathematics 1MA1',
      currentSession: {
        id: 'sub-123',
        title: 'Edexcel Mathematics 1MA1',
        detectedQuestion: {
          found: true,
          examPapers: [
            {
              examBoard: 'Edexcel',
              examCode: '1MA1',
              paperTitle: 'Paper 1',
              subject: 'Mathematics',
              examSeries: 'Jun 2023',
            },
          ],
        },
        messages: [],
      },
    };

    rerender(<SessionHeader />);
    expect(screen.queryByText('Processing')).not.toBeInTheDocument();
    expect(screen.getByText('Edexcel Mathematics 1MA1')).toBeInTheDocument();
    expect(screen.getByText('Jun 2023')).toBeInTheDocument();
  });

  it('renders "Processing" for temp- sessions while processing too', () => {
    mockMarkingPageState.currentSession.id = 'temp-456';
    render(<SessionHeader />);
    const titleSpan = screen.getByText('Processing');
    expect(titleSpan).toBeInTheDocument();
    expect(titleSpan).toHaveClass('processing-dots');
  });

  it('renders "Processing" while isProcessing is true even if session previously had "Upload Issue" or detectedQuestion', () => {
    mockMarkingPageState = {
      ...mockMarkingPageState,
      isProcessing: true,
      sessionTitle: 'Upload Issue',
      currentSession: {
        id: 'sub-789',
        title: 'Upload Issue',
        detectedQuestion: {
          found: true,
          examPapers: [
            {
              examBoard: 'AQA',
              examCode: '8300',
              paperTitle: 'Paper 1',
              subject: 'Mathematics',
              examSeries: 'Jun 2023',
            },
          ],
        },
        messages: [],
      },
    };

    const { rerender } = render(<SessionHeader />);
    const titleSpan = screen.getByText('Processing');
    expect(titleSpan).toBeInTheDocument();
    expect(titleSpan).toHaveClass('processing-dots');
    expect(screen.queryByText('Upload Issue')).not.toBeInTheDocument();

    mockMarkingPageState = {
      ...mockMarkingPageState,
      isProcessing: false,
      sessionTitle: 'AQA Mathematics 8300',
      currentSession: {
        id: 'sub-789',
        title: 'AQA Mathematics 8300',
        detectedQuestion: {
          found: true,
          examPapers: [
            {
              examBoard: 'AQA',
              examCode: '8300',
              paperTitle: 'Paper 1',
              subject: 'Mathematics',
              examSeries: 'Jun 2023',
            },
          ],
        },
        messages: [],
      },
    };

    rerender(<SessionHeader />);
    expect(screen.queryByText('Processing')).not.toBeInTheDocument();
    expect(screen.getByText('AQA Mathematics 8300')).toBeInTheDocument();
  });

  it('renders canonical "Primary · Secondary" sessionTitle consistently in header and Task Details', () => {
    mockMarkingPageState = {
      ...mockMarkingPageState,
      isProcessing: false,
      showInfoDropdown: true,
      sessionTitle: 'OCR Maths J560/04 · May 2023 Higher Q1–Q4',
      currentSession: {
        id: 'sub-999',
        title: 'OCR Maths J560/04 · May 2023 Higher Q1–Q4',
        detectedQuestion: {
          found: true,
          examPapers: [
            {
              examBoard: 'OCR',
              examCode: 'J560/04',
              paperTitle: 'Paper 4',
              subject: 'Mathematics',
              examSeries: 'May 2023',
              tier: 'Higher',
            },
          ],
        },
        messages: [],
      },
    };

    render(<SessionHeader />);
    expect(screen.getByText('OCR Maths J560/04')).toBeInTheDocument();
    expect(screen.getByText('May 2023 Higher Q1–Q4')).toBeInTheDocument();
    expect(screen.getByText('OCR Maths J560/04 · May 2023 Higher Q1–Q4')).toBeInTheDocument();
  });
});
