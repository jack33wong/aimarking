import imageCompression from 'browser-image-compression';
import API_CONFIG from '../config/api';
import { auth } from '../config/firebase';
import { setLatestPreInspectSessionId } from '../utils/funnelTracker';

export type PreInspectOverallStatus = 'ready' | 'action_needed' | 'invalid';

export type PreInspectDocType =
  | 'student_work'
  | 'question_paper'
  | 'mark_scheme_only'
  | 'cover_only'
  | 'missing_mark_scheme'
  | 'answers_without_questions'
  | 'paper_mismatch'
  | 'multi_paper_not_supported'
  | 'page_limit_exceeded'
  | 'pdf_structural_error'
  | 'unsupported_layout'
  | 'unofficial_paper'
  | 'non_academic'
  | 'unreadable';

export type PreInspectFileRole =
  | 'student_paper'
  | 'question_paper'
  | 'mark_scheme'
  | 'cover_only'
  | 'non_academic'
  | 'unreadable';

export interface PreInspectSuggestionAction {
  id: string;
  label: string;
  action: 'submit' | 'prefill' | 'attach_file' | 'replace_file' | 'submit_generic_rubric';
  prompt?: string;
}

export interface PreInspectFileSummary {
  fileName: string;
  role: PreInspectFileRole;
  examBoard?: string;
  subject?: string;
  paperCode?: string;
  pageCount: number;
  sampledPages: number[];
  inspected?: boolean;
  hasHandwriting?: boolean;
  hasPrintedQuestions?: boolean;
  requiresMarkScheme?: boolean;
  hasCatalogedOfficialScheme?: boolean;
  isUnofficialPaper?: boolean;
}

export interface PreInspectResult {
  preInspectToken: string;
  preInspectSessionId?: string;
  overallStatus: PreInspectOverallStatus;
  docType: PreInspectDocType;
  isWarning?: boolean;
  examBoard?: string;
  subject?: string;
  paperCode?: string;
  hasMarkScheme: boolean;
  requiresMarkScheme: boolean;
  hasHandwriting: boolean;
  bannerTitle: string;
  bannerMessage: string;
  perFileRoles: PreInspectFileSummary[];
  suggestions: PreInspectSuggestionAction[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
    costUsd: number;
  };
  durationMs?: number;
}

const MAX_PREINSPECT_FILE_BYTES = 20 * 1024 * 1024; // 20 MB ceiling for fast pre-inspect

// Shared pending pre-inspect state consumed automatically by markingApiService on Send
let pendingPreInspectToken: string | null = null;
let pendingAllowGenericSubjectMarking = false;

export function setPendingPreInspectContext(opts: {
  preInspectToken?: string | null;
  allowGenericSubjectMarking?: boolean;
}) {
  if ('preInspectToken' in opts) {
    pendingPreInspectToken = opts.preInspectToken || null;
  }
  if ('allowGenericSubjectMarking' in opts) {
    pendingAllowGenericSubjectMarking = Boolean(opts.allowGenericSubjectMarking);
  }
}

export function consumePendingPreInspectContext(): {
  preInspectToken: string | null;
  allowGenericSubjectMarking: boolean;
} {
  const snapshot = {
    preInspectToken: pendingPreInspectToken,
    allowGenericSubjectMarking: pendingAllowGenericSubjectMarking,
  };
  pendingPreInspectToken = null;
  pendingAllowGenericSubjectMarking = false;
  return snapshot;
}

async function computeFileSha256Hex(file: File): Promise<string> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return '';
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

async function prepareFileForPreInspect(file: File): Promise<File> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  if (isPdf) return file;
  try {
    const compressed = await imageCompression(file, {
      maxSizeMB: 0.25,
      maxWidthOrHeight: 800,
      useWebWorker: true,
      fileType: 'image/jpeg',
    });
    return new File([compressed], file.name || 'image.jpg', { type: compressed.type || 'image/jpeg' });
  } catch {
    return file;
  }
}

export async function preInspectUploadedFiles(
  files: File[],
  options?: { sessionId?: string | null; signal?: AbortSignal }
): Promise<PreInspectResult | null> {
  if (!files || files.length === 0) return null;

  // Skip pre-inspect for oversized files (>20MB) so we don't slow down the browser
  const eligibleFiles = files.filter((f) => f && f.size > 0 && f.size <= MAX_PREINSPECT_FILE_BYTES);
  if (eligibleFiles.length === 0) return null;

  const MAX_INSPECTED_IMAGES_CLIENT = 2;
  let imageQuota = 0;
  const shouldCompressImageAtIdx = eligibleFiles.map((f) => {
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
    if (isPdf) return false;
    if (imageQuota < MAX_INSPECTED_IMAGES_CLIENT) {
      imageQuota++;
      return true;
    }
    return false;
  });

  const createPlaceholderFile = (file: File) =>
    new File([new Uint8Array([0])], file.name || 'image.jpg', { type: file.type || 'image/jpeg' });

  const [hashes, preparedFiles] = await Promise.all([
    Promise.all(eligibleFiles.map((f) => computeFileSha256Hex(f))),
    Promise.all(
      eligibleFiles.map((f, idx) => {
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
        if (isPdf) return Promise.resolve(f);
        if (shouldCompressImageAtIdx[idx]) return prepareFileForPreInspect(f);
        // For images beyond the 2-image inspection quota, send a 1-byte placeholder instead of
        // compressing & uploading extra photos that the backend will not inspect during Pre-Inspect!
        return Promise.resolve(createPlaceholderFile(f));
      })
    ),
  ]);

  if (options?.signal?.aborted) return null;

  const formData = new FormData();
  const headers: Record<string, string> = {};

  try {
    const currentUser = auth?.currentUser;
    if (currentUser) {
      const token = await currentUser.getIdToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        formData.append('token', token);
      }
    }
  } catch {
    // Proceed as guest if token unavailable
  }

  if (options?.sessionId && !options.sessionId.startsWith('temp-')) {
    formData.append('sessionId', options.sessionId);
  }
  formData.append('originalHashes', JSON.stringify(hashes));
  preparedFiles.forEach((f) => {
    formData.append('files', f, f.name);
  });

  const response = await fetch(`${API_CONFIG.BASE_URL}/api/marking/pre-inspect`, {
    method: 'POST',
    headers,
    body: formData,
    signal: options?.signal,
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as PreInspectResult;
  if (data?.preInspectToken) {
    setPendingPreInspectContext({ preInspectToken: data.preInspectToken });
  }
  if (data?.preInspectSessionId) {
    setLatestPreInspectSessionId(data.preInspectSessionId);
  }
  return data;
}

function normalizeFullPaperCodeClient(code?: string): string | undefined {
  if (!code) return undefined;
  const m = code.toUpperCase().match(/\b([0-9A-Z]{3,6}\/[0-9A-Z]{1,3})\b/);
  return m ? m[1] : undefined;
}

/**
 * Pure client-side recomputation when a user removes a file and all remaining files
 * have already been inspected. Avoids any redundant network/server call (0ms, 0 LLM calls).
 */
export function recomputePreInspectFromSummaries(
  perFileRoles: PreInspectFileSummary[],
  existingToken: string
): PreInspectResult {
  const schemeFiles = perFileRoles.filter((f) => f.role === 'mark_scheme');
  const nonSchemeFiles = perFileRoles.filter((f) => f.role !== 'mark_scheme');
  const hasUploadedMarkScheme = schemeFiles.length > 0;
  const hasCatalogedOfficialScheme = nonSchemeFiles.some((f) => f.hasCatalogedOfficialScheme === true);
  const hasMarkScheme = hasUploadedMarkScheme || hasCatalogedOfficialScheme;

  const paperCode = nonSchemeFiles.find((f) => f.paperCode)?.paperCode || perFileRoles.find((f) => f.paperCode)?.paperCode;
  const examBoard = nonSchemeFiles.find((f) => f.examBoard)?.examBoard || perFileRoles.find((f) => f.examBoard)?.examBoard;
  const subject = nonSchemeFiles.find((f) => f.subject)?.subject || perFileRoles.find((f) => f.subject)?.subject;
  const hasHandwriting = nonSchemeFiles.some((f) => f.hasHandwriting === true || f.role === 'student_paper');
  const contentFiles = nonSchemeFiles.filter((f) => f.role !== 'cover_only' && f.role !== 'non_academic' && f.role !== 'unreadable');
  const hasPrintedQuestions = contentFiles.length === 0 ? true : contentFiles.some((f) => f.hasPrintedQuestions !== false);
  const isUnofficialPaper = nonSchemeFiles.some((f) => f.isUnofficialPaper === true);
  const labelPrefix = [examBoard, paperCode, subject].filter(Boolean).join(' · ') || 'Uploaded file';

  const base = {
    preInspectToken: existingToken,
    examBoard,
    subject,
    paperCode,
    hasMarkScheme,
    requiresMarkScheme: false,
    hasHandwriting,
    bannerMessage: '',
    perFileRoles,
  };

  if (hasUploadedMarkScheme && nonSchemeFiles.length === 0) {
    const msLabel = [examBoard, paperCode, subject].filter(Boolean).join(' · ');
    return {
      ...base,
      overallStatus: 'action_needed',
      docType: 'mark_scheme_only',
      isWarning: true,
      bannerTitle: `${msLabel ? `${msLabel} · ` : ''}Mark scheme only — attach student paper`,
      suggestions: [{ id: 'attach-paper', label: 'Attach student paper to mark', action: 'attach_file' }],
    };
  }

  if (nonSchemeFiles.length > 0 && nonSchemeFiles.every((f) => f.role === 'unreadable')) {
    return {
      ...base,
      overallStatus: 'invalid',
      docType: 'unreadable',
      isWarning: true,
      bannerTitle: 'Image looks blurry or unreadable',
      suggestions: [{ id: 'replace-file', label: 'Replace file', action: 'replace_file' }],
    };
  }

  if (nonSchemeFiles.length > 0 && nonSchemeFiles.every((f) => f.role === 'non_academic')) {
    return {
      ...base,
      overallStatus: 'invalid',
      docType: 'non_academic',
      isWarning: true,
      bannerTitle: 'Not an academic exam or homework image',
      suggestions: [{ id: 'replace-file', label: 'Replace file', action: 'replace_file' }],
    };
  }

  if (nonSchemeFiles.length > 0 && nonSchemeFiles.every((f) => f.role === 'cover_only')) {
    return {
      ...base,
      overallStatus: 'action_needed',
      docType: 'cover_only',
      isWarning: true,
      bannerTitle: `${labelPrefix} · Cover page only (no questions found)`,
      suggestions: [{ id: 'replace-cover', label: 'Replace with question or answer pages', action: 'replace_file' }],
    };
  }

  if (hasUploadedMarkScheme && nonSchemeFiles.length > 0) {
    const studentCode = normalizeFullPaperCodeClient(nonSchemeFiles.find((f) => f.paperCode)?.paperCode);
    const schemeCode = normalizeFullPaperCodeClient(schemeFiles.find((f) => f.paperCode)?.paperCode);
    if (studentCode && schemeCode && studentCode !== schemeCode) {
      return {
        ...base,
        overallStatus: 'action_needed',
        docType: 'paper_mismatch',
        isWarning: true,
        paperCode: studentCode,
        bannerTitle: `Paper mismatch: ${studentCode} paper vs ${schemeCode} mark scheme`,
        suggestions: [{ id: 'replace-mismatch', label: 'Replace mismatched file', action: 'replace_file' }],
      };
    }
  }

  const distinctStudentCodes = Array.from(
    new Set(nonSchemeFiles.map((f) => normalizeFullPaperCodeClient(f.paperCode)).filter((c): c is string => Boolean(c)))
  );
  if (distinctStudentCodes.length > 1) {
    return {
      ...base,
      overallStatus: 'action_needed',
      docType: 'multi_paper_not_supported',
      isWarning: true,
      paperCode: distinctStudentCodes[0],
      bannerTitle: `Multiple papers detected (${distinctStudentCodes.slice(0, 2).join(' & ')}) — upload 1 paper at a time`,
      suggestions: [{ id: 'replace-multi-paper', label: 'Replace with a single paper', action: 'replace_file' }],
    };
  }

  const needsMarkSchemeFiles = nonSchemeFiles.filter((f) => f.requiresMarkScheme === true);
  if (!hasMarkScheme && needsMarkSchemeFiles.length > 0) {
    const subjLabel = needsMarkSchemeFiles[0]?.subject || subject || 'This subject';
    const titleLead = [examBoard, paperCode, subjLabel].filter(Boolean).join(' · ');
    return {
      ...base,
      overallStatus: 'action_needed',
      docType: 'missing_mark_scheme',
      isWarning: false,
      subject: subjLabel,
      requiresMarkScheme: true,
      bannerTitle: `${titleLead} — attach a mark scheme for official grading`,
      suggestions: [
        { id: 'attach-ms', label: 'Attach official mark scheme (recommended)', action: 'attach_file' },
        { id: 'generic-rubric', label: 'Mark now with AI General Rubric', action: 'submit_generic_rubric' },
      ],
    };
  }

  if (hasHandwriting && !hasPrintedQuestions && !hasMarkScheme && contentFiles.length > 0) {
    return {
      ...base,
      overallStatus: 'action_needed',
      docType: 'answers_without_questions',
      isWarning: true,
      bannerTitle: `${labelPrefix} · Answers only (no questions detected) — generic mark scheme will be used`,
      suggestions: [
        { id: 'attach-q-or-ms', label: 'Attach question paper or mark scheme for official grading', action: 'attach_file' },
      ],
    };
  }

  if (isUnofficialPaper && !hasMarkScheme) {
    return {
      ...base,
      overallStatus: hasHandwriting ? 'ready' : 'action_needed',
      docType: 'unofficial_paper',
      isWarning: false,
      bannerTitle: hasHandwriting
        ? `${labelPrefix} · Practice/unofficial paper · Ready to mark (attach mark scheme if available)`
        : `${labelPrefix} · Practice/unofficial paper — attach its mark scheme if available`,
      suggestions: [{ id: 'attach-practice-ms', label: 'Attach mark scheme (optional)', action: 'attach_file' }],
    };
  }

  if (hasHandwriting || hasMarkScheme) {
    return {
      ...base,
      overallStatus: 'ready',
      docType: 'student_work',
      isWarning: false,
      bannerTitle: hasCatalogedOfficialScheme
        ? `${labelPrefix} · Official mark scheme found · Ready to mark`
        : hasUploadedMarkScheme
          ? `${labelPrefix} + Mark Scheme · Ready to mark`
          : `${labelPrefix} · Ready to mark`,
      suggestions: [],
    };
  }

  return {
    ...base,
    overallStatus: 'ready',
    docType: 'question_paper',
    isWarning: false,
    bannerTitle: `${labelPrefix} · Question paper detected`,
    suggestions: [{ id: 'attach-answers', label: 'Attach my handwritten answers to mark', action: 'attach_file' }],
  };
}
