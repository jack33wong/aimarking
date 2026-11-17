import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { simpleSessionService } from '../services/markingApiService';

const ACTIVE_JOBS_STORAGE_KEY = 'intellimark_active_jobs_v1';
const POLL_INTERVAL_MS = 2500;
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
  completeJob: (sessionId: string) => void;
  failJob: (sessionId: string, error?: string) => void;
  dismissJob: (sessionId: string) => void;
  startPollingJob: (sessionId: string) => void;
  getJobForSession: (sessionId?: string | null) => MarkingJob | null;
}

const MarkingJobContext = createContext<MarkingJobContextValue | null>(null);

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

  const registerJob = useCallback((input: RegisterJobInput) => {
    if (!input?.sessionId) return;
    const now = Date.now();
    commitJobs(prev => ({
      ...prev,
      [input.sessionId]: {
        sessionId: input.sessionId,
        title: input.title || 'Marking...',
        status: 'processing',
        isRemark: Boolean(input.isRemark),
        progressData: input.progressData || null,
        startedAt: prev[input.sessionId]?.startedAt || now,
        updatedAt: now
      }
    }));
  }, [commitJobs]);

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

  const completeJob = useCallback((sessionId: string) => {
    if (!sessionId) return;
    clearTimerForSession(sessionId);
    delete pollAttemptsRef.current[sessionId];
    const isViewing = window.location.pathname === `/app/${sessionId}`;
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
          status: 'completed',
          updatedAt: Date.now(),
          completedAt: Date.now()
        }
      };
    });
  }, [clearTimerForSession, commitJobs]);

  const failJob = useCallback((sessionId: string, error?: string) => {
    if (!sessionId) return;
    clearTimerForSession(sessionId);
    delete pollAttemptsRef.current[sessionId];
    const isViewing = window.location.pathname === `/app/${sessionId}`;
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
  }, [clearTimerForSession, commitJobs]);

  const dismissJob = useCallback((sessionId: string) => {
    if (!sessionId) return;
    clearTimerForSession(sessionId);
    delete pollAttemptsRef.current[sessionId];
    commitJobs(prev => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, [clearTimerForSession, commitJobs]);

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
        completeJob(sessionId);
        const liveSession = simpleSessionService.getCurrentSession() as any;
        const isViewing =
          liveSession?.id === sessionId ||
          window.location.pathname === `/app/${sessionId}`;

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
          window.location.pathname === `/app/${sessionId}`;

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
        <div
          style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxWidth: '320px'
          }}
        >
          {visibleToastJobs.map(job => {
            const isProcessing = job.status === 'processing';
            const isFailed = job.status === 'failed';
            const stepText = job.progressData?.currentStepDescription || (isProcessing ? 'Marking in background...' : isFailed ? 'Marking failed' : 'Marking complete');

            return (
              <div
                key={job.sessionId}
                onClick={() => {
                  navigate(`/app/${job.sessionId}`);
                  if (!isProcessing) {
                    dismissJob(job.sessionId);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  padding: '10px 14px',
                  borderRadius: '12px',
                  background: isFailed ? '#7f1d1d' : '#1e293b',
                  color: '#f8fafc',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  cursor: 'pointer',
                  fontSize: '13px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  {isProcessing ? (
                    <span
                      style={{
                        width: '14px',
                        height: '14px',
                        border: '2px solid rgba(255,255,255,0.3)',
                        borderTopColor: '#38bdf8',
                        borderRadius: '50%',
                        display: 'inline-block',
                        flexShrink: 0,
                        animation: 'spin 1s linear infinite'
                      }}
                    />
                  ) : (
                    <span style={{ flexShrink: 0 }}>{isFailed ? '⚠️' : '✅'}</span>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {job.title || 'Marking Session'}
                    </div>
                    <div style={{ fontSize: '11px', opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {stepText}
                    </div>
                  </div>
                </div>
                {!isProcessing && (
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissJob(job.sessionId);
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#cbd5e1',
                      cursor: 'pointer',
                      fontSize: '14px',
                      padding: '2px 4px',
                      lineHeight: 1
                    }}
                  >
                    ×
                  </button>
                )}
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
