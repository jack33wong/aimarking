import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { simpleSessionService } from '../services/markingApiService';
import './MarkingJobToast.css';

const ACTIVE_JOBS_STORAGE_KEY = 'intellimark_active_jobs_v1';
const POLL_INTERVAL_MS = 2500;
const AUTO_DISMISS_MS = 7000;
const MAX_CONSECUTIVE_POLL_ERRORS = 12;

export type MarkingJobStatus = 'processing' | 'completed' | 'failed';

export interface MarkingJob {
  sessionId: string;
  title: string;
  status: MarkingJobStatus;
  isRemark?: boolean;
  progressData?: any;
  error?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

interface RegisterJobInput {
  sessionId: string;
  title?: string;
  isRemark?: boolean;
  progressData?: any;
}

interface MarkingJobContextValue {
  jobsBySessionId: Record<string, MarkingJob>;
  activeJobs: MarkingJob[];
  registerJob: (input: RegisterJobInput) => void;
  updateJobProgress: (sessionId: string, progressData: any) => void;
  completeJob: (sessionId: string, title?: string) => void;
  failJob: (sessionId: string, error?: string) => void;
  dismissJob: (sessionId: string) => void;
  startPollingJob: (sessionId: string) => void;
  getJobForSession: (sessionId?: string | null) => MarkingJob | null;
}

const MarkingJobContext = createContext<MarkingJobContextValue | null>(null);

function isViewingSessionPath(pathname: string, sessionId: string): boolean {
  if (!pathname.startsWith('/app/')) return false;
  const routeSessionId = pathname.slice('/app/'.length).split('/')[0];
  return routeSessionId === sessionId;
}

function isFallbackJobTitle(title?: string | null): boolean {
  if (!title) return true;
  const trimmed = String(title).trim();
  if (
    !trimmed ||
    trimmed === 'Processing...' ||
    trimmed === 'Chat Session' ||
    trimmed === 'Marking Session' ||
    trimmed === 'Marking...' ||
    trimmed === 'Re-marking...'
  ) {
    return true;
  }
  return /^(Marking|Question|Single Message|Batch Session)\s*-\s*\d/i.test(trimmed);
}

function loadPersistedJobs(): Record<string, MarkingJob> {
  try {
    const raw = sessionStorage.getItem(ACTIVE_JOBS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const valid: Record<string, MarkingJob> = {};
    for (const [sid, job] of Object.entries(parsed as Record<string, MarkingJob>)) {
      if (
        job &&
        job.sessionId &&
        !job.sessionId.startsWith('temp-') &&
        job.status === 'processing' &&
        now - (job.updatedAt || job.startedAt || 0) < 15 * 60 * 1000
      ) {
        valid[sid] = job;
      }
    }
    return valid;
  } catch {
    return {};
  }
}

function persistActiveJobs(jobs: Record<string, MarkingJob>) {
  try {
    const activeOnly: Record<string, MarkingJob> = {};
    for (const [sid, job] of Object.entries(jobs)) {
      if (job.status === 'processing' && !sid.startsWith('temp-')) {
        activeOnly[sid] = job;
      }
    }
    if (Object.keys(activeOnly).length === 0) {
      sessionStorage.removeItem(ACTIVE_JOBS_STORAGE_KEY);
    } else {
      sessionStorage.setItem(ACTIVE_JOBS_STORAGE_KEY, JSON.stringify(activeOnly));
    }
  } catch {
    // Ignore storage quota errors
  }
}

export const MarkingJobProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const [jobsBySessionId, setJobsBySessionId] = useState<Record<string, MarkingJob>>(() => loadPersistedJobs());
  const jobsRef = useRef<Record<string, MarkingJob>>(jobsBySessionId);
  const pollingTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const autoDismissTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pollInFlightRef = useRef<Set<string>>(new Set());
  const pollAttemptsRef = useRef<Record<string, number>>({});
  const mountedRef = useRef(true);

  const commitJobs = useCallback((updater: (prev: Record<string, MarkingJob>) => Record<string, MarkingJob>) => {
    setJobsBySessionId(prev => {
      const next = updater(prev);
      jobsRef.current = next;
      persistActiveJobs(next);
      return next;
    });
  }, []);

  const clearTimerForSession = useCallback((sessionId: string) => {
    const timer = pollingTimersRef.current[sessionId];
    if (timer) {
      clearTimeout(timer);
      delete pollingTimersRef.current[sessionId];
    }
  }, []);

  const clearAutoDismissTimerForSession = useCallback((sessionId: string) => {
    const timer = autoDismissTimersRef.current[sessionId];
    if (timer) {
      clearTimeout(timer);
      delete autoDismissTimersRef.current[sessionId];
    }
  }, []);

  const registerJob = useCallback((input: RegisterJobInput) => {
    if (!input?.sessionId) return;
    clearAutoDismissTimerForSession(input.sessionId);
    const now = Date.now();
    commitJobs(prev => ({
      ...prev,
      [input.sessionId]: {
        sessionId: input.sessionId,
        title: isFallbackJobTitle(input.title) ? 'Processing...' : String(input.title).trim(),
        status: 'processing',
        isRemark: Boolean(input.isRemark),
        progressData: input.progressData || null,
        startedAt: prev[input.sessionId]?.startedAt || now,
        updatedAt: now
      }
    }));
  }, [clearAutoDismissTimerForSession, commitJobs]);

  const updateJobProgress = useCallback((sessionId: string, progressData: any) => {
    if (!sessionId || !progressData) return;
    commitJobs(prev => {
      const existing = prev[sessionId];
      if (!existing || existing.status !== 'processing') return prev;
      return {
        ...prev,
        [sessionId]: {
          ...existing,
          progressData,
          updatedAt: Date.now()
        }
      };
    });
  }, [commitJobs]);

  const dismissJob = useCallback((sessionId: string) => {
    if (!sessionId) return;
    clearTimerForSession(sessionId);
    clearAutoDismissTimerForSession(sessionId);
    delete pollAttemptsRef.current[sessionId];
    commitJobs(prev => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, [clearAutoDismissTimerForSession, clearTimerForSession, commitJobs]);

  const completeJob = useCallback((sessionId: string, title?: string) => {
    if (!sessionId) return;
    clearTimerForSession(sessionId);
    clearAutoDismissTimerForSession(sessionId);
    delete pollAttemptsRef.current[sessionId];
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    const isViewing = isViewingSessionPath(window.location.pathname, sessionId);
    commitJobs(prev => {
      const existing = prev[sessionId];
      if (!existing) return prev;
      if (isViewing) {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      }
      return {
        ...prev,
        [sessionId]: {
          ...existing,
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
          status: 'completed',
          updatedAt: Date.now(),
          completedAt: Date.now()
        }
      };
    });
  }, [clearAutoDismissTimerForSession, clearTimerForSession, commitJobs]);

  const failJob = useCallback((sessionId: string, error?: string) => {
    if (!sessionId) return;
    clearTimerForSession(sessionId);
    clearAutoDismissTimerForSession(sessionId);
    delete pollAttemptsRef.current[sessionId];
    const isViewing = isViewingSessionPath(window.location.pathname, sessionId);
    commitJobs(prev => {
      const existing = prev[sessionId];
      if (!existing) return prev;
      if (isViewing) {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      }
      return {
        ...prev,
        [sessionId]: {
          ...existing,
          status: 'failed',
          error: error || 'Marking failed',
          updatedAt: Date.now(),
          completedAt: Date.now()
        }
      };
    });
  }, [clearAutoDismissTimerForSession, clearTimerForSession, commitJobs]);

  const pollOnce = useCallback(async (sessionId: string) => {
    if (!mountedRef.current || !sessionId || sessionId.startsWith('temp-')) return;
    if (pollInFlightRef.current.has(sessionId)) return;

    const currentJob = jobsRef.current[sessionId];
    if (currentJob && currentJob.status !== 'processing') {
      clearTimerForSession(sessionId);
      return;
    }

    pollInFlightRef.current.add(sessionId);
    try {
      const res = await simpleSessionService.getSession(sessionId);
      if (!mountedRef.current) return;

      const latestJob = jobsRef.current[sessionId];
      if (latestJob && latestJob.status !== 'processing') {
        clearTimerForSession(sessionId);
        return;
      }

      if (res?.status === 'processing') {
        pollAttemptsRef.current[sessionId] = 0;
        if (res.progressData) {
          updateJobProgress(sessionId, res.progressData);
          const liveSession = simpleSessionService.getCurrentSession() as any;
          if (liveSession?.id === sessionId && Array.isArray(liveSession.messages)) {
            const processingMsg = [...liveSession.messages].reverse().find((m: any) => m.isProcessing);
            if (processingMsg) {
              (simpleSessionService.updateMessageInCurrentSession as any)(
                processingMsg.id,
                { progressData: res.progressData },
                sessionId
              );
            }
          }
        }
        clearTimerForSession(sessionId);
        pollingTimersRef.current[sessionId] = setTimeout(() => {
          void pollOnce(sessionId);
        }, POLL_INTERVAL_MS);
        return;
      }

      if (res?.status === 'completed' || (res?.success && (res?.session || res?.fallbackResult))) {
        const resolvedTitle = res?.session?.title || res?.fallbackResult?.sessionTitle;
        completeJob(sessionId, resolvedTitle);
        const liveSession = simpleSessionService.getCurrentSession() as any;
        const isViewing =
          liveSession?.id === sessionId ||
          isViewingSessionPath(window.location.pathname, sessionId);

        if (res.session) {
          simpleSessionService.updateSidebarSession(res.session);
          if (isViewing) {
            simpleSessionService.setCurrentSession(res.session);
          }
        } else if (res.fallbackResult && isViewing) {
          simpleSessionService.initClientSession(
            sessionId,
            res.fallbackResult.sessionTitle || 'Marking Session'
          );
          (simpleSessionService.handleProcessComplete as any)(
            res.fallbackResult,
            res.fallbackResult?.processingStats?.modelUsed || 'fast',
            res.fallbackResult?.aiMessage?.id || null,
            sessionId
          );
        } else if (res.fallbackResult && !isViewing && res.fallbackResult.sessionTitle) {
          simpleSessionService.updateSidebarSession({
            id: sessionId,
            title: res.fallbackResult.sessionTitle,
            updatedAt: new Date().toISOString()
          } as any);
        }
        simpleSessionService.stopAIThinking(sessionId);
        simpleSessionService.stopProcessing(sessionId);
        return;
      }

      if (res?.status === 'failed') {
        failJob(sessionId, res.error || 'Marking failed');
        const liveSession = simpleSessionService.getCurrentSession() as any;
        const isViewing =
          liveSession?.id === sessionId ||
          isViewingSessionPath(window.location.pathname, sessionId);

        if (res.fallbackResult && isViewing) {
          simpleSessionService.initClientSession(
            sessionId,
            res.fallbackResult.sessionTitle || 'Upload Issue'
          );
          (simpleSessionService.handleProcessComplete as any)(
            res.fallbackResult,
            'fast',
            res.fallbackResult?.aiMessage?.id || null,
            sessionId
          );
        } else if (res.session && isViewing) {
          simpleSessionService.setCurrentSession(res.session);
        }
        simpleSessionService.stopAIThinking(sessionId);
        simpleSessionService.stopProcessing(sessionId);
        return;
      }
    } catch (err: any) {
      if (!mountedRef.current) return;
      const status = err?.response?.status;
      if (status === 404 || status === 403) {
        dismissJob(sessionId);
        return;
      }
      const nextAttempts = (pollAttemptsRef.current[sessionId] || 0) + 1;
      pollAttemptsRef.current[sessionId] = nextAttempts;
      if (nextAttempts >= MAX_CONSECUTIVE_POLL_ERRORS) {
        failJob(sessionId, 'Lost connection while checking marking status.');
        simpleSessionService.stopAIThinking(sessionId);
        simpleSessionService.stopProcessing(sessionId);
        return;
      }
      clearTimerForSession(sessionId);
      pollingTimersRef.current[sessionId] = setTimeout(() => {
        void pollOnce(sessionId);
      }, POLL_INTERVAL_MS);
    } finally {
      pollInFlightRef.current.delete(sessionId);
    }
  }, [clearTimerForSession, completeJob, dismissJob, failJob, updateJobProgress]);

  const startPollingJob = useCallback((sessionId: string) => {
    if (!sessionId || sessionId.startsWith('temp-')) return;
    if (pollingTimersRef.current[sessionId] || pollInFlightRef.current.has(sessionId)) {
      return;
    }
    void pollOnce(sessionId);
  }, [pollOnce]);

  // Auto-dismiss completed toasts after AUTO_DISMISS_MS
  useEffect(() => {
    for (const [sid, timer] of Object.entries(autoDismissTimersRef.current)) {
      const job = jobsBySessionId[sid];
      if (!job || job.status !== 'completed') {
        clearTimeout(timer);
        delete autoDismissTimersRef.current[sid];
      }
    }

    for (const job of Object.values(jobsBySessionId)) {
      if (job.status === 'completed' && !autoDismissTimersRef.current[job.sessionId]) {
        autoDismissTimersRef.current[job.sessionId] = setTimeout(() => {
          if (mountedRef.current) {
            dismissJob(job.sessionId);
          }
        }, AUTO_DISMISS_MS);
      }
    }
  }, [jobsBySessionId, dismissJob]);

  // Resume persisted active jobs on mount
  useEffect(() => {
    mountedRef.current = true;
    const initialJobs = Object.values(jobsRef.current);
    initialJobs.forEach(job => {
      if (job.status === 'processing') {
        startPollingJob(job.sessionId);
      }
    });

    return () => {
      mountedRef.current = false;
      Object.values(pollingTimersRef.current).forEach(clearTimeout);
      pollingTimersRef.current = {};
      Object.values(autoDismissTimersRef.current).forEach(clearTimeout);
      autoDismissTimersRef.current = {};
    };
  }, [startPollingJob]);

  // Wakeup listeners for background tab / mobile safari / network reconnect
  useEffect(() => {
    const wakeUpActivePolls = () => {
      Object.values(jobsRef.current).forEach(job => {
        if (job.status === 'processing') {
          clearTimerForSession(job.sessionId);
          void pollOnce(job.sessionId);
        }
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        wakeUpActivePolls();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', wakeUpActivePolls);
    window.addEventListener('online', wakeUpActivePolls);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', wakeUpActivePolls);
      window.removeEventListener('online', wakeUpActivePolls);
    };
  }, [clearTimerForSession, pollOnce]);

  const activeJobs = useMemo(
    () => Object.values(jobsBySessionId).filter(j => j.status === 'processing'),
    [jobsBySessionId]
  );

  const getJobForSession = useCallback((sessionId?: string | null) => {
    if (!sessionId) return null;
    return jobsBySessionId[sessionId] || null;
  }, [jobsBySessionId]);

  const contextValue = useMemo<MarkingJobContextValue>(() => ({
    jobsBySessionId,
    activeJobs,
    registerJob,
    updateJobProgress,
    completeJob,
    failJob,
    dismissJob,
    startPollingJob,
    getJobForSession
  }), [
    jobsBySessionId,
    activeJobs,
    registerJob,
    updateJobProgress,
    completeJob,
    failJob,
    dismissJob,
    startPollingJob,
    getJobForSession
  ]);

  // Show floating pill only for jobs not currently being viewed on /app/:sessionId
  const currentRouteSessionId = location.pathname.startsWith('/app/')
    ? location.pathname.slice('/app/'.length).split('/')[0]
    : null;

  const visibleToastJobs = Object.values(jobsBySessionId).filter(job => {
    if (job.sessionId === currentRouteSessionId) {
      return false;
    }
    return true;
  });

  return (
    <MarkingJobContext.Provider value={contextValue}>
      {children}
      {visibleToastJobs.length > 0 && (
        <div className="marking-job-toast-container">
          {visibleToastJobs.map(job => {
            const isProcessing = job.status === 'processing';
            const isFailed = job.status === 'failed';
            const stepText = job.progressData?.currentStepDescription || (isProcessing ? 'Marking in background...' : isFailed ? 'Marking failed' : 'Marking complete');

            const handleViewJob = () => {
              navigate(`/app/${job.sessionId}`);
              if (!isProcessing) {
                dismissJob(job.sessionId);
              }
            };

            return (
              <div
                key={job.sessionId}
                onClick={handleViewJob}
                className={`marking-job-toast${isFailed ? ' marking-job-toast--failed' : ''}`}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  {isProcessing ? (
                    <span
                      style={{
                        width: '14px',
                        height: '14px',
                        border: '2px solid var(--border-strong, rgba(148,163,184,0.35))',
                        borderTopColor: 'var(--text-blue, #38bdf8)',
                        borderRadius: '50%',
                        display: 'inline-block',
                        flexShrink: 0,
                        animation: 'marking-job-spin 1s linear infinite'
                      }}
                    />
                  ) : (
                    <span style={{ flexShrink: 0 }}>{isFailed ? '⚠️' : '✅'}</span>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {isProcessing ? 'Processing...' : (job.title || 'Processing...')}
                    </div>
                    <div style={{ fontSize: '11px', opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {stepText}
                    </div>
                  </div>
                </div>
                <div className="marking-job-toast-actions">
                  <button
                    type="button"
                    className="marking-job-toast-view-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleViewJob();
                    }}
                  >
                    View
                  </button>
                  {!isProcessing && (
                    <button
                      type="button"
                      aria-label="Dismiss"
                      className="marking-job-toast-dismiss-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissJob(job.sessionId);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </MarkingJobContext.Provider>
  );
};

export const useMarkingJob = (): MarkingJobContextValue => {
  const ctx = useContext(MarkingJobContext);
  if (!ctx) {
    throw new Error('useMarkingJob must be used within a MarkingJobProvider');
  }
  return ctx;
};
