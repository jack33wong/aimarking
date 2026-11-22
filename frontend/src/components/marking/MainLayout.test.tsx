import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import MainLayout from './MainLayout';

const mockFollowUpChatInput = jest.fn();

let mockMarkingPageState: any = {};

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/app', search: '' }),
  useNavigate: () => jest.fn(),
}));

jest.mock('../../contexts/MarkingPageContext', () => ({
  useMarkingPage: () => mockMarkingPageState,
}));

jest.mock('../chat/FollowUpChatInput', () => ({
  __esModule: true,
  default: (props: any) => mockFollowUpChatInput(props),
}));

jest.mock('./SessionManagement', () => () => null);
jest.mock('../focused/ChatMessage', () => () => <div data-testid="chat-message" />);
jest.mock('./MarkdownMathRenderer', () => () => null);
jest.mock('./QuestionNavigator', () => () => null);
jest.mock('../common/SEO', () => () => null);
jest.mock('../common/ImageViewer', () => () => null);

let mockGroupedQuestions: any[] = [];
jest.mock('../../hooks/useQuestionGrouping', () => ({
  useQuestionGrouping: () => ({ groupedQuestions: mockGroupedQuestions, getGroupColor: () => 'gray' }),
}));

jest.mock('../../utils/engagementTracker', () => ({
  engagementTracker: {
    stopSession: jest.fn(),
    recordQuestionNavigation: jest.fn(),
    recordPageView: jest.fn(),
  },
}));

describe('MainLayout contextQuestionId propagation', () => {
  beforeAll(() => {
    (global as any).IntersectionObserver = class {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGroupedQuestions = [];
    mockFollowUpChatInput.mockImplementation((props: any) => (
      <div data-testid={`chat-input-${props.mode}`}>
        {props.contextQuestionId ? (
          <div className="context-chip-container">
            <span>Question {props.contextQuestionId} Focused</span>
            <span>AUTO</span>
          </div>
        ) : null}
      </div>
    ));
    mockMarkingPageState = {
      isProcessing: false,
      selectedModel: 'fast',
      onModelChange: jest.fn(),
      chatMessages: [],
      chatContainerRef: { current: null },
      showScrollButton: false,
      scrollToBottom: jest.fn(),
      handleImageLoad: jest.fn(),
      getImageSrc: jest.fn(),
      hasNewResponse: false,
      scrollToNewResponse: jest.fn(),
      scrollToMessage: jest.fn(),
      currentSession: null,
      handleImageAnalysis: jest.fn(),
      onAnalyzeMultiImage: jest.fn(),
      onFollowUpMultiImage: jest.fn(),
      onSendMessage: jest.fn(),
      addMessage: jest.fn(),
      startAIThinking: jest.fn(),
      isAIThinking: false,
      splitModeImages: null,
      activeImageIndex: 0,
      enterSplitMode: jest.fn(),
      exitSplitMode: jest.fn(),
      setActiveImageIndex: jest.fn(),
      activeQuestionId: '3',
      setActiveQuestionId: jest.fn(),
      isContextFilterActive: false,
      isQuestionTableVisible: true,
      visibleTableIds: new Set(),
      isNegative: false,
      isHistoryLoading: false,
      isModelAnswerMode: false,
      isMarkingSchemeMode: false,
      user: { uid: 'u1' },
      guestLimitInfo: null,
    };
  });

  it('does not pass activeQuestionId to FollowUpChatInput in mode="first-time"', () => {
    render(<MainLayout />);

    expect(screen.getByTestId('chat-input-first-time')).toBeInTheDocument();
    expect(screen.queryByText(/Question 3 Focused/i)).not.toBeInTheDocument();
    expect(mockFollowUpChatInput).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'first-time',
        contextQuestionId: null,
      })
    );
  });

  it('passes activeQuestionId to FollowUpChatInput in mode="follow-up"', () => {
    mockMarkingPageState.currentSession = { id: 'sess-1', messages: [{ id: 'm1', role: 'assistant', content: 'hi' }] };
    mockMarkingPageState.chatMessages = mockMarkingPageState.currentSession.messages;

    render(<MainLayout />);

    expect(screen.getByTestId('chat-input-follow-up')).toBeInTheDocument();
    expect(screen.getByText('Question 3 Focused')).toBeInTheDocument();
    expect(mockFollowUpChatInput).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'follow-up',
        contextQuestionId: '3',
      })
    );
  });

  it('does not render ribbon-thumbnail-tick-badge when marking is not completed (no student mark / total mark)', () => {
    mockMarkingPageState.currentSession = {
      id: 'sess-precheck',
      messages: [
        { id: 'u1', role: 'user', content: 'check hand written only', imageData: 'data:image/jpeg;base64,abc' },
        { id: 'a1', role: 'assistant', content: 'I have checked your document.', isPreCheckPause: true }
      ]
    };
    mockMarkingPageState.chatMessages = mockMarkingPageState.currentSession.messages;
    mockGroupedQuestions = [];

    const { container } = render(<MainLayout />);
    expect(container.querySelector('.ribbon-thumbnail-stack-btn')).toBeInTheDocument();
    expect(container.querySelector('.ribbon-thumbnail-tick-badge')).not.toBeInTheDocument();
  });

  it('renders ribbon-thumbnail-tick-badge when marking is completed with valid student mark / total mark', () => {
    mockMarkingPageState.currentSession = {
      id: 'sess-marked',
      messages: [
        { id: 'u1', role: 'user', content: '', imageData: 'data:image/jpeg;base64,abc' },
        { id: 'a1', role: 'assistant', content: 'Marked', isProcessing: false }
      ]
    };
    mockMarkingPageState.chatMessages = mockMarkingPageState.currentSession.messages;
    mockGroupedQuestions = [
      { questionNumber: '10', hasResults: true, awardedMarks: 5, totalMarks: 7 }
    ];

    const { container } = render(<MainLayout />);
    expect(container.querySelector('.ribbon-thumbnail-stack-btn')).toBeInTheDocument();
    expect(container.querySelector('.ribbon-thumbnail-tick-badge')).toBeInTheDocument();
  });
});
