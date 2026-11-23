import { getBaseQuestionNumber } from '../../utils/TextNormalizationUtils.js';

const PAGE_NUMBER_REGEX = /^[-–—\s]*(?:p(?:age|\.)?\s*)?\d{1,3}(?:\s*(?:\/|of)\s*\d{1,3})?[-–—\s]*$/i;
const BOILERPLATE_REGEX = /\b(do\s+not\s+write|leave\s+blank|turn\s+over|blank\s+page|end\s+of\s+paper|total\s+for\s+question|additional\s+page|extra\s+space|pmt\s+education|physics\s+and\s+maths\s+tutor|question\s+\d+\s+continued)\b/i;

function getBlockText(block: any): string {
    return String(block?.mathpixLatex || block?.googleVisionText || block?.text || '').trim();
}

function stripLatexWrappers(text: string): string {
    return text
        .replace(/\[PRINTED_INSTRUCTION[^\]]*\]/gi, '')
        .replace(/\\text\s*\{([^}]*)\}/g, '$1')
        .replace(/\\(?:left|right|quad|qquad|,|;|!|~)/g, ' ')
        .replace(/\\\(|\\\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeForComparison(text: string): string {
    return stripLatexWrappers(text).toLowerCase().replace(/[^a-z0-9=+\-./]/g, '');
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isExplicitLabelForQuestion(rawText: string, baseQNum: string): boolean {
    if (!baseQNum) return false;
    const escaped = escapeRegExp(baseQNum);

    // Explicit printed/question tag injected by upstream OCR tagging, e.g. "(3) [PRINTED_INSTRUCTION [Q3]]"
    if (new RegExp(`\\[PRINTED_INSTRUCTION\\s*\\[Q${escaped}\\b`, 'i').test(rawText)) {
        return true;
    }

    const cleaned = stripLatexWrappers(rawText);
    if (!cleaned) return false;

    // Matches leading question labels: "(3)", "3)", "3.", "Q3", "Q3a", "(3) a)", "3 a)"
    const leadingLabelRegex = new RegExp(
        `^(?:\\(\\s*${escaped}\\s*\\)|(?:Q\\s*)?${escaped}\\s*[.)]|Q\\s*${escaped}\\b)(?:\\s|$|[a-z]\\s*[.)])`,
        'i'
    );
    return leadingLabelRegex.test(cleaned);
}

function isSubstantiveContinuationText(rawText: string): boolean {
    if (!rawText) return false;
    if (/\[PRINTED_INSTRUCTION/i.test(rawText)) return false;

    const cleaned = stripLatexWrappers(rawText);
    if (!cleaned) return false;
    if (PAGE_NUMBER_REGEX.test(cleaned)) return false;
    if (BOILERPLATE_REGEX.test(cleaned)) return false;

    // Continuation math line (e.g. "= 4.58", "=> k = 3", "\Rightarrow x = 2") or >= 3 alphanumeric chars
    if (/^(?:=|=>|\\Rightarrow|\\therefore|\\approx)/i.test(cleaned)) return true;
    const alnumCount = (cleaned.match(/[a-z0-9]/gi) || []).length;
    return alnumCount >= 3;
}

function getNodePageIndices(node: any): number[] {
    const indices = new Set<number>();
    if (Array.isArray(node?.sourceImageIndices)) {
        node.sourceImageIndices.forEach((i: any) => {
            if (typeof i === 'number' && !isNaN(i)) indices.add(i);
        });
    }
    if (typeof node?.sourceImageIndex === 'number' && !isNaN(node.sourceImageIndex)) {
        indices.add(node.sourceImageIndex);
    }
    if (typeof node?.pageIndex === 'number' && !isNaN(node.pageIndex)) {
        indices.add(node.pageIndex);
    }
    if (Array.isArray(node?.studentWorkLines)) {
        node.studentWorkLines.forEach((l: any) => {
            const p = l?.pageIndex ?? l?.position?.pageIndex;
            if (typeof p === 'number' && !isNaN(p)) indices.add(p);
        });
    }
    return Array.from(indices).sort((a, b) => a - b);
}

function getMaxLineYOnPage(node: any, pageIndex: number): number {
    let maxY = -1;
    const lines = Array.isArray(node?.studentWorkLines) ? node.studentWorkLines : [];
    for (const l of lines) {
        const p = l?.pageIndex ?? l?.position?.pageIndex;
        if (p === pageIndex) {
            const y = typeof l?.position?.y === 'number' ? l.position.y : 0;
            if (y > maxY) maxY = y;
        }
    }
    return maxY;
}

function getMinLineYOnPage(node: any, pageIndex: number): number {
    let minY = Number.POSITIVE_INFINITY;
    const lines = Array.isArray(node?.studentWorkLines) ? node.studentWorkLines : [];
    for (const l of lines) {
        const p = l?.pageIndex ?? l?.position?.pageIndex;
        if (p === pageIndex && typeof l?.position?.y === 'number') {
            if (l.position.y < minY) minY = l.position.y;
        }
    }
    if (Array.isArray(node?.subQuestions)) {
        for (const sq of node.subQuestions) {
            const subMin = getMinLineYOnPage(sq, pageIndex);
            if (subMin < minY) minY = subMin;
        }
    }
    return minY;
}

function hasSubstantialPrintedPrompt(q: any): boolean {
    const qText = String(q?.text || '').trim();
    if (qText.length >= 25) return true;
    if (Array.isArray(q?.subQuestions)) {
        return q.subQuestions.some((sq: any) => String(sq?.text || '').trim().length >= 25);
    }
    return false;
}

function collectNormalizedWorkLinesOnPage(q: any, pageIndex: number): Set<string> {
    const set = new Set<string>();
    const addLines = (lines: any[]) => {
        for (const l of lines) {
            const p = l?.pageIndex ?? l?.position?.pageIndex;
            if (p === pageIndex) {
                const norm = normalizeForComparison(String(l?.text || l?.t || ''));
                if (norm) set.add(norm);
            }
        }
    };
    if (Array.isArray(q?.studentWorkLines)) addLines(q.studentWorkLines);
    if (Array.isArray(q?.subQuestions)) {
        q.subQuestions.forEach((sq: any) => {
            if (Array.isArray(sq?.studentWorkLines)) addLines(sq.studentWorkLines);
        });
    }
    return set;
}

function getNextLineSequence(q: any): number {
    let maxSeq = 0;
    const scan = (lines?: any[]) => {
        if (!Array.isArray(lines)) return;
        for (const l of lines) {
            const m = String(l?.id || '').match(/_line_(\d+)$/);
            if (m) {
                const n = Number(m[1]);
                if (n > maxSeq) maxSeq = n;
            }
        }
    };
    scan(q?.studentWorkLines);
    if (Array.isArray(q?.subQuestions)) {
        q.subQuestions.forEach((sq: any) => scan(sq?.studentWorkLines));
    }
    return maxSeq + 1;
}

export interface SpilloverRescueRecord {
    fromPageIndex: number;
    toPageIndex: number;
    questionNumber: string;
    subQuestionPart?: string;
    rescuedTexts: string[];
}

/**
 * Narrow, zero-LLM safety net for handwritten notebook / lined-paper page-boundary spillover:
 * When the last sub-question on Page N finishes with 1–3 unnumbered continuation lines at the
 * very top of Page N+1 (above the explicit label for the next question, e.g. `= 4.58` above `(3)`),
 * and the Mapper missed that spillover, attach Page N+1 and synthesize the missing studentWorkLines
 * onto Page N's final sub-question.
 *
 * Strictly guarded to avoid touching printed exam booklets or pages where the Mapper already
 * mapped the continuation.
 */
export function rescueOrphanTopLineSpillover(params: {
    classificationResult: any;
    allPagesOcrData: Array<{ pageIndex: number; ocrData?: { mathBlocks?: any[] } }>;
    pageDimensionsMap?: Map<number, { width: number; height: number }>;
    metaPageIndices?: number[];
}): SpilloverRescueRecord[] {
    const { classificationResult, allPagesOcrData, pageDimensionsMap, metaPageIndices = [] } = params;
    const rescues: SpilloverRescueRecord[] = [];

    const questions: any[] = classificationResult?.questions;
    if (!Array.isArray(questions) || questions.length < 2 || !Array.isArray(allPagesOcrData) || allPagesOcrData.length < 2) {
        return rescues;
    }

    const metaSet = new Set<number>(metaPageIndices);
    const ocrByPage = new Map<number, any[]>();
    for (const page of allPagesOcrData) {
        const blocks = page?.ocrData?.mathBlocks;
        if (typeof page?.pageIndex === 'number' && Array.isArray(blocks) && blocks.length > 0) {
            ocrByPage.set(page.pageIndex, blocks);
        }
    }

    const sortedPageIndices = Array.from(ocrByPage.keys()).sort((a, b) => a - b);

    for (const pageIdx of sortedPageIndices) {
        const nextPageIdx = pageIdx + 1;
        if (metaSet.has(pageIdx) || metaSet.has(nextPageIdx)) continue;
        const nextBlocks = ocrByPage.get(nextPageIdx);
        if (!nextBlocks || nextBlocks.length < 2) continue;

        // 1. Find the last question/sub-question with student work on `pageIdx`
        const candidatesOnPage: Array<{ q: any; sq?: any; maxY: number; orderIdx: number }> = [];
        questions.forEach((q, qIdx) => {
            if (Array.isArray(q?.subQuestions) && q.subQuestions.length > 0) {
                q.subQuestions.forEach((sq: any, sqIdx: number) => {
                    const sqPages = getNodePageIndices(sq);
                    const hasWorkOnPage = Array.isArray(sq?.studentWorkLines) && sq.studentWorkLines.some(
                        (l: any) => (l?.pageIndex ?? l?.position?.pageIndex) === pageIdx
                    );
                    if (sqPages.includes(pageIdx) && hasWorkOnPage) {
                        candidatesOnPage.push({
                            q,
                            sq,
                            maxY: getMaxLineYOnPage(sq, pageIdx),
                            orderIdx: qIdx * 100 + sqIdx
                        });
                    }
                });
            } else {
                const qPages = getNodePageIndices(q);
                const hasWorkOnPage = Array.isArray(q?.studentWorkLines) && q.studentWorkLines.some(
                    (l: any) => (l?.pageIndex ?? l?.position?.pageIndex) === pageIdx
                );
                if (qPages.includes(pageIdx) && hasWorkOnPage) {
                    candidatesOnPage.push({
                        q,
                        maxY: getMaxLineYOnPage(q, pageIdx),
                        orderIdx: qIdx * 100
                    });
                }
            }
        });

        if (candidatesOnPage.length === 0) continue;

        candidatesOnPage.sort((a, b) => {
            if (a.maxY >= 0 && b.maxY >= 0 && a.maxY !== b.maxY) return b.maxY - a.maxY;
            return b.orderIdx - a.orderIdx;
        });
        const lastOnPage = candidatesOnPage[0];
        const prevBaseQ = getBaseQuestionNumber(String(lastOnPage.q?.questionNumber || '')) || String(lastOnPage.q?.questionNumber || '').trim();

        // Skip if Mapper already mapped this question onto nextPageIdx
        const targetNode = lastOnPage.sq || lastOnPage.q;
        if (getNodePageIndices(lastOnPage.q).includes(nextPageIdx) || getNodePageIndices(targetNode).includes(nextPageIdx)) {
            continue;
        }

        // 2. Find the first question mapped on `nextPageIdx`
        const questionsOnNextPage = questions
            .map((q, idx) => ({ q, idx, minY: getMinLineYOnPage(q, nextPageIdx) }))
            .filter(({ q }) => getNodePageIndices(q).includes(nextPageIdx));

        if (questionsOnNextPage.length === 0) continue;

        questionsOnNextPage.sort((a, b) => {
            if (isFinite(a.minY) && isFinite(b.minY) && a.minY !== b.minY) return a.minY - b.minY;
            return a.idx - b.idx;
        });
        const firstOnNext = questionsOnNextPage[0].q;
        const nextBaseQ = getBaseQuestionNumber(String(firstOnNext?.questionNumber || '')) || String(firstOnNext?.questionNumber || '').trim();

        if (!nextBaseQ || nextBaseQ === prevBaseQ) continue;

        // 3. Notebook / lined-paper guard: skip printed exam booklets where nextQ has a printed question stem
        if (hasSubstantialPrintedPrompt(firstOnNext)) continue;

        // 4. Locate the explicit question label block for `firstOnNext` on `nextPageIdx`
        const positionedBlocks = nextBlocks
            .filter(b => b?.coordinates && typeof b.coordinates.y === 'number')
            .sort((a, b) => a.coordinates.y - b.coordinates.y);

        if (positionedBlocks.length < 2) continue;

        const firstLabelBlock = positionedBlocks.find(b => isExplicitLabelForQuestion(getBlockText(b), nextBaseQ));
        if (!firstLabelBlock) continue;

        const labelY = firstLabelBlock.coordinates.y;
        const pageHeight = pageDimensionsMap?.get(nextPageIdx)?.height || 0;
        const minValidBottomY = pageHeight > 0 ? pageHeight * 0.02 : 0;
        const nextQWorkSet = collectNormalizedWorkLinesOnPage(firstOnNext, nextPageIdx);

        // 5. Collect orphan blocks strictly above `firstLabelBlock`
        const orphanBlocks = positionedBlocks.filter(b => {
            if (b === firstLabelBlock) return false;
            const y = b.coordinates.y;
            const h = typeof b.coordinates.height === 'number' ? b.coordinates.height : 0;
            if (y >= labelY) return false;
            if (minValidBottomY > 0 && y + h <= minValidBottomY) return false;

            const rawText = getBlockText(b);
            if (!isSubstantiveContinuationText(rawText)) return false;

            const norm = normalizeForComparison(rawText);
            if (!norm || nextQWorkSet.has(norm)) return false;

            return true;
        });

        // Strict cap: genuine top-of-page spillover is 1–3 continuation lines
        if (orphanBlocks.length === 0 || orphanBlocks.length > 3) continue;

        // 6. Attach nextPageIdx and synthesize studentWorkLines onto Page N's final sub-question
        const addPageIndex = (node: any) => {
            const existing = Array.isArray(node.sourceImageIndices)
                ? node.sourceImageIndices
                : (typeof node.sourceImageIndex === 'number' ? [node.sourceImageIndex] : [pageIdx]);
            node.sourceImageIndices = Array.from(new Set([...existing, nextPageIdx])).sort((a, b) => a - b);
        };

        addPageIndex(lastOnPage.q);
        if (lastOnPage.sq) {
            addPageIndex(lastOnPage.sq);
        }

        if (!Array.isArray(targetNode.studentWorkLines)) {
            targetNode.studentWorkLines = [];
        }

        let nextLineSeq = getNextLineSequence(lastOnPage.q);
        const rescuedTexts: string[] = [];

        for (const block of orphanBlocks) {
            const cleanText = stripLatexWrappers(getBlockText(block));
            const coords = block.coordinates;
            targetNode.studentWorkLines.push({
                id: `p${nextPageIdx}_q${prevBaseQ}_line_${nextLineSeq++}`,
                text: cleanText,
                pageIndex: nextPageIdx,
                position: {
                    x: coords.x,
                    y: coords.y,
                    width: coords.width,
                    height: coords.height,
                    pageIndex: nextPageIdx
                },
                ...(block.globalBlockId ? { globalBlockId: block.globalBlockId } : {})
            });
            rescuedTexts.push(cleanText);
        }

        const label = lastOnPage.sq ? `${prevBaseQ}${lastOnPage.sq.part || ''}` : prevBaseQ;
        console.log(
            `🩹 [SPILLOVER-RESCUE] Attached ${rescuedTexts.length} orphan top line(s) from Page ${nextPageIdx + 1} to Q${label}: "${rescuedTexts.join(' | ')}"`
        );

        rescues.push({
            fromPageIndex: nextPageIdx,
            toPageIndex: pageIdx,
            questionNumber: prevBaseQ,
            ...(lastOnPage.sq?.part ? { subQuestionPart: lastOnPage.sq.part } : {}),
            rescuedTexts
        });
    }

    return rescues;
}
