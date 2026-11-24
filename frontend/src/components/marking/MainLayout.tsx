/**
 * MainLayout Component (TypeScript)
 * This is the definitive version with the fix for the re-mounting bug.
 */
import React, { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import ReactDOM from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { useMarkingPage } from '../../contexts/MarkingPageContext';
import SessionManagement from './SessionManagement';
import FollowUpChatInput from '../chat/FollowUpChatInput';
import ChatMessage from '../focused/ChatMessage';
import type { UnifiedMessage } from '../../types';
import MarkdownMathRenderer from './MarkdownMathRenderer';
import { ensureStringContent } from '../../utils/contentUtils';
import { getSessionImages } from '../../utils/imageCollectionUtils';
import { useQuestionGrouping } from '../../hooks/useQuestionGrouping';
import './css/ChatInterface.css';
import './css/ImageUploadInterface.css';
import '../common/LoadingSpinner.css';
import QuestionNavigator from './QuestionNavigator';
import SEO from '../common/SEO';
import ImageViewer from '../common/ImageViewer';
import { analyticsService } from '../../services/AnalyticsService';
import { engagementTracker } from '../../utils/engagementTracker';

const productSchema = {
  "@context": "https://schema.org/",
  "@type": "Product",
  "name": "AI Marking",
  "description": "AI-powered marking for GCSE Maths papers. Get instant grades and step-by-step logic analysis.",
  "brand": {
    "@type": "Brand",
    "name": "AI Marking"
  },
  "offers": {
    "@type": "Offer",
    "url": "https://aimarking.ai",
    "priceCurrency": "GBP",
    "availability": "https://schema.org/InStock"
  }
};

interface MainLayoutProps {
  noIndex?: boolean;
}

const MainLayout: React.FC<MainLayoutProps> = ({ noIndex = false }) => {
  const {
    isProcessing,
    selectedModel,
    onModelChange,
    chatMessages,
    chatContainerRef,
    showScrollButton,
    scrollToBottom,
    handleImageLoad,
    getImageSrc,
    hasNewResponse,
    scrollToNewResponse,
    scrollToMessage,
    cancelStabilization,
    currentSession,
    handleImageAnalysis,
    onAnalyzeMultiImage,
    onFollowUpMultiImage,
    onSendMessage,
    addMessage,
    startAIThinking,
    isAIThinking,
    // Context related state
    splitModeImages,
    activeImageIndex,
    enterSplitMode,
    exitSplitMode,
    setActiveImageIndex,
    activeQuestionId,
    setActiveQuestionId,
    isContextFilterActive,
    isQuestionTableVisible,
    visibleTableIds,
    isNegative,
    isHistoryLoading,
    isModelAnswerMode,
    isMarkingSchemeMode,
    user,
    guestLimitInfo
  } = useMarkingPage();

  const isGuest = !user;

  const isFollowUp = (chatMessages || []).length > 0;

  // Auto-refresh Header credits when session completes
  useEffect(() => {
    if (currentSession && !currentSession.id?.startsWith('temp-')) {
      // Wait 1 second for Firestore to save credit deduction
      setTimeout(() => {
        import('../../utils/eventManager').then(({ default: EventManager, EVENT_TYPES }) => {
          EventManager.dispatch(EVENT_TYPES.REFRESH_CREDITS);
        });
      }, 1000);
    } else {
      // Stop engagement tracker when session is cleared or reset to a new upload
      engagementTracker.stopSession('session_switch');
    }
  }, [currentSession?.id]);

  // Stop engagement tracker when navigating away from MainLayout (e.g., to /admin)
  useEffect(() => {
    return () => {
      engagementTracker.stopSession('unmount');
    };
  }, []);

  const location = useLocation();
  const navigate = useNavigate();

  // Track subscription success from redirect
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    if (searchParams.get('subscription') === 'success') {
      // Logic removed: Handle conversion via AnalyticsTracker.tsx
      // and URL cleanup via Header.js to prevent collisions.
    }
  }, [location]);

  // State to track if we've scrolled past the header to prevent ribbon overlap
  const [showRibbonOnScroll, setShowRibbonOnScroll] = React.useState(false);
  const [containerElement, setContainerElement] = React.useState<HTMLDivElement | null>(null);

  // Synchronization Lock: Prevents circular updates during programmatic navigation
  const isSyncingRef = React.useRef(false);
  const syncLockTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reliable Ref Callback to capture the container node
  const setChatContainerRef = React.useCallback((node: HTMLDivElement | null) => {
    // Preserve the original ref from useScrollManager context
    // Preserve the original ref from useScrollManager context
    if (chatContainerRef) {
      if (typeof chatContainerRef === 'function') {
        chatContainerRef(node);
      } else {
        (chatContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    }
    setContainerElement(node);
  }, [chatContainerRef]);

  // Scroll Listener for Ribbon Visibility
  useEffect(() => {
    const container = containerElement;
    if (!container) return;

    const handleScroll = () => {
      const isPastHeader = container.scrollTop > 150;
      setShowRibbonOnScroll(prev => {
        if (isPastHeader !== prev) {
          return isPastHeader;
        }
        return prev;
      });
    };

    container.addEventListener('scroll', handleScroll);
    handleScroll();

    return () => container.removeEventListener('scroll', handleScroll);
  }, [containerElement]);

  // Centralized Scroll-Spy Observer Ref
  const scrollSpyObserverRef = React.useRef<IntersectionObserver | null>(null);

  // Determine Marking Context for Ribbon
  const lastMarkingMessage = React.useMemo(() => {
    if (!currentSession || !currentSession.messages) return null;
    return [...currentSession.messages].reverse().find(m => (m as any).markingContext);
  }, [currentSession]);

  // Determine Detected Question for Ribbon logic (supports both past papers and generic/unmatched questions)
  const activeDetectedQuestion = React.useMemo(() => {
    if (!currentSession) return null;
    const hasDetectedQuestionData = (dq: any) =>
      Boolean(dq?.examPapers?.length || dq?.questions?.length || dq?.found);

    if (hasDetectedQuestionData(currentSession.detectedQuestion)) {
      return currentSession.detectedQuestion;
    }

    if (currentSession.messages) {
      const msgWithQuestion = currentSession.messages.find(
        (m: any) => hasDetectedQuestionData(m.detectedQuestion)
      );
      if (msgWithQuestion) return (msgWithQuestion as any).detectedQuestion;
    }
    return null;
  }, [currentSession]);

  // Use question grouping hook to get badges data
  const { groupedQuestions, getGroupColor } = useQuestionGrouping(activeDetectedQuestion, (lastMarkingMessage as any)?.markingContext);

  // Centralized Navigation & Sync Handler
  const navigateToQuestion = React.useCallback((qNum: string | number, imgIdx: number, source: 'ribbon' | 'image' | 'scroll') => {
    // 1. Set the Lock ONLY for explicit programmatic chat scrolls (ribbon / image clicks).
    // Scroll-spy updates (source === 'scroll') do NOT scroll the chat, so locking for 1000ms
    // would block syncing after an instant history-load jump or rapid scrolling.
    if (source !== 'scroll') {
      cancelStabilization?.(`navigate_${source}`);
      isSyncingRef.current = true;
      if (syncLockTimerRef.current) {
        clearTimeout(syncLockTimerRef.current);
      }
    }

    let targetImgIdx = imgIdx;

    // Auto-resolve index if not provided or invalid
    if (targetImgIdx === -1 || targetImgIdx === undefined) {
      const match = groupedQuestions.find(g => String(g.questionNumber).toLowerCase() === String(qNum).toLowerCase());
      if (match) {
        targetImgIdx = match.sourceImageIndex;
      } else {
        targetImgIdx = activeImageIndex || 0; // Fallback
      }
    }

    // 2. Update States
    setActiveQuestionId(qNum);
    if (source === 'ribbon') {
      engagementTracker.recordQuestionNavigation(targetImgIdx);
    } else {
      engagementTracker.recordPageView(targetImgIdx);
    }

    // If not in split mode, we only AUTO-ENTER it if the user explicitly clicked (Ribbon/Image)
    // Scrolling through the chat should NOT suddenly pop the user into split mode.
    if (!splitModeImages) {
      if (source !== 'scroll') {
        const sessionImages = currentSession ? getSessionImages(currentSession) : [];
        if (sessionImages.length > 0) {
          enterSplitMode(sessionImages, targetImgIdx);
        }
      } else {
        // Just keep the target index in sync background-ly
        setActiveImageIndex(targetImgIdx);
      }
    } else {
      // If already in split mode, always sync the image
      setActiveImageIndex(targetImgIdx);
    }

    // 3. Scroll Chat (only if triggered by ribbon or image)
    if (source !== 'scroll') {
      const normalizedQ = String(qNum).toLowerCase();
      // Prefer scrolling to the latest follow-up explanation message for this question if one exists
      const followUpForQ = [...(chatMessages || [])]
        .reverse()
        .find((m: any) =>
          m.role === 'assistant' &&
          !m.markingContext &&
          m.type !== 'marking_annotated' &&
          !m.performanceSummary &&
          String(m.contextQuestionId || '').toLowerCase() === normalizedQ
        );

      if (followUpForQ) {
        scrollToMessage(followUpForQ.id, { behavior: 'smooth', block: 'start' });
      } else {
        const targetId = `question-${normalizedQ}`;
        const el = document.getElementById(targetId);

        if (el) {
          // Native scroll with the CSS/inline scroll-margin-top handles the offset
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          // Fallback: search for any message containing this question if the specific header hasn't rendered yet
          const msg = chatMessages.find((m: any) => String(m.contextQuestionId || '').toLowerCase() === normalizedQ);
          if (msg) {
            scrollToMessage(msg.id, { behavior: 'smooth', block: 'start' });
          }
        }
      }

      // 4. Clear lock after navigation settlement (to allow smooth scroll to finish)
      syncLockTimerRef.current = setTimeout(() => {
        isSyncingRef.current = false;
        syncLockTimerRef.current = null;
      }, 1000);
    }
  }, [currentSession, chatMessages, scrollToMessage, cancelStabilization, setActiveQuestionId, setActiveImageIndex, enterSplitMode, groupedQuestions, splitModeImages, activeImageIndex]);

  // Refs for scroll-spy so the IntersectionObserver does NOT tear down and re-fire
  // every time activeQuestionId or activeImageIndex changes (which previously caused ping-pong loops).
  const activeQuestionIdRef = React.useRef(activeQuestionId);
  activeQuestionIdRef.current = activeQuestionId;
  const activeImageIndexRef = React.useRef(activeImageIndex);
  activeImageIndexRef.current = activeImageIndex;
  const groupedQuestionsRef = React.useRef(groupedQuestions);
  groupedQuestionsRef.current = groupedQuestions;
  const navigateToQuestionRef = React.useRef(navigateToQuestion);
  navigateToQuestionRef.current = navigateToQuestion;

  // Setup Centralized Scroll-Spy (reading-line based, immune to tall-bubble/nested-header conflicts)
  useEffect(() => {
    if (!containerElement) return;

    // Cleanup any legacy observer reference
    if (scrollSpyObserverRef.current) {
      scrollSpyObserverRef.current.disconnect();
      scrollSpyObserverRef.current = null;
    }

    let rafId: number | null = null;

    const evaluateActiveQuestion = () => {
      rafId = null;
      if (isSyncingRef.current) {
        return;
      }

      const containerRect = containerElement.getBoundingClientRect();
      // Reading line near top of chat container (just below header / bubble padding)
      const readingLine = containerRect.top + 140;
      const visibleBottom = containerRect.top + containerRect.height * 0.45;

      // Collect all question anchors:
      // 1. Specific question headers (`[id^="question-"]`)
      // 2. Outer message bubbles (`[data-context-question-id]`) ONLY if they do NOT contain
      //    internal `[id^="question-"]` headers (prevents an outer `data-context-question-id="2"`
      //    wrapper on a multi-question "explain q2 and q3" reply from overriding `#question-3`).
      const rawElements = Array.from(
        containerElement.querySelectorAll<HTMLElement>('[id^="question-"], [data-context-question-id]')
      );
      const anchors = rawElements.filter(el => {
        if (el.id && el.id.startsWith('question-')) return true;
        if (el.hasAttribute('data-context-question-id')) {
          return !el.querySelector('[id^="question-"]');
        }
        return false;
      });

      if (anchors.length === 0) return;

      let chosenEl: HTMLElement | null = null;
      let chosenTop = -Infinity;

      // Standard TOC scroll-spy: pick the LAST anchor whose top has passed above readingLine
      for (const el of anchors) {
        const top = el.getBoundingClientRect().top;
        if (top <= readingLine && top >= chosenTop) {
          chosenTop = top;
          chosenEl = el;
        }
      }

      // Fallback when at very top of chat (no anchor above readingLine yet):
      // pick the first anchor visible in the upper portion of the viewport.
      if (!chosenEl) {
        let earliestTop = Infinity;
        for (const el of anchors) {
          const top = el.getBoundingClientRect().top;
          if (top > readingLine && top <= visibleBottom && top < earliestTop) {
            earliestTop = top;
            chosenEl = el;
          }
        }
      }

      if (!chosenEl) return;

      const qId = chosenEl.id;
      const contextQ = chosenEl.getAttribute('data-context-question-id');
      const rawQNum = qId && qId.startsWith('question-')
        ? qId.replace('question-', '')
        : (contextQ || '');

      if (!rawQNum) return;

      // Match against groupedQuestions (exact first, then base numeric question e.g. "2a" -> "2")
      const normalizedRaw = rawQNum.toLowerCase();
      const baseNum = normalizedRaw.replace(/^(\d+).*/, '$1');
      const match =
        groupedQuestionsRef.current.find(
          g => String(g.questionNumber).toLowerCase() === normalizedRaw
        ) ||
        groupedQuestionsRef.current.find(
          g => String(g.questionNumber).toLowerCase() === baseNum
        );

      const resolvedQNum = match ? String(match.questionNumber) : rawQNum;

      if (resolvedQNum.toLowerCase() === String(activeQuestionIdRef.current || '').toLowerCase()) {
        return;
      }

      const imgIdx = match ? match.sourceImageIndex : activeImageIndexRef.current;
      navigateToQuestionRef.current(resolvedQNum, imgIdx, 'scroll');
    };

    const scheduleEvaluate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(evaluateActiveQuestion);
    };

    containerElement.addEventListener('scroll', scheduleEvaluate, { passive: true });
    scheduleEvaluate();

    // Re-evaluate when new messages/headers render or images expand
    const mutationObserver = new MutationObserver(scheduleEvaluate);
    mutationObserver.observe(containerElement, { childList: true, subtree: true });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      containerElement.removeEventListener('scroll', scheduleEvaluate);
      mutationObserver.disconnect();
    };
  }, [containerElement, currentSession?.id]);

  // NOTE: All reactive effects for syncing between activeQuestionId and activeImageIndex have been REMOVED.

  // Prioritize lowest-scoring / mistake question when multiple questions share a page
  const sortQuestionsByMistakePriority = useCallback((questions: any[]) => {
    return [...questions].sort((a, b) => {
      const aMistake = a.hasResults && a.awardedMarks !== null && a.totalMarks > 0 && a.awardedMarks < a.totalMarks ? 0 : 1;
      const bMistake = b.hasResults && b.awardedMarks !== null && b.totalMarks > 0 && b.awardedMarks < b.totalMarks ? 0 : 1;
      if (aMistake !== bMistake) return aMistake - bMistake;
      const aRatio = (a.hasResults && a.awardedMarks !== null && a.totalMarks > 0) ? a.awardedMarks / a.totalMarks : 1;
      const bRatio = (b.hasResults && b.awardedMarks !== null && b.totalMarks > 0) ? b.awardedMarks / b.totalMarks : 1;
      return aRatio - bRatio;
    });
  }, []);

  const lostMarkQuestions = useMemo(() => {
    return groupedQuestions.filter(
      q => q.hasResults && q.awardedMarks !== null && q.totalMarks > 0 && q.awardedMarks < q.totalMarks
    );
  }, [groupedQuestions]);

  const lostMarkPageIndices = useMemo(() => {
    if (!splitModeImages || splitModeImages.length === 0) return [];
    const mistakeRawIndices = new Set<number>();
    lostMarkQuestions.forEach(q => {
      if (Array.isArray(q.allImageIndices) && q.allImageIndices.length > 0) {
        q.allImageIndices.forEach(idx => mistakeRawIndices.add(idx));
      } else if (typeof q.sourceImageIndex === 'number') {
        mistakeRawIndices.add(q.sourceImageIndex);
      }
    });

    const viewerIndices: number[] = [];
    splitModeImages.forEach((img: any, idx: number) => {
      const isAnnotated = img.messageRole === 'assistant' || img.messageType === 'marking_annotated';
      if (!isAnnotated) return;
      const pageIdx = img.pageIndex ?? idx;
      if (mistakeRawIndices.has(pageIdx) || mistakeRawIndices.has(idx)) {
        viewerIndices.push(idx);
      }
    });
    return Array.from(new Set(viewerIndices)).sort((a, b) => a - b);
  }, [lostMarkQuestions, splitModeImages]);

  // Memoize enriched images to provide a stable reference to the ImageViewer
  const enrichedSplitModeImages = React.useMemo(() => {
    if (!splitModeImages) return null;

    return splitModeImages.map((img: any, idx: number) => {
      // Only show badges for assistant/annotated messages
      const isAnnotated = img.messageRole === 'assistant' || img.messageType === 'marking_annotated';

      if (isAnnotated) {
        const pageIdx = img.pageIndex ?? idx;
        const primaryMatches = groupedQuestions.filter(
          g => g.sourceImageIndex === pageIdx
        );
        const matches = primaryMatches.length > 0
          ? primaryMatches
          : groupedQuestions.filter(
              g => g.allImageIndices.includes(pageIdx) || g.allImageIndices.includes(idx)
            );
        if (matches.length === 1) {
          const match = matches[0];
          const scoreText = match.awardedMarks !== null ? `${match.awardedMarks}/${match.totalMarks}` : `?/${match.totalMarks}`;
          const rawQ = String(match.questionNumber ?? '').replace(/^Q/i, '').trim();
          const multiMatch = rawQ.match(/^(P\d+)[·.\-]Q?(.+)$/i);
          const qLabel = multiMatch ? `${multiMatch[1].toUpperCase()}.Q${multiMatch[2]}` : `Q${rawQ}`;
          return {
            ...img,
            badgeText: `${qLabel} ${scoreText}`,
            badgeColor: getGroupColor(match)
          };
        }
        if (matches.length > 1) {
          const formatQ = (qNum: any) => {
            const rawQ = String(qNum ?? '').replace(/^Q/i, '').trim();
            const multiMatch = rawQ.match(/^(P\d+)[·.\-]Q?(.+)$/i);
            return multiMatch ? `${multiMatch[1].toUpperCase()}.Q${multiMatch[2]}` : `Q${rawQ}`;
          };
          const labels = matches.map(m => formatQ(m.questionNumber));
          const qLabel = labels.length === 2
            ? `${labels[0]}, ${labels[1]}`
            : `${labels[0]}–${labels[labels.length - 1]}`;
          const totalMarks = matches.reduce((sum, m) => sum + (m.totalMarks || 0), 0);
          const allHaveResults = matches.every(m => m.hasResults && m.awardedMarks !== null);
          const awardedMarks = allHaveResults
            ? matches.reduce((sum, m) => sum + (m.awardedMarks || 0), 0)
            : null;
          const scoreText = awardedMarks !== null ? `${awardedMarks}/${totalMarks}` : `?/${totalMarks}`;
          const badgeColor = getGroupColor({
            ...matches[0],
            hasResults: allHaveResults,
            awardedMarks,
            totalMarks
          });
          return {
            ...img,
            badgeText: `${qLabel} ${scoreText}`,
            badgeColor
          };
        }
      }
      return {
        ...img,
        badgeText: undefined // Ensure no badge for originals
      };
    });
  }, [splitModeImages, groupedQuestions, getGroupColor, sortQuestionsByMistakePriority]);

  // Enhanced Split Mode Entry
  const enterSplitModeEnriched = useCallback((images: any[], index: number, isGlobal?: boolean) => {
    const img = images?.[index];
    const pageIdx = img?.pageIndex ?? index;
    // Determine the question associated with this image index to keep the Ribbon in sync
    const matches = groupedQuestions.filter(
      g => g.allImageIndices.includes(pageIdx) || g.allImageIndices.includes(index)
    );
    const match = matches.length > 0 ? sortQuestionsByMistakePriority(matches)[0] : null;
    if (match && activeQuestionId !== match.questionNumber) {
      setActiveQuestionId(match.questionNumber);
    }

    // If we're not in split mode, enter it
    if (!splitModeImages) {
      enterSplitMode(images, index, isGlobal);
      return;
    }

    // If already in split mode, check if we need to update the image set
    // (e.g. switching from session-wide view to message-specific view)
    const imagesChanged = images.length !== splitModeImages.length ||
      (images.length > 0 && images[0].src !== splitModeImages[0].src);

    if (imagesChanged) {
      enterSplitMode(images, index, isGlobal);
    } else if (activeImageIndex !== index) {
      setActiveImageIndex(index);
    }
  }, [splitModeImages, enterSplitMode, activeImageIndex, setActiveImageIndex, groupedQuestions, activeQuestionId, setActiveQuestionId, sortQuestionsByMistakePriority]);

  // Reusable Ribbon Render Function
  const ribbonSessionImages = useMemo(
    () => (currentSession ? getSessionImages(currentSession) : []),
    [currentSession]
  );

  const renderQuestionRibbon = (isChatMode: boolean) => {
    if (!currentSession || groupedQuestions.length === 0) return null;

    const ribbonContent = (
      <QuestionNavigator
        mode="ribbon"
        idPrefix="ribbon"
        detectedQuestion={activeDetectedQuestion}
        markingContext={(lastMarkingMessage as any)?.markingContext}
        onNavigate={(qNum, imgIdx) => {
          navigateToQuestion(qNum, imgIdx, 'ribbon');
        }}
        activeQuestionId={activeQuestionId}
      />
    );

    return (
      <div className="question-navigator-ribbon-wrapper">
        <div className="question-navigator-ribbon-container">
          {ribbonContent}
        </div>
      </div>
    );
  };

  // Handler for image change (e.g. from thumbnail click) to sync ribbon and chat
  const handleImageChange = (index: number) => {
    if (activeImageIndex === index) return;

    const img = splitModeImages?.[index];
    const pageIdx = img?.pageIndex ?? index;
    // Find the question that maps to this page index (prioritizing mistakes when multiple share a page)
    const matches = groupedQuestions.filter(
      q => q.allImageIndices.includes(pageIdx) || q.allImageIndices.includes(index)
    );
    if (matches.length > 0) {
      const question = sortQuestionsByMistakePriority(matches)[0];
      navigateToQuestion(question.questionNumber, index, 'image');
    } else {
      setActiveImageIndex(index);
    }
  };

  const activeQuestionMeta = useMemo(() => {
    const currentIdx = activeImageIndex || 0;
    const img = splitModeImages?.[currentIdx];
    const isAnnotated = img?.messageRole === 'assistant' || img?.messageType === 'marking_annotated';
    if (!isAnnotated) return null;
    const pageIdx = img?.pageIndex ?? currentIdx;

    if (activeQuestionId) {
      const byActiveId = groupedQuestions.find(
        q => String(q.questionNumber).toLowerCase() === String(activeQuestionId).toLowerCase()
      );
      if (byActiveId && (byActiveId.allImageIndices.includes(pageIdx) || byActiveId.allImageIndices.includes(currentIdx))) {
        return {
          questionNumber: String(byActiveId.questionNumber),
          awardedMarks: byActiveId.awardedMarks,
          totalMarks: byActiveId.totalMarks
        };
      }
    }

    const pageMatches = groupedQuestions.filter(
      q => q.allImageIndices.includes(pageIdx) || q.allImageIndices.includes(currentIdx)
    );
    if (pageMatches.length > 0) {
      const prioritized = sortQuestionsByMistakePriority(pageMatches)[0];
      return {
        questionNumber: String(prioritized.questionNumber),
        awardedMarks: prioritized.awardedMarks,
        totalMarks: prioritized.totalMarks
      };
    }

    if (activeQuestionId) {
      const byActiveId = groupedQuestions.find(
        q => String(q.questionNumber).toLowerCase() === String(activeQuestionId).toLowerCase()
      );
      if (byActiveId) {
        return {
          questionNumber: String(byActiveId.questionNumber),
          awardedMarks: byActiveId.awardedMarks,
          totalMarks: byActiveId.totalMarks
        };
      }
    }

    return null;
  }, [activeQuestionId, activeImageIndex, splitModeImages, groupedQuestions, sortQuestionsByMistakePriority]);

  // Lock Scroll-Spy during active processing/AI thinking (and briefly after) so auto-scrolling to a new follow-up message never hijacks activeQuestionId or activeImageIndex
  const prevSyncSessionIdRef = useRef<string | null>(currentSession?.id || null);
  useEffect(() => {
    const sessionChanged = (currentSession?.id || null) !== prevSyncSessionIdRef.current;
    prevSyncSessionIdRef.current = currentSession?.id || null;

    if (isProcessing || isAIThinking) {
      isSyncingRef.current = true;
      return;
    }
    if (sessionChanged) {
      // Switching to a completed historical session should immediately allow scroll-spy
      // to sync ribbon & image viewer with the landed assistant bubble.
      isSyncingRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      isSyncingRef.current = false;
    }, 1000);
    return () => clearTimeout(timer);
  }, [isProcessing, isAIThinking, currentSession?.id]);

  const handleViewerSendFollowUp = useCallback(async (rawText: string, questionNumber?: string | null) => {
    const trimmed = rawText.trim();
    if (!trimmed || !onSendMessage) return;
    isSyncingRef.current = true;
    const explicitMatch = trimmed.match(/\b(?:questions?|q)\s*(\d+)/i);
    const explicitQ = explicitMatch ? explicitMatch[1] : null;
    const targetQ = explicitQ || questionNumber || activeQuestionMeta?.questionNumber || activeQuestionId || null;
    if (targetQ) {
      setActiveQuestionId(String(targetQ));
      // If the viewer is currently on a metadata/cover page (or a page that doesn't contain targetQ), jump to targetQ's page
      const matchedGroup = groupedQuestions.find(
        g => String(g.questionNumber).toLowerCase() === String(targetQ).toLowerCase()
      );
      if (matchedGroup && splitModeImages && splitModeImages.length > 0) {
        const currentIdx = activeImageIndex || 0;
        const currentImg = splitModeImages[currentIdx];
        const currentPageIdx = currentImg?.pageIndex ?? currentIdx;
        const isAlreadyOnTargetQuestionPage =
          matchedGroup.allImageIndices.includes(currentPageIdx) ||
          matchedGroup.allImageIndices.includes(currentIdx);
        if (!isAlreadyOnTargetQuestionPage && typeof matchedGroup.sourceImageIndex === 'number') {
          setActiveImageIndex(matchedGroup.sourceImageIndex);
        }
      }
    }
    const mentionsQuestion = /\b(?:questions?|q)\s*\d+/i.test(trimmed);
    const formattedPrompt = targetQ && !mentionsQuestion
      ? `[Question ${targetQ}] ${trimmed}`
      : trimmed;
    await onSendMessage(formattedPrompt);
    setTimeout(() => {
      isSyncingRef.current = false;
    }, 1000);
  }, [onSendMessage, activeQuestionMeta, activeQuestionId, setActiveQuestionId, groupedQuestions, splitModeImages, activeImageIndex, setActiveImageIndex]);

  const followUpResponsesByQuestion = useMemo(() => {
    const map = new Map<string, { id: string; questionNumber: string; content: string }>();
    if (!chatMessages || chatMessages.length === 0) return map;

    const extractAllBaseQsFromText = (txt: string): string[] => {
      if (!txt) return [];
      const matches = Array.from(txt.matchAll(/\b(?:questions?|q)\s*(\d+)(?:[a-z]|\([a-z0-9]+\)|\.\d+)*/gi));
      const list: string[] = [];
      const seen = new Set<string>();
      for (const m of matches) {
        const base = String(m[1] || '').replace(/^0+(?=\d)/, '').trim();
        if (base && !seen.has(base)) {
          seen.add(base);
          list.push(base);
        }
      }
      return list;
    };

    const sliceContentForQuestion = (fullText: string, targetBaseQ: string, totalQuestionsInMsg: number): string => {
      if (totalQuestionsInMsg <= 1) return fullText;
      const lines = fullText.split('\n');
      const sectionStarts: Array<{ lineIdx: number; baseQ: string }> = [];

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx].trim();
        // Match markdown headings or bold section headers like "### **Question 1(c)**", "## Question 3a", "**Question 1(c)**"
        const hMatch = line.match(/^(?:#{1,4}\s*|\*\*)\s*(?:\*\*)?\s*(?:Question|Q)\s*(\d+)(?:[a-z]|\([a-z0-9]+\)|\.\d+)*(?:\*\*)?(?:\s*[:\-—]|\s*$)/i);
        if (hMatch && hMatch[1]) {
          const bQ = String(hMatch[1]).replace(/^0+(?=\d)/, '').trim();
          sectionStarts.push({ lineIdx: idx, baseQ: bQ });
        }
      }

      if (sectionStarts.length < 2) return fullText;
      const matchingSections: string[] = [];
      for (let s = 0; s < sectionStarts.length; s++) {
        if (sectionStarts[s].baseQ.toLowerCase() === targetBaseQ.toLowerCase()) {
          const startLine = sectionStarts[s].lineIdx;
          const endLine = s + 1 < sectionStarts.length ? sectionStarts[s + 1].lineIdx : lines.length;
          // Trim trailing horizontal rule (`---`) if it belongs to the separator before the next question section
          const sliceLines = lines.slice(startLine, endLine);
          while (sliceLines.length > 0 && /^(?:---+|\*\*\*+|___+|\s*)$/.test(sliceLines[sliceLines.length - 1].trim())) {
            sliceLines.pop();
          }
          const sectionText = sliceLines.join('\n').trim();
          if (sectionText) matchingSections.push(sectionText);
        }
      }

      if (matchingSections.length > 0) {
        return matchingSections.join('\n\n---\n\n');
      }
      return fullText;
    };

    for (let i = 0; i < chatMessages.length; i++) {
      const msg = chatMessages[i] as any;
      if (
        msg.role === 'assistant' &&
        !msg.markingContext &&
        msg.type !== 'marking_annotated' &&
        !msg.performanceSummary &&
        !msg.studentScore
      ) {
        const rawContentStr = ensureStringContent(msg.content).trim();
        if (!rawContentStr) continue;
        // Strip any stray [SHOW_WORK_Q:X] tags from display content
        const contentStr = rawContentStr.replace(/\s*\[SHOW_WORK_Q:\s*\d+\]/gi, '').trim();
        const prevUser = i > 0 && chatMessages[i - 1]?.role === 'user' ? (chatMessages[i - 1] as any) : null;
        const userQs = extractAllBaseQsFromText(ensureStringContent(prevUser?.content || ''));
        const contentQs = extractAllBaseQsFromText(contentStr);

        const candidateQs = new Set<string>();
        userQs.forEach(q => candidateQs.add(String(q).toLowerCase()));
        if (msg.contextQuestionId) candidateQs.add(String(msg.contextQuestionId).replace(/^0+(?=\d)/, '').toLowerCase());
        if (prevUser?.contextQuestionId) candidateQs.add(String(prevUser.contextQuestionId).replace(/^0+(?=\d)/, '').toLowerCase());
        if (candidateQs.size === 0) {
          contentQs.forEach(q => candidateQs.add(String(q).toLowerCase()));
        } else {
          // Also include any question with an explicit section heading in the AI reply
          contentQs.forEach(q => candidateQs.add(String(q).toLowerCase()));
        }

        const allMatchedKeys = Array.from(candidateQs).filter(Boolean);
        for (const key of allMatchedKeys) {
          const slicedContent = sliceContentForQuestion(contentStr, key, allMatchedKeys.length);
          map.set(key, {
            id: `${String(msg.id || i)}-q${key}`,
            questionNumber: key,
            content: slicedContent
          });
        }
      }
    }
    return map;
  }, [chatMessages, ensureStringContent]);

  const activeQuestionFollowUpResponse = useMemo(() => {
    const activeQ = activeQuestionMeta?.questionNumber || activeQuestionId;
    if (activeQ) {
      const matched = followUpResponsesByQuestion.get(String(activeQ).toLowerCase());
      if (matched) return matched;
    }
    return null;
  }, [activeQuestionMeta, activeQuestionId, followUpResponsesByQuestion]);

  const hasExplanationForActiveQuestion = Boolean(activeQuestionFollowUpResponse);

  const handleFocusExistingExplanation = useCallback((questionNumber: string) => {
    if (!questionNumber) return;
    const normalizedQ = String(questionNumber).toLowerCase();
    const match = groupedQuestions.find(g => String(g.questionNumber).toLowerCase() === normalizedQ);
    const imgIdx = match ? match.sourceImageIndex : (activeImageIndex || 0);
    navigateToQuestion(questionNumber, imgIdx, 'image');
  }, [groupedQuestions, activeImageIndex, navigateToQuestion]);

  // Common Chat Content Render Function to reuse in both modes
  const renderChatContent = () => {
    let displayedMessages: UnifiedMessage[] = (chatMessages || []) as UnifiedMessage[];

    // Apply context filter if active
    if (isContextFilterActive && activeQuestionId) {
      displayedMessages = displayedMessages.filter((msg: UnifiedMessage) =>
        String(msg.contextQuestionId) === String(activeQuestionId) ||
        msg.role === 'system' ||
        (msg as any).markingContext
      );
    }

    const hasMessages = displayedMessages.length > 0;

    return (
      <div className="chat-panel-layout">
        <div className="marking-header-unified">
          {currentSession && (
            <SessionManagement key={currentSession.id} />
          )}

          {/* 🛡️ HIDE RIBBON IN QUESTION MODE: Added !isQuestionMode to the condition */}
          {!isModelAnswerMode && !isMarkingSchemeMode && !isQuestionMode && (
            <div className="marking-header-ribbon-row">
              <div className="ribbon-wrapper-full-width">
                {/* Sticky Ribbon Navigator for Chat Mode */}
                {renderQuestionRibbon(true)}
              </div>

              {ribbonSessionImages.length > 0 && (() => {
                const activeGroup = activeQuestionId
                  ? groupedQuestions.find(g => String(g.questionNumber) === String(activeQuestionId))
                  : null;
                const rawTargetIdx = activeGroup
                  ? (activeGroup.allImageIndices?.[0] ?? 0)
                  : 0;
                const targetIdx = Math.max(0, Math.min(rawTargetIdx, ribbonSessionImages.length - 1));
                const startIdx = ribbonSessionImages.length <= 3
                  ? 0
                  : Math.min(Math.max(0, targetIdx - 1), ribbonSessionImages.length - 3);
                const previewImages = ribbonSessionImages.slice(startIdx, startIdx + 3);
                const extraCount = ribbonSessionImages.length - previewImages.length;
                const hasScoredQuestions = groupedQuestions.some(
                  q => q.hasResults && q.awardedMarks !== null && q.totalMarks > 0
                );
                const totalAwarded = groupedQuestions.reduce(
                  (sum, q) => sum + (q.hasResults && q.awardedMarks !== null ? q.awardedMarks : 0),
                  0
                );
                const totalMax = groupedQuestions.reduce(
                  (sum, q) => sum + (q.totalMarks || 0),
                  0
                );
                const messageWithGrade = (currentSession?.messages || chatMessages || []).find(
                  (m: any) => m.grade && m.grade !== 'N/A' && m.grade !== 'Partial Paper'
                );
                const ribbonGrade = (messageWithGrade as any)?.grade as string | undefined;
                const isMarkingCompleted =
                  !isProcessing &&
                  !isAIThinking &&
                  hasScoredQuestions &&
                  totalMax > 0 &&
                  chatMessages.some((m: UnifiedMessage) => m.role === 'assistant' && !m.isProcessing);

                return (
                  <div className="ribbon-thumbnail-stack-wrapper">
                    {hasScoredQuestions && totalMax > 0 && (
                      <span className="ribbon-thumbnail-total-score">
                        <span className="ribbon-thumbnail-total-label">Total:</span>
                        <span className="ribbon-thumbnail-total-value">
                          {totalAwarded}
                          <span className="ribbon-score-slash">/</span>
                          {totalMax}
                        </span>
                        {ribbonGrade && (
                          <>
                            <span className="ribbon-thumbnail-total-sep">·</span>
                            <span className="ribbon-thumbnail-total-label">Grade</span>
                            <span className="ribbon-thumbnail-total-value">{ribbonGrade}</span>
                          </>
                        )}
                      </span>
                    )}
                    <button
                      type="button"
                      className="ribbon-thumbnail-stack-btn"
                      onClick={() => enterSplitModeEnriched(ribbonSessionImages, targetIdx, true)}
                      title={`View marked page ${targetIdx + 1} of ${ribbonSessionImages.length}`}
                      aria-label={`View marked results (${ribbonSessionImages.length} pages)`}
                    >
                      <div className="ribbon-thumbnail-stack">
                        {previewImages.map((img, idx) => (
                          <img
                            key={img.messageId ? `${img.messageId}-${idx}` : idx}
                            src={img.src}
                            alt={`Page ${startIdx + idx + 1}`}
                            className="ribbon-thumbnail-item"
                            style={{ zIndex: previewImages.length - idx }}
                          />
                        ))}
                      </div>
                      {extraCount > 0 && (
                        <span className="ribbon-thumbnail-more">+{extraCount}</span>
                      )}
                      {isMarkingCompleted && (
                        <span className="ribbon-thumbnail-tick-badge" aria-hidden="true">
                          <Check size={9} strokeWidth={3.2} />
                        </span>
                      )}
                    </button>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        <div className="chat-container" ref={setChatContainerRef}>
          {/* Welcome Message or Chat Messages */}
          {!hasMessages ? (
            <div className="focused-app-entry">
              <div className="landing-chat-input-placeholder">
                <FollowUpChatInput
                  selectedModel={selectedModel}
                  onModelChange={onModelChange}
                  isProcessing={isProcessing}
                  onAnalyzeImage={handleImageAnalysis}
                  onFollowUpImage={handleImageAnalysis}
                  onAnalyzeMultiImage={onAnalyzeMultiImage}
                  onFollowUpMultiImage={onFollowUpMultiImage}
                  onSendMessage={onSendMessage}
                  mode="first-time"
                  currentSession={currentSession}
                  contextQuestionId={null}
                  setContextQuestionId={setActiveQuestionId}
                  isNegative={isNegative}
                  isFollowUp={isFollowUp}
                />
              </div>
            </div>
          ) : (
            <div className="chat-messages" key={currentSession?.id || 'empty'}>
              {displayedMessages.map((msg: any) => (
                <ChatMessage
                  key={`${currentSession?.id || 'no-session'}-${msg.id}`}
                  message={msg}
                  onImageLoad={() => {
                    // Only align to a freshly uploaded user message while actively processing/waiting
                    // and before any assistant bubble exists after it. Never hijack scroll on history load.
                    const lastMsg = (chatMessages || [])[(chatMessages || []).length - 1];
                    if ((isProcessing || isAIThinking) && msg.role === 'user' && msg.id === lastMsg?.id) {
                      scrollToMessage(msg.id, { behavior: 'smooth', block: 'start' });
                    }
                  }}
                  getImageSrc={getImageSrc}
                  MarkdownMathRenderer={MarkdownMathRenderer}
                  ensureStringContent={ensureStringContent}
                  scrollToBottom={scrollToBottom}
                  session={currentSession}
                  addMessage={addMessage}
                  startAIThinking={startAIThinking}
                  selectedModel={selectedModel}
                  onEnterSplitMode={enterSplitModeEnriched}
                  onNavigate={navigateToQuestion}
                  isSyncingRef={isSyncingRef}
                />
              ))}
              {/* Bottom spacer with dynamic height */}
              <div
                className="chat-bottom-spacer"
                style={{
                  height: (isProcessing || isAIThinking) ? '60vh' : '250px',
                  flexShrink: 0
                }}
              />
            </div>
          )}
        </div>

        <div className={`scroll-to-bottom-container ${(showScrollButton || hasNewResponse) && hasMessages ? 'show' : 'hidden'}`}>
          <button
            className={`scroll-to-bottom-btn ${hasNewResponse ? 'new-response-btn' : ''}`}
            onClick={hasNewResponse ? scrollToNewResponse : scrollToBottom}
          >
            {hasNewResponse ? (
              <div className="new-response-icon"><span>New</span><ChevronDown size={16} /></div>
            ) : (
              <ChevronDown size={20} />
            )}
          </button>
        </div>

        {isFollowUp && (
          <div className="follow-up-chat-input-container follow-up-bottom">
            <FollowUpChatInput
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              isProcessing={isProcessing}
              onAnalyzeImage={handleImageAnalysis}
              onFollowUpImage={handleImageAnalysis}
              onAnalyzeMultiImage={onAnalyzeMultiImage}
              onFollowUpMultiImage={onFollowUpMultiImage}
              onSendMessage={onSendMessage}
              mode="follow-up"
              currentSession={currentSession}
              contextQuestionId={activeQuestionId}
              setContextQuestionId={setActiveQuestionId}
              isNegative={isNegative}
              isFollowUp={isFollowUp}
            />
          </div>
        )}
      </div>
    );
  };

  // Responsive mobile media query listener
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width: 768px)').matches
      : typeof window !== 'undefined' && window.innerWidth <= 768
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(max-width: 768px)');
    const handleMediaChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches);
    };
    handleMediaChange(mql);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleMediaChange);
      return () => mql.removeEventListener('change', handleMediaChange);
    } else {
      mql.addListener(handleMediaChange);
      return () => mql.removeListener(handleMediaChange);
    }
  }, []);

  const hasImages = splitModeImages && splitModeImages.length > 0;
  
  // 1. Lift Question Mode evaluation
  const sessionMode = (currentSession?.mode || '').toLowerCase();
  const hasQuestionResponseType = (chatMessages || []).some((m: any) => m.type === 'question_response');
  
  const isQuestionMode = sessionMode === 'question' || 
                         sessionMode === 'question mode' ||
                         hasQuestionResponseType;

  // 2. Split view condition: show split view when images are open, on desktop, and not in Question Mode
  // Note: Do NOT block/close split view during active processing/AI thinking so follow-up actions keep the image panel stably open
  const showSplitView = hasImages && !isMobile && !isQuestionMode;

  const layoutClass = `mark-homework-page ${isFollowUp ? 'chat-mode follow-up-mode' : 'initial-mode'} ${showSplitView ? 'split-mode' : ''}`;

  return (
    <div className={layoutClass}>
      <SEO
        title={!isFollowUp ? "Instant GCSE Maths Marking" : currentSession?.title || "Session"}
        schemaData={!isFollowUp ? productSchema : undefined}
        noIndex={noIndex}
      />
      {showSplitView ? (
        <div className="split-view-container">
          <div className="split-chat-panel">
            {renderChatContent()}
          </div>
          <div className="split-canvas-panel">
            <ImageViewer
              key={currentSession?.id || 'viewer'}
              images={enrichedSplitModeImages || []}
              initialImageIndex={activeImageIndex || 0}
              onClose={exitSplitMode}
              isOpen={true}
              onImageChange={handleImageChange}
              lostMarkPageIndices={lostMarkPageIndices}
              activeQuestionMeta={activeQuestionMeta}
              isMobile={false}
              onSendFollowUpMessage={!isQuestionMode ? handleViewerSendFollowUp : undefined}
              isProcessingFollowUp={isProcessing || isAIThinking}
              latestFollowUpResponse={activeQuestionFollowUpResponse}
              hasExplanationForActiveQuestion={hasExplanationForActiveQuestion}
              onFocusExistingExplanation={handleFocusExistingExplanation}
              MarkdownRenderer={MarkdownMathRenderer}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="mark-homework-main-content">
            {renderChatContent()}
          </div>
          {(isMobile || isQuestionMode) && hasImages && (
            <div className="mobile-image-viewer-overlay">
              <ImageViewer
                key={currentSession?.id || 'viewer-mobile'}
                images={enrichedSplitModeImages || []}
                initialImageIndex={activeImageIndex || 0}
                onClose={exitSplitMode}
                isOpen={true}
                onImageChange={handleImageChange}
                lostMarkPageIndices={lostMarkPageIndices}
                activeQuestionMeta={activeQuestionMeta}
                isMobile={isMobile}
                onSendFollowUpMessage={!isQuestionMode ? handleViewerSendFollowUp : undefined}
                isProcessingFollowUp={isProcessing || isAIThinking}
                latestFollowUpResponse={activeQuestionFollowUpResponse}
                hasExplanationForActiveQuestion={hasExplanationForActiveQuestion}
                onFocusExistingExplanation={handleFocusExistingExplanation}
                MarkdownRenderer={MarkdownMathRenderer}
              />
            </div>
          )}
        </>
      )}
      
      {isGuest && (chatMessages || []).length > 0 && guestLimitInfo?.usageLimit > 0 && (
        <div className="guest-mode-floating-banner">
          <span className="guest-banner-text">
            🔒 Viewing {Math.max(0, guestLimitInfo.usageLimit - (guestLimitInfo.usageCount || 0))} free answers
          </span>
          <button className="guest-banner-btn" onClick={() => {
            import('../../utils/eventManager').then(({ default: EventManager, EVENT_TYPES }) => {
              EventManager.dispatch(EVENT_TYPES.OPEN_AUTH_MODAL, { mode: 'signup' });
            });
          }}>
            Create Free Account
          </button>
        </div>
      )}
    </div>
  );
};

export default MainLayout;
