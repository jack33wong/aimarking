import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { UnifiedMessage } from '../types';

export interface FocusStabilizeOptions {
  behavior?: ScrollBehavior;
  block?: ScrollLogicalPosition;
  stabilizeMs?: number;
}

/**
 * A dedicated hook to manage all complex scrolling logic for the chat view.
 */
export const useScrollManager = (
  chatMessages: UnifiedMessage[],
  isAIThinking: boolean,
  sessionId: string | null = null
) => {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hasNewResponse, setHasNewResponse] = useState(false);
  const [newResponseMessageId, setNewResponseMessageId] = useState<string | number | null>(null);

  // State to hold the actual DOM element. This triggers re-renders/effects when the node changes.
  const [chatContainerElement, setChatContainerElement] = useState<HTMLDivElement | null>(null);

  // Callback ref to capture the DOM element from the consumer
  const chatContainerRef = useCallback((node: HTMLDivElement | null) => {
    setChatContainerElement(node);
  }, []);

  // Keep latest messages in a ref so scrollToMessage stays referentially stable across renders
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;

  const prevMessagesCountRef = useRef(chatMessages.length);
  const prevIsAIThinkingRef = useRef(isAIThinking);
  const prevSessionIdRef = useRef<string | null>(sessionId ?? null);
  const stabilizationCleanupRef = useRef<(() => void) | null>(null);

  const cancelStabilization = useCallback((_reason?: string) => {
    if (stabilizationCleanupRef.current) {
      const cleanup = stabilizationCleanupRef.current;
      stabilizationCleanupRef.current = null;
      cleanup();
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    if (chatContainerElement) {
      chatContainerElement.scrollTo({
        top: chatContainerElement.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [chatContainerElement]);

  const scrollToMessage = useCallback((messageId: string | number, options?: ScrollIntoViewOptions): boolean => {
    if (chatContainerElement && messageId) {
      const targetMessage = chatContainerElement.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;

      if (targetMessage) {
        if (options?.block === 'start') {
          const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
          const currentMessages = chatMessagesRef.current;
          const targetMsgObj = currentMessages.find(m => String(m.id) === String(messageId));
          const isTargetingAssistant = targetMsgObj?.role === 'assistant';
          // On initial turn, only clamp to top: 0 when targeting the user message;
          // when targeting the AI assistant bubble, scroll directly to the bubble with a small
          // topOffset so the bottom of the user's thumbnails peeks neatly above the thinking header.
          const isFirstTurn = currentMessages.length <= 2;
          if (isFirstTurn && !isTargetingAssistant) {
            chatContainerElement.scrollTo({
              top: 0,
              behavior: options.behavior || 'smooth'
            });
            return true;
          }

          const containerRect = chatContainerElement.getBoundingClientRect();
          const targetRect = targetMessage.getBoundingClientRect();
          const topOffset = isTargetingAssistant
            ? (isMobile ? 76 : 96)
            : (isMobile ? 116 : 140);
          const nextTop = Math.max(0, targetRect.top - containerRect.top + chatContainerElement.scrollTop - topOffset);
          chatContainerElement.scrollTo({
            top: nextTop,
            behavior: options.behavior || 'smooth'
          });
          return true;
        }

        // Native behavior is now boosted by scroll-margin-top in CSS
        targetMessage.scrollIntoView(options || { behavior: 'smooth', block: 'center' });
        return true;
      }
    }
    // If we can't find message, only scroll to bottom if no specific options were passed (default behavior)
    if (!options) {
      scrollToBottom();
    }
    return false;
  }, [chatContainerElement, scrollToBottom]);

  /**
   * Instantly (or smoothly) focus on a message and keep it pinned while images / KaTeX above it
   * finish expanding layout, immediately yielding to any manual user scroll interaction.
   */
  const focusMessageWithStabilization = useCallback((
    messageId: string | number,
    options?: FocusStabilizeOptions
  ): boolean => {
    const behavior = options?.behavior ?? 'auto';
    const block = options?.block ?? 'start';
    const stabilizeMs = options?.stabilizeMs ?? 1200;

    cancelStabilization('new_focus_request');

    const didScroll = scrollToMessage(messageId, { behavior, block });
    if (!didScroll || !chatContainerElement) {
      return false;
    }

    if (stabilizeMs <= 0) {
      return true;
    }

    let rafId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let lastObservedHeight = chatContainerElement.scrollHeight;

    const handleUserInteraction = (e: Event) => {
      if (e.type === 'keydown') {
        const key = (e as KeyboardEvent).key;
        if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key)) {
          return;
        }
      }
      cancelStabilization(`user_${e.type}`);
    };

    const targetObserveNode = (chatContainerElement.firstElementChild as HTMLElement | null) || chatContainerElement;

    if (typeof ResizeObserver !== 'undefined' && targetObserveNode) {
      resizeObserver = new ResizeObserver(() => {
        const currentHeight = chatContainerElement.scrollHeight;
        if (Math.abs(currentHeight - lastObservedHeight) < 2) {
          return;
        }
        lastObservedHeight = currentHeight;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(() => {
          rafId = null;
          scrollToMessage(messageId, { behavior: 'auto', block });
        });
      });
      resizeObserver.observe(targetObserveNode);
    }

    chatContainerElement.addEventListener('wheel', handleUserInteraction, { passive: true });
    chatContainerElement.addEventListener('touchstart', handleUserInteraction, { passive: true });
    chatContainerElement.addEventListener('pointerdown', handleUserInteraction, { passive: true });
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', handleUserInteraction, { passive: true });
    }

    const timeoutId = setTimeout(() => {
      cancelStabilization('stabilize_window_complete');
    }, stabilizeMs);

    stabilizationCleanupRef.current = () => {
      clearTimeout(timeoutId);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      chatContainerElement.removeEventListener('wheel', handleUserInteraction);
      chatContainerElement.removeEventListener('touchstart', handleUserInteraction);
      chatContainerElement.removeEventListener('pointerdown', handleUserInteraction);
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleUserInteraction);
      }
    };

    return true;
  }, [chatContainerElement, scrollToMessage, cancelStabilization]);

  // Cleanup stabilization on unmount or container change
  useEffect(() => {
    return () => {
      cancelStabilization('container_change_or_unmount');
    };
  }, [chatContainerElement, cancelStabilization]);

  const scrollToNewResponse = useCallback(() => {
    if (newResponseMessageId) {
      scrollToMessage(newResponseMessageId);
    }
    setHasNewResponse(false);
    setNewResponseMessageId(null);
  }, [newResponseMessageId, scrollToMessage]);

  // Effect to attach scroll listener whenever the element is available/changes
  useEffect(() => {
    const container = chatContainerElement;
    if (!container) return;

    const handleScroll = () => {
      // Show button if scrolled up more than 200px
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const isUp = distanceFromBottom > 200;
      setShowScrollButton(isUp);

      if (hasNewResponse && !isUp) {
        setHasNewResponse(false);
        setNewResponseMessageId(null);
      }
    };

    container.addEventListener('scroll', handleScroll);
    handleScroll(); // Initial check
    return () => container.removeEventListener('scroll', handleScroll);
  }, [chatContainerElement, hasNewResponse]);

  // Auto-scroll on new messages (within the SAME session, or a new actively-processing session)
  useEffect(() => {
    let initialTimer: ReturnType<typeof setTimeout> | null = null;
    let refineTimer: ReturnType<typeof setTimeout> | null = null;

    const normalizedSessionId = sessionId ?? null;
    const sessionChanged = normalizedSessionId !== prevSessionIdRef.current;

    if (sessionChanged) {
      prevSessionIdRef.current = normalizedSessionId;
      cancelStabilization('session_changed');
      setHasNewResponse(false);
      setNewResponseMessageId(null);

      const lastMessage = chatMessages[chatMessages.length - 1];
      const isActivelyProcessingSession = Boolean(
        isAIThinking || (lastMessage && lastMessage.role === 'assistant' && lastMessage.isProcessing)
      );

      if (!isActivelyProcessingSession) {
        prevMessagesCountRef.current = chatMessages.length;
        return;
      }
    }

    if (chatMessages.length > prevMessagesCountRef.current) {
      const lastMessage = chatMessages[chatMessages.length - 1];
      const isProcessingAssistant = Boolean(lastMessage && lastMessage.role === 'assistant' && lastMessage.isProcessing);
      const targetFocusMessage =
        isProcessingAssistant
          ? lastMessage
          : lastMessage?.role === 'user'
            ? lastMessage
            : null;

      // Delay to ensure DOM rendering and layout stabilization
      initialTimer = setTimeout(() => {
        // Priority 1: Focus on the newly added AI processing bubble (so its header & scanning cards
        // sit cleanly in view), or on a newly sent user message.
        if (targetFocusMessage) {
          // Double-scroll strategy: Immediately start, then refine
          scrollToMessage(targetFocusMessage.id, { behavior: 'smooth', block: 'start' });

          // Refinement scroll after potential image expansion/spacer jump
          refineTimer = setTimeout(() => {
            scrollToMessage(targetFocusMessage.id, { behavior: 'smooth', block: 'start' });
          }, 450);
        }
        // Priority 2: If we are currently in AI thinking mode or just updated a processing message,
        // OR if this is the final AI response arriving, DO NOT scroll to bottom.
        // We want to keep the user locked to their current reading position (usually the start of their last question).
        else if (isAIThinking || (lastMessage && lastMessage.role === 'assistant')) {
          // No-op: Maintain user focus position
        }
        // Priority 3: Otherwise (system message), scroll to bottom.
        else {
          scrollToBottom();
        }
      }, 250); // Increased for better stability
    }
    prevMessagesCountRef.current = chatMessages.length;

    return () => {
      if (initialTimer) clearTimeout(initialTimer);
      if (refineTimer) clearTimeout(refineTimer);
    };
  }, [chatMessages, isAIThinking, sessionId, scrollToBottom, scrollToMessage, cancelStabilization]);

  useLayoutEffect(() => {
    const wasThinking = prevIsAIThinkingRef.current;
    prevIsAIThinkingRef.current = isAIThinking;

    if (wasThinking === true && isAIThinking === false) {
      const animationFrameId = requestAnimationFrame(() => {
        const container = chatContainerElement;
        if (!container) return;
        const lastMessage = chatMessagesRef.current[chatMessagesRef.current.length - 1];
        if (!lastMessage) return;

        const isScrolledUp = container.scrollHeight - container.scrollTop - container.clientHeight > 200;
        if (isScrolledUp) {
          setHasNewResponse(true);
          setNewResponseMessageId(lastMessage.id || lastMessage.timestamp);
        }
        // Removed scrollToBottom() here to prevent "Completion Jump"
        // User stays locked to their current reading position (e.g., top of question)
      });
      return () => cancelAnimationFrame(animationFrameId);
    }
  }, [isAIThinking, chatContainerElement]);

  return {
    chatContainerRef, // Now exposing the callback
    chatContainerElement,
    showScrollButton,
    hasNewResponse,
    scrollToBottom,
    scrollToNewResponse,
    scrollToMessage,
    focusMessageWithStabilization,
    cancelStabilization,
  };
};

