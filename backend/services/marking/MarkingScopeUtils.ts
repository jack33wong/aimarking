/**
 * Scope-Aware Blank Question Page Handling Utilities
 *
 * Parses explicit user scope instructions from Student Input (e.g.,
 * "only mark to page 8", "mark Q1-Q12", "pages 1 to 6", "mark questions 1-10")
 * and applies scope-aware classification filtering before meta-page collection.
 */

export interface MarkingScope {
  type: 'pages' | 'questions';
  minPage?: number; // 1-based inclusive
  maxPage?: number; // 1-based inclusive
  minQuestion?: number; // 1-based inclusive
  maxQuestion?: number; // 1-based inclusive
  questionNumbers?: Set<number>;
  label: string; // e.g., "Pages 1–8", "Q1–Q12", "Page 4", "Q3, Q5, Q7"
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

  return null;
}

export function isPageInScope(oneBasedPage: number, scope: MarkingScope): boolean {
  if (scope.type !== 'pages') return true;
  if (scope.minPage !== undefined && oneBasedPage < scope.minPage) return false;
  if (scope.maxPage !== undefined && oneBasedPage > scope.maxPage) return false;
  return true;
}

export function isQuestionInScope(questionNumber: string | number | undefined, scope: MarkingScope): boolean {
  if (scope.type !== 'questions') return true;
  const baseNum = extractBaseQuestionNum(questionNumber);
  if (baseNum === null) return false;
  if (scope.questionNumbers) {
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
          } else if (kept.length !== item.result.questions.length) {
            item.result.questions = kept;
          }
        }
      }
    }
  }

  // 2. Preserve blank question pages in Marking Mode whenever student work exists
  // (When 100% of the uploaded paper is blank, hasAnyStudentWork is false -> preserve All question-only routing!)
  if (hasAnyStudentWork && !ejectedPureReferenceFiles) {
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
