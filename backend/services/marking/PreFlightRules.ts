import { isRecognizedAcademicSubject, type GeometryAnalysisResult } from './ImageGeometryService.js';
import {
  collapseCompatibleSubjectAliases,
  hasUnofficialPaperIndicators,
  hasVerifiedUnofficialGeometryFlag
} from './MarkingHelpers.js';

export type SupportedUserPlan = 'free' | 'pro' | 'ultra' | 'admin_test';

export interface ResolvedPageLimits {
  userPlan: SupportedUserPlan;
  isFreeUser: boolean;
  isProOrUltra: boolean;
  maxPagesLimit: number;
  maxFreePages: number;
  maxRawCombinedPages: number;
  effectiveMaxPages: number;
}

export interface PageLimitCheckResult {
  exceeded: boolean;
  code?: 'PDF_PAGE_LIMIT_EXCEEDED' | 'FREE_PAGE_LIMIT_EXCEEDED';
  limit?: number;
  shortTitle?: string;
}

/**
 * Single source of truth for upload & grading page limits across Pre-Inspect and MarkingPipelineService.
 */
export function resolvePageLimits(userId?: string | null, userPlanRaw?: string | null): ResolvedPageLimits {
  const rawPlan = (userPlanRaw || 'free').trim();
  const userPlan: SupportedUserPlan =
    rawPlan === 'pro' || rawPlan === 'ultra' || rawPlan === 'admin_test' ? rawPlan : 'free';
  const normalizedUserId = userId && userId !== 'anonymous' && !String(userId).startsWith('guest:') ? userId : undefined;
  const isFreeUser = !normalizedUserId || userPlan === 'free';
  const isProOrUltra = Boolean(
    normalizedUserId && (userPlan === 'pro' || userPlan === 'ultra' || userPlan === 'admin_test')
  );

  const maxPagesLimit = isProOrUltra
    ? Number.MAX_SAFE_INTEGER
    : parseInt(process.env.MAX_UPLOAD_PAGES || '50', 10);
  const maxFreePages = parseInt(process.env.MAX_FREE_PAGES || '50', 10);
  const maxRawCombinedPages = isProOrUltra
    ? Number.MAX_SAFE_INTEGER
    : parseInt(process.env.MAX_RAW_UPLOAD_PAGES || '100', 10);
  const effectiveMaxPages = isProOrUltra
    ? Number.MAX_SAFE_INTEGER
    : (isFreeUser ? Math.min(maxFreePages, maxPagesLimit) : maxPagesLimit);

  return {
    userPlan,
    isFreeUser,
    isProOrUltra,
    maxPagesLimit,
    maxFreePages,
    maxRawCombinedPages,
    effectiveMaxPages,
  };
}

/**
 * Deterministic check for raw combined page limit (default 100 pages for non-Pro/Ultra).
 */
export function checkRawCombinedPageLimit(totalRawPages: number, limits: ResolvedPageLimits): PageLimitCheckResult {
  if (!limits.isProOrUltra && totalRawPages > limits.maxRawCombinedPages) {
    return {
      exceeded: true,
      code: 'PDF_PAGE_LIMIT_EXCEEDED',
      limit: limits.maxRawCombinedPages,
      shortTitle: `${totalRawPages} pages uploaded — max ${limits.maxRawCombinedPages} raw pages per upload`,
    };
  }
  return { exceeded: false };
}

/**
 * Deterministic check for student page grading limit (default 50 student pages for Free/non-Pro; Mark Scheme pages exempt).
 */
export function checkStudentPageLimit(studentPageCount: number, limits: ResolvedPageLimits): PageLimitCheckResult {
  if (limits.isFreeUser && studentPageCount > limits.maxFreePages) {
    return {
      exceeded: true,
      code: 'FREE_PAGE_LIMIT_EXCEEDED',
      limit: limits.maxFreePages,
      shortTitle: `${studentPageCount} student pages — Free limit is ${limits.maxFreePages} pages (split or upgrade to Pro)`,
    };
  }
  if (!limits.isProOrUltra && studentPageCount > limits.maxPagesLimit) {
    return {
      exceeded: true,
      code: 'PDF_PAGE_LIMIT_EXCEEDED',
      limit: limits.maxPagesLimit,
      shortTitle: `${studentPageCount} student pages — max ${limits.maxPagesLimit} pages per submission`,
    };
  }
  return { exceeded: false };
}

/**
 * Single source of truth for identifying academic non-Maths/English pages that require a mark scheme
 * (or AI General Rubric / cataloged official DB scheme). Excludes NON_ACADEMIC, unreadable, and mark scheme pages.
 */
export function filterAcademicUnsupportedPages(geometryResults: Array<GeometryAnalysisResult | undefined>): GeometryAnalysisResult[] {
  return geometryResults.filter(
    (g): g is GeometryAnalysisResult =>
      Boolean(g) &&
      g!.is_acceptable_quality !== false &&
      g!.is_supported_doc === false &&
      !g!.is_marking_scheme &&
      g!.detected_subject !== 'NON_ACADEMIC' &&
      !/not educational|please upload an academic exam|non-academic/i.test(g!.rejection_reason || '') &&
      (g!.detected_subject === 'ENGLISH_LITERATURE' ||
        (g!.detected_subject === 'UNSUPPORTED_SUBJECT' && isRecognizedAcademicSubject(g!.unsupported_subject_name)))
  );
}

/**
 * In a multi-page upload where the majority of non-scheme academic pages belong to a built-in supported
 * subject (MATHS or ENGLISH_LANGUAGE) and the unsupported page count is below the multi-page consensus
 * rejection threshold (< 2 pages AND < 40% of non-scheme pages), rescue the minority academic page(s)
 * in-place so a single Mechanics/word-problem page in the middle of a Maths paper is never silently dropped.
 */
export function rescueMinorityUnsupportedPagesInSupportedBatch(
  geometryResults: Array<GeometryAnalysisResult | undefined>
): { rescuedCount: number; dominantSupportedSubject?: 'MATHS' | 'ENGLISH_LANGUAGE' } {
  const nonSchemeGeos = geometryResults.filter(
    (g): g is GeometryAnalysisResult => Boolean(g) && !g!.is_marking_scheme && g!.is_acceptable_quality !== false
  );
  if (nonSchemeGeos.length < 2) {
    return { rescuedCount: 0 };
  }

  const unsupportedPages = filterAcademicUnsupportedPages(geometryResults);
  if (unsupportedPages.length === 0) {
    return { rescuedCount: 0 };
  }

  const unsupportedRatio = unsupportedPages.length / Math.max(1, nonSchemeGeos.length);
  if (unsupportedPages.length >= 2 || unsupportedRatio >= 0.4) {
    return { rescuedCount: 0 };
  }

  const mathsCount = nonSchemeGeos.filter(
    (g) => g.is_supported_doc !== false && (g.detected_subject === 'MATHS' || !g.detected_subject)
  ).length;
  const engLangCount = nonSchemeGeos.filter(
    (g) => g.is_supported_doc !== false && g.detected_subject === 'ENGLISH_LANGUAGE'
  ).length;

  if (mathsCount === 0 && engLangCount === 0) {
    return { rescuedCount: 0 };
  }

  const dominantSupportedSubject: 'MATHS' | 'ENGLISH_LANGUAGE' =
    engLangCount > mathsCount ? 'ENGLISH_LANGUAGE' : 'MATHS';

  let rescuedCount = 0;
  for (const g of unsupportedPages) {
    g.is_supported_doc = true;
    g.detected_subject = dominantSupportedSubject;
    g.unsupported_subject_name = undefined;
    g.rejection_reason = undefined;
    rescuedCount++;
  }

  return { rescuedCount, dominantSupportedSubject };
}

/**
 * Collapse compatible subject aliases from unsupported academic geometry results.
 */
export function extractDistinctUnsupportedSubjects(unsupportedPages: GeometryAnalysisResult[]): string[] {
  return collapseCompatibleSubjectAliases(
    unsupportedPages
      .map((g) =>
        g?.detected_subject === 'ENGLISH_LITERATURE'
          ? 'English Literature'
          : (g?.unsupported_subject_name || '').trim()
      )
      .filter(Boolean)
  );
}

/**
 * Extract normalized full official paper codes (e.g. "1MA1/2H", "8700/1", "J560/01") and return unique list.
 */
export function normalizeFullPaperCode(code?: string): string | undefined {
  if (!code) return undefined;
  const m = code.toUpperCase().match(/\b([0-9A-Z]{3,6}\/[0-9A-Z]{1,3})\b/);
  return m ? m[1] : undefined;
}

export function findDistinctFullPaperCodes(codes: Array<string | undefined>): string[] {
  const unique = new Set<string>();
  for (const raw of codes) {
    const normalized = normalizeFullPaperCode(raw);
    if (normalized) unique.add(normalized);
  }
  return Array.from(unique);
}

/**
 * Shared auto-cataloged official Mark Scheme DB lookup used by both Pre-Inspect and MarkingPipelineService.
 * Skips lookup for unofficial/practice papers.
 */
export async function lookupCatalogedOfficialSchemeIfEligible(params: {
  geometryResults: Array<GeometryAnalysisResult | undefined>;
  unsupportedPages: GeometryAnalysisResult[];
  distinctUnsupportedSubjects: string[];
  customText?: string;
}): Promise<{ catalogedScheme: any | null; skippedUnofficial: boolean }> {
  const { geometryResults, unsupportedPages, distinctUnsupportedSubjects, customText } = params;
  if (unsupportedPages.length === 0 || distinctUnsupportedSubjects.length > 1) {
    return { catalogedScheme: null, skippedUnofficial: false };
  }

  const hasGeometryUnofficialFlag = hasVerifiedUnofficialGeometryFlag(geometryResults);
  const combinedGeoHints = [
    ...geometryResults.map((g) => g?.paper_code_hint || ''),
    ...geometryResults.map((g) => g?.evidence_text_snippet || ''),
    ...geometryResults.map((g) => g?.unofficial_reason || ''),
    customText || '',
  ]
    .filter(Boolean)
    .join(' ');

  if (hasGeometryUnofficialFlag || hasUnofficialPaperIndicators(combinedGeoHints)) {
    return { catalogedScheme: null, skippedUnofficial: true };
  }

  try {
    const primarySubjName = distinctUnsupportedSubjects[0] || unsupportedPages[0]?.unsupported_subject_name || undefined;
    const fullSeriesMatch = combinedGeoHints.match(/\b((?:June|May|Summer|November|Autumn|January|Winter)\s+20\d{2})\b/i);
    const yearOnlyMatch = combinedGeoHints.match(/\b(20\d{2})\b/);
    const examSeriesHint = fullSeriesMatch?.[1] || yearOnlyMatch?.[1];

    const { MarkingSchemeParserService } = await import('./MarkingSchemeParserService.js');
    const catalogedScheme = await MarkingSchemeParserService.findCatalogedSchemeByPaperHint(
      combinedGeoHints,
      primarySubjName,
      examSeriesHint
    );
    return { catalogedScheme: catalogedScheme || null, skippedUnofficial: false };
  } catch {
    return { catalogedScheme: null, skippedUnofficial: false };
  }
}
