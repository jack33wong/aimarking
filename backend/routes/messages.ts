/**
 * Messages API Routes - UnifiedMessage System
 * Single source of truth for all chat, marking, and question data
 */

import express from 'express';
import { FirestoreService } from '../services/firestoreService.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { MarkingServiceLocator } from '../services/marking/MarkingServiceLocator.js';
import { createUserMessage, createAIMessage, createChatProgressData, handleAIMessageIdForEndpoint } from '../utils/messageUtils.js';
import { ProgressTracker, getStepsForMode } from '../utils/progressTracker.js';
import type { UnifiedMessage, QuestionPart } from '../types/index.js';
import { isValidSuggestedFollowUpMode as isFollowUpMode } from '../config/suggestedFollowUpConfig.js';
import { checkCredits, deductCredits } from '../services/creditService.js';
import UsageTracker from '../utils/UsageTracker.js';
import { GuestUsageService } from '../services/guestUsageService.js';
import SubscriptionService from '../services/subscriptionService.js';
import { getFirebaseAuth, getFirestore, getUserRole } from '../config/firebase.js';
import { AdminAlertService, type SessionDigestUploadedFile } from '../services/AdminAlertService.js';
import { runWithLogCapture, type CapturedLogResult } from '../utils/RequestLogCapture.js';

const router = express.Router();

/**
 * Format "Your Work" section from marking context using clean nested structure
 */
function formatYourWorkSection(parts: QuestionPart[], questionNumber: string): string {
  if (!parts || parts.length === 0) return '';

  // Helper to ensure LaTeX has proper backslashes and formatting
  const fixLatexAndMath = (text: string): string => {
    if (!text) return '';

    // 1. Restore missing backslashes for common OCR commands
    let fixed = text
      .replace(/(?<!\\)frac\s*{/g, '\\frac{')
      .replace(/(?<!\\)sqrt\s*{/g, '\\sqrt{')
      .replace(/(?<!\\)times(\s|$)/g, '\\times$1')
      .replace(/(?<!\\)div(\s|$)/g, '\\div$1')
      .replace(/(?<!\\)degree/g, '\\degree')
      .replace(/(?<!\\)pm/g, '\\pm');

    // 2. Wrap in $ if it contains LaTeX commands and is NOT already wrapped
    // We check for \ (backslash), ^ (superscript), or _ (subscript)
    const hasLatex = /[\\^_{}]/.test(fixed);
    const isWrapped = fixed.trim().startsWith('$') && fixed.trim().endsWith('$');

    if (hasLatex && !isWrapped) {
      // Proactively wrap in math delimiters for the frontend renderer
      return `$${fixed.trim()}$`;
    }

    // 3. Simple text-based cleanup if no LaTeX
    return fixed
      .replace(/\\times/g, '×')
      .replace(/\\div/g, '÷')
      .replace(/\^{([^}]+)}/g, '<sup>$1</sup>')
      .replace(/\^(\d)/g, '<sup>$1</sup>')
      .replace(/_{([^}]+)}/g, '<sub>$1</sub>')
      .replace(/_(\d)/g, '<sub>$1</sub>');
  };

  let output = `:::your-work\n`;
  output += `YOUR WORK:\n`;

  output += `${questionNumber}\n`;

  parts.forEach((part) => {
    part.marks.forEach((mark, markIdx) => {
      const cleanWork = mark.work ? fixLatexAndMath(mark.work) : '';

      // First mark of a part (a, b...) gets the label
      // FIX: Don't repeat the question number if the part is exactly the question number (for single part questions)
      const isSinglePartHeader = part.part === questionNumber || !part.part;
      const partLabel = (markIdx === 0 && part.part && !isSinglePartHeader) ? `${part.part}) ` : '';

      // Alignment padding: if we don't have a part label (subsequent marks), we must pad its space
      const partPadding = (markIdx > 0 && part.part) ? ' '.repeat(part.part.length + 2) : '';

      output += `${partLabel}${partPadding}${cleanWork} -- ${mark.code} - ${mark.reasoning}\n`;
    });
  });

  output += `:::\n\n`;
  return output;
}


export function formatYourWork(
  markingContext: any,
  questionNumber: string
): string {
  if (!markingContext || !markingContext.questionResults) {
    return '';
  }

  // Find question result
  const questionResult = markingContext.questionResults.find(
    (q: any) => String(q.number) === String(questionNumber)
  );

  if (!questionResult || !questionResult.parts || questionResult.parts.length === 0) {
    return '';
  }

  return formatYourWorkSection(questionResult.parts, questionNumber);
}


/**
 * POST /messages/chat
 * Unified chat endpoint - handles conversational flow with session management
 * Supports both authenticated and anonymous users
 */
router.post('/chat', optionalAuth, async (req, res) => {
  try {
    const chatUserId = req.user?.uid;
    if (chatUserId) {
      AdminAlertService.markUserActive(chatUserId);
    }

    const {
      message,
      imageData,
      model = 'auto',
      sessionId,
      mode,
      aiMessageId,
      sourceMessageId,
      contextQuestionId,
      messageId // Extract user message ID if provided
    } = req.body;

    // Instantiate UsageTracker for this request
    const usageTracker = new UsageTracker();

    // Resolve tier aliases ('auto', 'fast', 'thinking', etc.) to the canonical Gemini model ID
    const { resolveModelTier } = await import('../config/aiModels.js');
    const resolvedModel = resolveModelTier(model || 'auto');

    // Use authenticated user ID or anonymous
    const userId = req.user?.uid || 'anonymous';
    const isAuthenticated = !!req.user?.uid;
    const userIP = req.ip || '0.0.0.0';

    console.log(`[CHAT DEBUG] Message: "${message?.substring(0, 50) || ''}...", Mode: ${mode}, Session: ${sessionId}`);

    // 🛑 THE GUARD: Anti-Ghost Strategy
    // Prevent initializing chat with temporary or incomplete marking sessions
    if (sessionId) {
      if (sessionId.startsWith('temp-')) {
        console.warn(`⚠️ [CHAT] Rejected temp- session: ${sessionId}`);
        return res.status(400).json({ success: false, error: "Session not ready or invalid." });
      }
      if (sessionId.startsWith('sub-') && isAuthenticated) {
        const sessionExists = await FirestoreService.getUnifiedSession(sessionId);
        if (!sessionExists) {
          console.warn(`⚠️ [CHAT] Rejected non-existent sub- session: ${sessionId}`);
          return res.status(400).json({ success: false, error: "Marking session not ready or invalid." });
        }
      }
    }

    // --- NEW: Guest Usage Limit Check ---
    if (!isAuthenticated) {
      const { GuestUsageService } = await import('../services/guestUsageService.js');
      const limitInfo = await GuestUsageService.checkLimit(userIP);
      if (!limitInfo.allowed) {
        return res.status(403).json({
          success: false,
          error: 'Guest limit reached',
          limit_reached: true,
          remaining: 0
        });
      }
    }

    // Validate required fields - allow empty message if imageData is provided
    if ((!message || typeof message !== 'string') && !imageData) {
      return res.status(400).json({
        success: false,
        error: 'Message or image data is required'
      });
    }

    // Upload image to Firebase Storage if imageData is provided
    let imageLink = null;
    if (imageData && isAuthenticated) {
      try {
        const { ImageStorageService } = await import('../services/imageStorageService');
        imageLink = await ImageStorageService.uploadImage(
          imageData,
          userId,
          sessionId || `temp-${Date.now()}`,
          'original'
        );
      } catch (error) {
        console.error('❌ Failed to upload follow-up image:', error);
        // Continue without imageLink for unauthenticated users
      }
    }

    let currentSessionId = sessionId;
    let sessionTitle = 'Chat Session';

    // Create user message using factory (only for authenticated users)
    let userMessage = null;
    if (isAuthenticated) {
      userMessage = createUserMessage({
        messageId: messageId, // Use the ID from the frontend to ensure consistency (matches field in UserMessageOptions)
        content: message || (imageData ? 'Image uploaded' : ''),
        imageLink: imageLink, // Only for authenticated users
        imageData: imageData, // For both authenticated and unauthenticated users
        sessionId: sessionId,
        model: model,
        contextQuestionId: contextQuestionId
      });

    }

    // Session management - use provided sessionId or create new one
    if (!currentSessionId) {
      // Create a real session in unifiedSessions for authenticated users only

      if (isAuthenticated) {
        const newSessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        // Create session with user message - both frontend and backend need it
        currentSessionId = await FirestoreService.createUnifiedSessionWithMessages({
          sessionId: newSessionId,
          title: sessionTitle,
          userId: userId,
          messageType: 'Chat',
          messages: [userMessage], // Include user message in database
          usageMode: 'chat'
        });
      } else {
        // For anonymous users, use provided sessionId or create a permanent one
        currentSessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }
    }

    // Check credits before processing (skip for anonymous users)
    let creditWarning: string | undefined;
    if (isAuthenticated && userId !== 'anonymous') {
      try {
        // Estimate cost based on message length and image size
        const estimatedCost = ((imageData ? imageData.length / 1000 : 0) + (message?.length || 0) / 100) * 0.001;
        const userPlan = (req as any).userPlan;
        const creditCheck = await checkCredits(userId, estimatedCost, userPlan);
        creditWarning = creditCheck.warning;

        if (!creditCheck.canProceed) {
          return res.status(403).json({
            success: false,
            error: creditCheck.warning,
            credits_exhausted: true,
            remaining: creditCheck.remaining
          });
        }

        if (creditWarning) {
          console.log(`💳 Credit warning for user ${userId}: ${creditWarning}`);
        }
      } catch (error) {
        console.error('❌ Credit check failed:', error);
      }
    }

    // Generate AI response using real AI service
    let aiResponse: string;
    let apiUsed = 'Unknown API';
    let finalProgressData: any = null;
    let contextualResult: any = null;
    let contextSummary: string | undefined = undefined; // Declare at function scope
    let pendingPreMarkingState: {
      requiresMarkingScheme: boolean;
      canStartMarkingFromPreCheck: boolean;
      detectedSubjectName?: string;
      paperCodeHint?: string;
      uploadedPageCount?: number;
      handwrittenPageCount?: number;
    } | undefined = undefined;
    const startTime = Date.now();

    // Auto-resolve follow-up mode from message text if mode is missing or 'chat'
    let followUpMode = mode;
    if (!followUpMode || followUpMode === 'chat') {
      const lower = typeof message === 'string' ? message.toLowerCase() : '';
      if (lower.includes('similar') && lower.includes('practice')) {
        followUpMode = 'similarquestions';
      } else if (lower.includes('model answer')) {
        followUpMode = 'model-answer';
      } else if (lower.includes('marking scheme') || lower.includes('show marking scheme')) {
        followUpMode = 'marking-scheme';
      }
    }

    let capturedChatLogs: CapturedLogResult | null = null;
    try {
      await runWithLogCapture(
        `chat-${currentSessionId || Date.now()}`,
        async () => {
          if (process.env.LOG_AI_MARKING_USER_PROMPT === 'true') {
            console.log('\n💬 [CHAT-INPUT] FULL STUDENT INPUT:');
            console.log(`Mode: ${followUpMode || mode || 'chat'} | Session: ${currentSessionId} | ContextQ: ${contextQuestionId || 'all'}`);
            console.log(message || (imageData ? '[Image uploaded without text]' : '[Empty]'));
            console.log('------------------------------------------------------------------');
          }

          if (imageData) {
        // For messages with images, use image-aware chat response
        // Note: passing usageTracker as the 8th argument
        const aiResult = await MarkingServiceLocator.generateChatResponse(
          imageData,
          message,
          resolvedModel as any,
          "questionAnswer",
          false,         // debug
          undefined,     // onProgress
          false,         // useOcrText
          usageTracker   // tracker
        );
        aiResponse = aiResult.response;
        apiUsed = aiResult.apiUsed;
        contextualResult = aiResult; // Store for processing stats
      } else if (isFollowUpMode(followUpMode)) {
        // Handle all follow-up requests using the centralized service
        const { SuggestedFollowUpService } = await import('../services/marking/suggestedFollowUpService.js');

        const followUpResult = await SuggestedFollowUpService.handleSuggestedFollowUp({
          mode: followUpMode,
          sessionId: currentSessionId,
          sourceMessageId,
          model: resolvedModel,
          detectedQuestion: req.body.detectedQuestion, // Pass detectedQuestion from request (for unauthenticated users)
          tracker: usageTracker, // NEW: pass tracker for usage stats
          contextQuestionId: contextQuestionId // Pass contextQuestionId so it only generates for the specific question if requested
        });

        aiResponse = followUpResult.response;
        apiUsed = followUpResult.apiUsed;
        finalProgressData = followUpResult.progressData;
        // Store usageTokens for processingStats
        contextualResult = {
          response: followUpResult.response,
          apiUsed: followUpResult.apiUsed,
          usageTokens: followUpResult.usageTokens || 0,
          inputTokens: usageTracker.getTotalInputOutput().inputTokens,
          outputTokens: usageTracker.getTotalInputOutput().outputTokens
        };
      } else {
        // For text-only messages, use contextual response with progress tracking

        const progressTracker = new ProgressTracker(getStepsForMode('text'), (data) => {
          finalProgressData = data;
        });

        // Start with AI thinking step
        progressTracker.startStep('ai_thinking');

        // First get existing session messages for context
        let chatHistory: any[] = [];
        contextSummary = undefined; // Reset for this block
        let resolvedSubjectProfile: any = undefined;

        if (currentSessionId && isAuthenticated) {
          try {
            const existingSession = await FirestoreService.getUnifiedSession(currentSessionId);
            if (existingSession?.messages) {
              const { ChatContextBuilder } = await import('../services/marking/ChatContextBuilder.js');
              const { resolveSubjectProfile } = await import('../config/subjectProfiles.js');

              // INJECT: Find rich marking context from the assistant's marking result
              const lastMarkingMessage = [...existingSession.messages].reverse().find(msg => (msg as any).markingContext);
              const hasActiveMarkingContext = Boolean(lastMarkingMessage && (lastMarkingMessage as any).markingContext);

              // Extract any question numbers explicitly mentioned in the student's message (e.g. "Why did I lose marks on Question 1c and Question 3a?" -> ["1", "3"])
              const referencedQuestionIds = hasActiveMarkingContext
                ? ChatContextBuilder.extractReferencedQuestionNumbers(message)
                : [];
              const targetContextQuestionIds = hasActiveMarkingContext
                ? (referencedQuestionIds.length > 0
                    ? Array.from(new Set([...referencedQuestionIds, ...(contextQuestionId ? [String(contextQuestionId)] : [])]))
                    : (contextQuestionId ? [String(contextQuestionId)] : []))
                : [];

              // Only filter chatHistory by contextQuestionId when the session actually has graded question results
              // matching that question — and NEVER filter out upload/error/requiresMarkingScheme messages!
              const effectiveContextQuestionId = targetContextQuestionIds.length === 1
                ? targetContextQuestionIds[0]
                : (targetContextQuestionIds.length > 1 ? targetContextQuestionIds[0] : undefined);

              chatHistory = existingSession.messages
                .filter(msg => {
                  if (targetContextQuestionIds.length === 0) return true;
                  const isUploadOrSystemEvent =
                    msg.role === 'system' ||
                    Boolean((msg as any).markingContext) ||
                    Boolean((msg as any).requiresMarkingScheme) ||
                    Boolean((msg as any).errorCode) ||
                    Boolean((msg as any).canMarkAnyway) ||
                    Boolean((msg as any).canRetryUpload) ||
                    (Array.isArray((msg as any).pdfContexts) && (msg as any).pdfContexts.length > 0) ||
                    Boolean((msg as any).originalFileName);
                  return targetContextQuestionIds.includes(String((msg as any).contextQuestionId)) || isUploadOrSystemEvent;
                })
                .map(msg => {
                  let content = msg.content;
                  // If we have a specific context, and this message is the "all questions" marking context,
                  // truncate it to just a placeholder to prevent AI from seeing details of OTHER questions.
                  if (targetContextQuestionIds.length > 0 && (msg as any).markingContext && !msg.role.startsWith('user')) {
                    content = `[Marking report for all questions - Follow specific context prompt for Question ${targetContextQuestionIds.join(', ')} details]`;
                  }
                  return {
                    role: msg.role,
                    content: content
                  };
                });

              const {
                inventoryPrompt,
                detectedSubjectHint,
                paperCodeHint,
                pendingPreMarkingState: detectedPendingState
              } = ChatContextBuilder.formatSessionUploadInventory(existingSession.messages);
              pendingPreMarkingState = detectedPendingState;

              if (lastMarkingMessage && (lastMarkingMessage as any).markingContext) {
                const markingContext = (lastMarkingMessage as any).markingContext;

                // Populate followUpHistory from the recent chat history
                // We pair User -> Assistant messages to create coherent history entries
                const followUpHistory = [];
                const msgs = existingSession.messages;

                for (let i = 0; i < msgs.length - 1; i++) {
                  if (msgs[i].role === 'user' && msgs[i + 1]?.role === 'assistant') {
                    // Always include upload/error/requiresMarkingScheme turns OR turns matching targetContextQuestionIds
                    const isImportantTurn =
                      Boolean((msgs[i + 1] as any).requiresMarkingScheme) ||
                      Boolean((msgs[i + 1] as any).errorCode) ||
                      Boolean((msgs[i + 1] as any).canMarkAnyway) ||
                      Boolean((msgs[i + 1] as any).canRetryUpload);
                    if (
                      targetContextQuestionIds.length === 0 ||
                      targetContextQuestionIds.includes(String((msgs[i] as any).contextQuestionId)) ||
                      isImportantTurn
                    ) {
                      followUpHistory.push({
                        userMessage: msgs[i].content,
                        aiResponse: msgs[i + 1].content,
                        timestamp: Date.parse(msgs[i].timestamp || new Date().toISOString())
                      });
                    }
                  }
                }

                // Update the context object (in memory only) with recent history
                markingContext.followUpHistory = followUpHistory;

                // Generate the full prompt including upload inventory + marking details + history
                const promptContextSelector = targetContextQuestionIds.length > 1
                  ? targetContextQuestionIds
                  : effectiveContextQuestionId;
                const formattedMarkingContext = ChatContextBuilder.formatContextAsPrompt(markingContext, promptContextSelector);
                contextSummary = inventoryPrompt
                  ? `${inventoryPrompt}${formattedMarkingContext}`
                  : formattedMarkingContext;
                resolvedSubjectProfile = ChatContextBuilder.resolveSubjectProfile(markingContext, promptContextSelector);

                // Update progress tracker to indicate context mode
                progressTracker.updateStepDescription('generating_response', 'Thinking with marking context...');
              } else if (inventoryPrompt) {
                // Session has uploaded file(s) awaiting a mark scheme or stopped by a validation/system error
                const recentChatLines = chatHistory
                  .slice(-6)
                  .map(item => `${item.role}: ${item.content}`)
                  .join('\n');
                contextSummary = recentChatLines
                  ? `${inventoryPrompt}## Recent Conversation History\n${recentChatLines}`
                  : inventoryPrompt;
                if (detectedSubjectHint || paperCodeHint) {
                  resolvedSubjectProfile = resolveSubjectProfile({
                    subject: detectedSubjectHint,
                    paperCode: paperCodeHint
                  });
                }
              }
            }
          } catch (error) {
            console.error('Failed to load chat/marking context from DB:', error);
          }
        }

        // --- NEW: Context Chat Support for Guests ---
        // If the frontend provided markingContext (since it's not in DB for guests), use it
        if (!contextSummary && !isAuthenticated && req.body.markingContext) {
          try {
            const { ChatContextBuilder } = await import('../services/marking/ChatContextBuilder.js');
            const guestRefIds = ChatContextBuilder.extractReferencedQuestionNumbers(message);
            const guestContextSelector = guestRefIds.length > 0
              ? Array.from(new Set([...guestRefIds, ...(contextQuestionId ? [String(contextQuestionId)] : [])]))
              : contextQuestionId;
            contextSummary = ChatContextBuilder.formatContextAsPrompt(req.body.markingContext, guestContextSelector);
            resolvedSubjectProfile = ChatContextBuilder.resolveSubjectProfile(req.body.markingContext, guestContextSelector);

            if (progressTracker) {
              progressTracker.updateStepDescription('generating_response', 'Thinking with provided context...');
            }
          } catch (error) {
            console.error('Failed to build context from provided data:', error);
          }
        }

        // Complete AI thinking step and start generating response step
        progressTracker.completeCurrentStep();
        progressTracker.startStep('generating_response');

        // Simulate processing time for "Generating response..." step
        await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 seconds

        contextualResult = await MarkingServiceLocator.generateContextualResponse(
          message,  // user's message text
          chatHistory,  // chat history for context (fallback if contextSummary used, or ignored)
          resolvedModel,
          contextSummary, // Pass the rich context summary
          usageTracker,    // Pass usage tracker
          mode || 'chat', // Pass mode for persona weighting
          resolvedSubjectProfile // Pass resolved SubjectProfile for subject-aware follow-up prompt
        );
        aiResponse = contextualResult.response;
        apiUsed = contextualResult.apiUsed;

        // Complete generating response step
        progressTracker.completeCurrentStep();
        progressTracker.finish();
      }
        },
        (captured) => {
          capturedChatLogs = captured;
        }
      );
    } catch (error) {
      console.error('❌ AI service failed:', error);
      if (capturedChatLogs) {
        const errLogs = capturedChatLogs as CapturedLogResult;
        AdminAlertService.recordSessionTurn({
          sessionId: currentSessionId,
          turnType: 'FOLLOW_UP_CHAT',
          userId: isAuthenticated ? userId : `guest:${userIP}`,
          userEmail: req.user?.email,
          userAgent: (typeof req.get === 'function' ? req.get('user-agent') : req.headers?.['user-agent']) || undefined,
          model: resolvedModel,
          error,
          userInput: message || (imageData ? '[Image uploaded]' : ''),
          uploadedFiles: imageLink ? [{ filename: 'follow-up-image.jpg', url: imageLink }] : [],
          ...errLogs,
        });
      }
      throw error;
    }

    // Prepend "Your Work" section if applicable and strip all [SHOW_WORK_Q: X] tags cleanly
    let finalResponse = aiResponse;
    const showWorkQuestionNumbers: string[] = [];
    if (aiResponse) {
      const allShowWorkMatches = Array.from(aiResponse.matchAll(/\[SHOW_WORK_Q:\s*(\d+)\]/gi));
      for (const m of allShowWorkMatches) {
        const qNum = String(m[1] || '').trim();
        if (qNum && !showWorkQuestionNumbers.includes(qNum)) {
          showWorkQuestionNumbers.push(qNum);
        }
      }
      if (allShowWorkMatches.length > 0) {
        aiResponse = aiResponse.replace(/\s*\[SHOW_WORK_Q:\s*\d+\]/gi, '').trim();
        finalResponse = aiResponse;
      }
    }

    if (aiResponse && contextSummary && showWorkQuestionNumbers.length > 0) {
      const questionNumber = showWorkQuestionNumbers[0];

      // Get marking context from last marking message or request
      const currentMarkingContext = !isAuthenticated && req.body.markingContext ? req.body.markingContext : null;

      let lastMarkingMsg = null;
      if (isAuthenticated) {
        const existingSession = await FirestoreService.getUnifiedSession(currentSessionId);
        lastMarkingMsg = [...(existingSession?.messages || [])].reverse().find(m => (m as any).markingContext);
      }

      const markingContextToUse = currentMarkingContext || (lastMarkingMsg ? (lastMarkingMsg as any).markingContext : null);

      if (markingContextToUse) {
        const yourWorkSection = showWorkQuestionNumbers
          .map(qNum => formatYourWork(markingContextToUse, qNum))
          .filter(Boolean)
          .join('\n');

        // Check if AI response already contains :::your-work (prevent duplicates)
        if (yourWorkSection && !aiResponse.includes(':::your-work')) {
          // Find where to insert Your Work section (after first paragraph/question header)
          // Look for first double newline which usually separates header from content
          const firstParagraphEnd = aiResponse.indexOf('\n\n');

          if (firstParagraphEnd !== -1) {
            // Insert Your Work right after the question header paragraph
            const beforeYourWork = aiResponse.substring(0, firstParagraphEnd + 2);
            const afterYourWork = aiResponse.substring(firstParagraphEnd + 2);
            finalResponse = beforeYourWork + yourWorkSection + '\n' + afterYourWork;
          } else {
            // Fallback: prepend if no double newline found
            finalResponse = yourWorkSection + '\n' + aiResponse;
          }
        } else if (aiResponse.includes(':::your-work')) {
          finalResponse = aiResponse; // Use AI response as-is
        }
      }
    }

    // --- Two-Prompt Bridge for Diagrams in Follow-Up Chat Mode ---
    if (finalResponse && !isFollowUpMode(followUpMode)) {
      const { DiagramBridgeService } = await import('../services/diagram/DiagramBridgeService.js');
      finalResponse = await DiagramBridgeService.processDiagramHints(
        finalResponse,
        resolvedModel,
        usageTracker,
        'FOLLOW-UP-CHAT'
      );
    }

    // Create AI message using factory
    const resolvedAIMessageId = handleAIMessageIdForEndpoint(req.body, aiResponse, 'chat');

    // Use the first extracted [SHOW_WORK_Q: X] question number, or the explicitly provided context ID
    const aiContextQuestionId = showWorkQuestionNumbers[0] || contextQuestionId;

    // --- NEW: Increment Guest Usage ---
    if (!isAuthenticated) {
      const { GuestUsageService } = await import('../services/guestUsageService.js');
      await GuestUsageService.incrementUsage(userIP);
    }

    const aiMessage: any = createAIMessage({
      content: finalResponse, // Use finalResponse here
      messageId: resolvedAIMessageId,
      imageData: !isAuthenticated && imageData ? imageData : undefined, // Include imageData for unauthenticated users
      progressData: finalProgressData || createChatProgressData(false),
      processingStats: {
        modelUsed: resolvedModel,
        imageSize: imageData ? imageData.length : 0,
        apiUsed: apiUsed,
        llmTokens: contextualResult?.usageTokens || 0,
        llmInputTokens: contextualResult?.inputTokens || usageTracker.getTotalInputOutput().inputTokens,
        llmOutputTokens: contextualResult?.outputTokens || usageTracker.getTotalInputOutput().outputTokens,
        mathpixCalls: usageTracker.getMathpixPages() || 0,
        confidence: contextualResult?.confidence || 0,
        annotations: 0,
        totalCost: usageTracker.calculateCost(resolvedModel).total,
        costBreakdown: {
          llmCost: usageTracker.calculateCost(resolvedModel).total - usageTracker.calculateCost(resolvedModel).mathpix,
          mathpixCost: usageTracker.calculateCost(resolvedModel).mathpix
        },
        processingTimeMs: Date.now() - startTime
      },
      contextQuestionId: aiContextQuestionId // Use the detected or passed context
    });

    // Carry forward pre-marking CTA flags onto the latest follow-up reply so the student always sees
    // actionable buttons ([ Attach Marking Scheme ] / [ Mark with AI ] or [ Mark Full Paper ]) right below the AI's reply
    if (pendingPreMarkingState) {
      if (pendingPreMarkingState.requiresMarkingScheme) {
        aiMessage.requiresMarkingScheme = true;
      } else if (pendingPreMarkingState.canStartMarkingFromPreCheck) {
        aiMessage.canStartMarkingFromPreCheck = true;
      }
      if (pendingPreMarkingState.detectedSubjectName) {
        aiMessage.detectedSubjectName = pendingPreMarkingState.detectedSubjectName;
      }
      if (pendingPreMarkingState.paperCodeHint) {
        aiMessage.paperCodeHint = pendingPreMarkingState.paperCodeHint;
      }
      if (pendingPreMarkingState.uploadedPageCount !== undefined) {
        aiMessage.uploadedPageCount = pendingPreMarkingState.uploadedPageCount;
      }
      if (pendingPreMarkingState.handwrittenPageCount !== undefined) {
        aiMessage.handwrittenPageCount = pendingPreMarkingState.handwrittenPageCount;
      }
    }


    // Handle session creation and message storage - only for authenticated users
    if (isAuthenticated) {
      if (!sessionId || sessionId.startsWith('temp-')) {
        // Creating new session - create session with both user and AI messages
        await FirestoreService.createUnifiedSessionWithMessages({
          sessionId: currentSessionId,
          title: sessionTitle,
          userId: userId,
          messageType: 'Chat',
          messages: [userMessage, aiMessage],
          sessionStats: {
            totalProcessingTimeMs: contextualResult?.processingTimeMs || (Date.now() - startTime),
            lastModelUsed: resolvedModel,
            lastApiUsed: apiUsed,
            totalLlmTokens: contextualResult?.usageTokens || usageTracker.getTotalTokens(),
            totalLlmInputTokens: contextualResult?.inputTokens || usageTracker.getTotalInputOutput().inputTokens,
            totalLlmOutputTokens: contextualResult?.outputTokens || usageTracker.getTotalInputOutput().outputTokens,
            totalMathpixCalls: usageTracker.getMathpixPages() || 0,
            totalTokens: usageTracker.getTotalTokens(),
            totalCost: usageTracker.calculateCost(resolvedModel).total,
            costBreakdown: {
              llmCost: usageTracker.calculateCost(resolvedModel).total - usageTracker.calculateCost(resolvedModel).mathpix,
              mathpixCost: usageTracker.calculateCost(resolvedModel).mathpix,
              total: usageTracker.calculateCost(resolvedModel).total
            },
            totalMessages: 2,
            averageConfidence: contextualResult?.confidence || 0,
            imageSize: imageData ? imageData.length : 0,
            totalAnnotations: 0,
            apiRequests: 1 // Initialize API requests count
          },
          usageMode: followUpMode || 'chat'
        });
      } else {
        // Adding to existing session - add both user and AI messages
        // User message needs to be persisted for follow-up messages
        try {
          // Check if session exists before adding messages
          const sessionExists = await FirestoreService.getUnifiedSession(currentSessionId);

          if (sessionExists) {
            await FirestoreService.addMessageToUnifiedSession(currentSessionId, userMessage, followUpMode || 'chat');
            await FirestoreService.addMessageToUnifiedSession(currentSessionId, aiMessage, followUpMode || 'chat');
          } else {
            console.log(`🔍 [CHAT] Session ${currentSessionId} not found in Firestore. Creating new session.`);
            // Create new session if it doesn't exist
            await FirestoreService.createUnifiedSessionWithMessages({
              sessionId: currentSessionId,
              title: sessionTitle || 'Context Chat',
              userId: userId,
              messageType: followUpMode || 'chat',
              messages: [userMessage, aiMessage],
              isPastPaper: false,
              sessionStats: {
                totalTokens: usageTracker.getTotalTokens(),
                totalCost: usageTracker.calculateCost(resolvedModel).total,
                modelUsed: resolvedModel,
                lastModelUsed: resolvedModel,
                totalProcessingTimeMs: Date.now() - startTime,
                apiRequests: 1,
                costBreakdown: await (async () => {
                  try {
                    const cost = usageTracker.calculateCost(resolvedModel);
                    return { llmCost: cost.total - cost.mathpix, mathpixCost: cost.mathpix, total: cost.total };
                  } catch (e) { return { llmCost: 0, mathpixCost: 0, total: 0 }; }
                })()
              },
              usageMode: mode || 'chat'
            });
          }
        } catch (error) {
          console.error(`❌ Failed to handle session ${currentSessionId}:`, error);
          throw error;
        }
      }
    }

    // Deduct credits after processing (skip for anonymous users)
    if (isAuthenticated && userId !== 'anonymous') {
      try {
        // Wait briefly to ensure usageRecord is created
        await new Promise(resolve => setTimeout(resolve, 500));

        // Get usage cost from usageRecords collection
        const { getFirestore } = await import('../config/firebase.js');
        const db = getFirestore();
        if (db) {
          // Use UsageTracker for accurate INCREMENTAL cost calculation for this interaction
          const incrementalCost = usageTracker.calculateCost(resolvedModel).total;

          if (incrementalCost > 0) {
            await deductCredits(userId, incrementalCost, currentSessionId);
            console.log(`💳 Deducted ${incrementalCost.toFixed(2)} cost (session: ${currentSessionId}, incremental) from user ${userId}`);
          }
        }
      } catch (error) {
        console.error('❌ Credit deduction failed:', error);
        // Don't fail the request if credit deduction fails
      }
    }

    // Get session data for response
    let sessionData;

    if (isAuthenticated) {
      // Load session data for response - add small delay to ensure database consistency
      try {
        sessionData = await FirestoreService.getUnifiedSession(currentSessionId);
      } catch (error) {
        console.error(`❌ Failed to load session ${currentSessionId}:`, error);
        return res.status(500).json({
          success: false,
          error: 'Failed to load session data'
        });
      }
    } else {
      // For anonymous users, frontend maintains user messages, backend only provides AI response
      // No need to create user message - frontend already has it
      sessionData = {
        id: currentSessionId,
        title: sessionTitle,
        userId: userId,
        messageType: 'Chat',
        messages: [aiMessage], // Only AI message - frontend handles user messages
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPastPaper: false
      };

    }

    if (capturedChatLogs) {
      const chatLogs = capturedChatLogs as CapturedLogResult;
      const chatUploadedFiles: SessionDigestUploadedFile[] = [];
      if (imageLink) {
        chatUploadedFiles.push({ filename: 'follow-up-image.jpg', url: imageLink });
      } else if (!isAuthenticated && imageData) {
        const uploadedGuestImg = await Promise.race([
          AdminAlertService.uploadBase64ImageForLog(imageData, `guest:${userIP}`),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]);
        if (uploadedGuestImg) {
          chatUploadedFiles.push(uploadedGuestImg);
        }
      }

      AdminAlertService.recordSessionTurn({
        sessionId: currentSessionId,
        turnType: 'FOLLOW_UP_CHAT',
        userId: isAuthenticated ? userId : `guest:${userIP}`,
        userEmail: req.user?.email,
        userAgent: (typeof req.get === 'function' ? req.get('user-agent') : req.headers?.['user-agent']) || undefined,
        sessionTitle: sessionData?.title || sessionTitle,
        model: resolvedModel,
        userInput: message || (imageData ? '[Image uploaded]' : ''),
        aiResponse: finalResponse,
        uploadedFiles: chatUploadedFiles,
        ...chatLogs,
      });
    }

    // Return consistent response format (same as process-single)
    if (isAuthenticated) {
      // Authenticated users get only AI message (like marking/question modes)
      res.json({
        success: true,
        aiMessage: aiMessage,
        sessionId: currentSessionId,
        sessionTitle: sessionTitle
      });
    } else {
      // Anonymous users get only AI message for frontend to append
      res.json({
        success: true,
        aiMessage: aiMessage, // Only AI message - frontend handles user messages
        sessionId: currentSessionId,
        sessionTitle: sessionTitle
      });
    }

  } catch (error) {
    console.error('❌ Chat endpoint error:', error);
    void AdminAlertService.notifyCrash('FOLLOW_UP_CHAT', req, error);
    res.status(500).json({
      success: false,
      error: 'Failed to process chat message',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /messages
 * Create a new message (low-level API) - REQUIRES AUTHENTICATION
 */
router.post('/', optionalAuth, async (req, res) => {
  try {
    const messageData = req.body;

    // Use authenticated user ID or anonymous
    const userId = req.user?.uid || 'anonymous';
    const isAuthenticated = !!req.user?.uid;

    // Validate required fields
    if (!messageData.id || !messageData.sessionId || !messageData.role || !messageData.content) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: id, sessionId, role, content'
      });
    }

    // For individual message creation, we'll create a single-message session
    const sessionId = messageData.sessionId || `single-msg-${Date.now()}`;

    if (isAuthenticated) {
      const sessionId_result = await FirestoreService.createUnifiedSessionWithMessages({
        sessionId: sessionId,
        title: `Single Message - ${new Date().toLocaleDateString()}`,
        userId: userId,
        messageType: 'Chat',
        messages: [messageData]
      });

      return res.json({
        success: true,
        sessionId: sessionId_result,
        message: 'Message saved successfully'
      });
    } else {
      return res.json({
        success: true,
        sessionId: sessionId,
        message: 'Message processed (not saved - anonymous user)'
      });
    }
  } catch (error) {
    console.error('Failed to save message:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to save message'
    });
  }
});

/**
 * GET /messages/session/:sessionId
 * Get UnifiedSession with all messages (parent-child structure) - REQUIRES AUTHENTICATION
 */
router.get('/session/:sessionId', optionalAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const [session, job] = await Promise.all([
      FirestoreService.getUnifiedSession(sessionId),
      FirestoreService.getMarkingJob(sessionId)
    ]);

    const requesterId = req.user?.uid || null;
    const isAdmin = req.user?.role === 'admin';

    const hasOwnedId = (ownerId: any) =>
      Boolean(ownerId && ownerId !== 'guest' && ownerId !== 'anonymous');

    if (session && hasOwnedId(session.userId)) {
      if (!isAdmin && (!requesterId || requesterId !== session.userId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        });
      }
    }

    if (job && hasOwnedId(job.userId)) {
      if (!isAdmin && (!requesterId || requesterId !== job.userId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        });
      }
    }

    const JOB_FRESHNESS_MS = 15 * 60 * 1000;
    const isJobFresh = Boolean(
      job &&
      typeof job.updatedAt === 'number' &&
      (Date.now() - job.updatedAt) < JOB_FRESHNESS_MS
    );

    if (isJobFresh && job.status === 'processing') {
      return res.json({
        success: true,
        status: 'processing',
        sessionId,
        progressData: job.progressData || null,
        isRemark: Boolean(job.isRemark),
        startedAt: job.startedAt || job.updatedAt,
        ...(session ? { session, messages: session.messages } : {})
      });
    }

    if (isJobFresh && job.status === 'failed' && !(job.isRemark && session)) {
      return res.json({
        success: true,
        status: 'failed',
        sessionId,
        error: job.error || 'Marking failed',
        credits_exhausted: Boolean(job.credits_exhausted),
        ...(job.fallbackResult ? { fallbackResult: job.fallbackResult } : {}),
        ...(session ? { session, messages: session.messages } : {})
      });
    }

    if (session) {
      const hasAssistantMessage =
        Array.isArray(session.messages) &&
        session.messages.some((m: any) => m.role === 'assistant');
      const sessionTimestamp = new Date(
        (session as any).updatedAt || (session as any).createdAt || 0
      ).getTime();
      const isRecentIncompleteSession =
        !hasAssistantMessage &&
        sessionTimestamp > 0 &&
        Date.now() - sessionTimestamp < JOB_FRESHNESS_MS;

      if (isRecentIncompleteSession) {
        return res.json({
          success: true,
          status: 'processing',
          sessionId,
          progressData: job?.progressData || null,
          session,
          messages: session.messages,
        });
      }

      return res.json({
        success: true,
        status: 'completed',
        session,
        sessionId,
        messages: session.messages,
      });
    }

    if (job?.fallbackResult) {
      return res.json({
        success: true,
        status: 'completed',
        sessionId,
        fallbackResult: job.fallbackResult
      });
    }

    return res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  } catch (error) {
    console.error('Failed to get UnifiedSession:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve session',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /messages/admin/sessions/subscribers
 * Get UnifiedSessions for all active subscribers (Admin Only)
 */
router.get('/admin/sessions/subscribers', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied - admin role required',
        details: `Authenticated: ${req.user.uid}, Role: ${req.user.role}`
      });
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const messageType = req.query.messageType as string || null;
    const lastUpdatedAt = req.query.lastUpdatedAt as string || null;

    const startTime = Date.now();

    // 1. Get active subscriber IDs
    let activeSubscriberIds = await SubscriptionService.getActiveSubscriberIds();
    
    // Filter out Admin users from the subscriber list
    if (activeSubscriberIds.length > 0) {
      try {
        const firebaseAuth = getFirebaseAuth();
        if (firebaseAuth) {
          const nonAdminSubscriberIds: string[] = [];
          for (let i = 0; i < activeSubscriberIds.length; i += 100) {
            const chunk = activeSubscriberIds.slice(i, i + 100);
            const uidIdentifiers = chunk.map(uid => ({ uid }));
            const userRecords = await firebaseAuth.getUsers(uidIdentifiers);
            userRecords.users.forEach(userRecord => {
              const role = getUserRole(userRecord.email || '');
              if (role !== 'admin') {
                nonAdminSubscriberIds.push(userRecord.uid);
              }
            });
          }
          activeSubscriberIds = nonAdminSubscriberIds;
        }
      } catch (e) {
        console.error('Failed to filter admin subscribers:', e);
      }
    }

    if (activeSubscriberIds.length === 0) {
      return res.json({ success: true, sessions: [], count: 0, perfMs: Date.now() - startTime });
    }

    // 2. Fetch sessions for each subscriber individually to avoid Firestore composite index errors on 'in' + 'orderBy'
    const db = getFirestore();
    const sessionsRef = db.collection('unifiedSessions');

    const promises = activeSubscriberIds.map(uid => {
      let query = sessionsRef.where('userId', '==', uid);
      if (messageType && messageType !== 'all') {
        query = query.where('messageType', '==', messageType);
      }
      query = query.orderBy('updatedAt', 'desc');

      if (lastUpdatedAt) {
        let timestamp: any;
        if (typeof lastUpdatedAt === 'string' && lastUpdatedAt.includes('T')) {
          timestamp = new Date(lastUpdatedAt).getTime();
        } else if (!isNaN(Number(lastUpdatedAt))) {
          timestamp = Number(lastUpdatedAt);
        } else {
          timestamp = lastUpdatedAt;
        }
        query = query.startAfter(timestamp);
      }

      // Fetch up to 'limit' for EACH subscriber, so we can merge and slice the true top 'limit'
      return query.limit(limit).get();
    });

    const snapshots = await Promise.all(promises);
    
    let allSessions: any[] = [];
    for (const snapshot of snapshots) {
      for (const doc of snapshot.docs) {
        const sessionData = doc.data();
        let lastMessage = sessionData.lastMessagePreview;

        if (!lastMessage && sessionData.unifiedMessages) {
          const unifiedMessages = sessionData.unifiedMessages || [];
          if (unifiedMessages.length > 0) {
            const sortedMessages = [...unifiedMessages].sort((a: any, b: any) => {
              const timeA = new Date(a.timestamp || a.createdAt || 0).getTime();
              const timeB = new Date(b.timestamp || b.createdAt || 0).getTime();
              return timeB - timeA;
            });
            lastMessage = sortedMessages[0];
          }
        }

        allSessions.push({
          id: doc.id,
          title: sessionData.title,
          userId: sessionData.userId,
          messageType: sessionData.messageType,
          createdAt: sessionData.createdAt,
          updatedAt: sessionData.updatedAt,
          favorite: sessionData.favorite || false,
          pinned: sessionData.pinned || false,
          rating: sessionData.rating || 0,
          messages: [],
          detectedQuestion: sessionData.detectedQuestion || null,
          lastMessage: lastMessage ? {
            content: lastMessage.content,
            role: lastMessage.role,
            timestamp: lastMessage.timestamp || lastMessage.createdAt
          } : null,
          hasImage: sessionData.sessionStats?.hasImage || false,
          imagesPreview: sessionData.imagesPreview || [],
          lastApiUsed: sessionData.sessionStats?.lastApiUsed,
          studentScore: sessionData.studentScore || null,
          usageMode: sessionData.usageMode || null
        });
      }
    }

    // Sort all merged sessions by date descending (and respect pinned)
    allSessions.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;

      const timeA = new Date(a.updatedAt || 0).getTime();
      const timeB = new Date(b.updatedAt || 0).getTime();
      return timeB - timeA;
    });
    
    // Slice top limit
    const finalSessions = allSessions.slice(0, limit);

    // Fetch user emails for admin view
    if (finalSessions.length > 0) {
      try {
        const uniqueUserIds = [...new Set(finalSessions.map(s => s.userId))]
          .filter(uid => uid && uid !== 'anonymous' && uid !== 'system' && uid !== 'all') as string[];
        
        if (uniqueUserIds.length > 0) {
          const firebaseAuth = getFirebaseAuth();
          if (firebaseAuth) {
            const userEmails = new Map<string, string>();
            for (let i = 0; i < uniqueUserIds.length; i += 100) {
              const chunk = uniqueUserIds.slice(i, i + 100);
              const uidIdentifiers = chunk.map(uid => ({ uid }));
              const userRecords = await firebaseAuth.getUsers(uidIdentifiers);
              userRecords.users.forEach(userRecord => {
                if (userRecord.email) {
                  userEmails.set(userRecord.uid, userRecord.email);
                }
              });
            }
            finalSessions.forEach(session => {
              if (userEmails.has(session.userId)) {
                session.userEmail = userEmails.get(session.userId);
              }
            });
          }
        }
      } catch (emailError) {
        console.error('Failed to fetch user emails:', emailError);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[PERF] GET /admin/sessions/subscribers took ${duration}ms for ${finalSessions.length} sessions`);

    return res.json({
      success: true,
      sessions: finalSessions,
      count: finalSessions.length,
      perfMs: duration
    });
  } catch (error) {
    console.error('Failed to get subscriber sessions:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve subscriber sessions',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /messages/sessions/:userId
 * Get user's UnifiedSessions (lightweight list) - REQUIRES AUTHENTICATION
 */
router.get('/sessions/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const lastUpdatedAt = req.query.lastUpdatedAt as string || null;
    const lastPinned = req.query.lastPinned === 'true' ? true : (req.query.lastPinned === 'false' ? false : null);
    const messageType = req.query.messageType as string || null;
    const search = req.query.search as string || null;

    // Only return sessions for authenticated users who match the requested userId
    // OR if the requester is an admin and requesting 'all' users
    if (userId === 'all') {
      if (req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          error: 'Access denied - admin role required for global history',
          details: `Authenticated: ${req.user.uid}, Role: ${req.user.role}`
        });
      }
    } else if (req.user.uid !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied - can only access your own sessions',
        details: `Requested: ${userId}, Authenticated: ${req.user.uid}`
      });
    }

    const startTime = Date.now();
    const sessions = await FirestoreService.getUserUnifiedSessions(userId, limit, lastUpdatedAt, messageType, search);
    const duration = Date.now() - startTime;
    console.log(`[PERF] GET /sessions/${userId} took ${duration}ms for ${sessions.length} sessions (limit: ${limit})`);

    return res.json({
      success: true,
      sessions,
      count: sessions.length,
      perfMs: duration
    });
  } catch (error) {
    console.error('Failed to get user UnifiedSessions:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve user sessions',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /messages/batch
 * Save multiple messages at once (for session creation) - REQUIRES AUTHENTICATION
 */
router.post('/batch', optionalAuth, async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Messages array is required'
      });
    }

    // Use authenticated user ID or anonymous
    const userId = req.user?.uid || 'anonymous';
    const isAuthenticated = !!req.user?.uid;

    // Create session with all messages using batch creation
    const sessionId = messages[0]?.sessionId || `batch-session-${Date.now()}`;

    if (isAuthenticated) {
      const sessionId_result = await FirestoreService.createUnifiedSessionWithMessages({
        sessionId: sessionId,
        title: `Batch Session - ${new Date().toLocaleDateString()}`,
        userId: userId,
        messageType: 'Chat',
        messages: messages
      });

      return res.json({
        success: true,
        sessionId: sessionId_result,
        count: messages.length,
        savedSessionId: sessionId_result
      });
    } else {
      return res.json({
        success: true,
        sessionId: sessionId,
        count: messages.length,
        message: 'Messages processed (not saved - anonymous user)'
      });
    }
  } catch (error) {
    console.error('Failed to save message batch:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to save messages'
    });
  }
});

/**
 * DELETE /messages/session/:sessionId
 * Delete a UnifiedSession - REQUIRES AUTHENTICATION
 */
router.delete('/session/:sessionId', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;


    // Verify session exists and get ownership info
    const session = await FirestoreService.getUnifiedSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Verify ownership before deleting
    if (session.userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You can only delete your own sessions'
      });
    }

    // Delete the UnifiedSession
    await FirestoreService.deleteUnifiedSession(sessionId, session.userId);

    return res.json({
      success: true,
      message: 'Session deleted successfully'
    });
  } catch (error) {
    console.error('Failed to delete UnifiedSession:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete session',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * PUT /messages/session/:sessionId
 * Update session metadata (favorite, rating, title) - REQUIRES AUTHENTICATION
 */
router.put('/session/:sessionId', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const updates = req.body;

    // Update the session
    await FirestoreService.updateUnifiedSession(sessionId, updates);

    res.json({
      success: true,
      message: 'Session updated successfully'
    });
  } catch (error) {
    console.error('❌ Update session error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update session'
    });
  }
});

/**
 * GET /messages/stats
 * Get basic statistics about messages
 */
router.get('/stats', optionalAuth, async (req, res) => {
  try {
    // This would be implemented based on your analytics needs
    return res.json({
      success: true,
      stats: {
        message: 'Stats endpoint - to be implemented'
      }
    });
  } catch (error) {
    console.error('Failed to get message stats:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve message statistics'
    });
  }
});

export default router;
