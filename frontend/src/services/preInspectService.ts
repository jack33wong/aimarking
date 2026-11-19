import imageCompression from 'browser-image-compression';
import API_CONFIG from '../config/api';
import { auth } from '../config/firebase';

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
  subject?: string;
  paperCode?: string;
  pageCount: number;
  sampledPages: number[];
}

export interface PreInspectResult {
  preInspectToken: string;
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

  const [hashes, preparedFiles] = await Promise.all([
    Promise.all(eligibleFiles.map((f) => computeFileSha256Hex(f))),
    Promise.all(eligibleFiles.map((f) => prepareFileForPreInspect(f))),
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
  return data;
}
