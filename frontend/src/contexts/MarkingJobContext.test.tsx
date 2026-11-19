import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MarkingJobProvider, useMarkingJob } from './MarkingJobContext';
import { simpleSessionService } from '../services/markingApiService';

const mockNavigate = jest.fn();
let mockPathname = '/home';

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: mockPathname, search: '' }),
}));

jest.mock('../services/markingApiService', () => ({
  simpleSessionService: {
    getSession: jest.fn(),
    getCurrentSession: jest.fn(() => null),
    updateMessageInCurrentSession: jest.fn(),
    updateSidebarSession: jest.fn(),
    setCurrentSession: jest.fn(),
    initClientSession: jest.fn(),
    handleProcessComplete: jest.fn(),
    stopAIThinking: jest.fn(),
    stopProcessing: jest.fn(),
  },
}));

const TestHarness: React.FC<{ onReady: (ctx: ReturnType<typeof useMarkingJob>) => void }> = ({ onReady }) => {
  const ctx = useMarkingJob();
  React.useEffect(() => {
    onReady(ctx);
  }, [ctx, onReady]);
  return null;
};

describe('MarkingJobContext', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    sessionStorage.clear();
    mockPathname = '/home';
    window.history.pushState({}, '', '/home');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('updates title on completeJob, shows View & Dismiss buttons, and auto-dismisses after 7s without navigating', () => {
    let ctx!: ReturnType<typeof useMarkingJob>;
    render(
      <MarkingJobProvider>
        <TestHarness onReady={(c) => { ctx = c; }} />
      </MarkingJobProvider>
    );

    act(() => {
      ctx.registerJob({ sessionId: 'sess-123' });
    });

    expect(screen.getByText('Processing...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();

    act(() => {
      ctx.completeJob('sess-123', 'Edexcel Maths Paper 2');
    });

    expect(screen.getByText('Edexcel Maths Paper 2')).toBeInTheDocument();
    expect(screen.getByText('Marking complete')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();

    // Advance 6.9s — should still be visible
    act(() => {
      jest.advanceTimersByTime(6900);
    });
    expect(screen.getByText('Edexcel Maths Paper 2')).toBeInTheDocument();

    // Advance past 7s — should auto-dismiss
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Edexcel Maths Paper 2')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates and dismisses when clicking View, and dismisses without navigating when clicking Dismiss', () => {
    let ctx!: ReturnType<typeof useMarkingJob>;
    render(
      <MarkingJobProvider>
        <TestHarness onReady={(c) => { ctx = c; }} />
      </MarkingJobProvider>
    );

    act(() => {
      ctx.registerJob({ sessionId: 'sess-view' });
      ctx.completeJob('sess-view', 'Physics Q4');
    });

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(mockNavigate).toHaveBeenCalledWith('/app/sess-view');
    expect(screen.queryByText('Physics Q4')).not.toBeInTheDocument();

    mockNavigate.mockClear();

    act(() => {
      ctx.registerJob({ sessionId: 'sess-dismiss' });
      ctx.completeJob('sess-dismiss', 'Chemistry Q1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText('Chemistry Q1')).not.toBeInTheDocument();
  });

  it('resolves session title from pollOnce response and auto-dismisses', async () => {
    (simpleSessionService.getSession as jest.Mock).mockResolvedValueOnce({
      status: 'completed',
      session: { id: 'sess-poll', title: 'AQA Biology Paper 1' },
    });

    let ctx!: ReturnType<typeof useMarkingJob>;
    render(
      <MarkingJobProvider>
        <TestHarness onReady={(c) => { ctx = c; }} />
      </MarkingJobProvider>
    );

    act(() => {
      ctx.registerJob({ sessionId: 'sess-poll' });
    });

    await act(async () => {
      ctx.startPollingJob('sess-poll');
      await Promise.resolve();
    });

    expect(screen.getByText('AQA Biology Paper 1')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(7100);
    });
    expect(screen.queryByText('AQA Biology Paper 1')).not.toBeInTheDocument();
  });

  it('shows "Processing..." in floating toast even when registerJob receives a stale title like "Upload Issue", then updates to real title on completion', () => {
    let ctx!: ReturnType<typeof useMarkingJob>;
    render(
      <MarkingJobProvider>
        <TestHarness onReady={(c) => { ctx = c; }} />
      </MarkingJobProvider>
    );

    act(() => {
      ctx.registerJob({ sessionId: 'sess-upload-issue', title: 'Upload Issue' });
    });

    expect(screen.getByText('Processing...')).toBeInTheDocument();
    expect(screen.queryByText('Upload Issue')).not.toBeInTheDocument();

    act(() => {
      ctx.completeJob('sess-upload-issue', 'OCR Chemistry H432');
    });

    expect(screen.getByText('OCR Chemistry H432')).toBeInTheDocument();
    expect(screen.queryByText('Processing...')).not.toBeInTheDocument();
  });

  it('updates sidebar session and toast title when pollOnce completes with fallbackResult while viewing another chat', async () => {
    mockPathname = '/app/other-session';
    window.history.pushState({}, '', '/app/other-session');
    (simpleSessionService.getSession as jest.Mock).mockResolvedValueOnce({
      status: 'completed',
      fallbackResult: { sessionTitle: 'Edexcel Physics 9PH0' },
    });

    let ctx!: ReturnType<typeof useMarkingJob>;
    render(
      <MarkingJobProvider>
        <TestHarness onReady={(c) => { ctx = c; }} />
      </MarkingJobProvider>
    );

    act(() => {
      ctx.registerJob({ sessionId: 'sess-fallback-poll' });
    });

    expect(screen.getByText('Processing...')).toBeInTheDocument();

    await act(async () => {
      ctx.startPollingJob('sess-fallback-poll');
      await Promise.resolve();
    });

    expect(screen.getByText('Edexcel Physics 9PH0')).toBeInTheDocument();
    expect(simpleSessionService.updateSidebarSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sess-fallback-poll',
        title: 'Edexcel Physics 9PH0',
      })
    );
  });
});
