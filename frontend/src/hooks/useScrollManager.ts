import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { UnifiedMessage } from '../types';

/**
 * A dedicated hook to manage all complex scrolling logic for the chat view.
 */
export const useScrollManager = (chatMessages: UnifiedMessage[], isAIThinking: boolean) => {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hasNewResponse, setHasNewResponse] = useState(false);
  const [newResponseMessageId, setNewResponseMessageId] = useState<string | number | null>(null);

  // State to hold the actual DOM element. This triggers re-renders/effects when the node changes.
  const [chatContainerElement, setChatContainerElement] = useState<HTMLDivElement | null>(null);

  // Callback ref to capture the DOM element from the consumer
  const chatContainerRef = useCallback((node: HTMLDivElement | null) => {
    setChatContainerElement(node);
  }, []);

  const prevMessagesCountRef = useRef(chatMessages.length);
  const prevIsAIThinkingRef = useRef(isAIThinking);

  const scrollToBottom = useCallback(() => {
    if (chatContainerElement) {
      chatContainerElement.scrollTo({
        top: chatContainerElement.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [chatContainerElement]);

  const scrollToMessage = useCallback((messageId: string | number, options?: ScrollIntoViewOptions) => {
    if (chatContainerElement && messageId) {
      const targetMessage = chatContainerElement.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;

      if (targetMessage) {
        if (options?.block === 'start') {
          const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
          const targetMsgObj = chatMessages.find(m => String(m.id) === String(messageId));
          const isTargetingAssistant = targetMsgObj?.role === 'assistant';
          // On initial turn, only clamp to top: 0 when targeting the user message;
          // when targeting the AI assistant bubble, scroll directly to the bubble with a small
          // topOffset so the bottom of the user's thumbnails peeks neatly above the thinking header.
          const isFirstTurn = chatMessages.length <= 2;
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
  }, [chatContainerElement, chatMessages, scrollToBottom]);

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
      const isUp = container.scrollHeight - container.scrollTop - container.clientHeight > 200;
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

  // Auto-scroll on new messages
  useEffect(() => {
    let initialTimer: ReturnType<typeof setTimeout> | null = null;
    let refineTimer: ReturnType<typeof setTimeout> | null = null;

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
  }, [chatMessages, isAIThinking, scrollToBottom, scrollToMessage]);

  useLayoutEffect(() => {
    if (prevIsAIThinkingRef.current === true && isAIThinking === false) {
      const animationFrameId = requestAnimationFrame(() => {
        const container = chatContainerElement;
        if (!container) return;
        const lastMessage = chatMessages[chatMessages.length - 1];
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
    prevIsAIThinkingRef.current = isAIThinking;
  }, [isAIThinking, chatMessages, scrollToBottom, chatContainerElement]);

  return {
    chatContainerRef, // Now exposing the callback
    showScrollButton,
    hasNewResponse,
    scrollToBottom,
    scrollToNewResponse,
    scrollToMessage,
  };
};

