import nodemailer, { type Transporter } from 'nodemailer';
import { FirestoreService } from './firestoreService.js';

export interface CompletionEmailPayload {
  sessionId: string;
  userEmail: string;
  userName?: string | null;
  sessionTitle?: string | null;
  durationMs: number;
  awardedMarks?: number | null;
  totalMarks?: number | null;
  questionCount?: number | null;
  grade?: string | null;
  isRemark?: boolean;
}

interface PendingNotification {
  timer: NodeJS.Timeout;
  scheduledAt: number;
  expiresAt: number;
  payload: CompletionEmailPayload;
}

const DEFAULT_DELAY_MS = 75_000; // 75 seconds (~60–90s)
const DEFAULT_MIN_JOB_DURATION_MS = 30_000; // Only email on long jobs (>= 30s)
const MAX_VIEWED_CACHE_SIZE = 500;

function escapeHtml(input: string): string {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class CompletionNotificationService {
  private static pending = new Map<string, PendingNotification>();
  private static viewedSessions = new Map<string, number>();
  private static transporter: Transporter | null = null;

  static getDelayMs(): number {
    const parsed = parseInt(process.env.COMPLETION_EMAIL_DELAY_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DELAY_MS;
  }

  static getMinJobDurationMs(): number {
    const parsed = parseInt(process.env.COMPLETION_EMAIL_MIN_JOB_DURATION_MS || '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_JOB_DURATION_MS;
  }

  static setTransporterForTesting(transporter: Transporter | null): void {
    this.transporter = transporter;
  }

  static resetForTesting(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.viewedSessions.clear();
    this.transporter = null;
  }

  private static getTransporter(): Transporter | null {
    if (this.transporter) return this.transporter;

    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    const user = process.env.SMTP_USER || process.env.EMAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

    if (!user || !pass || user.includes('your-smtp-user')) {
      return null;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });

    return this.transporter;
  }

  /**
   * Schedules a delayed completion email (~75s) for a long marking job if the user
   * has not viewed the completed session before the timer fires.
   */
  static scheduleCompletionEmail(params: {
    sessionId?: string | null;
    userEmail?: string | null;
    userName?: string | null;
    sessionTitle?: string | null;
    durationMs: number;
    awardedMarks?: number | null;
    totalMarks?: number | null;
    questionCount?: number | null;
    grade?: string | null;
    isRemark?: boolean;
  }): boolean {
    const sessionId = String(params.sessionId || '').trim();
    const userEmail = String(params.userEmail || '').trim();
    if (!sessionId || sessionId.startsWith('temp-') || !userEmail || !userEmail.includes('@')) {
      return false;
    }

    const minDurationMs = this.getMinJobDurationMs();
    if (!Number.isFinite(params.durationMs) || params.durationMs < minDurationMs) {
      return false;
    }

    const now = Date.now();
    // Replace any previous pending timer for this session (e.g. re-mark)
    const existing = this.pending.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(sessionId);
    }
    // Clear stale viewed timestamp from a prior run on the same session
    this.viewedSessions.delete(sessionId);

    const delayMs = this.getDelayMs();
    const payload: CompletionEmailPayload = {
      sessionId,
      userEmail,
      userName: params.userName || null,
      sessionTitle: params.sessionTitle || null,
      durationMs: params.durationMs,
      awardedMarks: params.awardedMarks ?? null,
      totalMarks: params.totalMarks ?? null,
      questionCount: params.questionCount ?? null,
      grade: params.grade || null,
      isRemark: Boolean(params.isRemark)
    };

    const entry: PendingNotification = {
      scheduledAt: now,
      expiresAt: now + delayMs,
      payload,
      timer: setTimeout(() => {
        this.pending.delete(sessionId);
        void this.flushNotification(entry);
      }, delayMs)
    };
    if (typeof entry.timer.unref === 'function') {
      entry.timer.unref();
    }

    this.pending.set(sessionId, entry);
    console.log(
      `📧 [COMPLETION-EMAIL] Scheduled delayed notification for session ${sessionId} (${Math.round(params.durationMs / 1000)}s job) in ${Math.round(delayMs / 1000)}s.`
    );
    return true;
  }

  /**
   * Marks a session as viewed by the user, cancelling any pending delayed completion email
   * in memory and recording `viewedAt` on the Firestore markingJob for multi-instance safety.
   */
  static markSessionViewed(sessionId?: string | null): boolean {
    const sid = String(sessionId || '').trim();
    if (!sid || sid.startsWith('temp-')) return false;

    const now = Date.now();
    if (this.viewedSessions.size >= MAX_VIEWED_CACHE_SIZE) {
      const oldestKey = this.viewedSessions.keys().next().value;
      if (oldestKey) this.viewedSessions.delete(oldestKey);
    }
    this.viewedSessions.set(sid, now);

    let cancelled = false;
    const existing = this.pending.get(sid);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(sid);
      cancelled = true;
      console.log(`👁️ [COMPLETION-EMAIL] Cancelled pending email for session ${sid} (user viewed result).`);
    }

    // Best-effort multi-instance marker so another Cloud Run instance holding the timer also cancels
    void FirestoreService.upsertMarkingJob(sid, { viewedAt: now }).catch(() => {});

    return cancelled;
  }

  /**
   * Flushes any timers that expired while Cloud Run CPU was throttled between requests.
   */
  static sweepExpiredNotifications(): void {
    const now = Date.now();
    for (const [sid, entry] of this.pending.entries()) {
      if (now >= entry.expiresAt) {
        clearTimeout(entry.timer);
        this.pending.delete(sid);
        void this.flushNotification(entry);
      }
    }
  }

  static buildSessionUrl(sessionId: string): string {
    const baseUrl = (
      process.env.FRONTEND_URL ||
      process.env.APP_URL ||
      'https://aimarking.ai'
    ).replace(/\/+$/, '');
    return `${baseUrl}/app/${encodeURIComponent(sessionId)}`;
  }

  static formatScoreSummary(payload: CompletionEmailPayload): string {
    const hasScore =
      typeof payload.awardedMarks === 'number' &&
      typeof payload.totalMarks === 'number' &&
      payload.totalMarks > 0;
    const parts: string[] = [];

    if (hasScore) {
      const pct = Math.round(((payload.awardedMarks as number) / (payload.totalMarks as number)) * 100);
      parts.push(`${payload.awardedMarks} / ${payload.totalMarks} (${pct}%)`);
    }
    if (payload.grade && payload.grade !== 'N/A' && payload.grade !== 'Partial Paper') {
      parts.push(`Grade ${payload.grade}`);
    }
    if (typeof payload.questionCount === 'number' && payload.questionCount > 0) {
      parts.push(`${payload.questionCount} question${payload.questionCount === 1 ? '' : 's'} marked`);
    }
    return parts.join(' · ');
  }

  private static async flushNotification(entry: PendingNotification): Promise<boolean> {
    const { payload, scheduledAt } = entry;
    const { sessionId, userEmail } = payload;

    // 1. Check in-memory viewed map
    const localViewedAt = this.viewedSessions.get(sessionId);
    if (localViewedAt && localViewedAt >= scheduledAt) {
      return false;
    }

    // 2. Check Firestore markingJob for multi-instance viewedAt
    try {
      const job = await FirestoreService.getMarkingJob(sessionId);
      if (job && typeof job.viewedAt === 'number' && job.viewedAt >= scheduledAt) {
        return false;
      }
    } catch {
      // Non-fatal: proceed to send
    }

    const transporter = this.getTransporter();
    if (!transporter) {
      console.warn(`⚠️ [COMPLETION-EMAIL] SMTP not configured; skipped completion email for session ${sessionId}.`);
      return false;
    }

    const sessionUrl = this.buildSessionUrl(sessionId);
    const title = (payload.sessionTitle || 'Your Marking Session').trim();
    const scoreSummary = this.formatScoreSummary(payload);
    const greetingName = payload.userName ? ` ${payload.userName.split(' ')[0]}` : '';
    const actionLabel = payload.isRemark ? 're-marking' : 'marking';
    const subject = `✓ Ready: ${title} · AI Marking`;

    const textLines = [
      `Hi${greetingName},`,
      '',
      `Your AI Marking ${actionLabel} results for "${title}" are ready to review.`,
      ...(scoreSummary ? ['', `Score summary: ${scoreSummary}`] : []),
      '',
      `View your marked paper: ${sessionUrl}`,
      '',
      '— AI Marking'
    ];

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111827;">
        <div style="font-size: 13px; font-weight: 600; color: #2563eb; letter-spacing: 0.02em; margin-bottom: 8px;">AI MARKING</div>
        <h2 style="margin: 0 0 12px 0; font-size: 20px; color: #111827;">✓ Your ${escapeHtml(actionLabel)} results are ready</h2>
        <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.5; color: #374151;">
          Hi${escapeHtml(greetingName)}, your paper <strong>${escapeHtml(title)}</strong> has finished ${escapeHtml(actionLabel)}.
        </p>
        ${
          scoreSummary
            ? `<div style="background: #f3f4f6; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; font-size: 15px; font-weight: 600; color: #111827;">
                 ${escapeHtml(scoreSummary)}
               </div>`
            : ''
        }
        <a href="${escapeHtml(sessionUrl)}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 12px 20px; border-radius: 8px;">
          View Marked Results
        </a>
        <p style="margin: 20px 0 0 0; font-size: 12px; color: #6b7280; word-break: break-all;">
          Or open directly: <a href="${escapeHtml(sessionUrl)}" style="color: #2563eb;">${escapeHtml(sessionUrl)}</a>
        </p>
      </div>
    `;

    try {
      const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@aimarking.ai';
      await transporter.sendMail({
        from: fromAddress,
        to: userEmail,
        subject,
        text: textLines.join('\n'),
        html
      });
      console.log(`📧 [COMPLETION-EMAIL] Sent completion email to ${userEmail} for session ${sessionId}.`);
      return true;
    } catch (err) {
      console.warn(`⚠️ [COMPLETION-EMAIL] Failed to send completion email for session ${sessionId}:`, err);
      return false;
    }
  }
}
