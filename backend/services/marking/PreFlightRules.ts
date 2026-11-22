import {
  isRecognizedAcademicSubject,
  sanitizePageLayout,
  type GeometryAnalysisResult,
  type PageLayoutType
} from './ImageGeometryService.js';
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

const ONENOTE_PRINTOUT_SIGNATURE_REGEX = /\b(?:onenote|new\s+section\s+\d+\s+page\s+\d+|printout\s+\d{1,2}\s+[a-z]+\s+\d{4})\b/i;

export function hasOneNotePrintoutSignature(text?: string): boolean {
  if (!text) return false;
  return ONENOTE_PRINTOUT_SIGNATURE_REGEX.test(text);
}

export interface DocumentLayoutPolicyResult {
  /** True ONLY when multi-signal corroboration confirms an unsupported OneNote / asymmetric / drifting-gutter canvas layout. */
  shouldRejectUnsupportedLayout: boolean;
  /** True when explicit OneNote Printout indicators contributed to the rejection. */
  isOneNoteDetected: boolean;
  /** Human-readable technical reason for logging. */
  rejectionReason?: string;
  /** Resolved per-page split layout (1:1 aligned with input pages) after batch-consistency & zero-false-alarm guards. */
  effectivePageLayouts: PageLayoutType[];
  /** True when the batch is a majority 1x2 landscape spread batch. */
  isMajoritySpreadBatch: boolean;
}

/**
 * Single source of truth for document-level layout policy across Pre-Inspect and MarkingPipelineService:
 * 1. Rejects unsupported OneNote / asymmetric-whitespace / drifting-gutter canvas exports ONLY when corroborated
 *    (multi-page consensus >= 40% & >= 2 pages, OR explicit OneNote printout signature + stacked/asymmetric evidence,
 *    OR 1-2 page upload where ALL non-scheme pages are flagged AND pixel-level asymmetric whitespace confirms it).
 * 2. Prevents isolated false-positive 2x1 / 2x2 splits on normal 1x1 multi-page papers by requiring >= 2 pages
 *    (or >= 35% of non-scheme pages) before enabling 2x1/2x2 splitting on batches of >= 3 pages.
 * 3. Preserves existing 1x2 landscape spread batch sweep behavior 100%.
 */
export function resolveDocumentLayoutPolicy(params: {
  pages: Array<{ width?: number; height?: number }>;
  geometryResults: Array<GeometryAnalysisResult | undefined>;
  asymmetricCanvasFlags?: boolean[];
  hasExplicitOneNoteCoverOrFooter?: boolean;
}): DocumentLayoutPolicyResult {
  const { pages, geometryResults, asymmetricCanvasFlags = [], hasExplicitOneNoteCoverOrFooter = false } = params;
  const isPageLandscape = (p?: { width?: number; height?: number }) =>
    Boolean(p?.width && p?.height && p.width > p.height * 1.1);

  const nonSchemeIndices = pages
    .map((_, idx) => idx)
    .filter(idx => {
      const g = geometryResults[idx];
      if (!g) return false;
      if (g.is_marking_scheme) return false;
      if (g.detected_subject === 'NON_ACADEMIC') return false;
      return true;
    });

  const getRawLayout = (idx: number): PageLayoutType => {
    const g = geometryResults[idx];
    if (!g) return '1x1';
    const isLand = isPageLandscape(pages[idx]);
    const sanitized = sanitizePageLayout({
      rawPageLayout: g.page_layout,
      rawIsTwoPageSpread: g.is_two_page_spread,
      isPhysicallyLandscape: isLand
    }).pageLayout;
    // Deterministic upgrade: a '2x1' vertical stack squeezed into only one half of the sheet
    // (opposite 45% is blank white canvas) is an asymmetric OneNote-style canvas, not a full-width 2x1.
    if (sanitized === '2x1' && asymmetricCanvasFlags[idx]) {
      return 'unsupported_canvas';
    }
    return sanitized;
  };

  // 1. Check for OneNote / Asymmetric Whitespace / Drifting-Gutter unsupported canvas
  const unsupportedCanvasIndices = nonSchemeIndices.filter(idx => getRawLayout(idx) === 'unsupported_canvas');
  const asymmetricPixelIndices = nonSchemeIndices.filter(idx => Boolean(asymmetricCanvasFlags[idx]));
  const anyOneNoteTextSignature =
    hasExplicitOneNoteCoverOrFooter ||
    geometryResults.some(g =>
      hasOneNotePrintoutSignature(`${g?.evidence_text_snippet || ''} ${g?.unsupported_layout_reason || ''} ${g?.rejection_reason || ''}`)
    );

  const nonSchemeCount = nonSchemeIndices.length;
  const unsupportedRatio = nonSchemeCount > 0 ? unsupportedCanvasIndices.length / nonSchemeCount : 0;
  const asymmetricPixelRatio = nonSchemeCount > 0 ? asymmetricPixelIndices.length / nonSchemeCount : 0;

  let shouldRejectUnsupportedLayout = false;
  let rejectionReason: string | undefined;

  if (nonSchemeCount >= 3) {
    if (unsupportedCanvasIndices.length >= 2 && unsupportedRatio >= 0.4) {
      shouldRejectUnsupportedLayout = true;
      rejectionReason = `Unsupported multi-page canvas layout detected on ${unsupportedCanvasIndices.length}/${nonSchemeCount} pages (asymmetric whitespace / drifting page breaks).`;
    } else if (anyOneNoteTextSignature && (unsupportedCanvasIndices.length >= 1 || asymmetricPixelRatio >= 0.4)) {
      shouldRejectUnsupportedLayout = true;
      rejectionReason = `OneNote Printout layout detected with asymmetric whitespace / stacked pages (${asymmetricPixelIndices.length}/${nonSchemeCount} asymmetric pages).`;
    }
  } else if (nonSchemeCount >= 1) {
    const allFlaggedUnsupported = unsupportedCanvasIndices.length === nonSchemeCount;
    const hasPixelOrOneNoteCorroboration =
      asymmetricPixelIndices.length === nonSchemeCount || anyOneNoteTextSignature;
    // Also catch sampled pre-inspect batches (e.g. 2 content pages + 1 OneNote Printout cover page)
    // where deterministic OneNote signature + pixel-level asymmetric whitespace both agree.
    const oneNotePlusAsymmetricPixels =
      anyOneNoteTextSignature && asymmetricPixelIndices.length >= 1 && asymmetricPixelRatio >= 0.5;
    if ((allFlaggedUnsupported && hasPixelOrOneNoteCorroboration) || oneNotePlusAsymmetricPixels) {
      shouldRejectUnsupportedLayout = true;
      rejectionReason = anyOneNoteTextSignature
        ? `OneNote Printout layout detected with shrunk/asymmetric pages (${asymmetricPixelIndices.length}/${nonSchemeCount} asymmetric).`
        : 'Unsupported asymmetric multi-page canvas layout detected.';
    }
  }

  // 2. Compute symmetric grid batch sweeps (1x2, 2x1, 2x2) with false-positive guards
  const spread1x2Count = nonSchemeIndices.filter(
    idx => getRawLayout(idx) === '1x2' && isPageLandscape(pages[idx])
  ).length;
  const isMajoritySpreadBatch =
    nonSchemeCount >= 3 && (spread1x2Count / nonSchemeCount) >= 0.5;

  const count2x1 = nonSchemeIndices.filter(idx => getRawLayout(idx) === '2x1').length;
  const count2x2 = nonSchemeIndices.filter(idx => getRawLayout(idx) === '2x2').length;

  const allow2x1Batch = nonSchemeCount < 3 || (count2x1 >= 2 && (count2x1 / nonSchemeCount) >= 0.35);
  const isMajority2x1Batch = nonSchemeCount >= 3 && (count2x1 / nonSchemeCount) >= 0.5;

  const allow2x2Batch = nonSchemeCount < 3 || (count2x2 >= 2 && (count2x2 / nonSchemeCount) >= 0.35);
  const isMajority2x2Batch = nonSchemeCount >= 3 && (count2x2 / nonSchemeCount) >= 0.5;

  const effectivePageLayouts: PageLayoutType[] = pages.map((p, idx) => {
    const g = geometryResults[idx];
    if (!g || g.is_marking_scheme || g.detected_subject === 'NON_ACADEMIC') {
      return '1x1';
    }
    const rawLayout = getRawLayout(idx);
    const isLand = isPageLandscape(p);

    if (rawLayout === 'unsupported_canvas') {
      return shouldRejectUnsupportedLayout ? 'unsupported_canvas' : '1x1';
    }
    if (rawLayout === '1x2' || (isMajoritySpreadBatch && isLand)) {
      return isLand ? '1x2' : '1x1';
    }
    if (rawLayout === '2x2') {
      return allow2x2Batch ? '2x2' : '1x1';
    }
    if (isMajority2x2Batch) {
      return '2x2';
    }
    if (rawLayout === '2x1') {
      return allow2x1Batch ? '2x1' : '1x1';
    }
    if (isMajority2x1Batch && !isLand) {
      return '2x1';
    }
    return '1x1';
  });

  return {
    shouldRejectUnsupportedLayout,
    isOneNoteDetected: anyOneNoteTextSignature,
    rejectionReason,
    effectivePageLayouts,
    isMajoritySpreadBatch
  };
}

export function formatUnsupportedLayoutMessage(isOneNoteDetected: boolean): string {
  const sourceHint = isOneNoteDetected
    ? 'a **OneNote Printout** export where multiple exam pages are shrunk into one column with large empty margins and split page breaks'
    : 'a **shrunk / asymmetric multi-page canvas** (such as a OneNote Printout) where exam pages are pushed to one side or sliced across page breaks';

  return (
    `### Unsupported Page Layout Detected\n\n` +
    `This upload looks like ${sourceHint}. Because the exam pages are scaled down and cut mid-question across sheets, the text and handwriting become too small to mark accurately.\n\n` +
    `### How to Fix & Re-Upload\n` +
    `- **From OneNote:** Upload your original annotated PDF directly, or set OneNote's **Paper Size** to **A4 (1 page per sheet)** instead of Auto / Infinite Canvas before exporting to PDF.\n` +
    `- **From Print to PDF:** Choose **1 page per sheet (100% scale)** (standard 2-up \`1×2\`, \`2×1\`, or 4-up \`2×2\` full-sheet grids are also supported).\n` +
    `- **From Phone / Tablet Photos:** Upload **1 full exam page per photo** (or a clean side-by-side 2-page spread).\n\n` +
    `No credits were charged for this check. Click **Upload Corrected File** below to try again.`
  );
}

export function formatPreInspectUnsupportedLayoutBanner(isOneNoteDetected: boolean): {
  bannerTitle: string;
  bannerMessage: string;
} {
  if (isOneNoteDetected) {
    return {
      bannerTitle: 'OneNote Printout layout not supported — export 1 page per sheet (A4)',
      bannerMessage: 'Multiple exam pages are shrunk into one column with large empty margins and split page breaks. Upload the original PDF or set OneNote Paper Size to A4 (1 page per sheet) before exporting.'
    };
  }
  return {
    bannerTitle: 'Unsupported shrunk / asymmetric page layout — export 1 page per sheet',
    bannerMessage: 'Exam pages are scaled down into one side of the sheet or sliced across page breaks, making handwriting too small to mark accurately. Re-export at 100% scale (1 page per sheet) and upload again.'
  };
}
