import type { StandardizedPage, PageOcrResult } from '../../types/markingRouter.js';
import type { GeometryAnalysisResult } from './ImageGeometryService.js';
import type { QuestionResult } from '../../types/marking.js';
import { UserFacingError } from '../../utils/UserFacingError.js';

export interface InterceptedSchemeImageMeta {
    imageData: string;
    sourceIndex?: number;
    originalFileName?: string;
}

export interface PaperBucket {
    paperIndex: number;
    paperLabel: string;
    paperCodeHint?: string;
    subjectHint?: string;
    standardizedPages: StandardizedPage[];
    lightweightPages: StandardizedPage[];
    geometryResults: GeometryAnalysisResult[];
    interceptedSchemeImages: string[];
    deferredSchemePdfFiles: Express.Multer.File[];
}

export interface SinglePaperCoreSubResult {
    paperIndex: number;
    paperLabel: string;
    sortedStandardizedPages: StandardizedPage[];
    updatedQuestionResults: QuestionResult[];
    classificationResult: any;
    allClassificationResults: any[];
    markingSchemesMap: Map<string, any>;
    reindexedDetectionResults: any[];
    finalAnnotatedOutput: string[];
    overallScore: number;
    totalPossibleScore: number;
    overallScoreText: string;
    allPagesOcrData: PageOcrResult[];
    combinedQuestionResponses: any[];
    precomputedPerformanceSummaryPromise: Promise<{
        summary: string;
        durationMs: number;
        startTime: number;
    }>;
    subjectProfile: any;
}

function normalizePaperCode(code?: string): string {
    if (!code || typeof code !== 'string') return '';
    const trimmed = code.trim().toUpperCase().replace(/1M11/g, '1MA1');
    // Extract canonical exam code like 1MA1/1H, 8300/2F, 8461/1H, 8700/1, J560/04, etc.
    const match = trimmed.match(/\b([0-9A-Z]{4,6}\/[0-9A-Z]{1,3}|8700\/[12]|8300\/[123][FH]?|1MA1\/[123][FH]?|J560\/0[1-6]|J351\/0[12]|1EN0\/0[12])\b/);
    if (match) return match[1];
    // Or "PAPER 1", "PAPER 2", "PAPER 3"
    const paperNum = trimmed.match(/\bPAPER\s*([1234])\b/);
    if (paperNum) return `PAPER_${paperNum[1]}`;
    return '';
}

function extractPaperCodeFromFilename(fileName?: string): string {
    if (!fileName || typeof fileName !== 'string') return '';
    const normalized = fileName.replace(/1m11/ig, '1MA1');
    const match = normalized.match(/(?:^|[^a-z0-9]|edexcel|aqa|ocr|wjec|eduqas|cie)(1ma1|8300|8700|8702|8461|8462|8463|8464|j560|j351|9ma0|wma1[1-4]|wma0[1-3]|wme0[1-3]|wst0[1-3]|wfm0[1-3]|wdm11|wdm01|1bi0|1ch0|1ph0|1en0|1et0|1sc0)[-_\/ ]([0-9]{1,2}[a-z]?|[a-z][0-9]{1,2})\b/i);
    if (match) {
        return `${match[1].toUpperCase()}/${match[2].toUpperCase()}`;
    }
    return '';
}

function extractPaperToken(raw?: string): string {
    if (!raw || typeof raw !== 'string') return '';
    const code = extractPaperCodeFromFilename(raw) || normalizePaperCode(raw);
    if (code) {
        if (code.includes('/')) {
            return code.split('/')[1].toUpperCase();
        }
        if (code.startsWith('PAPER_')) {
            return code.slice('PAPER_'.length);
        }
    }
    const paperMatch = raw.match(/(?:^|[^a-z0-9])paper[-_\s]*([1-4][fh]?)\b/i);
    if (paperMatch) return paperMatch[1].toUpperCase();
    const pMatch = raw.match(/(?:^|[^a-z0-9])p([1-4][fh]?)(?:[-_\s.]|$)/i);
    if (pMatch) return pMatch[1].toUpperCase();
    return '';
}

function getPaperTokenSortOrder(paperToken?: string, paperCodeHint?: string): number {
    const candidates = [paperToken];
    if (paperCodeHint) {
        if (paperCodeHint.includes('/')) {
            candidates.push(paperCodeHint.split('/')[1]);
        } else if (paperCodeHint.toUpperCase().startsWith('PAPER_')) {
            candidates.push(paperCodeHint.slice('PAPER_'.length));
        } else {
            candidates.push(paperCodeHint);
        }
    }
    for (const c of candidates) {
        if (!c) continue;
        const m = String(c).trim().match(/^0*([1-9])(?:[A-Za-z]|$)/);
        if (m) {
            return parseInt(m[1], 10);
        }
    }
    return Infinity;
}

function paperTokensMatch(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    const ua = a.toUpperCase();
    const ub = b.toUpperCase();
    if (ua === ub) return true;
    const tierA = ua.match(/[FH]$/)?.[0] || '';
    const tierB = ub.match(/[FH]$/)?.[0] || '';
    if (tierA && tierB && tierA !== tierB) return false;
    const numA = ua.replace(/[FH]$/, '').replace(/^0+/, '');
    const numB = ub.replace(/[FH]$/, '').replace(/^0+/, '');
    return Boolean(numA && numB && numA === numB);
}

function getEffectivePageSubject(geo?: GeometryAnalysisResult): string {
    if (!geo) return 'MATHS';
    if (geo.detected_subject === 'UNSUPPORTED_SUBJECT' && geo.unsupported_subject_name) {
        return geo.unsupported_subject_name.trim().toUpperCase();
    }
    if (geo.detected_subject === 'ENGLISH_LITERATURE') return 'ENGLISH_LITERATURE';
    if (geo.detected_subject === 'ENGLISH_LANGUAGE') return 'ENGLISH_LANGUAGE';
    return 'MATHS';
}

function extractSubjectHintFromFilename(fileName?: string): string {
    if (!fileName || typeof fileName !== 'string') return '';
    const m = fileName.match(
        /(?:^|[^a-z])(biology|chemistry|physics|math(?:ematics)?|english(?:\s*[-_]?\s*(?:lit(?:erature)?|lang(?:uage)?))?|computer[-_\s]*science|economics|psychology|geography|history|business)(?:[^a-z]|$)/i
    );
    if (!m) return '';
    const token = m[1].toLowerCase().replace(/[-_\s]+/g, ' ').trim();
    if (token === 'math' || token === 'mathematics') return 'MATHS';
    if (token.startsWith('english')) {
        return /\blit(?:erature)?\b/.test(token) ? 'ENGLISH_LITERATURE' : 'ENGLISH_LANGUAGE';
    }
    return token.toUpperCase();
}

function getMajoritySubjectHint(geo: GeometryAnalysisResult[]): string {
    const counts = new Map<string, number>();
    geo.forEach(g => {
        const s = getEffectivePageSubject(g);
        counts.set(s, (counts.get(s) || 0) + 1);
    });
    let best = 'MATHS';
    let bestCount = 0;
    counts.forEach((cnt, s) => {
        if (cnt > bestCount) {
            bestCount = cnt;
            best = s;
        }
    });
    return best;
}

function normalizeBoard(raw?: string): string {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    if (s.includes('edexcel') || s.includes('pearson')) return 'EDEXCEL';
    if (s.includes('aqa')) return 'AQA';
    if (s.includes('ocr')) return 'OCR';
    if (s.includes('wjec') || s.includes('eduqas')) return 'WJEC';
    if (s.includes('cambridge') || s.includes('cie') || s.includes('caie')) return 'CIE';
    return s.toUpperCase();
}

function normalizeSeries(raw?: string): string {
    const s = String(raw || '').trim();
    if (!s) return '';
    const yearMatch = s.match(/\b(20\d{2}|19\d{2})\b/);
    const year = yearMatch ? yearMatch[1] : '';
    let sitting = '';
    if (/\b(nov(?:ember)?|autumn|winter)\b/i.test(s)) sitting = 'NOV';
    else if (/\b(may|jun(?:e)?|summer)\b/i.test(s)) sitting = 'JUN';
    else if (/\b(jan(?:uary)?)\b/i.test(s)) sitting = 'JAN';
    else if (/\b(mar(?:ch)?)\b/i.test(s)) sitting = 'MAR';
    else if (/\b(spec(?:imen)?|sample)\b/i.test(s)) sitting = 'SPECIMEN';
    if (sitting && year) return `${sitting}-${year}`;
    if (year) return `YEAR-${year}`;
    return s.toUpperCase();
}

function normalizeTier(tierRaw?: string, codeRaw?: string): string {
    const t = String(tierRaw || '').trim();
    if (/\b(higher|^h$)\b/i.test(t)) return 'HIGHER';
    if (/\b(foundation|^f$)\b/i.test(t)) return 'FOUNDATION';
    const c = String(codeRaw || '').trim();
    if (/(?:\/|-|\s|\d)H$/i.test(c)) return 'HIGHER';
    if (/(?:\/|-|\s|\d)F$/i.test(c)) return 'FOUNDATION';
    return t.toUpperCase();
}

function resolveBucketCodeHint(pages: StandardizedPage[], geo: GeometryAnalysisResult[]): string {
    const coverCode = geo
        .filter(g => g?.is_cover_page)
        .map(g => normalizePaperCode(g?.paper_code_hint))
        .find(Boolean);
    if (coverCode) return coverCode;

    const fileCode = pages.map(p => extractPaperCodeFromFilename(p?.originalFileName)).find(Boolean);
    if (fileCode) return fileCode;

    const counts = new Map<string, number>();
    geo.forEach(g => {
        const c = normalizePaperCode(g?.paper_code_hint);
        if (c) counts.set(c, (counts.get(c) || 0) + 1);
    });
    let bestCode = '';
    let bestCount = 0;
    counts.forEach((cnt, code) => {
        if (cnt >= 2 && cnt > bestCount) {
            bestCount = cnt;
            bestCode = code;
        }
    });
    return bestCode;
}

const STEM_STOP_WORDS = new Set([
    'the', 'and', 'for', 'that', 'with', 'from', 'this', 'are',
    'work', 'out', 'find', 'write', 'down', 'give', 'your', 'answer',
    'show', 'diagram', 'shows', 'figure', 'table', 'below', 'marks', 'mark'
]);

function collectStudentWorkText(node: any): string {
    if (!node || typeof node !== 'object') return '';
    const parts: string[] = [];
    if (typeof node.studentWork === 'string') {
        parts.push(node.studentWork);
    }
    if (Array.isArray(node.studentWorkLines)) {
        for (const line of node.studentWorkLines) {
            if (typeof line === 'string') {
                parts.push(line);
            } else if (line && typeof line.text === 'string') {
                parts.push(line.text);
            }
        }
    }
    if (Array.isArray(node.subQuestions)) {
        for (const sq of node.subQuestions) {
            const nested = collectStudentWorkText(sq);
            if (nested) parts.push(nested);
        }
    }
    return parts.join(' ');
}

function isOpeningQuestionStemOnPage(q: any): string {
    const qNumStr = String(q?.questionNumber ?? '').trim();
    const baseMatch = qNumStr.match(/^(\d+)/);
    if (!baseMatch) return '';

    const trailingPart = qNumStr.slice(baseMatch[0].length).replace(/[().\s]/g, '').toLowerCase();
    if (trailingPart && trailingPart !== 'a' && trailingPart !== 'i' && trailingPart !== 'ai') {
        return '';
    }

    if (Array.isArray(q?.subQuestions) && q.subQuestions.length > 0) {
        const firstSubPart = String(q.subQuestions[0]?.part || '').replace(/[()\s.]/g, '').toLowerCase();
        if (firstSubPart !== '' && !['a', 'i', '1', 'ai'].includes(firstSubPart)) {
            return '';
        }
    }

    const cleanField = (val: any): string => {
        const s = String(val ?? '').trim();
        return s === 'null' || s === 'undefined' ? '' : s;
    };
    const mainRaw = cleanField(q?.text) || cleanField(q?.questionText);
    const firstSubRaw = Array.isArray(q?.subQuestions) && q.subQuestions.length > 0
        ? (cleanField(q.subQuestions[0]?.text) || cleanField(q.subQuestions[0]?.questionText))
        : '';
    const combinedRaw = [mainRaw, firstSubRaw].filter(Boolean).join(' ').trim();
    if (!combinedRaw) return '';

    if (
        /(?:\b(?:question|q)\s*\d*[a-z0-9().\s]*continued\b|\b\d+\s*\(\s*continued\s*\)|\(\s*continued\s*\))/i.test(combinedRaw) ||
        /^\s*(?:\(?[b-z]\)|\((?:ii+|iv|v|vi+|[2-9])\)|(?:ii+|iv|v|vi+|[2-9])\))/i.test(combinedRaw) ||
        (/^\s*[a-z]/.test(combinedRaw) && !/^\s*[a-z](?:\([a-z0-9,\s]+\))?\s*=/.test(combinedRaw))
    ) {
        return '';
    }

    const rawText = combinedRaw
        .replace(/turn over/gi, ' ')
        .replace(/leave blank/gi, ' ')
        .replace(/do not write in this area/gi, ' ')
        .replace(/total for question[^\n]*marks/gi, ' ')
        .replace(/blank page/gi, ' ')
        .replace(/context:\s*based on[^\n]*/gi, ' ')
        .trim();

    if (rawText.length < 20) return '';

    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const studentWorkText = collectStudentWorkText(q);
    const normStem = norm(rawText);
    const normWork = norm(studentWorkText);
    if (normStem.length >= 10 && normWork.includes(normStem.slice(0, 35))) {
        return '';
    }

    return rawText;
}

function tokenizeQuestionStem(stem: string): Set<string> {
    const tokens = new Set<string>();
    const matches = stem.toLowerCase().match(/[a-z0-9]+/g) || [];
    for (const tok of matches) {
        if (/^\d+$/.test(tok)) {
            tokens.add(tok);
        } else if (tok.length >= 3 && !STEM_STOP_WORDS.has(tok)) {
            tokens.add(tok);
        }
    }
    return tokens;
}

function getValidPastPaperMatch(sub: SinglePaperCoreSubResult): any | null {
    const valid = (sub.reindexedDetectionResults || []).find((r: any) => {
        const m = r?.detectionResult?.match;
        return r?.detectionResult?.found &&
            m &&
            !m.isGeneric &&
            m.paperCode &&
            m.paperCode !== 'Generic Question' &&
            m.board &&
            m.board !== 'Unknown' &&
            m.board !== 'N/A';
    });
    return valid?.detectionResult?.match || null;
}

export class PaperSplitterService {
    /**
     * Post-classification single-paper guard:
     * Rejects loose-image or combined-PDF uploads where >= 2 main question numbers
     * appear on different pages with completely different printed opening question stems.
     */
    static assertSinglePaperClassification(
        allClassificationResults: Array<{ pageIndex: number; result?: any }>,
        options: { isPdf?: boolean; pageCount?: number; fileName?: string } = {}
    ): void {
        const stemsByBaseQ = new Map<string, Array<{ pageIndex: number; tokens: Set<string> }>>();

        for (const entry of allClassificationResults || []) {
            const pageIndex = entry?.pageIndex;
            const questions = entry?.result?.questions;
            if (pageIndex === undefined || !Array.isArray(questions)) continue;

            for (const q of questions) {
                const baseMatch = String(q?.questionNumber ?? '').trim().match(/^(\d+)/);
                if (!baseMatch) continue;
                const baseQ = baseMatch[1];

                const stem = isOpeningQuestionStemOnPage(q);
                if (!stem) continue;

                const tokens = tokenizeQuestionStem(stem);
                if (tokens.size < 4) continue;

                const list = stemsByBaseQ.get(baseQ) || [];
                list.push({ pageIndex, tokens });
                stemsByBaseQ.set(baseQ, list);
            }
        }

        const conflictingQuestionNumbers = new Set<string>();
        stemsByBaseQ.forEach((entries, baseQ) => {
            for (let i = 0; i < entries.length; i++) {
                for (let j = i + 1; j < entries.length; j++) {
                    if (entries[i].pageIndex === entries[j].pageIndex) continue;
                    const tokensA = entries[i].tokens;
                    const tokensB = entries[j].tokens;
                    let intersectionSize = 0;
                    tokensA.forEach(t => {
                        if (tokensB.has(t)) intersectionSize++;
                    });
                    const overlap = intersectionSize / Math.min(tokensA.size, tokensB.size);
                    if (overlap < 0.30) {
                        conflictingQuestionNumbers.add(baseQ);
                    }
                }
            }
        });

        if (conflictingQuestionNumbers.size >= 2) {
            const sortedConflicts = Array.from(conflictingQuestionNumbers).sort((a, b) => Number(a) - Number(b));
            const sampleQs = sortedConflicts.slice(0, 5).map(q => `Q${q}`).join(', ');
            console.warn(
                `⚠️ [PAPER-SPLITTER] Conflicting question stems detected on ${sortedConflicts.map(q => `Q${q}`).join(', ')} (isPdf=${Boolean(options.isPdf)}, pages=${options.pageCount ?? 'unknown'}).`
            );

            if (options.isPdf) {
                throw new UserFacingError({
                    code: 'COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED',
                    category: 'user_fixable',
                    shouldAlertAdmin: false,
                    userMessage:
                        `This PDF${options.fileName ? ` ("${options.fileName}")` : ''} appears to contain **multiple exam papers combined into a single file** (duplicate question numbers with different questions detected: ${sampleQs}).\n\n` +
                        `**How to fix:** Please upload **each exam paper as a separate PDF file** (e.g. Paper 1 PDF, Paper 2 PDF, Paper 3 PDF) so they can be graded accurately in parallel.`,
                    technicalMessage: `Combined multi-paper PDF rejected after classification: conflicting question stems on Q${sortedConflicts.join(', Q')}.`
                });
            }

            throw new UserFacingError({
                code: 'MULTI_PAPER_LOOSE_IMAGES_NOT_SUPPORTED',
                category: 'user_fixable',
                shouldAlertAdmin: true,
                userMessage:
                    `Loose image uploads support **1 exam paper at a time**. We detected multiple exam papers in your upload (duplicate question numbers with different questions: ${sampleQs}).\n\n` +
                    `**How to mark multiple papers:**\n` +
                    `1. **Upload each paper as a separate PDF file** (e.g. 3 PDFs for Paper 1, Paper 2, and Paper 3, optionally with mark scheme PDFs).\n` +
                    `2. **Or upload 1 paper at a time** if using loose photos/images.`,
                technicalMessage: `Multi-paper loose image upload rejected after classification: conflicting question stems on Q${sortedConflicts.join(', Q')}.`
            });
        }
    }

    /**
     * Deterministic multi-PDF paper splitter & 1-paper fast path.
     * - Single-paper uploads (1 PDF or loose images) return 1 bucket directly.
     * - Multi-paper uploads are supported ONLY as >=2 separate student PDFs.
     * - Mixed PDF+loose images are rejected deterministically.
     */
    static splitIntoPaperBuckets(params: {
        standardizedPages: StandardizedPage[];
        lightweightPages: StandardizedPage[];
        geometryResults: GeometryAnalysisResult[];
        interceptedSchemeImages: Array<string | InterceptedSchemeImageMeta>;
        deferredSchemePdfFiles: Express.Multer.File[];
        files: Express.Multer.File[];
    }): PaperBucket[] {
        const {
            standardizedPages,
            lightweightPages,
            geometryResults,
            interceptedSchemeImages,
            deferredSchemePdfFiles
        } = params;

        const normalizedSchemes: InterceptedSchemeImageMeta[] = (interceptedSchemeImages || []).map(item =>
            typeof item === 'string' ? { imageData: item } : item
        );

        if (standardizedPages.length === 0) {
            return [{
                paperIndex: 0,
                paperLabel: 'Paper 1',
                standardizedPages,
                lightweightPages,
                geometryResults,
                interceptedSchemeImages: normalizedSchemes.map(s => s.imageData),
                deferredSchemePdfFiles
            }];
        }

        // CRITICAL: geometryResults is 1:1 aligned with post-split standardizedPages[idx]
        const alignedGeo: GeometryAnalysisResult[] = standardizedPages.map((_, idx) => {
            return geometryResults[idx] || {
                is_acceptable_quality: true,
                needs_rotation: 0,
                is_two_page_spread: false,
                is_marking_scheme: false,
                is_supported_doc: true
            };
        });

        const isPdfPage = (p: StandardizedPage) =>
            /\.pdf$/i.test(p.originalFileName || '') && (p as any)._sourceIndex !== undefined;

        const studentPdfSourceIndices = Array.from(
            new Set(
                standardizedPages
                    .filter(isPdfPage)
                    .map(p => Number((p as any)._sourceIndex))
            )
        );
        const looseImagePages = standardizedPages.filter(p => !isPdfPage(p));

        // Guard C: Mixed student PDF(s) + loose student image(s)
        if (studentPdfSourceIndices.length >= 1 && looseImagePages.length > 0) {
            throw new UserFacingError({
                code: 'MIXED_MULTI_PAPER_UPLOAD_NOT_SUPPORTED',
                category: 'user_fixable',
                shouldAlertAdmin: false,
                userMessage:
                    `Mixing PDF exam papers and loose student answer images in the same upload is not supported.\n\n` +
                    `**How to fix:** Please upload each exam paper as its own PDF file, or upload 1 paper at a time.`,
                technicalMessage: `Mixed student PDF(s) (${studentPdfSourceIndices.length}) and loose student image(s) (${looseImagePages.length}) rejected.`
            });
        }

        // 1-Paper Zero-Regression Fast Path (0 or 1 student PDF)
        if (studentPdfSourceIndices.length <= 1) {
            const singleCode = resolveBucketCodeHint(standardizedPages, alignedGeo) || undefined;
            const singleSubj = getMajoritySubjectHint(alignedGeo);
            return [{
                paperIndex: 0,
                paperLabel: singleCode || 'Paper 1',
                paperCodeHint: singleCode,
                subjectHint: singleSubj,
                standardizedPages,
                lightweightPages,
                geometryResults: alignedGeo,
                interceptedSchemeImages: normalizedSchemes.map(s => s.imageData),
                deferredSchemePdfFiles
            }];
        }

        // Deterministic Multi-PDF Bucketing (Strategy 1: >= 2 separate student PDFs)
        const bucketsBySource = new Map<number, {
            sourceIndex: number;
            std: StandardizedPage[];
            light: StandardizedPage[];
            geo: GeometryAnalysisResult[];
        }>();

        standardizedPages.forEach((p, idx) => {
            const srcIdx = Number((p as any)._sourceIndex);
            if (!bucketsBySource.has(srcIdx)) {
                bucketsBySource.set(srcIdx, { sourceIndex: srcIdx, std: [], light: [], geo: [] });
            }
            const entry = bucketsBySource.get(srcIdx)!;
            entry.std.push(p);
            entry.light.push(lightweightPages[idx]);
            entry.geo.push(alignedGeo[idx]);
        });

        const orderedEntries = studentPdfSourceIndices
            .map(srcIdx => bucketsBySource.get(srcIdx))
            .filter((v): v is NonNullable<typeof v> => Boolean(v && v.std.length > 0));

        const builtBuckets = orderedEntries.map((entry, bIdx) => {
            const codeHint = resolveBucketCodeHint(entry.std, entry.geo) || undefined;
            const firstFileName = entry.std[0]?.originalFileName || '';
            const paperToken = extractPaperToken(codeHint || firstFileName);
            const subjHint = getMajoritySubjectHint(entry.geo);
            return {
                sourceIndex: entry.sourceIndex,
                originalUploadOrderIdx: bIdx,
                paperToken,
                paperSortOrder: getPaperTokenSortOrder(paperToken, codeHint),
                bucket: {
                    paperIndex: bIdx,
                    paperLabel: codeHint || `Paper ${bIdx + 1}`,
                    paperCodeHint: codeHint,
                    subjectHint: subjHint,
                    standardizedPages: entry.std.map((p, i) => ({ ...p, pageIndex: i })),
                    lightweightPages: entry.light.map((p, i) => ({ ...p, pageIndex: i })),
                    geometryResults: entry.geo,
                    interceptedSchemeImages: [] as string[],
                    deferredSchemePdfFiles: [] as Express.Multer.File[]
                } as PaperBucket
            };
        });

        // Canonical bucket sorting (e.g. 1H -> 2H -> 3H) regardless of OS file-picker selection order
        const finiteOrders = new Set(
            builtBuckets.map(b => b.paperSortOrder).filter(n => Number.isFinite(n))
        );
        if (finiteOrders.size >= 2) {
            builtBuckets.sort((a, b) => {
                const subjCmp = (a.bucket.subjectHint || '').localeCompare(b.bucket.subjectHint || '');
                if (subjCmp !== 0) return subjCmp;
                if (a.paperSortOrder !== b.paperSortOrder) return a.paperSortOrder - b.paperSortOrder;
                return a.originalUploadOrderIdx - b.originalUploadOrderIdx;
            });
            builtBuckets.forEach((b, idx) => {
                b.bucket.paperIndex = idx;
                if (!b.bucket.paperCodeHint) {
                    b.bucket.paperLabel = `Paper ${idx + 1}`;
                }
            });
        }

        const matchSchemeToUniqueBucket = (
            code: string,
            token: string,
            subjectHint: string
        ) => {
            const codeMatches = code
                ? builtBuckets.filter(b => b.bucket.paperCodeHint && b.bucket.paperCodeHint === code)
                : [];
            if (codeMatches.length === 1) {
                return codeMatches[0];
            }

            const tokenMatches = token
                ? builtBuckets.filter(b => paperTokensMatch(token, b.paperToken))
                : [];
            if (tokenMatches.length === 1) {
                return tokenMatches[0];
            }
            if (tokenMatches.length > 1 && subjectHint) {
                const narrowed = tokenMatches.filter(b => b.bucket.subjectHint === subjectHint);
                if (narrowed.length === 1) {
                    return narrowed[0];
                }
            }

            if (tokenMatches.length === 0 && subjectHint) {
                const subjMatches = builtBuckets.filter(b => b.bucket.subjectHint === subjectHint);
                if (subjMatches.length === 1) {
                    return subjMatches[0];
                }
            }

            return null;
        };

        // Pair Stage-2 interceptedSchemeImages to buckets
        const unmatchedStage2SchemeNames = new Set<string>();
        for (const item of normalizedSchemes) {
            if (item.sourceIndex !== undefined) {
                const bySrc = builtBuckets.find(b => b.sourceIndex === item.sourceIndex);
                if (bySrc) {
                    bySrc.bucket.interceptedSchemeImages.push(item.imageData);
                    continue;
                }
            }
            const itemCode = extractPaperCodeFromFilename(item.originalFileName) || normalizePaperCode(item.originalFileName);
            const itemToken = extractPaperToken(item.originalFileName);
            const itemSubject = extractSubjectHintFromFilename(item.originalFileName);
            const matched = matchSchemeToUniqueBucket(itemCode, itemToken, itemSubject);
            if (matched) {
                matched.bucket.interceptedSchemeImages.push(item.imageData);
            } else {
                unmatchedStage2SchemeNames.add(item.originalFileName || 'markscheme');
            }
        }

        if (unmatchedStage2SchemeNames.size > 0) {
            const firstUnmatchedName = Array.from(unmatchedStage2SchemeNames)[0];
            throw new UserFacingError({
                code: 'AMBIGUOUS_MARK_SCHEME_PAIRING',
                category: 'user_fixable',
                shouldAlertAdmin: false,
                userMessage:
                    `Could not determine which paper the marking scheme "${firstUnmatchedName}" belongs to. ` +
                    `Please include the paper code in the marking scheme filename (e.g. 1MA1-1H-MS.pdf) or upload 1 paper + 1 marking scheme at a time.`,
                technicalMessage: `Ambiguous Stage-2 mark scheme pairing for "${firstUnmatchedName}" across ${builtBuckets.length} student PDFs.`
            });
        }

        // Pair deferredSchemePdfFiles to buckets (order-independent)
        const unmatchedSchemes: Array<{ msFile: Express.Multer.File; msCode: string; msToken: string; msSubject: string; originalIdx: number }> = [];
        let hasConflictingPositionalIdentity = false;

        deferredSchemePdfFiles.forEach((msFile, idx) => {
            const name = msFile?.originalname || '';
            let msCode = extractPaperCodeFromFilename(name) || normalizePaperCode(name);
            let msToken = extractPaperToken(name);
            const msSubject = extractSubjectHintFromFilename(name);

            if (!msCode && msFile?.buffer) {
                const headerSample = msFile.buffer.toString('latin1', 0, Math.min(msFile.buffer.length, 65536));
                const headerCode = extractPaperCodeFromFilename(headerSample) || normalizePaperCode(headerSample);
                if (headerCode) {
                    msCode = headerCode;
                    if (!msToken) msToken = extractPaperToken(headerCode);
                }
            }

            const matched = matchSchemeToUniqueBucket(msCode, msToken, msSubject);
            if (matched) {
                matched.bucket.deferredSchemePdfFiles.push(msFile);
                return;
            }

            // Check if this scheme had an explicit identity that contradicts its positional bucket
            const positional = builtBuckets.find(b => b.originalUploadOrderIdx === idx);
            if ((msCode && (!positional || positional.bucket.paperCodeHint !== msCode)) ||
                (msToken && (!positional || !paperTokensMatch(msToken, positional.paperToken))) ||
                (msSubject && (!positional || positional.bucket.subjectHint !== msSubject))) {
                hasConflictingPositionalIdentity = true;
            }

            unmatchedSchemes.push({ msFile, msCode, msToken, msSubject, originalIdx: idx });
        });

        if (unmatchedSchemes.length > 0) {
            const canUsePositionalFallback =
                deferredSchemePdfFiles.length === builtBuckets.length &&
                !hasConflictingPositionalIdentity &&
                unmatchedSchemes.every(u => {
                    const target = builtBuckets.find(b => b.originalUploadOrderIdx === u.originalIdx);
                    return Boolean(target && target.bucket.deferredSchemePdfFiles.length === 0);
                });

            if (canUsePositionalFallback) {
                unmatchedSchemes.forEach(u => {
                    const target = builtBuckets.find(b => b.originalUploadOrderIdx === u.originalIdx);
                    if (target) {
                        target.bucket.deferredSchemePdfFiles.push(u.msFile);
                    }
                });
            } else {
                const firstUnmatched = unmatchedSchemes[0].msFile;
                throw new UserFacingError({
                    code: 'AMBIGUOUS_MARK_SCHEME_PAIRING',
                    category: 'user_fixable',
                    shouldAlertAdmin: false,
                    userMessage:
                        `Could not determine which paper the marking scheme "${firstUnmatched?.originalname || 'markscheme.pdf'}" belongs to. ` +
                        `Please include the paper code in the marking scheme filename (e.g. 1MA1-1H-MS.pdf) or upload 1 paper + 1 marking scheme at a time.`,
                    technicalMessage: `Ambiguous mark scheme pairing for "${firstUnmatched?.originalname}" across ${builtBuckets.length} student PDFs.`
                });
            }
        }

        const result = builtBuckets.map(b => b.bucket);
        console.log(
            `📚 [PAPER-SPLITTER] Split ${standardizedPages.length} pages into ${result.length} deterministic PDF bucket(s): ` +
            result.map((b, idx) => `P${idx + 1}(${b.paperLabel}, ${b.standardizedPages.length}p, ms=${b.deferredSchemePdfFiles.length})`).join(', ')
        );
        return result;
    }

    /**
     * Merges the results of multiple parallel single-paper pipeline runs into one unified output:
     * - Offsets pageIndex / sourceImageIndices so pages are contiguous [P1..., P2..., P3...]
     * - Prefixes question numbers as "P1·1", "P2·1", "P3·1" so Q1s across papers never collide
     * - Builds either a Same-Subject Combined AI Summary (with Overall + Paper 1..N tabs)
     *   or a Cross-Subject Tabbed AI Summary (e.g. Biology tab + Chemistry tab, no fake combined grade).
     */
    static async aggregateMultiPaperResults(
        inputSubResults: SinglePaperCoreSubResult[]
    ): Promise<{
        sortedStandardizedPages: StandardizedPage[];
        updatedQuestionResults: QuestionResult[];
        classificationResult: any;
        allClassificationResults: any[];
        markingSchemesMap: Map<string, any>;
        reindexedDetectionResults: any[];
        finalAnnotatedOutput: string[];
        overallScore: number;
        totalPossibleScore: number;
        overallScoreText: string;
        allPagesOcrData: PageOcrResult[];
        combinedQuestionResponses: any[];
        precomputedPerformanceSummaryPromise: Promise<{
            summary: string;
            durationMs: number;
            startTime: number;
        }>;
    }> {
        const subResults = inputSubResults;
        if (subResults.length === 1) {
            const single = subResults[0];
            return {
                sortedStandardizedPages: single.sortedStandardizedPages,
                updatedQuestionResults: single.updatedQuestionResults,
                classificationResult: single.classificationResult,
                allClassificationResults: single.allClassificationResults,
                markingSchemesMap: single.markingSchemesMap,
                reindexedDetectionResults: single.reindexedDetectionResults,
                finalAnnotatedOutput: single.finalAnnotatedOutput,
                overallScore: single.overallScore,
                totalPossibleScore: single.totalPossibleScore,
                overallScoreText: single.overallScoreText,
                allPagesOcrData: single.allPagesOcrData,
                combinedQuestionResponses: single.combinedQuestionResponses,
                precomputedPerformanceSummaryPromise: single.precomputedPerformanceSummaryPromise
            };
        }

        const mergedStandardizedPages: StandardizedPage[] = [];
        const mergedQuestionResults: QuestionResult[] = [];
        const mergedClassificationQuestions: any[] = [];
        const mergedAllClassificationResults: any[] = [];
        const mergedMarkingSchemesMap = new Map<string, any>();
        const mergedDetectionResults: any[] = [];
        const mergedAnnotatedOutput: string[] = [];
        const mergedOcrData: PageOcrResult[] = [];
        const mergedQuestionResponses: any[] = [];

        let totalAwarded = 0;
        let totalPossible = 0;
        let pageOffset = 0;

        const prefixQNum = (paperIdx: number, qNum: any): string => {
            const raw = String(qNum ?? '').trim();
            if (!raw) return `P${paperIdx + 1}·1`;
            if (/^P\d+[·.-]/i.test(raw)) return raw;
            return `P${paperIdx + 1}·${raw.replace(/^Q/i, '')}`;
        };

        for (let i = 0; i < subResults.length; i++) {
            const sub = subResults[i];
            const currentOffset = pageOffset;
            const pageCount = sub.sortedStandardizedPages.length;

            // 1. Offset standardized pages
            sub.sortedStandardizedPages.forEach((p, idx) => {
                mergedStandardizedPages.push({
                    ...p,
                    pageIndex: currentOffset + idx,
                    originalPageIndex: currentOffset + idx
                });
            });

            // 2. Concatenate annotated output buffers
            mergedAnnotatedOutput.push(...sub.finalAnnotatedOutput);

            // 3. Offset & prefix question results
            sub.updatedQuestionResults.forEach(qr => {
                const prefixedQ = prefixQNum(i, qr.questionNumber);
                const newPageIdx = (qr.pageIndex ?? 0) + currentOffset;
                const newSourceIndices = Array.isArray(qr.sourceImageIndices)
                    ? qr.sourceImageIndices.map(idx => idx + currentOffset)
                    : [newPageIdx];
                const newAnnotations = Array.isArray(qr.annotations)
                    ? qr.annotations.map(a => ({
                        ...a,
                        pageIndex: (a.pageIndex ?? qr.pageIndex ?? 0) + currentOffset,
                        subQuestion: a.subQuestion ? prefixQNum(i, a.subQuestion) : a.subQuestion
                    }))
                    : [];

                mergedQuestionResults.push({
                    ...qr,
                    questionNumber: prefixedQ,
                    pageIndex: newPageIdx,
                    sourceImageIndices: newSourceIndices,
                    annotations: newAnnotations
                });
            });

            // 4. Offset & prefix classification questions
            if (Array.isArray(sub.classificationResult?.questions)) {
                sub.classificationResult.questions.forEach((q: any) => {
                    mergedClassificationQuestions.push({
                        ...q,
                        questionNumber: prefixQNum(i, q.questionNumber),
                        pageIndex: (q.pageIndex ?? 0) + currentOffset,
                        sourceImageIndex: (q.sourceImageIndex ?? 0) + currentOffset,
                        sourceImageIndices: Array.isArray(q.sourceImageIndices)
                            ? q.sourceImageIndices.map((idx: number) => idx + currentOffset)
                            : [(q.sourceImageIndex ?? 0) + currentOffset]
                    });
                });
            }

            if (Array.isArray(sub.allClassificationResults)) {
                sub.allClassificationResults.forEach(cr => {
                    mergedAllClassificationResults.push({
                        ...cr,
                        pageIndex: (cr.pageIndex ?? 0) + currentOffset
                    });
                });
            }

            // 5. Merge markingSchemesMap with paper prefix to avoid collisions
            if (sub.markingSchemesMap) {
                for (const [key, val] of sub.markingSchemesMap.entries()) {
                    const basePart = key.split('_')[0];
                    const rest = key.slice(basePart.length);
                    const prefixedKey = `${prefixQNum(i, basePart)}${rest}`;
                    mergedMarkingSchemesMap.set(prefixedKey, val);
                }
            }

            // 6. Offset & prefix detectionResults (for ExamPaperTab)
            if (Array.isArray(sub.reindexedDetectionResults)) {
                sub.reindexedDetectionResults.forEach(dr => {
                    const newDr = { ...dr };
                    if (newDr.question) {
                        newDr.question = {
                            ...newDr.question,
                            questionNumber: prefixQNum(i, newDr.question.questionNumber),
                            sourceImageIndex: (newDr.question.sourceImageIndex ?? 0) + currentOffset
                        };
                    }
                    mergedDetectionResults.push(newDr);
                });
            }

            // 7. Offset OCR data
            if (Array.isArray(sub.allPagesOcrData)) {
                sub.allPagesOcrData.forEach(o => {
                    mergedOcrData.push({
                        ...o,
                        pageIndex: (o.pageIndex ?? 0) + currentOffset
                    });
                });
            }

            if (Array.isArray(sub.combinedQuestionResponses)) {
                sub.combinedQuestionResponses.forEach(r => {
                    mergedQuestionResponses.push({
                        ...r,
                        questionNumber: prefixQNum(i, r.questionNumber)
                    });
                });
            }

            totalAwarded += sub.overallScore || 0;
            totalPossible += sub.totalPossibleScore || 0;
            pageOffset += pageCount;
        }

        const overallScoreText = `${totalAwarded}/${totalPossible}`;

        // 8. Build Aggregated Performance Summary (Same-Subject Combined vs Cross-Subject Tabbed)
        const precomputedPerformanceSummaryPromise = (async () => {
            const start = Date.now();
            try {
                const resolvedSummaries = await Promise.all(
                    subResults.map(s => s.precomputedPerformanceSummaryPromise)
                );

                const parsedPayloads: Array<{
                    idx: number;
                    label: string;
                    subjectKey: string;
                    subjectName: string;
                    qualificationSignature: string;
                    payload: any;
                }> = [];

                for (let i = 0; i < resolvedSummaries.length; i++) {
                    const raw = resolvedSummaries[i]?.summary;
                    if (!raw || typeof raw !== 'string' || !raw.trim().startsWith('{')) continue;
                    try {
                        const obj = JSON.parse(raw.trim());
                        if (obj && obj._type === 'AI_SUMMARY_V2') {
                            // Prefix question references inside each paper's summary so clicking jumps to P{i+1}·Q{n}
                            if (Array.isArray(obj.mastered)) {
                                obj.mastered = obj.mastered.map((m: any) => ({
                                    ...m,
                                    q: m.q ? prefixQNum(i, m.q) : m.q
                                }));
                            }
                            if (Array.isArray(obj.focusNext)) {
                                obj.focusNext = obj.focusNext.map((f: any) => ({
                                    ...f,
                                    q: f.q ? prefixQNum(i, f.q) : f.q
                                }));
                            }
                            if (Array.isArray(obj.questionCoaching)) {
                                obj.questionCoaching = obj.questionCoaching.map((qc: any) => ({
                                    ...qc,
                                    q: qc.q ? prefixQNum(i, qc.q) : qc.q
                                }));
                            }

                            const firstMatch =
                                getValidPastPaperMatch(subResults[i]) ||
                                subResults[i]?.reindexedDetectionResults?.find((r: any) => r?.detectionResult?.found && r?.detectionResult?.match)?.detectionResult?.match ||
                                {};
                            const subjName = (obj.examInfo?.subject || firstMatch.subject || subResults[i].subjectProfile?.displayName || 'Paper').trim();
                            const code = obj.examInfo?.examCode || firstMatch.paperCode || subResults[i].paperLabel || `Paper ${i + 1}`;
                            const rawBoard = obj.examInfo?.examBoard || firstMatch.board || '';
                            const rawSeries = obj.examInfo?.examSeries || firstMatch.examSeries || firstMatch.year || '';
                            const rawTier = obj.examInfo?.tier || firstMatch.tier || '';

                            const normBoard = normalizeBoard(rawBoard);
                            const normSeries = normalizeSeries(rawSeries);
                            const normTier = normalizeTier(rawTier, code);

                            const aw = obj.score?.awardedMarks ?? subResults[i].overallScore ?? 0;
                            const tot = obj.score?.totalMarks ?? subResults[i].totalPossibleScore ?? 0;
                            const gradeTag = obj.grading?.grade && obj.grading.grade !== 'N/A' ? ` (${obj.grading.grade})` : '';
                            const subjectKey = String(obj.subjectKey || subResults[i].subjectProfile?.key || subjName).toUpperCase();
                            const subjectNameUpper = subjName.toUpperCase();

                            parsedPayloads.push({
                                idx: i,
                                label: `${code}: ${aw}/${tot}${gradeTag}`,
                                subjectKey,
                                subjectName: subjectNameUpper,
                                qualificationSignature: [subjectKey, subjectNameUpper, normBoard, normSeries, normTier].join('::'),
                                payload: obj
                            });
                        }
                    } catch {
                        // Ignore malformed summary JSON
                    }
                }

                if (parsedPayloads.length === 0) {
                    return { summary: resolvedSummaries[0]?.summary || '', durationMs: Date.now() - start, startTime: start };
                }

                if (parsedPayloads.length === 1) {
                    return {
                        summary: JSON.stringify(parsedPayloads[0].payload),
                        durationMs: Date.now() - start,
                        startTime: start
                    };
                }

                // Determine whether all papers belong to the exact same qualification sitting:
                // same subject + same exam board + same exam series/year + same tier (e.g. Higher vs Foundation).
                // If any of these differ, treat them as separate tabbed papers (hasCombinedOverview: false).
                const distinctQualificationSittings = new Set(parsedPayloads.map(p => p.qualificationSignature));
                const isSameQualificationSitting = distinctQualificationSittings.size === 1;

                if (!isSameQualificationSitting) {
                    // CASE B: Cross-Subject OR Different Year/Series OR Different Tier Upload
                    // Do NOT invent a combined score/grade/radar across incompatible papers; expose per-paper tabs.
                    const firstPayload = {
                        ...parsedPayloads[0].payload,
                        hasCombinedOverview: false,
                        paperSummaries: parsedPayloads.map(p => {
                            const info = p.payload.examInfo || {};
                            const metaParts = [info.examCode, info.examSeries, info.tier].filter(Boolean);
                            const metaTag = metaParts.length > 0 ? ` (${metaParts.join(' • ')})` : '';
                            return {
                                label: `${info.subject || 'Paper'}${metaTag} • ${p.payload.score?.awardedMarks ?? 0}/${p.payload.score?.totalMarks ?? 0}`,
                                summary: p.payload
                            };
                        })
                    };
                    return {
                        summary: JSON.stringify(firstPayload),
                        durationMs: Date.now() - start,
                        startTime: start
                    };
                }

                // CASE A: Same Subject, Multiple Papers (e.g. Edexcel Maths Papers 1, 2, 3)
                const base = parsedPayloads[0].payload;
                const combinedPercentage = totalPossible > 0 ? Math.round((totalAwarded / totalPossible) * 100) : 0;

                // Sum grade boundaries across all papers if every paper has boundaries
                let combinedBoundaries: Record<string, number> | undefined = undefined;
                let combinedGrade: string | null = null;
                const allHaveBoundaries = parsedPayloads.every(
                    p => p.payload.grading?.boundaries && Object.keys(p.payload.grading.boundaries).length > 0
                );
                if (allHaveBoundaries) {
                    combinedBoundaries = {};
                    const gradeKeys = Object.keys(parsedPayloads[0].payload.grading.boundaries);
                    for (const gKey of gradeKeys) {
                        const sumMark = parsedPayloads.reduce(
                            (acc, p) => acc + (Number(p.payload.grading.boundaries[gKey]) || 0),
                            0
                        );
                        if (sumMark > 0) combinedBoundaries[gKey] = sumMark;
                    }
                    const sortedDesc = Object.entries(combinedBoundaries)
                        .map(([g, m]) => ({ g, m }))
                        .sort((a, b) => b.m - a.m);
                    const matched = sortedDesc.find(b => totalAwarded >= b.m);
                    if (matched) {
                        combinedGrade = /^\d+$/.test(matched.g) ? `Grade ${matched.g}` : matched.g;
                    }
                }

                // Merge radar axes across all papers of the same subject
                const axisMap = new Map<string, { awarded: number; total: number; assessed: boolean; fallbackScores: number[] }>();
                parsedPayloads.forEach(p => {
                    (p.payload.radar || []).forEach((pt: any) => {
                        const entry = axisMap.get(pt.axis) || { awarded: 0, total: 0, assessed: false, fallbackScores: [] };
                        entry.awarded += Number(pt.awarded || 0);
                        entry.total += Number(pt.total || 0);
                        if (pt.assessed) entry.assessed = true;
                        if (typeof pt.score === 'number') entry.fallbackScores.push(pt.score);
                        axisMap.set(pt.axis, entry);
                    });
                });

                const combinedRadar = Array.from(axisMap.entries()).map(([axis, data]) => ({
                    axis,
                    awarded: data.awarded,
                    total: data.total,
                    assessed: data.assessed,
                    score: data.total > 0
                        ? Math.round((data.awarded / data.total) * 100)
                        : (data.fallbackScores.length > 0
                            ? Math.round(data.fallbackScores.reduce((a, b) => a + b, 0) / data.fallbackScores.length)
                            : 0)
                }));

                const paperBreakdownHeadline = parsedPayloads
                    .map((p, idx) => {
                        const code = p.payload.examInfo?.examCode || `Paper ${idx + 1}`;
                        const aw = p.payload.score?.awardedMarks ?? 0;
                        const tot = p.payload.score?.totalMarks ?? 0;
                        const gr = p.payload.grading?.grade && p.payload.grading.grade !== 'N/A' ? ` (${p.payload.grading.grade})` : '';
                        return `${code}: ${aw}/${tot}${gr}`;
                    })
                    .join(' • ');

                const combinedCodes = Array.from(
                    new Set(parsedPayloads.map(p => p.payload.examInfo?.examCode).filter(Boolean))
                ).join(', ');

                const combinedPayload = {
                    ...base,
                    headline: paperBreakdownHeadline,
                    examInfo: base.examInfo
                        ? {
                            ...base.examInfo,
                            examCode: combinedCodes || base.examInfo.examCode
                        }
                        : null,
                    score: {
                        awardedMarks: totalAwarded,
                        totalMarks: totalPossible,
                        percentage: combinedPercentage,
                        questionsTotal: parsedPayloads.reduce((s, p) => s + Number(p.payload.score?.questionsTotal || 0), 0),
                        questionsFullMarks: parsedPayloads.reduce((s, p) => s + Number(p.payload.score?.questionsFullMarks || 0), 0),
                        questionsAttempted: parsedPayloads.reduce((s, p) => s + Number(p.payload.score?.questionsAttempted || 0), 0)
                    },
                    grading: combinedBoundaries
                        ? {
                            grade: combinedGrade,
                            predictedGrade: combinedGrade,
                            boundaries: combinedBoundaries
                        }
                        : base.grading,
                    radar: combinedRadar,
                    mastered: parsedPayloads.flatMap(p => (p.payload.mastered || []).slice(0, 2)).slice(0, 5),
                    focusNext: parsedPayloads.flatMap(p => (p.payload.focusNext || []).slice(0, 2)).slice(0, 5),
                    questionCoaching: parsedPayloads.flatMap(p => p.payload.questionCoaching || []),
                    hasCombinedOverview: true,
                    paperSummaries: parsedPayloads.map(p => ({
                        label: p.label,
                        summary: p.payload
                    }))
                };

                return {
                    summary: JSON.stringify(combinedPayload),
                    durationMs: Date.now() - start,
                    startTime: start
                };
            } catch (err) {
                console.warn('⚠️ [MULTI-PAPER SUMMARY] Failed to aggregate summaries:', err);
                return { summary: '', durationMs: Date.now() - start, startTime: start };
            }
        })();

        return {
            sortedStandardizedPages: mergedStandardizedPages,
            updatedQuestionResults: mergedQuestionResults,
            classificationResult: {
                category: 'questionAnswer',
                questions: mergedClassificationQuestions,
                hasAnyStudentWork: true,
                hasMixedContent: false
            },
            allClassificationResults: mergedAllClassificationResults,
            markingSchemesMap: mergedMarkingSchemesMap,
            reindexedDetectionResults: mergedDetectionResults,
            finalAnnotatedOutput: mergedAnnotatedOutput,
            overallScore: totalAwarded,
            totalPossibleScore: totalPossible,
            overallScoreText,
            allPagesOcrData: mergedOcrData,
            combinedQuestionResponses: mergedQuestionResponses,
            precomputedPerformanceSummaryPromise
        };
    }
}
