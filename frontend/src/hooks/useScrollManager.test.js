import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useScrollManager } from './useScrollManager';
import { jest } from '@jest/globals';

global.requestAnimationFrame = (cb) => {
  cb();
  return 1;
};
global.cancelAnimationFrame = () => {};

describe('useScrollManager hook', () => {
  let mockChatContainer;
  let mockMessageElements;
  let listeners;
  let resizeCallback;
  let resizeDisconnect;
  let consoleErrorSpy;
  let consoleDebugSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    listeners = {};
    resizeCallback = null;
    resizeDisconnect = jest.fn();

    global.ResizeObserver = class {
      constructor(cb) {
        resizeCallback = cb;
      }
      observe = jest.fn();
      disconnect = resizeDisconnect;
    };

    mockMessageElements = {
      'user-1': {
        getBoundingClientRect: () => ({ top: 100 }),
        scrollIntoView: jest.fn(),
      },
      'ai-1': {
        getBoundingClientRect: () => ({ top: 400 }),
        scrollIntoView: jest.fn(),
      },
      'ai-2': {
        getBoundingClientRect: () => ({ top: 900 }),
        scrollIntoView: jest.fn(),
      },
    };

    mockChatContainer = {
      scrollHeight: 1500,
      scrollTop: 0,
      clientHeight: 500,
      firstElementChild: {},
      getBoundingClientRect: () => ({ top: 0 }),
      addEventListener: jest.fn((event, handler) => {
        listeners[event] = handler;
      }),
      removeEventListener: jest.fn((event, handler) => {
        if (listeners[event] === handler) {
          delete listeners[event];
        }
      }),
      scrollTo: jest.fn(({ top }) => {
        mockChatContainer.scrollTop = top;
      }),
      querySelector: jest.fn((selector) => {
        const match = typeof selector === 'string' && selector.match(/\[data-message-id="([^"]+)"\]/);
        if (match && mockMessageElements[match[1]]) {
          return mockMessageElements[match[1]];
        }
        return null;
      }),
      querySelectorAll: jest.fn(() => Object.values(mockMessageElements)),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  it('should initialize with default scroll states', () => {
    const { result } = renderHook(() => useScrollManager([], false));
    expect(result.current.showScrollButton).toBe(false);
    expect(result.current.hasNewResponse).toBe(false);
  });

  it('should scroll smoothly to a newly sent user message within the same session', () => {
    const { result, rerender } = renderHook(
      ({ chatMessages, isAIThinking, sessionId }) => useScrollManager(chatMessages, isAIThinking, sessionId),
      { initialProps: { chatMessages: [], isAIThinking: false, sessionId: 'sess-1' } }
    );

    act(() => {
      result.current.chatContainerRef(mockChatContainer);
    });

    const newUserMessage = { id: 'user-1', role: 'user', content: 'hello' };
    rerender({ chatMessages: [newUserMessage], isAIThinking: false, sessionId: 'sess-1' });

    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(mockChatContainer.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('should NOT trigger new-message auto-scroll when switching to a completed historical session', () => {
    const { result, rerender } = renderHook(
      ({ chatMessages, isAIThinking, sessionId }) => useScrollManager(chatMessages, isAIThinking, sessionId),
      { initialProps: { chatMessages: [], isAIThinking: false, sessionId: null } }
    );

    act(() => {
      result.current.chatContainerRef(mockChatContainer);
    });

    const historyMessages = [
      { id: 'user-1', role: 'user', content: 'q1' },
      { id: 'ai-1', role: 'assistant', content: 'a1' },
      { id: 'ai-2', role: 'assistant', content: 'a2' },
    ];
    rerender({ chatMessages: historyMessages, isAIThinking: false, sessionId: 'hist-1' });

    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(mockChatContainer.scrollTo).not.toHaveBeenCalled();
  });

  it('should instant-jump and re-snap on layout shift via focusMessageWithStabilization, and yield on user wheel', () => {
    const historyMessages = [
      { id: 'user-1', role: 'user', content: 'q1' },
      { id: 'ai-1', role: 'assistant', content: 'a1' },
      { id: 'ai-2', role: 'assistant', content: 'a2' },
    ];
    const { result } = renderHook(() => useScrollManager(historyMessages, false, 'hist-1'));

    act(() => {
      result.current.chatContainerRef(mockChatContainer);
    });

    let didFocus = false;
    act(() => {
      didFocus = result.current.focusMessageWithStabilization('ai-2', {
        behavior: 'auto',
        block: 'start',
        stabilizeMs: 1200,
      });
    });

    expect(didFocus).toBe(true);
    // 900 (targetRect.top) - 96 (desktop assistant topOffset) = 804
    expect(mockChatContainer.scrollTo).toHaveBeenCalledWith({ top: 804, behavior: 'auto' });

    // Simulate image above expanding height by 200px
    mockChatContainer.scrollTo.mockClear();
    mockChatContainer.scrollHeight = 1700;
    mockMessageElements['ai-2'].getBoundingClientRect = () => ({ top: 296 }); // shifted down by 200px relative to viewport
    act(() => {
      resizeCallback();
      jest.advanceTimersByTime(20);
    });
    expect(mockChatContainer.scrollTo).toHaveBeenCalledTimes(1);
    expect(mockChatContainer.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));

    // User scrolls with wheel -> stabilization cancels immediately
    mockChatContainer.scrollTo.mockClear();
    act(() => {
      listeners.wheel({ type: 'wheel' });
    });
    expect(resizeDisconnect).toHaveBeenCalled();
  });

  it('should keep reading position (no completion jump) and show "New Response" button when AI finishes and user is scrolled up', () => {
    const { result, rerender } = renderHook(
      ({ chatMessages, isAIThinking, sessionId }) => useScrollManager(chatMessages, isAIThinking, sessionId),
      { initialProps: { chatMessages: [{ id: 'user-1', role: 'user' }], isAIThinking: true, sessionId: 'sess-1' } }
    );

    act(() => {
      result.current.chatContainerRef(mockChatContainer);
      mockChatContainer.scrollTop = 100;
    });

    const aiResponseMessage = { id: 'ai-1', role: 'assistant', content: 'response' };
    rerender({
      chatMessages: [{ id: 'user-1', role: 'user' }, aiResponseMessage],
      isAIThinking: false,
      sessionId: 'sess-1',
    });

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(result.current.hasNewResponse).toBe(true);
    expect(mockChatContainer.scrollTo).not.toHaveBeenCalled();
  });

  it('should show the scroll-to-bottom button when user scrolls up', () => {
    const { result } = renderHook(() => useScrollManager([], false, 'sess-1'));

    act(() => {
      result.current.chatContainerRef(mockChatContainer);
    });

    expect(listeners.scroll).toBeDefined();

    act(() => {
      mockChatContainer.scrollTop = 100; // 1500 - 100 - 500 = 900 > 200
      listeners.scroll();
    });
    expect(result.current.showScrollButton).toBe(true);

    act(() => {
      mockChatContainer.scrollTop = 1000; // 1500 - 1000 - 500 = 0 <= 200
      listeners.scroll();
    });
    expect(result.current.showScrollButton).toBe(false);
  });

  it('should call scrollToMessage and reset state when scrollToNewResponse is called', () => {
    const { result } = renderHook(() => useScrollManager([], false, 'sess-1'));

    act(() => {
      result.current.chatContainerRef(mockChatContainer);
    });

    act(() => {
      result.current.scrollToMessage('ai-1');
    });

    expect(mockChatContainer.querySelector).toHaveBeenCalledWith('[data-message-id="ai-1"]');
    expect(mockMessageElements['ai-1'].scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });

    act(() => {
      result.current.scrollToNewResponse();
    });
    expect(mockChatContainer.scrollTo).not.toHaveBeenCalled();
  });
});

