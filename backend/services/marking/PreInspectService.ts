import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { ImageGeometryService, type GeometryAnalysisResult } from './ImageGeometryService.js';
import { PdfProcessingService } from '../pdf/PdfProcessingService.js';
import { ImageUtils } from '../../utils/ImageUtils.js';
import { UsageTracker } from '../../utils/UsageTracker.js';
import { AdminAlertService } from '../AdminAlertService.js';
import { UserFacingError } from '../../utils/UserFacingError.js';
import { hasVerifiedUnofficialGeometryFlag } from './MarkingHelpers.js';
import {
  resolvePageLimits,
  checkRawCombinedPageLimit,
  checkStudentPageLimit,
  filterAcademicUnsupportedPages,
  extractDistinctUnsupportedSubjects,
  normalizeFullPaperCode,
  findDistinctFullPaperCodes,
  lookupCatalogedOfficialSchemeIfEligible,
  rescueMinorityUnsupportedPagesInSupportedBatch,
  type ResolvedPageLimits,
} from './PreFlightRules.js';

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

export interface PreInspectResponse {
  preInspectToken: string;
  overallStatus: PreInspectOverallStatus;
  docType: PreInspectDocType;
  isWarning: boolean;
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
  usage: {
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
    costUsd: number;
  };
  durationMs: number;
}

export interface PreInspectUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  requestCount: number;
  costUsd: number;
  modelsUsed: string[];
}

interface CachedPreInspectFileEntry {
  sha256: string;
  originalName: string;
  pageCount: number;
  sampledPages: number[];
  geometryByPageIndex: Map<number, GeometryAnalysisResult>;
  expiresAt: number;
}

interface CachedPreInspectEntry {
  token: string;
  userId: string;
  digestSessionId: string;
  createdAt: number;
  expiresAt: number;
  files: CachedPreInspectFileEntry[];
  usageSnapshot: PreInspectUsageSnapshot;
  consumed: boolean;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_ENTRIES = 500;
const MAX_INSPECTED_IMAGES = 2;

export function selectStrategicPdfPageIndices(pageCount: number): number[] {
  if (pageCount <= 1) return [0];
  if (pageCount === 2) return [0, 1];
  if (pageCount === 3) return [0, 1, 2];
  // 4+ pages: Page 1 (cover/code), Page 3 (first inner question page in UK booklets), Middle page
  const mid = Math.floor(pageCount / 2);
  const set = new Set<number>([0, 2, mid]);
  return Array.from(set)
    .filter((i) => i >= 0 && i < pageCount)
    .sort((a, b) => a - b);
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pickBestPaperCode(hints: Array<string | undefined>): string | undefined {
  const cleaned = hints.map((h) => (h || '').trim()).filter(Boolean);
  if (cleaned.length === 0) return undefined;
  // Prefer full official paper codes like "1MA1/2H", "8700/2", "J560/01", "7357/2" over partial fragments like "2H"
  const fullCode = cleaned.find((c) => /\b[0-9A-Z]{3,6}\/[0-9A-Z]{1,3}\b/i.test(c));
  if (fullCode) {
    return fullCode.match(/\b([0-9A-Z]{3,6}\/[0-9A-Z]{1,3})\b/i)?.[1]?.toUpperCase() || fullCode;
  }
  return cleaned.sort((a, b) => b.length - a.length)[0];
}

function normalizeExamBoard(raw?: string): string | undefined {
  if (!raw) return undefined;
  const clean = raw.trim();
  if (!clean) return undefined;
  if (/pearson|edexcel/i.test(clean)) return 'Pearson Edexcel';
  if (/\baqa\b/i.test(clean)) return 'AQA';
  if (/\bocr\b/i.test(clean)) return 'OCR';
  if (/eduqas/i.test(clean)) return 'WJEC Eduqas';
  if (/\bwjec\b/i.test(clean)) return 'WJEC';
  if (/cambridge|\bcie\b|\bcaie\b/i.test(clean)) return 'CIE';
  if (/\bib\b|international baccalaureate/i.test(clean)) return 'IB';
  return clean;
}

export function inferExamBoardFromPaperCode(paperCode?: string): string | undefined {
  if (!paperCode) return undefined;
  const code = paperCode.trim().toUpperCase();
  if (/^(1MA1|9MA0|8MA0|1EN0|1ET0|1BI0|1CH0|1PH0|1SC0|4MA1|WMA|WME|WST|WFM|WDM)/.test(code)) {
    return 'Pearson Edexcel';
  }
  if (/^(8300|8700|8702|8461|8462|8463|8464|7357|7356|7402|7405|7408)/.test(code)) {
    return 'AQA';
  }
  if (/^(J560|J351|J352|J247|J248|J249|J250|H240|H230|H640)/.test(code)) {
    return 'OCR';
  }
  if (/^(C300|C700|C720)/.test(code)) {
    return 'WJEC Eduqas';
  }
  if (/^(0580|0606|0620|0625|0610|9709|9700|9701|9702)/.test(code)) {
    return 'CIE';
  }
  return undefined;
}

function pickExamBoard(boards: Array<string | undefined>, paperCode?: string): string | undefined {
  for (const b of boards) {
    const normalized = normalizeExamBoard(b);
    if (normalized) return normalized;
  }
  return inferExamBoardFromPaperCode(paperCode);
}

function formatSubjectLabel(geo?: GeometryAnalysisResult): string | undefined {
  if (!geo) return undefined;
  if (geo.detected_subject === 'MATHS') return 'Mathematics';
  if (geo.detected_subject === 'ENGLISH_LANGUAGE') return 'English Language';
  if (geo.detected_subject === 'ENGLISH_LITERATURE') return 'English Literature';
  if (geo.detected_subject === 'UNSUPPORTED_SUBJECT' && geo.unsupported_subject_name) {
    return geo.unsupported_subject_name.trim();
  }
  return undefined;
}

export class PreInspectService {
  private static cache = new Map<string, CachedPreInspectEntry>();
  /** Per-file cache keyed by `${userId}:${sha256}` so adding/removing a 2nd file is an instant 0ms hit for unchanged files */
  private static fileCache = new Map<string, CachedPreInspectFileEntry>();

  private static sweepExpiredCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }

    for (const [key, entry] of this.fileCache.entries()) {
      if (entry.expiresAt <= now) {
        this.fileCache.delete(key);
      }
    }
    while (this.fileCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.fileCache.keys().next().value;
      if (!oldestKey) break;
      this.fileCache.delete(oldestKey);
    }
  }

  /**
   * Inspect uploaded files on-attach (before Send) in parallel using 1-3 strategic pages per PDF at 96 DPI.
   * Reuses per-file SHA-256 cache for unchanged files, tracks usage in UsageTracker under phase='preInspect',
   * and caches geometry for reuse on Send.
   */
  public static async inspectFiles(params: {
    files: Express.Multer.File[];
    userId: string;
    userPlan?: string;
    digestSessionId: string;
    originalHashes?: string[];
    usageTracker: UsageTracker;
  }): Promise<PreInspectResponse> {
    const startTime = Date.now();
    const { files, userId, userPlan, digestSessionId, originalHashes = [], usageTracker } = params;
    const pageLimits = resolvePageLimits(userId, userPlan);

    this.sweepExpiredCache();
    console.log(`\n🔍 [PRE-INSPECT] Starting pre-inspection for ${files.length} file(s) (user: ${userId}, plan: ${pageLimits.userPlan})...`);

    // ⚡ Stage 0 (0ms, $0 LLM): Deterministic PDF structural & raw page limit checks via shared PreFlightRules + PdfProcessingService
    const preScannedPageCounts: number[] = [];
    let structuralErrorTitle: string | null = null;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
      if (!isPdf) {
        preScannedPageCounts.push(1);
        continue;
      }
      try {
        const pdfDoc = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
        const count = Math.max(1, pdfDoc.getPageCount());
        preScannedPageCounts.push(count);
        if (!pdfDoc.isEncrypted) {
          PdfProcessingService.validateNoContinuousScrollPages(pdfDoc);
        }
      } catch (err: any) {
        if (err instanceof UserFacingError && err.code === 'PDF_CONTINUOUS_PAGE') {
          structuralErrorTitle = 'Continuous-scroll PDF detected — choose Print → Save as PDF (separate A4 pages)';
          break;
        }
        preScannedPageCounts.push(1);
      }
    }

    const totalRawPages = preScannedPageCounts.reduce((sum, n) => sum + n, 0);
    const rawLimitCheck = checkRawCombinedPageLimit(totalRawPages, pageLimits);
    if (structuralErrorTitle || rawLimitCheck.exceeded) {
      const token = `pi-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      const durationMs = Date.now() - startTime;
      const isStructural = Boolean(structuralErrorTitle);
      const bannerTitle = structuralErrorTitle || rawLimitCheck.shortTitle || 'Upload exceeds maximum page limit';
      console.log(`⚠️ [PRE-INSPECT FAST-GATE] Short-circuited in ${durationMs}ms (0 LLM calls): ${bannerTitle}`);
      return {
        preInspectToken: token,
        overallStatus: 'invalid',
        docType: isStructural ? 'pdf_structural_error' : 'page_limit_exceeded',
        isWarning: true,
        hasMarkScheme: false,
        requiresMarkScheme: false,
        hasHandwriting: false,
        bannerTitle,
        bannerMessage: '',
        perFileRoles: files.map((f, idx) => ({
          fileName: f.originalname || `file-${idx + 1}`,
          role: 'unreadable',
          pageCount: preScannedPageCounts[idx] || 1,
          sampledPages: [],
        })),
        suggestions: [{ id: 'replace-file', label: 'Replace file', action: 'replace_file' }],
        usage: { inputTokens: 0, outputTokens: 0, requestCount: 0, costUsd: 0 },
        durationMs,
      };
    }

    // Determine which image files should be inspected (up to MAX_INSPECTED_IMAGES in a loose image batch)
    let imageInspectQuota = 0;
    const shouldInspectImageAtIndex = files.map((file) => {
      const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
      if (isPdf) return false;
      if (imageInspectQuota < MAX_INSPECTED_IMAGES) {
        imageInspectQuota++;
        return true;
      }
      return false;
    });

    // Process all files in PARALLEL (huge latency win for multi-PDF / Paper + MS uploads!)
    const perFileResults = await Promise.all(
      files.map(async (file, fileIdx) => {
        const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
        const fileHash = (originalHashes[fileIdx] && /^[a-f0-9]{64}$/i.test(originalHashes[fileIdx]))
          ? originalHashes[fileIdx].toLowerCase()
          : sha256Hex(file.buffer);
        const fileCacheKey = `${userId}:${fileHash}`;

        // ⚡ Instant 0ms cache hit if this exact file was just inspected recently
        const cachedFile = this.fileCache.get(fileCacheKey);
        if (cachedFile && cachedFile.expiresAt > Date.now() && cachedFile.geometryByPageIndex.size > 0) {
          console.log(`⚡ [PRE-INSPECT CACHE HIT] Reusing recent pre-inspect for "${file.originalname}" (0ms, 0 LLM calls)`);
          const geos = Array.from(cachedFile.geometryByPageIndex.values());
          const summary = this.summarizeSingleFile(
            file.originalname || cachedFile.originalName,
            cachedFile.pageCount,
            cachedFile.sampledPages,
            geos
          );
          return { cachedEntry: cachedFile, summary, geos };
        }

        const geometryByPageIndex = new Map<number, GeometryAnalysisResult>();
        let pageCount = preScannedPageCounts[fileIdx] || 1;
        let sampledPages: number[] = [];
        let pdfStructuralError: string | undefined;

        if (isPdf) {
          // ⚡ Zero-LLM-cost digital Mark Scheme PDF peek (pages 1–2 via Ghostscript in ~15ms):
          // If the PDF has a digital text layer proving it is an official Mark Scheme, sample ONLY Page 0 (1 page instead of 3)
          // to extract the paper code/board, cutting Mark Scheme PDF pre-inspect LLM calls by 67%!
          let isVerifiedDigitalMarkScheme = false;
          try {
            const peek = await PdfProcessingService.peekPdfMarkSchemeMetadata(file.buffer);
            if (peek?.hasTextLayer && peek.isDigitalMarkScheme) {
              isVerifiedDigitalMarkScheme = true;
            }
          } catch {
            // Non-fatal: fall back to standard strategic page sampling
          }

          sampledPages = isVerifiedDigitalMarkScheme ? [0] : selectStrategicPdfPageIndices(pageCount);
          console.log(
            `📄 [PRE-INSPECT] PDF "${file.originalname}" (${pageCount} page(s)${isVerifiedDigitalMarkScheme ? ', digital Mark Scheme detected' : ''}) -> sampling page indices [${sampledPages.join(', ')}] at 96 DPI`
          );

          try {
            const renderedPages = await PdfProcessingService.convertPdfToImages(file.buffer, {
              density: 96,
              selectedPageIndices: sampledPages,
            });

            await Promise.all(
              renderedPages.map(async (page, idx) => {
                const rawPageIdx = sampledPages[idx] ?? page.pageIndex ?? idx;
                const lightImg = page.imageData.length > 260_000
                  ? await ImageUtils.createLightweightCopy(page.imageData, 768)
                  : page.imageData;
                const geo = await ImageGeometryService.analyze(
                  lightImg,
                  page.width,
                  page.height,
                  'fast',
                  usageTracker,
                  'preInspect'
                );
                if (isVerifiedDigitalMarkScheme) {
                  geo.is_marking_scheme = true;
                }
                geometryByPageIndex.set(rawPageIdx, geo);
              })
            );
          } catch (pdfErr: any) {
            if (pdfErr instanceof UserFacingError) {
              pdfStructuralError = pdfErr.code === 'PDF_UNREADABLE'
                ? 'Could not read this PDF (corrupted or password-protected) — try Print → Save as PDF'
                : pdfErr.code === 'PDF_OVERSIZED_PAGE'
                  ? 'PDF has an oversized continuous page — try Print → Save as PDF (A4 pages)'
                  : pdfErr.userMessage.split('\n')[0];
            } else {
              console.warn(`⚠️ [PRE-INSPECT] PDF rasterization failed for "${file.originalname}": ${pdfErr?.message || pdfErr}`);
            }
          }
        } else if (shouldInspectImageAtIndex[fileIdx]) {
          sampledPages = [0];
          const base64DataUrl = `data:${file.mimetype || 'image/jpeg'};base64,${file.buffer.toString('base64')}`;
          const lightImg = file.buffer.length > 350_000
            ? await ImageUtils.createLightweightCopy(base64DataUrl, 768)
            : base64DataUrl;
          const geo = await ImageGeometryService.analyze(
            lightImg,
            undefined,
            undefined,
            'fast',
            usageTracker,
            'preInspect'
          );
          geometryByPageIndex.set(0, geo);
        }

        const geos = Array.from(geometryByPageIndex.values());
        const summary = this.summarizeSingleFile(file.originalname || `file-${fileIdx + 1}`, pageCount, sampledPages, geos);
        const cachedEntry: CachedPreInspectFileEntry = {
          sha256: fileHash,
          originalName: file.originalname || `file-${fileIdx + 1}`,
          pageCount,
          sampledPages,
          geometryByPageIndex,
          expiresAt: Date.now() + CACHE_TTL_MS,
        };
        if (geometryByPageIndex.size > 0) {
          this.fileCache.set(fileCacheKey, cachedEntry);
        }
        return { cachedEntry, summary, geos, pdfStructuralError };
      })
    );

    const cachedFileEntries = perFileResults.map((r) => r.cachedEntry);
    const perFileRoles = perFileResults.map((r) => r.summary);
    const allGeometries = perFileResults.flatMap((r) => r.geos);
    const firstPdfStructuralError = perFileResults.find((r) => (r as any).pdfStructuralError)?.pdfStructuralError;

    const combined = await this.buildCombinedDecision(perFileRoles, allGeometries, pageLimits, firstPdfStructuralError);
    const token = `pi-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const breakdown = usageTracker.getBreakdown().preInspect;
    const costUsd = usageTracker.calculateCost('fast').preInspect;
    const durationMs = Date.now() - startTime;

    const usageSnapshot: PreInspectUsageSnapshot = {
      inputTokens: breakdown.inputTokens,
      outputTokens: breakdown.outputTokens,
      thoughtTokens: breakdown.thoughtTokens || 0,
      requestCount: breakdown.requestCount,
      costUsd,
      modelsUsed: Array.from(breakdown.modelsUsed || []),
    };

    this.cache.set(token, {
      token,
      userId,
      digestSessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + CACHE_TTL_MS,
      files: cachedFileEntries,
      usageSnapshot,
      consumed: false,
    });

    console.log(
      `✅ [PRE-INSPECT] Complete in ${(durationMs / 1000).toFixed(2)}s | status=${combined.overallStatus} | docType=${combined.docType} | board=${combined.examBoard || 'N/A'} | subject=${combined.subject || 'N/A'} | paper=${combined.paperCode || 'N/A'} | reqs=${usageSnapshot.requestCount} | tokens=${(usageSnapshot.inputTokens + usageSnapshot.outputTokens).toLocaleString()} | cost=$${costUsd.toFixed(6)}`
    );

    return {
      preInspectToken: token,
      ...combined,
      perFileRoles,
      usage: {
        inputTokens: usageSnapshot.inputTokens,
        outputTokens: usageSnapshot.outputTokens,
        requestCount: usageSnapshot.requestCount,
        costUsd,
      },
      durationMs,
    };
  }

  /**
   * Reuse cached pre-inspect geometry during the full marking pipeline so we don't pay twice
   * for pages already inspected. Also merges pre-inspect usage into the marking UsageTracker
   * and links the PRE_INSPECT digest turn into the real marking session digest.
   */
  public static consumeCachedGeometry(params: {
    preInspectToken?: string;
    userId?: string;
    files: Express.Multer.File[];
    usageTracker?: UsageTracker;
    targetSessionId?: string;
  }): {
    reusedByFileAndPage: Map<string, GeometryAnalysisResult>;
    reusedPageCount: number;
    mergedUsage?: PreInspectUsageSnapshot;
  } {
    const empty = { reusedByFileAndPage: new Map<string, GeometryAnalysisResult>(), reusedPageCount: 0 };
    const { preInspectToken, userId, files, usageTracker, targetSessionId } = params;
    if (!preInspectToken || typeof preInspectToken !== 'string') return empty;

    this.sweepExpiredCache();
    const entry = this.cache.get(preInspectToken);
    if (!entry) return empty;
    if (entry.userId && userId && entry.userId !== userId) return empty;

    const hashToFileIndices = new Map<string, number[]>();
    const nameToImageFileIndices = new Map<string, number[]>();
    files.forEach((f, idx) => {
      if (f?.buffer) {
        const h = sha256Hex(f.buffer);
        const arr = hashToFileIndices.get(h) || [];
        arr.push(idx);
        hashToFileIndices.set(h, arr);
      }
      const isPdf = f?.mimetype === 'application/pdf' || /\.pdf$/i.test(f?.originalname || '');
      if (!isPdf && f?.originalname) {
        const normName = f.originalname.trim().toLowerCase();
        const nameArr = nameToImageFileIndices.get(normName) || [];
        nameArr.push(idx);
        nameToImageFileIndices.set(normName, nameArr);
      }
    });

    const reusedByFileAndPage = new Map<string, GeometryAnalysisResult>();
    const claimedImageIndices = new Set<number>();

    for (let cachedIdx = 0; cachedIdx < entry.files.length; cachedIdx++) {
      const cachedFile = entry.files[cachedIdx];
      let matchingIndices = hashToFileIndices.get(cachedFile.sha256);

      // Tier 2 Fallback for re-compressed images: on Attach, the frontend sends an 800px compressed JPEG
      // (plus raw SHA-256), whereas on Send it sends a 2000px compressed JPEG whose buffer SHA-256 differs.
      // Match single-page images by normalized originalFileName (preferring same file index) so Pre-Inspect
      // LLM calls on images are 100% reused in Pre-Flight!
      if ((!matchingIndices || matchingIndices.length === 0) && cachedFile.pageCount === 1 && cachedFile.originalName) {
        const normCachedName = cachedFile.originalName.trim().toLowerCase();
        const candidateIndices = (nameToImageFileIndices.get(normCachedName) || []).filter(
          (i) => !claimedImageIndices.has(i)
        );
        if (candidateIndices.length > 0) {
          const preferredIdx = candidateIndices.includes(cachedIdx) ? cachedIdx : candidateIndices[0];
          matchingIndices = [preferredIdx];
          claimedImageIndices.add(preferredIdx);
        }
      }

      if (!matchingIndices || matchingIndices.length === 0) continue;
      for (const fileIdx of matchingIndices) {
        for (const [pageIdx, geo] of cachedFile.geometryByPageIndex.entries()) {
          reusedByFileAndPage.set(`${fileIdx}:${pageIdx}`, { ...geo });
        }
      }
    }

    if (!entry.consumed && usageTracker && entry.usageSnapshot.requestCount > 0) {
      const snap = entry.usageSnapshot;
      const modelId = snap.modelsUsed[0] || 'gemini-3.5-flash-lite';
      usageTracker.recordPreInspect(
        snap.inputTokens,
        snap.outputTokens,
        snap.thoughtTokens,
        modelId,
        snap.costUsd
      );
      entry.consumed = true;
    }

    if (targetSessionId && entry.digestSessionId) {
      AdminAlertService.mergePreInspectDigestIntoSession(entry.digestSessionId, targetSessionId);
    }

    if (reusedByFileAndPage.size > 0) {
      console.log(
        `♻️ [PRE-INSPECT REUSE] Reused cached geometry for ${reusedByFileAndPage.size} page(s) from token ${preInspectToken} (merged preInspect cost: $${entry.usageSnapshot.costUsd.toFixed(6)})`
      );
    }

    return {
      reusedByFileAndPage,
      reusedPageCount: reusedByFileAndPage.size,
      mergedUsage: entry.usageSnapshot,
    };
  }

  private static summarizeSingleFile(
    fileName: string,
    pageCount: number,
    sampledPages: number[],
    geos: GeometryAnalysisResult[]
  ): PreInspectFileSummary {
    if (geos.length === 0) {
      return { fileName, role: 'student_paper', pageCount, sampledPages, inspected: false };
    }

    const paperCode = pickBestPaperCode(geos.map((g) => g.paper_code_hint));
    const examBoard = pickExamBoard(geos.map((g) => g.exam_board), paperCode);
    const subject = geos.map(formatSubjectLabel).find(Boolean);

    const schemeCount = geos.filter((g) => g.is_marking_scheme).length;
    const nonAcademicCount = geos.filter((g) => g.detected_subject === 'NON_ACADEMIC').length;
    const unreadableCount = geos.filter((g) => g.is_acceptable_quality === false).length;
    const coverCount = geos.filter((g) => g.is_cover_page).length;
    const hasHandwriting = geos.some((g) => g.has_handwriting === true && !g.is_cover_page && !g.is_marking_scheme);
    const contentGeos = geos.filter((g) => !g.is_cover_page && !g.is_marking_scheme && g.is_acceptable_quality !== false && g.detected_subject !== 'NON_ACADEMIC');
    const hasPrintedQuestions = contentGeos.length === 0 ? true : contentGeos.some((g) => g.has_printed_questions !== false);
    const requiresMarkScheme = filterAcademicUnsupportedPages(geos).length > 0;
    const isUnofficialPaper = hasVerifiedUnofficialGeometryFlag(geos);

    let role: PreInspectFileRole = 'question_paper';
    if (schemeCount > 0 && schemeCount >= Math.ceil(geos.length / 2)) {
      role = 'mark_scheme';
    } else if (unreadableCount === geos.length) {
      role = 'unreadable';
    } else if (nonAcademicCount === geos.length) {
      role = 'non_academic';
    } else if (coverCount > 0 && coverCount === geos.filter((g) => g.is_acceptable_quality !== false).length && pageCount <= 3) {
      role = 'cover_only';
    } else if (hasHandwriting) {
      role = 'student_paper';
    } else {
      role = 'question_paper';
    }

    return {
      fileName,
      role,
      examBoard,
      subject,
      paperCode,
      pageCount,
      sampledPages,
      inspected: true,
      hasHandwriting,
      hasPrintedQuestions,
      requiresMarkScheme,
      isUnofficialPaper,
    };
  }

  private static async buildCombinedDecision(
    perFileRoles: PreInspectFileSummary[],
    allGeometries: GeometryAnalysisResult[],
    pageLimits: ResolvedPageLimits,
    pdfStructuralError?: string
  ): Promise<Omit<PreInspectResponse, 'preInspectToken' | 'perFileRoles' | 'usage' | 'durationMs'>> {
    if (pdfStructuralError) {
      return {
        overallStatus: 'invalid',
        docType: 'pdf_structural_error',
        isWarning: true,
        hasMarkScheme: false,
        requiresMarkScheme: false,
        hasHandwriting: false,
        bannerTitle: pdfStructuralError,
        bannerMessage: '',
        suggestions: [{ id: 'replace-file', label: 'Replace file', action: 'replace_file' }],
      };
    }

    const schemeFiles = perFileRoles.filter((f) => f.role === 'mark_scheme');
    const nonSchemeFiles = perFileRoles.filter((f) => f.role !== 'mark_scheme');
    let hasMarkScheme = schemeFiles.length > 0 || allGeometries.some((g) => g.is_marking_scheme);
    let hasCatalogedOfficialScheme = false;
    const nonSchemeGeos = allGeometries.filter((g) => !g.is_marking_scheme);

    const paperCode = pickBestPaperCode([
      ...nonSchemeFiles.map((f) => f.paperCode),
      ...perFileRoles.map((f) => f.paperCode),
      ...allGeometries.map((g) => g.paper_code_hint),
    ]);
    const examBoard = pickExamBoard(
      [...nonSchemeFiles.map((f) => f.examBoard), ...perFileRoles.map((f) => f.examBoard), ...allGeometries.map((g) => g.exam_board)],
      paperCode
    );
    const subject = nonSchemeFiles.find((f) => f.subject)?.subject
      || perFileRoles.find((f) => f.subject)?.subject
      || allGeometries.map(formatSubjectLabel).find(Boolean);

    const hasHandwriting = nonSchemeGeos.some((g) => g.has_handwriting === true && !g.is_cover_page);
    const contentNonSchemeGeos = nonSchemeGeos.filter((g) => !g.is_cover_page && g.is_acceptable_quality !== false && g.detected_subject !== 'NON_ACADEMIC');
    const hasPrintedQuestions = contentNonSchemeGeos.some((g) => g.has_printed_questions !== false);
    const isUnofficialPaper = hasVerifiedUnofficialGeometryFlag(nonSchemeGeos);

    const labelPrefix = [examBoard, paperCode, subject].filter(Boolean).join(' · ') || 'Uploaded file';

    // 1. Mark scheme only (no student paper / question paper)
    if (hasMarkScheme && nonSchemeFiles.length === 0) {
      const msLabel = [examBoard, paperCode, subject].filter(Boolean).join(' · ');
      return {
        overallStatus: 'action_needed',
        docType: 'mark_scheme_only',
        isWarning: true,
        examBoard,
        subject,
        paperCode,
        hasMarkScheme: true,
        requiresMarkScheme: false,
        hasHandwriting: false,
        bannerTitle: `${msLabel ? `${msLabel} · ` : ''}Mark scheme only — attach student paper`,
        bannerMessage: '',
        suggestions: [
          { id: 'attach-paper', label: 'Attach student paper to mark', action: 'attach_file' },
        ],
      };
    }

    // 2. All non-scheme pages unreadable / blurry
    if (nonSchemeGeos.length > 0 && nonSchemeGeos.every((g) => g.is_acceptable_quality === false)) {
      return {
        overallStatus: 'invalid',
        docType: 'unreadable',
        isWarning: true,
        examBoard,
        subject,
        paperCode,
        hasMarkScheme,
        requiresMarkScheme: false,
        hasHandwriting: false,
        bannerTitle: 'Image looks blurry or unreadable',
        bannerMessage: '',
        suggestions: [
          { id: 'replace-file', label: 'Replace file', action: 'replace_file' },
        ],
      };
    }

    // 3. All non-scheme pages explicitly non-academic
    if (nonSchemeGeos.length > 0 && nonSchemeGeos.every((g) => g.detected_subject === 'NON_ACADEMIC')) {
      return {
        overallStatus: 'invalid',
        docType: 'non_academic',
        isWarning: true,
        hasMarkScheme,
        requiresMarkScheme: false,
        hasHandwriting: false,
        bannerTitle: 'Not an academic exam or homework image',
        bannerMessage: '',
        suggestions: [
          { id: 'replace-file', label: 'Replace file', action: 'replace_file' },
        ],
      };
    }

    // 4. Cover page only / blank PDF (short PDF with only cover/blank pages)
    if (nonSchemeFiles.length > 0 && nonSchemeFiles.every((f) => f.role === 'cover_only')) {
      return {
        overallStatus: 'action_needed',
        docType: 'cover_only',
        isWarning: true,
        examBoard,
        subject,
        paperCode,
        hasMarkScheme,
        requiresMarkScheme: false,
        hasHandwriting: false,
        bannerTitle: `${labelPrefix} · Cover page only (no questions found)`,
        bannerMessage: '',
        suggestions: [
          { id: 'replace-cover', label: 'Replace with question or answer pages', action: 'replace_file' },
        ],
      };
    }

    // 5. Paper vs Mark Scheme code mismatch (e.g., OCR J560/01 student paper + Pearson 1MA1/3H mark scheme)
    if (hasMarkScheme && nonSchemeFiles.length > 0) {
      const studentCode = normalizeFullPaperCode(nonSchemeFiles.find((f) => f.paperCode)?.paperCode);
      const schemeCode = normalizeFullPaperCode(schemeFiles.find((f) => f.paperCode)?.paperCode);
      if (studentCode && schemeCode && studentCode !== schemeCode) {
        return {
          overallStatus: 'action_needed',
          docType: 'paper_mismatch',
          isWarning: true,
          examBoard,
          subject,
          paperCode: studentCode,
          hasMarkScheme: true,
          requiresMarkScheme: false,
          hasHandwriting,
          bannerTitle: `Paper mismatch: ${studentCode} paper vs ${schemeCode} mark scheme`,
          bannerMessage: '',
          suggestions: [
            { id: 'replace-mismatch', label: 'Replace mismatched file', action: 'replace_file' },
          ],
        };
      }
    }

    // 5b. Multiple distinct official student paper codes (shared DRY helper via PreFlightRules)
    const distinctStudentPaperCodes = findDistinctFullPaperCodes([
      ...nonSchemeFiles.map((f) => f.paperCode),
      ...nonSchemeGeos.map((g) => g.paper_code_hint),
    ]);
    if (distinctStudentPaperCodes.length > 1) {
      return {
        overallStatus: 'action_needed',
        docType: 'multi_paper_not_supported',
        isWarning: true,
        examBoard,
        subject,
        paperCode: distinctStudentPaperCodes[0],
        hasMarkScheme,
        requiresMarkScheme: false,
        hasHandwriting,
        bannerTitle: `Multiple papers detected (${distinctStudentPaperCodes.slice(0, 2).join(' & ')}) — upload 1 paper at a time`,
        bannerMessage: '',
        suggestions: [
          { id: 'replace-multi-paper', label: 'Replace with a single paper', action: 'replace_file' },
        ],
      };
    }

    // 5c. Student page limit check (Free 50-page limit; Mark Scheme PDFs exempt — shared DRY rule)
    const studentPageCount = nonSchemeFiles.reduce((sum, f) => sum + (f.pageCount || 1), 0);
    const studentLimitCheck = checkStudentPageLimit(studentPageCount, pageLimits);
    if (studentLimitCheck.exceeded) {
      return {
        overallStatus: 'action_needed',
        docType: 'page_limit_exceeded',
        isWarning: true,
        examBoard,
        subject,
        paperCode,
        hasMarkScheme,
        requiresMarkScheme: false,
        hasHandwriting,
        bannerTitle: studentLimitCheck.shortTitle || `Upload exceeds ${studentLimitCheck.limit} student page limit`,
        bannerMessage: '',
        suggestions: [
          { id: 'replace-oversized', label: 'Replace with fewer pages', action: 'replace_file' },
        ],
      };
    }

    // 6. Other academic subject without a mark scheme (shared DRY filter + DB official scheme lookup)
    if (!hasMarkScheme && nonSchemeGeos.length >= 2) {
      rescueMinorityUnsupportedPagesInSupportedBatch(nonSchemeGeos);
    }
    const needsMarkSchemeGeos = filterAcademicUnsupportedPages(nonSchemeGeos);
    const distinctUnsupportedSubjects = extractDistinctUnsupportedSubjects(needsMarkSchemeGeos);

    if (!hasMarkScheme && needsMarkSchemeGeos.length > 0 && distinctUnsupportedSubjects.length <= 1) {
      const { catalogedScheme } = await lookupCatalogedOfficialSchemeIfEligible({
        geometryResults: nonSchemeGeos,
        unsupportedPages: needsMarkSchemeGeos,
        distinctUnsupportedSubjects,
      });
      if (catalogedScheme) {
        hasMarkScheme = true;
        hasCatalogedOfficialScheme = true;
        nonSchemeFiles.forEach((f) => {
          if (f.requiresMarkScheme) {
            f.hasCatalogedOfficialScheme = true;
          }
        });
      }
    }

    if (!hasMarkScheme && needsMarkSchemeGeos.length > 0) {
      const subjLabel = distinctUnsupportedSubjects[0] || formatSubjectLabel(needsMarkSchemeGeos[0]) || subject || 'This subject';
      const titleLead = [examBoard, paperCode, subjLabel].filter(Boolean).join(' · ');
      return {
        overallStatus: 'action_needed',
        docType: 'missing_mark_scheme',
        isWarning: false,
        examBoard,
        subject: subjLabel,
        paperCode,
        hasMarkScheme: false,
        requiresMarkScheme: true,
        hasHandwriting,
        bannerTitle: `${titleLead} — attach a mark scheme for official grading`,
        bannerMessage: '',
        suggestions: [
          { id: 'attach-ms', label: 'Attach official mark scheme (recommended)', action: 'attach_file' },
          { id: 'generic-rubric', label: 'Mark now with AI General Rubric', action: 'submit_generic_rubric' },
        ],
      };
    }

    // 7. Answers only without printed questions & without a mark scheme (e.g. English Language essay/answers on lined paper)
    if (hasHandwriting && !hasPrintedQuestions && !hasMarkScheme && contentNonSchemeGeos.length > 0) {
      return {
        overallStatus: 'action_needed',
        docType: 'answers_without_questions',
        isWarning: true,
        examBoard,
        subject,
        paperCode,
        hasMarkScheme: false,
        requiresMarkScheme: false,
        hasHandwriting: true,
        bannerTitle: `${labelPrefix} · Answers only (no questions detected) — generic mark scheme will be used`,
        bannerMessage: '',
        suggestions: [
          { id: 'attach-q-or-ms', label: 'Attach question paper or mark scheme for official grading', action: 'attach_file' },
        ],
      };
    }

    // 8. Unofficial / practice paper without a mark scheme
    if (isUnofficialPaper && !hasMarkScheme) {
      return {
        overallStatus: hasHandwriting ? 'ready' : 'action_needed',
        docType: 'unofficial_paper',
        isWarning: false,
        examBoard,
        subject,
        paperCode,
        hasMarkScheme: false,
        requiresMarkScheme: false,
        hasHandwriting,
        bannerTitle: hasHandwriting
          ? `${labelPrefix} · Practice/unofficial paper · Ready to mark (attach mark scheme if available)`
          : `${labelPrefix} · Practice/unofficial paper — attach its mark scheme if available`,
        bannerMessage: '',
        suggestions: [
          { id: 'attach-practice-ms', label: 'Attach mark scheme (optional)', action: 'attach_file' },
        ],
      };
    }

    // 9. Ready — Student work detected (Maths/Eng Lang or Any Subject + Mark Scheme)
    if (hasHandwriting || hasMarkScheme) {
      return {
        overallStatus: 'ready',
        docType: 'student_work',
        isWarning: false,
        examBoard,
        subject,
        paperCode,
        hasMarkScheme,
        requiresMarkScheme: false,
        hasHandwriting,
        bannerTitle: hasCatalogedOfficialScheme
          ? `${labelPrefix} · Official mark scheme found · Ready to mark`
          : hasMarkScheme
            ? `${labelPrefix} + Mark Scheme · Ready to mark`
            : `${labelPrefix} · Ready to mark`,
        bannerMessage: '',
        suggestions: [],
      };
    }

    // 10. Ready — Blank question paper (no handwriting detected yet)
    return {
      overallStatus: 'ready',
      docType: 'question_paper',
      isWarning: false,
      examBoard,
      subject,
      paperCode,
      hasMarkScheme,
      requiresMarkScheme: false,
      hasHandwriting: false,
      bannerTitle: `${labelPrefix} · Question paper detected`,
      bannerMessage: '',
      suggestions: [
        { id: 'attach-answers', label: 'Attach my handwritten answers to mark', action: 'attach_file' },
      ],
    };
  }
}
