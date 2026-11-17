import React from 'react';
import '@testing-library/jest-dom';
import { render, act } from '@testing-library/react';
import { MarkingPageProvider, useMarkingPage } from './MarkingPageContext';

let mockRouteSessionId: string | undefined = 'session-a';
const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useParams: () => ({ sessionId: mockRouteSessionId }),
  useLocation: () => ({ pathname: mockRouteSessionId ? `/app/${mockRouteSessionId}` : '/app', search: '' }),
  useNavigate: () => mockNavigate,
}));

jest.mock('../services/apiClient', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('../services/markingApiService', () => ({
  simpleSessionService: {
    getCurrentSession: jest.fn(() => null),
    getSession: jest.fn(),
    setApiControls: jest.fn(),
    addMessage: jest.fn(),
    initClientSession: jest.fn(),
    handleProcessComplete: jest.fn(),
  },
}));

let mockCurrentSession: any = null;
let mockChatMessages: any[] = [];
const mockLoadSession = jest.fn((session: any) => {
  mockCurrentSession = session;
  mockChatMessages = session?.messages || [];
});
const mockClearSession = jest.fn(() => {
  mockCurrentSession = null;
  mockChatMessages = [];
});

jest.mock('../hooks/useSessionManager', () => ({
  useSessionManager: () => ({
    currentSession: mockCurrentSession,
    chatMessages: mockChatMessages,
    sessionTitle: mockCurrentSession?.title || '',
    isFavorite: false,
    rating: 0,
    addMessage: jest.fn(),
    clearSession: mockClearSession,
    loadSession: mockLoadSession,
    onFavoriteToggle: jest.fn(),
    onRatingChange: jest.fn(),
    onTitleUpdate: jest.fn(),
  }),
}));

jest.mock('../hooks/useImageUpload', () => ({
  useImageUpload: () => ({
    selectedFile: null,
    processImage: jest.fn(),
    clearFile: jest.fn(),
    handleFileSelect: jest.fn(),
  }),
}));

jest.mock('../hooks/useApiProcessor', () => ({
  useApiProcessor: () => ({
    isProcessing: false,
    isAIThinking: false,
    error: null,
    loadingProgress: 0,
    loadingStep: 0,
    loadingTotalSteps: 0,
    loadingMessage: '',
    showProgressDetails: false,
    progressData: null,
    stepList: [],
    currentStepIndex: 0,
    updateProgress: jest.fn(),
    setShowProgressDetails: jest.fn(),
    startProcessing: jest.fn(),
    stopProcessing: jest.fn(),
    startAIThinking: jest.fn(),
    stopAIThinking: jest.fn(),
    processImageAPI: jest.fn(),
    processMultiImageAPI: jest.fn(),
    handleError: jest.fn(),
    processingSessionId: null,
  }),
}));

jest.mock('../hooks/useScrollManager', () => ({
  useScrollManager: () => ({
    chatContainerRef: { current: null },
    showScrollButton: false,
    hasNewResponse: false,
    scrollToBottom: jest.fn(),
    scrollToNewResponse: jest.fn(),
    scrollToMessage: jest.fn(),
  }),
}));

jest.mock('../hooks/useCredits', () => ({
  useCredits: () => ({
    credits: { remainingCredits: 10 },
    isNegative: false,
    refreshCredits: jest.fn(),
    ensureCredits: jest.fn(),
    loading: false,
  }),
}));

jest.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'test-user' },
    loading: false,
    getAuthToken: jest.fn(),
  }),
}));

jest.mock('./MarkingJobContext', () => ({
  useMarkingJob: () => ({
    registerJob: jest.fn(),
    updateJobProgress: jest.fn(),
    completeJob: jest.fn(),
    failJob: jest.fn(),
    startPollingJob: jest.fn(),
    getJobForSession: jest.fn(() => null),
  }),
}));

jest.mock('./ModelContext', () => ({
  useModels: () => ({
    models: [{ id: 'fast', name: 'Fast' }],
    defaultModel: 'fast',
    isLoading: false,
  }),
}));

jest.mock('../utils/funnelTracker', () => ({
  trackFunnelEvent: jest.fn(),
  getNavigationType: jest.fn(() => 'navigate'),
}));

jest.mock('../components/common/InsufficientCreditsModal', () => () => null);
jest.mock('../components/modals/GuestLimitModal', () => () => null);

const ContextHarness: React.FC<{ onReady: (ctx: any) => void }> = ({ onReady }) => {
  const ctx = useMarkingPage();
  React.useEffect(() => {
    onReady(ctx);
  }, [ctx, onReady]);
  return null;
};

const makeSession = (id: string) => ({
  id,
  title: `Session ${id}`,
  messages: [
    {
      id: `${id}-m1`,
      role: 'assistant',
      content: 'Marked result',
      imageDataArray: [{ src: `https://example.com/${id}.png`, filename: 'annotated-1.png' }],
    },
  ],
});

const defaultProviderProps = {
  onPageModeChange: jest.fn(),
  onProcessingChange: jest.fn(),
  setSidebarOpen: jest.fn(),
};

describe('MarkingPageContext activeQuestionId & isContextFilterActive reset', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteSessionId = 'session-a';
    mockCurrentSession = null;
    mockChatMessages = [];
  });

  it('resets activeQuestionId and isContextFilterActive on resetSignal', () => {
    let ctx: any;
    const sessionA = makeSession('session-a');
    const { rerender } = render(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={sessionA} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    act(() => {
      ctx.setActiveQuestionId('3');
      ctx.setContextFilterActive(true);
    });
    expect(ctx.activeQuestionId).toBe('3');
    expect(ctx.isContextFilterActive).toBe(true);

    rerender(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={sessionA} resetSignal={1}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    expect(ctx.activeQuestionId).toBeNull();
    expect(ctx.isContextFilterActive).toBe(false);
  });

  it('resets activeQuestionId and isContextFilterActive when returning to /app (!routeSessionId & no selectedMarkingResult)', () => {
    let ctx: any;
    const sessionA = makeSession('session-a');
    const { rerender } = render(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={sessionA} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    act(() => {
      ctx.setActiveQuestionId('3');
      ctx.setContextFilterActive(true);
    });
    expect(ctx.activeQuestionId).toBe('3');
    expect(ctx.isContextFilterActive).toBe(true);

    mockRouteSessionId = undefined;
    rerender(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={null} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    expect(ctx.activeQuestionId).toBeNull();
    expect(ctx.isContextFilterActive).toBe(false);
  });

  it('resets activeQuestionId and isContextFilterActive when switching to another chat history session', () => {
    let ctx: any;
    const sessionA = makeSession('session-a');
    const sessionB = makeSession('session-b');

    const { rerender } = render(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={sessionA} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    act(() => {
      ctx.setActiveQuestionId('3');
      ctx.setContextFilterActive(true);
    });
    expect(ctx.activeQuestionId).toBe('3');
    expect(ctx.isContextFilterActive).toBe(true);

    mockRouteSessionId = 'session-b';
    rerender(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={sessionB} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    expect(ctx.activeQuestionId).toBeNull();
    expect(ctx.isContextFilterActive).toBe(false);
  });

  it('resets activeQuestionId and isContextFilterActive when currentSession changes to another permanent session directly', () => {
    let ctx: any;
    const sessionA = makeSession('session-a');
    mockCurrentSession = sessionA;
    mockChatMessages = sessionA.messages;

    const { rerender } = render(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={undefined} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    act(() => {
      ctx.setActiveQuestionId('3');
      ctx.setContextFilterActive(true);
    });
    expect(ctx.activeQuestionId).toBe('3');
    expect(ctx.isContextFilterActive).toBe(true);

    const sessionB = makeSession('session-b');
    mockRouteSessionId = 'session-b';
    mockCurrentSession = sessionB;
    mockChatMessages = sessionB.messages;

    rerender(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={undefined} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    expect(ctx.activeQuestionId).toBeNull();
    expect(ctx.isContextFilterActive).toBe(false);
  });

  it('preserves activeQuestionId when a temp- session transitions to a permanent session ID', () => {
    let ctx: any;
    const tempSession = makeSession('temp-123');
    mockRouteSessionId = undefined;
    mockCurrentSession = tempSession;
    mockChatMessages = tempSession.messages;

    const { rerender } = render(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={undefined} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    act(() => {
      ctx.setActiveQuestionId('3');
    });
    expect(ctx.activeQuestionId).toBe('3');

    const permSession = makeSession('perm-456');
    mockRouteSessionId = 'perm-456';
    mockCurrentSession = permSession;
    mockChatMessages = permSession.messages;

    rerender(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={undefined} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    expect(ctx.activeQuestionId).toBe('3');
  });

  it('resets activeQuestionId and isContextFilterActive immediately when routeSessionId changes to another session before selectedMarkingResult updates', () => {
    let ctx: any;
    const sessionA = makeSession('session-a');
    mockRouteSessionId = 'session-a';
    mockCurrentSession = sessionA;
    mockChatMessages = sessionA.messages;

    const { rerender } = render(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={sessionA} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    act(() => {
      ctx.setActiveQuestionId('3');
      ctx.setContextFilterActive(true);
    });
    expect(ctx.activeQuestionId).toBe('3');
    expect(ctx.isContextFilterActive).toBe(true);

    mockRouteSessionId = 'session-b';
    rerender(
      <MarkingPageProvider {...defaultProviderProps} selectedMarkingResult={sessionA} resetSignal={0}>
        <ContextHarness onReady={(c) => { ctx = c; }} />
      </MarkingPageProvider>
    );

    expect(ctx.activeQuestionId).toBeNull();
    expect(ctx.isContextFilterActive).toBe(false);
  });
});
