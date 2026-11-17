import { useState, useCallback, useMemo } from 'react';
import { simpleSessionService } from '../services/markingApiService';
import type { UnifiedMessage, UnifiedSession } from '../types';

// Define the shape of the API state
interface ApiState {
  isProcessing: boolean;
  isAIThinking: boolean;
  processingSessionId: string | null;
  error: string | null;
  loadingProgress: number;
  loadingStep: number;
  loadingTotalSteps: number | null;
  loadingMessage: string;
  showProgressDetails: boolean;
  progressData: any;
  stepList: any[];
  currentStepIndex: number;
}

// Define the type for the progress data from the backend
interface ProgressData {
  currentStepDescription?: string;
  allSteps?: any[];
  currentStepIndex?: number;
  isComplete?: boolean;
}

export const useApiProcessor = () => {
  const [apiState, setApiState] = useState<ApiState>({
    isProcessing: false,
    isAIThinking: false,
    processingSessionId: null,
    error: null,
    loadingProgress: 0,
    loadingStep: 0,
    loadingTotalSteps: null,
    loadingMessage: 'Processing...',
    showProgressDetails: false,
    progressData: null,
    stepList: [],
    currentStepIndex: 0,
  });

  const startProcessing = useCallback((sessionId: string | null = null) => {
    const resolvedSessionId = sessionId || (simpleSessionService.getCurrentSession() as any)?.id || null;
    setApiState(prev => ({
      ...prev,
      isProcessing: true,
      processingSessionId: resolvedSessionId,
      error: null,
      loadingProgress: 0,
      loadingMessage: 'Processing...'
    }));
  }, []);

  const stopProcessing = useCallback((targetSessionId: string | null = null) => {
    setApiState(prev => {
      if (targetSessionId && prev.processingSessionId && prev.processingSessionId !== targetSessionId) {
        return prev;
      }
      return { ...prev, isProcessing: false, processingSessionId: null };
    });
  }, []);

  const startAIThinking = useCallback((progressData: any = null, aiMessageId?: string, imageDataArray?: any[], targetSessionId: string | null = null) => {
    setApiState(prev => ({
      ...prev,
      isAIThinking: true,
      ...(targetSessionId ? { processingSessionId: targetSessionId } : {})
    }));

    // Use provided aiMessageId or generate one
    // This ensures React treats processing and final messages as the same component
    const processingMessage: Partial<UnifiedMessage> = {
      id: aiMessageId || `ai-${Date.now()}`,
      messageId: aiMessageId || `ai-${Date.now()}`,
      role: 'assistant',
      content: '',
      isProcessing: true,
      progressData: progressData || { allSteps: [] },
      imageDataArray: imageDataArray || [],
      timestamp: new Date().toISOString()
    };
    (simpleSessionService.addMessage as any)(processingMessage, targetSessionId);
  }, []);

  const stopAIThinking = useCallback((targetSessionId: string | null = null) => {
    setApiState(prev => {
      if (targetSessionId && prev.processingSessionId && prev.processingSessionId !== targetSessionId) {
        return prev;
      }
      return { ...prev, isAIThinking: false };
    });

    const currentSession = simpleSessionService.getCurrentSession() as any;
    if (targetSessionId && currentSession?.id && currentSession.id !== targetSessionId) {
      return;
    }
    if (currentSession?.messages && Array.isArray(currentSession.messages)) {
      const updatedMessages = currentSession.messages
        .map((msg: any) => {
          // If this is an existing marked message that was being re-marked in place, NEVER delete it! Restore isProcessing: false.
          if (msg.role === 'assistant' && msg.isProcessing && (msg.performanceSummary || msg.studentScore || (msg.content && msg.content.trim() !== ''))) {
            return {
              ...msg,
              isProcessing: false,
              progressData: msg.progressData ? { ...msg.progressData, isComplete: true } : undefined
            };
          }
          return msg;
        })
        // Only remove truly empty placeholder messages from failed first-time uploads
        .filter((msg: any) => !(msg.role === 'assistant' && msg.isProcessing));

      simpleSessionService.updateCurrentSessionOnly({
        ...currentSession,
        messages: updatedMessages
      });
    }
  }, []);

  const handleError = useCallback((error: Error & { isTransportDisconnect?: boolean }) => {
    if (error?.isTransportDisconnect) {
      return;
    }
    setApiState(prev => ({ ...prev, isProcessing: false, isAIThinking: false, processingSessionId: null, error: error.message || 'An unknown error occurred' }));
  }, []);

  const updateProgress = useCallback((data: ProgressData, targetSessionId: string | null = null) => {
    const currentStepIndex = data.currentStepIndex || 0;
    const totalSteps = (data.allSteps || []).length;

    setApiState(prev => {
      if (targetSessionId && prev.processingSessionId && prev.processingSessionId !== targetSessionId) {
        return prev;
      }
      return {
        ...prev,
        loadingMessage: data.currentStepDescription || prev.loadingMessage,
        progressData: data,
        stepList: data.allSteps || [],
        currentStepIndex: currentStepIndex,
        loadingStep: currentStepIndex + (data.isComplete ? 0 : 1),
        loadingTotalSteps: totalSteps,
        loadingProgress: data.isComplete ? 100 : Math.round((currentStepIndex / (totalSteps || 1)) * 100)
      };
    });

    const currentSession = simpleSessionService.getCurrentSession() as UnifiedSession | null;
    if (targetSessionId && currentSession?.id && currentSession.id !== targetSessionId) {
      return;
    }
    if (currentSession?.messages?.length) {
      const processingMessageIndex = [...currentSession.messages].reverse().findIndex(m => m.isProcessing);

      if (processingMessageIndex !== -1) {
        const messageToUpdate = currentSession.messages[currentSession.messages.length - 1 - processingMessageIndex];

        const progressData = {
          currentStepDescription: data.currentStepDescription || '',
          allSteps: data.allSteps && data.allSteps.length > 0 ? [...data.allSteps] : (messageToUpdate.progressData?.allSteps || []), // Use new allSteps if available, otherwise preserve existing
          currentStepIndex: data.currentStepIndex || 0,
          isComplete: data.isComplete || false,
        };

        // Use the simpler update method
        (simpleSessionService.updateMessageInCurrentSession as any)(messageToUpdate.id, { progressData }, targetSessionId);
      }
    }
  }, []);

  const processImageAPI = useCallback(async (
    imageData: string,
    model: string,
    mode: string,
    customText?: string,
    aiMessageId?: string,
    originalFileName?: string,
    extraParams?: any,
    onProgressOverride?: (data: ProgressData) => void
  ) => {
    const targetSessionId = extraParams?.submissionId || extraParams?.sessionId || null;
    try {
      const onProgress = (data: ProgressData) => {
        updateProgress(data, targetSessionId);
        if (onProgressOverride) onProgressOverride(data);
      };
      const result = await (simpleSessionService.processImageWithProgress as any)(
        imageData, model, mode, customText as any, onProgress as any, aiMessageId as any, originalFileName as any, extraParams
      );
      return result;
    } catch (error) {
      if (!(error as any)?.isTransportDisconnect) {
        handleError(error as Error);
      }
      throw error;
    }
  }, [updateProgress, handleError]);

  const processMultiImageAPI = useCallback(async (
    files: File[],
    model: string,
    mode: string,
    customText?: string,
    aiMessageId?: string,
    extraParams?: any,
    onProgressOverride?: (data: ProgressData) => void
  ) => {
    const targetSessionId = extraParams?.submissionId || extraParams?.sessionId || null;
    try {
      const onProgress = (data: ProgressData) => {
        updateProgress(data, targetSessionId);
        if (onProgressOverride) onProgressOverride(data);
      };
      const result = await simpleSessionService.processMultiImageWithProgress(
        files, model, mode, customText as any, onProgress as any, aiMessageId as any, extraParams
      );
      return result;
    } catch (error) {
      if (!(error as any)?.isTransportDisconnect) {
        handleError(error as Error);
      }
      throw error;
    }
  }, [updateProgress, handleError]);

  const processStreamRequest = useCallback(async (
    endpoint: string,
    body: any,
    stepMapping: Record<string, number> = {},
    onProgressOverride?: (data: ProgressData) => void
  ) => {
    const targetSessionId = body?.targetSessionId || body?.sessionId || null;
    try {
      // Wrapper to handle progress updates from stream
      const onProgress = (data: any) => {
        // Handle common variations in progress data
        if (data.description && !data.currentStepDescription) {
          data.currentStepDescription = data.description;
        }

        // If the backend sends a 'step' string, map it to an index
        if (data.step && stepMapping[data.step] !== undefined) {
          data.currentStepIndex = stepMapping[data.step];
        }
        updateProgress(data, targetSessionId);
        if (onProgressOverride) onProgressOverride(data);
      };

      // Call the generic stream processor
      const result = await (simpleSessionService as any).processStream(
        endpoint,
        body.paper || body.paperTitle,
        body.model,
        onProgress as any,
        body.aiMessageId,
        body
      );
      return result;
    } catch (error) {
      if (!(error as any)?.isTransportDisconnect) {
        handleError(error as Error);
      }
      throw error;
    }
  }, [updateProgress, handleError]);

  const setShowProgressDetails = useCallback((show: boolean) => {
    setApiState(prev => ({ ...prev, showProgressDetails: show }));
  }, []);

  return useMemo(() => ({
    ...apiState,
    startProcessing,
    stopProcessing,
    startAIThinking,
    stopAIThinking,
    handleError,
    updateProgress,
    processImageAPI,
    processMultiImageAPI,
    processStreamRequest,
    setShowProgressDetails,
  }), [
    apiState,
    startProcessing,
    stopProcessing,
    startAIThinking,
    stopAIThinking,
    handleError,
    updateProgress,
    processImageAPI,
    processMultiImageAPI,
    processStreamRequest,
    setShowProgressDetails
  ]);
};

