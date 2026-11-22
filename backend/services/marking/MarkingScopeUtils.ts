/**
 * Scope-Aware Blank Question Page Handling Utilities
 *
 * Parses explicit user scope instructions from Student Input (e.g.,
 * "only mark to page 8", "mark Q1-Q12", "pages 1 to 6", "mark questions 1-10")
 * and applies scope-aware classification filtering before meta-page collection.
 */

export interface MarkingScope {
  type: 'pages' | 'questions' | 'attempted_only';
  minPage?: number; // 1-based inclusive
  maxPage?: number; // 1-based inclusive
  pageNumbers?: Set<number>;
  minQuestion?: number; // 1-based inclusive
  maxQuestion?: number; // 1-based inclusive
  questionNumbers?: Set<number>;
  excludedQuestionNumbers?: Set<number>;
  label: string; // e.g., "Pages 1–8", "Q1–Q12", "Page 4", "Q3, Q5, Q7", "Attempted Questions Only", "Excluding Q5"
}

function extractBaseQuestionNum(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).trim().match(/^(?:q\s*)?(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parses explicit page or question marking limits from user input text.
 * Returns null if no explicit scope limit is requested.
 */
export function parseMarkingScope(customText?: string): MarkingScope | null {
  if (!customText || typeof customText !== 'string') return null;
  const text = customText.trim();
  if (text.length < 3) return null;

  // 1. Explicit page range: "mark pages 1-8", "only mark pages 2 to 6", "pages 1–8", "p1-p8", "p. 1-8"
  const pageRangeMatch = text.match(
    /\b(?:(?:only\s+)?(?:mark|grade|check)\s+)?(?:pages?|pp?\.?)\s*(\d{1,3})\s*(?:[-–—]|\bto\b|\bthrough\b)\s*(?:pages?|pp?\.?)?\s*(\d{1,3})\b/i
  );
  if (pageRangeMatch) {
    const a = parseInt(pageRangeMatch[1], 10);
    const b = parseInt(pageRangeMatch[2], 10);
    if (a >= 1 && b >= a && b <= 200) {
      return {
        type: 'pages',
        minPage: a,
        maxPage: b,
        label: a === b ? `Page ${a}` : `Pages ${a}–${b}`
      };
    }
  }

  // 2. Explicit upper page bound: "only mark to page 8", "mark up to page 8", "mark until page 8", "up to p8", "first 8 pages"
  const pageUpToMatch = text.match(
    /\b(?:(?:only\s+)?(?:mark|grade|check)\s+)?(?:up\s+to|until|till|to|through)\s+(?:page|p\.?)\s*(\d{1,3})\b/i
  ) || text.match(
    /\b(?:only\s+)?(?:mark|grade|check)?\s*(?:the\s+)?first\s+(\d{1,3})\s+pages?\b/i
  );
  if (pageUpToMatch) {
    const maxPage = parseInt(pageUpToMatch[1], 10);
    if (maxPage >= 1 && maxPage <= 200) {
      return {
        type: 'pages',
        minPage: 1,
        maxPage,
        label: maxPage === 1 ? 'Page 1' : `Pages 1–${maxPage}`
      };
    }
  }

  // 3. Explicit single page: "only mark page 4", "mark page 4 only", "mark page 4", "just page 3"
  const singlePageMatch = text.match(
    /\b(?:(?:only|just)\s+(?:mark|grade|check)\s+|(?:mark|grade|check)\s+(?:only\s+)?|just\s+)page\s*(\d{1,3})\b/i
  ) || text.match(
    /\b(?:mark|grade|check)\s+page\s*(\d{1,3})\s+only\b/i
  );
  if (singlePageMatch) {
    const p = parseInt(singlePageMatch[1], 10);
    if (p >= 1 && p <= 200) {
      return {
        type: 'pages',
        minPage: p,
        maxPage: p,
        label: `Page ${p}`
      };
    }
  }

  // 4. Explicit question range: "mark Q1-Q12", "only mark Q1 to Q12", "mark questions 1-12", "Q1–Q12", "questions 1 to 12"
  const qRangeMatch = text.match(
    /\b(?:(?:only\s+)?(?:mark|grade|check)\s+)?(?:questions?|qs?\.?|q)\s*(\d{1,3})\s*(?:[-–—]|\bto\b|\bthrough\b)\s*(?:questions?|qs?\.?|q)?\s*(\d{1,3})\b/i
  );
  if (qRangeMatch) {
    const a = parseInt(qRangeMatch[1], 10);
    const b = parseInt(qRangeMatch[2], 10);
    if (a >= 1 && b >= a && b <= 200) {
      return {
        type: 'questions',
        minQuestion: a,
        maxQuestion: b,
        label: a === b ? `Q${a}` : `Q${a}–Q${b}`
      };
    }
  }

  // 5. Explicit upper question bound: "only mark to Q12", "mark up to question 12", "mark until Q8"
  const qUpToMatch = text.match(
    /\b(?:(?:only\s+)?(?:mark|grade|check)\s+)?(?:up\s+to|until|till|to|through)\s+(?:question|q\.?)\s*(\d{1,3})\b/i
  ) || text.match(
    /\b(?:only\s+)?(?:mark|grade|check)?\s*(?:the\s+)?first\s+(\d{1,3})\s+questions?\b/i
  );
  if (qUpToMatch) {
    const maxQ = parseInt(qUpToMatch[1], 10);
    if (maxQ >= 1 && maxQ <= 200) {
      return {
        type: 'questions',
        minQuestion: 1,
        maxQuestion: maxQ,
        label: maxQ === 1 ? 'Q1' : `Q1–Q${maxQ}`
      };
    }
  }

  // 6. Explicit list/single question: "mark q1 and q2", "mark Q1, Q2", "only mark Q3, Q5, Q7", "mark question 4"
  const explicitQListMatch = text.match(
    /\b(?:(?:only|just)\s+(?:mark|grade|check)|(?:mark|grade|check)(?:\s+only)?)\s+((?:questions?|qs?\.?|q)\s*\d{1,3}(?:\s*(?:,|and|&)\s*(?:(?:questions?|qs?\.?|q)\s*)?\d{1,3})*)\b/i
  );
  if (explicitQListMatch) {
    const nums = Array.from(explicitQListMatch[1].matchAll(/\d{1,3}/g))
      .map(m => parseInt(m[0], 10))
      .filter(n => n >= 1 && n <= 200);
    const uniqueSorted = [...new Set(nums)].sort((a, b) => a - b);
    if (uniqueSorted.length > 0) {
      return {
        type: 'questions',
        questionNumbers: new Set(uniqueSorted),
        label: uniqueSorted.map(n => `Q${n}`).join(', ')
      };
    }
  }

  // 7. Explicit question exclusion: "skip question 5", "don't mark Q5", "except question 5", "ignore Q3 and Q5"
  const excludeQMatch = text.match(
    /\b(?:skip(?:ped)?|ignore|exclude|except(?:\s+for)?|(?:do\s+not|don'?t)\s+(?:mark|grade|check))\s+((?:questions?|qs?\.?|q)\s*\d{1,3}(?:\s*(?:,|and|&)\s*(?:(?:questions?|qs?\.?|q)\s*)?\d{1,3})*)\b/i
  );
  if (excludeQMatch && !/\bexcept\s+(?:for\s+)?the\s+first\s+part\b/i.test(text)) {
    const nums = Array.from(excludeQMatch[1].matchAll(/\d{1,3}/g))
      .map(m => parseInt(m[0], 10))
      .filter(n => n >= 1 && n <= 200);
    const uniqueSorted = [...new Set(nums)].sort((a, b) => a - b);
    if (uniqueSorted.length > 0) {
      return {
        type: 'questions',
        excludedQuestionNumbers: new Set(uniqueSorted),
        label: `Excluding ${uniqueSorted.map(n => `Q${n}`).join(', ')}`
      };
    }
  }

  // 8. Attempted / Answered / Handwritten questions only (when explicitly asking to mark/grade only attempted/answered/handwritten work)
  const attemptedOnlyMatch =
    /\b(?:(?:only|just)\s+(?:mark|grade)|(?:mark|grade)\s+(?:only|just))\s+(?:the\s+)?(?:attempted|answered|completed|hand\s*written|my\s+answers?|what\s+i\s+(?:did|wrote|answered))\b/i.test(text) ||
    /\b(?:mark|grade)\s+(?:attempted|answered|completed|hand\s*written)\s+(?:questions?\s+|pages?\s+|work\s+)?only\b/i.test(text) ||
    /\b(?:skip|ignore|exclude|don'?t\s+(?:mark|grade))\s+(?:any\s+|all\s+|the\s+)?(?:blank|unattempted|unanswered|skipped|empty)\s+(?:questions?|pages?)\b/i.test(text);
  if (attemptedOnlyMatch) {
    return {
      type: 'attempted_only',
      label: 'Attempted Questions Only'
    };
  }

  return null;
}

export function isPageInScope(oneBasedPage: number, scope: MarkingScope): boolean {
  if (scope.type !== 'pages') return true;
  if (scope.pageNumbers && scope.pageNumbers.size > 0) {
    return scope.pageNumbers.has(oneBasedPage);
  }
  if (scope.minPage !== undefined && oneBasedPage < scope.minPage) return false;
  if (scope.maxPage !== undefined && oneBasedPage > scope.maxPage) return false;
  return true;
}

export function isQuestionInScope(questionNumber: string | number | undefined, scope: MarkingScope): boolean {
  const baseNum = extractBaseQuestionNum(questionNumber);
  if (scope.excludedQuestionNumbers && scope.excludedQuestionNumbers.size > 0 && baseNum !== null) {
    if (scope.excludedQuestionNumbers.has(baseNum)) return false;
  }
  if (scope.type !== 'questions') return true;
  if (baseNum === null) return false;
  if (scope.questionNumbers && scope.questionNumbers.size > 0) {
    return scope.questionNumbers.has(baseNum);
  }
  if (scope.minQuestion !== undefined && baseNum < scope.minQuestion) return false;
  if (scope.maxQuestion !== undefined && baseNum > scope.maxQuestion) return false;
  return true;
}

export function hasValidMappedQuestions(result: any): boolean {
  if (!result) return false;
  if (Array.isArray(result.questions) && result.questions.some((q: any) => extractBaseQuestionNum(q?.questionNumber) !== null)) {
    return true;
  }
  return false;
}

function questionHasStudentWork(q: any): boolean {
  if (!q) return false;
  if (q.hasStudentDrawing === true) return true;
  if (typeof q.studentWork === 'string' && q.studentWork.trim().length > 0) return true;
  if (Array.isArray(q.studentWorkLines) && q.studentWorkLines.some((l: any) => {
    const t = (l?.text ?? l?.t ?? '').trim();
    return t.length > 0;
  })) return true;
  if (Array.isArray(q.subQuestions) && q.subQuestions.some((sq: any) => questionHasStudentWork(sq))) {
    return true;
  }
  return false;
}

/**
 * Applies explicit user scope filtering and unscoped blank-question-page preservation
 * to classification results before meta-page collection.
 *
 * Rules:
 * 1. If explicit user scope is present:
 *    - Exclude pages/questions outside the scope (reclassify to 'metadata', mark `_excludedByScope = true`).
 *    - In-scope blank question pages when student work exists stay in Marking Mode.
 * 2. If NO explicit user scope is present:
 *    - If 100% of the paper is blank (`hasAnyStudentWork === false`): do nothing so `All question-only` routing is preserved.
 *    - If student work exists (`hasAnyStudentWork === true` and not ejectedPureReferenceFiles):
 *      NEVER reclassify a page to 'metadata' (or add to [PIPELINE-META]) if the Mapper assigned valid question number(s) to it.
 *      Promote blank question pages to `questionAnswer` (tagged `_isBlankQuestionPage = true` and `q.isUnattempted = true`)
 *      so they enter Marking Mode (and short-circuit to 0/max) and the denominator reflects the full exam.
 *      Only blank pages with NO mapped questions are reclassified to 'metadata'.
 */
export function applyScopeAndBlankPageHandling(params: {
  allClassificationResults: Array<{ pageIndex: number; result: any }>;
  markingScope: MarkingScope | null;
  hasAnyStudentWork: boolean;
  ejectedPureReferenceFiles: boolean;
}): {
  excludedPageIndices: number[];
  preservedBlankQuestionPageIndices: number[];
} {
  const { allClassificationResults, markingScope, hasAnyStudentWork, ejectedPureReferenceFiles } = params;
  const excludedPageIndices: number[] = [];
  const preservedBlankQuestionPageIndices: number[] = [];

  // 1. Apply explicit user scope filtering first (before meta-page filtering)
  if (markingScope) {
    for (const item of allClassificationResults) {
      if (!item.result) continue;
      const oneBasedPage = item.pageIndex + 1;

      if (markingScope.type === 'pages') {
        if (!isPageInScope(oneBasedPage, markingScope)) {
          const existingQs = Array.isArray(item.result.questions)
            ? item.result.questions.map((q: any) => String(q.questionNumber || '')).filter(Boolean)
            : [];
          if (existingQs.length > 0) {
            item.result.mapperHints = [...new Set([...(item.result.mapperHints || []), ...existingQs])];
          }
          item.result._excludedByScope = true;
          item.result.category = 'metadata';
          item.result.questions = [];
          excludedPageIndices.push(item.pageIndex);
          continue;
        }
      } else if (markingScope.type === 'questions') {
        if (Array.isArray(item.result.questions) && item.result.questions.length > 0) {
          const kept = item.result.questions.filter((q: any) => isQuestionInScope(q.questionNumber, markingScope));
          if (kept.length === 0) {
            const existingQs = item.result.questions.map((q: any) => String(q.questionNumber || '')).filter(Boolean);
            item.result.mapperHints = [...new Set([...(item.result.mapperHints || []), ...existingQs])];
            item.result._excludedByScope = true;
            item.result.category = 'metadata';
            item.result.questions = [];
            excludedPageIndices.push(item.pageIndex);
            continue;
          } else if (kept.length !== item.result.questions.length) {
            item.result.questions = kept;
          }
        }
      }

      // Scoped Marking Rule: When ANY markingScope is active (pages, questions, or attempted_only)
      // and the paper has student work, ONLY include attempted/marked questions in the denominator
      // and NEVER produce "Not attempted" annotations on blank questions or blank pages.
      if (hasAnyStudentWork) {
        if (item.result.category === 'questionOnly' || item.result._isBlankMappedPage) {
          const existingQs = Array.isArray(item.result.questions)
            ? item.result.questions.map((q: any) => String(q.questionNumber || '')).filter(Boolean)
            : [];
          if (existingQs.length > 0) {
            item.result.mapperHints = [...new Set([...(item.result.mapperHints || []), ...existingQs])];
          }
          item.result._excludedByScope = true;
          item.result.category = 'metadata';
          item.result.questions = [];
          if (!excludedPageIndices.includes(item.pageIndex)) {
            excludedPageIndices.push(item.pageIndex);
          }
          continue;
        }

        if (Array.isArray(item.result.questions) && item.result.questions.length > 0) {
          const hasAnyExplicitStudentWorkField = item.result.questions.some(
            (q: any) =>
              q?.studentWork !== undefined ||
              Array.isArray(q?.studentWorkLines) ||
              q?.hasStudentDrawing !== undefined ||
              (Array.isArray(q?.subQuestions) && q.subQuestions.length > 0)
          );
          const attemptedQuestions = item.result.questions.filter(
            (q: any) => !q?.isUnattempted && (questionHasStudentWork(q) || (!hasAnyExplicitStudentWorkField && item.result.category === 'questionAnswer'))
          );
          if (attemptedQuestions.length === 0) {
            const existingQs = item.result.questions.map((q: any) => String(q.questionNumber || '')).filter(Boolean);
            if (existingQs.length > 0) {
              item.result.mapperHints = [...new Set([...(item.result.mapperHints || []), ...existingQs])];
            }
            item.result._excludedByScope = true;
            item.result.category = 'metadata';
            item.result.questions = [];
            if (!excludedPageIndices.includes(item.pageIndex)) {
              excludedPageIndices.push(item.pageIndex);
            }
          } else if (attemptedQuestions.length !== item.result.questions.length) {
            item.result.questions = attemptedQuestions;
          }
        }
      }
    }
  }

  // 2. Non-Scoped Marking Rule: When NO markingScope is active and student work exists,
  // preserve blank question pages in Marking Mode so the denominator reflects the full exam
  // and blank questions display a neutral "Not attempted (0/max)" pill.
  // (When 100% of the uploaded paper is blank, hasAnyStudentWork is false -> preserve All question-only routing!)
  if (!markingScope && hasAnyStudentWork && !ejectedPureReferenceFiles) {
    for (const item of allClassificationResults) {
      if (!item.result || item.result._excludedByScope) continue;
      if (item.result.category === 'questionOnly') {
        if (hasValidMappedQuestions(item.result)) {
          // Keep in Marking Mode — NEVER add to [PIPELINE-META]
          item.result.category = 'questionAnswer';
          item.result._isBlankQuestionPage = true;
          if (Array.isArray(item.result.questions)) {
            item.result.questions.forEach((q: any) => {
              if (!questionHasStudentWork(q)) {
                q.isUnattempted = true;
              }
            });
          }
          preservedBlankQuestionPageIndices.push(item.pageIndex);
        } else {
          // Pure filler/blank page with no mapped question numbers -> safe to reclassify as metadata
          item.result.category = 'metadata';
          item.result.questions = [];
        }
      }
    }
  }

  return { excludedPageIndices, preservedBlankQuestionPageIndices };
}

export interface UploadIntentGeometrySummary {
  totalPages: number;
  handwrittenPageCount: number;
  handwrittenOneBasedPages: number[];
  acceptableQualityPageCount: number;
  detectedSubjectName: string;
  paperCodeHint?: string;
  examBoardHint?: string;
  fileNames: string[];
  hasUploadedMarkingScheme: boolean;
  requiresExternalMarkingScheme: boolean;
}

export interface UploadInstructionIntentResult {
  action: 'PAUSE_FOR_CHECK' | 'MARK_NOW';
  checkType?: 'HANDWRITING_READABILITY' | 'FILE_CONFIRMATION' | 'GENERAL_QUESTION' | null;
  checkReply?: string;
  scope: MarkingScope | null;
}

const SYSTEM_GENERATED_CUSTOM_TEXT_REGEX =
  /^(?:Attached Marking Scheme\b|Marking with AI using General Rubric\b|Mark Paper Anyway\b|Retrying upload\b|Grading\s+.*\(\d+\s*pages\)|Start Marking\b|Mark Attempted Questions Only\b|Mark Full Paper\b)/i;

/**
 * Deterministic check for whether a student's upload instruction is asking to
 * check/confirm handwriting readability or file visibility BEFORE marking (or asking NOT to mark yet).
 */
export function isDeterministicPreCheckPauseIntent(customText?: string): boolean {
  if (!customText || typeof customText !== 'string') return false;
  const text = customText.trim();
  if (text.length < 3 || SYSTEM_GENERATED_CUSTOM_TEXT_REGEX.test(text)) return false;

  // 1. "check hand written only", "check handwriting only", "just check my handwriting", "confirm if you can see the handwriting"
  const checkHandwritingOnly =
    /\b(?:(?:only|just|first)\s+)?(?:check|confirm|verify|see|tell\s+me)\s+(?:if\s+(?:you|u)\s+can\s+(?:see|read)\s+)?(?:the\s+|my\s+)?(?:hand\s*writing|hand\s*written|writing|file|scan|upload)(?:\s+only|\s+first)?\b/i.test(text) &&
    !/\b(?:and\s+(?:then\s+)?(?:mark|grade)|mark\s+(?:my\s+|the\s+)?(?:answers?|questions?|work|paper))\b/i.test(text);

  // 2. "first confirm if u can see the handwriting", "I will send the mark scheme after/first confirm..."
  const waitBeforeMarking =
    /\b(?:first\s+(?:confirm|check|let\s+me\s+know|tell\s+me)|(?:will|gonna|going\s+to)\s+(?:send|upload|attach)\s+(?:the\s+)?(?:mark(?:ing)?\s*scheme|ms)\s+but\s+first)\b/i.test(text) ||
    /\b(?:(?:do\s+not|don'?t)\s+(?:mark|grade)(?:\s+it|\s+this|\s+yet)?|wait\s+before\s+marking|pause\s+marking|no\s+marking\s+yet)\b/i.test(text) ||
    /\bcan\s+(?:you|u)\s+(?:see|read)\s+(?:the\s+|my\s+)?(?:hand\s*writing|hand\s*written|writing)\b/i.test(text);

  return checkHandwritingOnly || waitBeforeMarking;
}

export function buildDeterministicPreCheckReply(
  summary: UploadIntentGeometrySummary
): string {
  const fileLabel = summary.fileNames.length > 0
    ? summary.fileNames.map(f => `"${f}"`).join(', ')
    : 'your uploaded document';
  const pageCountLabel = `${summary.totalPages} page${summary.totalPages === 1 ? '' : 's'}`;
  const paperInfoParts = [
    summary.examBoardHint,
    summary.detectedSubjectName,
    summary.paperCodeHint ? `(${summary.paperCodeHint})` : ''
  ].filter(Boolean);
  const paperDesc = paperInfoParts.length > 0 ? paperInfoParts.join(' ') : 'Academic Exam Paper';

  let handwritingLine = '';
  if (summary.handwrittenPageCount > 0) {
    const samplePages = summary.handwrittenOneBasedPages.slice(0, 12).join(', ');
    const moreSuffix = summary.handwrittenOneBasedPages.length > 12 ? ', ...' : '';
    handwritingLine = `✅ **Handwriting & Readability:** Yes! Your handwriting is **clear and readable** across **${summary.handwrittenPageCount} of ${summary.totalPages} page${summary.totalPages === 1 ? '' : 's'}** (Page${summary.handwrittenOneBasedPages.length === 1 ? '' : 's'} ${samplePages}${moreSuffix}).`;
  } else {
    handwritingLine = `ℹ️ **Handwriting Check:** I can clearly read the printed questions across all **${pageCountLabel}**, though I did not detect handwritten student answers on the pages.`;
  }

  const nextStepLine = summary.requiresExternalMarkingScheme && !summary.hasUploadedMarkingScheme
    ? `📋 **Next Step (${summary.detectedSubjectName}):** I have paused marking as requested (no pages or credits were used). Whenever you're ready, click **Attach Marking Scheme** below to grade against your official mark scheme, or click **Mark with AI (General Mark Scheme)** to grade right away!`
    : `⏸️ **Marking Paused:** I have checked your file without starting the grading process yet (no credits were deducted). Whenever you're ready, choose how you'd like to mark your paper below:`;

  return (
    `🔍 **File & Handwriting Check Complete** (${fileLabel} — ${pageCountLabel})\n\n` +
    `- **Detected Paper:** ${paperDesc}\n` +
    `- ${handwritingLine}\n\n` +
    `${nextStepLine}`
  );
}

/**
 * Interprets the user's upload instruction (`customText`) using a fast structured LLM call
 * (`gemini-3.5-flash-lite` via phase='preFlight') combined with deterministic regex safeguards.
 *
 * Returns:
 * - `action: 'PAUSE_FOR_CHECK'` when the user asks to check handwriting readability / confirm file visibility / not mark yet
 * - `action: 'MARK_NOW'` with optional `scope` (`pages`, `questions` including `excludedQuestionNumbers`, or `attempted_only`)
 */
export async function resolveUploadInstructionIntent(params: {
  customText?: string;
  geometrySummary: UploadIntentGeometrySummary;
  bypassPreCheckPause?: boolean;
  tracker?: any;
}): Promise<UploadInstructionIntentResult> {
  const { customText, geometrySummary, bypassPreCheckPause, tracker } = params;
  if (!customText || typeof customText !== 'string') {
    return { action: 'MARK_NOW', scope: null };
  }
  const trimmed = customText.trim();
  if (trimmed.length < 3 || SYSTEM_GENERATED_CUSTOM_TEXT_REGEX.test(trimmed)) {
    return { action: 'MARK_NOW', scope: parseMarkingScope(trimmed) };
  }

  const deterministicScope = parseMarkingScope(trimmed);
  const deterministicPreCheck = !bypassPreCheckPause && isDeterministicPreCheckPauseIntent(trimmed);

  // If deterministic regex already matched a pure numeric scope (e.g. "only mark pages 1-8", "mark Q1-Q5")
  // and there is no conversational pre-check cue, return immediately in 0ms!
  if (
    deterministicScope &&
    !deterministicPreCheck &&
    trimmed.split(/\s+/).length <= 8 &&
    !/\b(?:hand\s*writing|hand\s*written|confirm|see|read|skip|except|haven'?t\s+learnt|wait)\b/i.test(trimmed)
  ) {
    return {
      action: 'MARK_NOW',
      scope: deterministicScope
    };
  }

  try {
    const { ModelProvider } = await import('../../utils/ModelProvider.js');
    const systemPrompt =
      `You are an intent classifier for an AI Exam Marking system. ` +
      `Analyze the student's upload instruction along with the uploaded document's pre-flight summary, and output ONLY valid JSON matching this schema:\n` +
      `{\n` +
      `  "action": "PAUSE_FOR_CHECK" | "MARK_NOW",\n` +
      `  "checkType": "HANDWRITING_READABILITY" | "FILE_CONFIRMATION" | "GENERAL_QUESTION" | null,\n` +
      `  "checkReply": "string (only when action is PAUSE_FOR_CHECK)",\n` +
      `  "scopeMode": "FULL_PAPER" | "ATTEMPTED_ONLY" | "SPECIFIC_PAGES" | "SPECIFIC_QUESTIONS",\n` +
      `  "includePages": [number],\n` +
      `  "includeQuestions": [number],\n` +
      `  "excludeQuestions": [number],\n` +
      `  "scopeLabel": "string"\n` +
      `}\n\n` +
      `RULES:\n` +
      `1. Set "action": "PAUSE_FOR_CHECK" if the student is asking to:\n` +
      `   - check or confirm if their handwriting is readable/visible (e.g. "check hand written only", "confirm if u can see the handwriting", "is my writing clear?"), OR\n` +
      `   - wait before marking because they will send the mark scheme next, OR\n` +
      `   - explicitly tells you NOT to mark/grade yet.\n` +
      `2. Set "action": "MARK_NOW" if the student wants you to mark/grade their work now.\n` +
      `   - If they ask to mark ONLY the questions/parts they attempted/answered/handwrote, OR say they skipped part of a question (e.g. "only mark the questions I answered", "grade attempted questions only", "skip blank questions", "I skipped question 5 except for the first part"), set "scopeMode": "ATTEMPTED_ONLY" (do NOT put Q5 in "excludeQuestions" if they answered part of Q5 — ATTEMPTED_ONLY will grade the attempted part and automatically exclude the skipped parts!).\n` +
      `   - If they ask to mark specific questions or skip/exclude an ENTIRE question (e.g. "mark Q1 to Q4", "skip all of question 5"), set "scopeMode": "SPECIFIC_QUESTIONS" and populate "includeQuestions" or "excludeQuestions".\n` +
      `   - If they ask to mark specific pages (e.g. "mark pages 1-8"), set "scopeMode": "SPECIFIC_PAGES" and populate "includePages".\n` +
      `   - Otherwise set "scopeMode": "FULL_PAPER".\n` +
      `3. When "action" is "PAUSE_FOR_CHECK", write a warm, concise "checkReply" in Markdown that directly answers their question using the provided Document Pre-Flight Facts (confirming the exact number of pages with readable handwriting, the detected subject/paper code, that marking is paused with 0 credits used, and inviting them to click the button below when ready).`;

    const userPrompt =
      `Student Instruction: "${trimmed}"\n\n` +
      `Document Pre-Flight Facts:\n` +
      `- File(s): ${geometrySummary.fileNames.join(', ') || 'Uploaded Document'}\n` +
      `- Total Pages: ${geometrySummary.totalPages}\n` +
      `- Pages with Readable Handwriting Detected: ${geometrySummary.handwrittenPageCount} of ${geometrySummary.totalPages} (Pages: ${geometrySummary.handwrittenOneBasedPages.join(', ') || 'none'})\n` +
      `- Detected Subject: ${geometrySummary.detectedSubjectName}${geometrySummary.paperCodeHint ? ` (${geometrySummary.paperCodeHint})` : ''}\n` +
      `- Has Mark Scheme Attached: ${geometrySummary.hasUploadedMarkingScheme}\n` +
      `- Requires External Mark Scheme: ${geometrySummary.requiresExternalMarkingScheme}`;

    const llmRes = await ModelProvider.callGeminiText(
      systemPrompt,
      userPrompt,
      'fast',
      true,
      tracker,
      'preFlight'
    );

    const cleanJson = (llmRes.content || '').trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleanJson);

    if (!bypassPreCheckPause && (parsed?.action === 'PAUSE_FOR_CHECK' || deterministicPreCheck)) {
      const reply = (typeof parsed?.checkReply === 'string' && parsed.checkReply.trim().length >= 20)
        ? parsed.checkReply.trim()
        : buildDeterministicPreCheckReply(geometrySummary);
      return {
        action: 'PAUSE_FOR_CHECK',
        checkType: parsed?.checkType || 'HANDWRITING_READABILITY',
        checkReply: reply,
        scope: deterministicScope
      };
    }

    // Build MarkingScope from LLM response (falling back to deterministicScope)
    let llmScope: MarkingScope | null = null;
    const scopeMode = String(parsed?.scopeMode || '').toUpperCase();
    const includePages: number[] = Array.isArray(parsed?.includePages)
      ? parsed.includePages.map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 200)
      : [];
    const includeQuestions: number[] = Array.isArray(parsed?.includeQuestions)
      ? parsed.includeQuestions.map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 200)
      : [];
    const excludeQuestions: number[] = Array.isArray(parsed?.excludeQuestions)
      ? parsed.excludeQuestions.map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 200)
      : [];

    if (scopeMode === 'ATTEMPTED_ONLY') {
      llmScope = {
        type: 'attempted_only',
        ...(excludeQuestions.length > 0 ? { excludedQuestionNumbers: new Set(excludeQuestions) } : {}),
        label: parsed?.scopeLabel || 'Attempted Questions Only'
      };
    } else if (scopeMode === 'SPECIFIC_PAGES' && includePages.length > 0) {
      const sorted = [...new Set(includePages)].sort((a, b) => a - b);
      const isContiguous = sorted.every((p, i) => i === 0 || p === sorted[i - 1] + 1);
      llmScope = {
        type: 'pages',
        ...(isContiguous
          ? { minPage: sorted[0], maxPage: sorted[sorted.length - 1] }
          : { pageNumbers: new Set(sorted) }),
        label: parsed?.scopeLabel || (sorted.length === 1 ? `Page ${sorted[0]}` : `Pages ${sorted[0]}–${sorted[sorted.length - 1]}`)
      };
    } else if (scopeMode === 'SPECIFIC_QUESTIONS' && (includeQuestions.length > 0 || excludeQuestions.length > 0)) {
      const sortedInc = [...new Set(includeQuestions)].sort((a, b) => a - b);
      const sortedExc = [...new Set(excludeQuestions)].sort((a, b) => a - b);
      llmScope = {
        type: 'questions',
        ...(sortedInc.length > 0 ? { questionNumbers: new Set(sortedInc) } : {}),
        ...(sortedExc.length > 0 ? { excludedQuestionNumbers: new Set(sortedExc) } : {}),
        label:
          parsed?.scopeLabel ||
          (sortedInc.length > 0
            ? sortedInc.map(n => `Q${n}`).join(', ')
            : `Excluding ${sortedExc.map(n => `Q${n}`).join(', ')}`)
      };
    }

    return {
      action: 'MARK_NOW',
      scope: llmScope || deterministicScope
    };
  } catch (err) {
    if (deterministicPreCheck) {
      return {
        action: 'PAUSE_FOR_CHECK',
        checkType: 'HANDWRITING_READABILITY',
        checkReply: buildDeterministicPreCheckReply(geometrySummary),
        scope: deterministicScope
      };
    }
    return {
      action: 'MARK_NOW',
      scope: deterministicScope
    };
  }
}
