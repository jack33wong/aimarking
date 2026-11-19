import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, act, waitFor } from '@testing-library/react';
import Sidebar from './Sidebar';
import EventManager, { EVENT_TYPES } from '../../utils/eventManager';

let mockJobsBySessionId: Record<string, any> = {};
const mockGetMarkingHistoryFromSessions = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'user-1' },
    getAuthToken: jest.fn().mockResolvedValue('mock-token'),
    isAdmin: () => false,
  }),
}));

jest.mock('../../contexts/MarkingJobContext', () => ({
  useMarkingJob: () => ({
    jobsBySessionId: mockJobsBySessionId,
    dismissJob: jest.fn(),
  }),
}));

jest.mock('../../hooks/useSubscription', () => ({
  useSubscription: () => ({
    checkPermission: () => true,
    loading: false,
  }),
}));

jest.mock('../../services/markingHistoryService', () => ({
  __esModule: true,
  default: {
    getMarkingHistoryFromSessions: (...args: any[]) => mockGetMarkingHistoryFromSessions(...args),
    deleteSession: jest.fn(),
    updateSession: jest.fn(),
  },
}));

jest.mock('../../services/markingApiService', () => ({
  simpleSessionService: {
    clearAllSessions: jest.fn(),
    updateSidebarSessionsBatch: jest.fn(),
    subscribe: jest.fn(() => jest.fn()),
    getCurrentSession: jest.fn(() => null),
    setCurrentSession: jest.fn(),
  },
}));

describe('Sidebar processing title sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockJobsBySessionId = {};
    // IntersectionObserver mock for JSDOM
    (global as any).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('displays "Processing..." for a processing session with fallback title and updates to real title on completion', async () => {
    mockGetMarkingHistoryFromSessions.mockResolvedValue({
      success: true,
      sessions: [
        {
          id: 'sub-999',
          title: 'Chat Session',
          messageType: 'Marking',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockJobsBySessionId = {
      'sub-999': { sessionId: 'sub-999', title: 'Processing...', status: 'processing' },
    };

    const { rerender } = render(
      <Sidebar
        isOpen={true}
        onMarkingHistoryClick={jest.fn()}
        onMarkingResultSaved={jest.fn()}
        onMarkHomeworkClick={jest.fn()}
        onMenuToggle={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Processing...')).toBeInTheDocument();
    });
    expect(screen.getByTitle('Marking in progress')).toBeInTheDocument();

    // Simulate job completion and SESSION_UPDATED with real title
    mockJobsBySessionId = {};
    act(() => {
      EventManager.dispatch(EVENT_TYPES.SESSION_UPDATED, {
        session: {
          id: 'sub-999',
          title: 'AQA Physics 7408 Paper 1',
          messageType: 'Marking',
          updatedAt: '2026-01-01T00:01:00Z',
        },
      });
    });

    rerender(
      <Sidebar
        isOpen={true}
        onMarkingHistoryClick={jest.fn()}
        onMarkingResultSaved={jest.fn()}
        onMarkHomeworkClick={jest.fn()}
        onMenuToggle={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('AQA Physics 7408 Paper 1')).toBeInTheDocument();
    });
    expect(screen.queryByText('Processing...')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Marking in progress')).not.toBeInTheDocument();
  });

  it('displays "Processing..." for a processing session even when prior title was "Upload Issue", then updates to real title on completion', async () => {
    mockGetMarkingHistoryFromSessions.mockResolvedValue({
      success: true,
      sessions: [
        {
          id: 'sub-upload-issue',
          title: 'Upload Issue',
          messageType: 'Marking',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockJobsBySessionId = {
      'sub-upload-issue': { sessionId: 'sub-upload-issue', title: 'Processing...', status: 'processing' },
    };

    const { rerender } = render(
      <Sidebar
        isOpen={true}
        onMarkingHistoryClick={jest.fn()}
        onMarkingResultSaved={jest.fn()}
        onMarkHomeworkClick={jest.fn()}
        onMenuToggle={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Processing...')).toBeInTheDocument();
    });
    expect(screen.queryByText('Upload Issue')).not.toBeInTheDocument();
    expect(screen.getByTitle('Marking in progress')).toBeInTheDocument();

    mockJobsBySessionId = {};
    act(() => {
      EventManager.dispatch(EVENT_TYPES.SESSION_UPDATED, {
        session: {
          id: 'sub-upload-issue',
          title: 'Edexcel Maths 1MA1 Paper 2',
          messageType: 'Marking',
          updatedAt: '2026-01-01T00:01:00Z',
        },
      });
    });

    rerender(
      <Sidebar
        isOpen={true}
        onMarkingHistoryClick={jest.fn()}
        onMarkingResultSaved={jest.fn()}
        onMarkHomeworkClick={jest.fn()}
        onMenuToggle={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Edexcel Maths 1MA1 Paper 2')).toBeInTheDocument();
    });
    expect(screen.queryByText('Processing...')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Marking in progress')).not.toBeInTheDocument();
  });
});
