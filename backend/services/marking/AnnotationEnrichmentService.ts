import type { Annotation, EnrichedAnnotation, MarkingTask } from '../../types/index.js';
import { CoordinateTransformationService } from './CoordinateTransformationService.js';
import { ZoneUtils } from '../../utils/ZoneUtils.js';
import { CoordinateAuditLogger } from '../../utils/LoggerUtils.js';
import { AnnotationCollisionService } from './AnnotationCollisionService.js';
import { latexToPlainText } from '../../utils/TextNormalizationUtils.js';

const getPageDims = (pageDimensions: Map<number, any>, idx: number) => {
    if (pageDimensions?.has(idx)) return pageDimensions.get(idx);
    if (pageDimensions?.size === 1) return pageDimensions.values().next().value;
    return { width: 1000, height: 1000 };
};

// Helper: Check if two mark codes are "The Same Type"
// e.g. "M1" and "M0" are equivalent (Method Mark type)
// e.g. "A1" and "M0" are NOT equivalent (Accuracy vs Method)
const areMarkCodesEquivalent = (tickCode: string, crossCode: string): boolean => {
    // 1. Strict Match (e.g. "M1" hides "M1")
    if (tickCode === crossCode) return true;

    // 2. Zero-Code Matching (e.g. "M1" hides "M0")
    const tickType = tickCode.charAt(0).toUpperCase();
    const crossType = crossCode.charAt(0).toUpperCase();

    // Check if the cross is a "Zero" version (ends in 0) AND types match
    if (crossCode.endsWith('0') && tickType === crossType) {
        return true;
    }

    return false;
};

// Logic: Hide Crosses ONLY if a Tick of the SAME CODE exists on the same line,
// while preserving partial-credit 0-mark crosses (e.g. ✓ B1 + ✗ B0 on a 2-mark single-line answer)
// that carry distinct constructive error reasoning for the student.
const applyPositiveDominance = (annotations: EnrichedAnnotation[]): EnrichedAnnotation[] => {
    // 1. Map lines to their Awarded Marks (Ticks)
    const lineTicksMap = new Map<string, Array<{ code: string; reasoning: string }>>();

    annotations.forEach(anno => {
        // Use linked_ocr_id as it is already resolved in the enriched loop
        const lineId = anno.linked_ocr_id;
        if (lineId && anno.action === 'tick' && (anno.text || anno.classification_text)) {
            if (!lineTicksMap.has(lineId)) {
                lineTicksMap.set(lineId, []);
            }
            const markText = anno.text || anno.classification_text || "";
            const tickReason = String((anno as any).reasoning || '').trim().toLowerCase();
            lineTicksMap.get(lineId)?.push({ code: markText, reasoning: tickReason });
        }
    });

    // 2. Filter out Crosses that are dominated by an equivalent Tick
    return annotations.filter(anno => {
        const lineId = anno.linked_ocr_id;
        const markText = anno.text || anno.classification_text;
        if (anno.action === 'cross' && lineId && markText) {
            const ticksOnThisLine = lineTicksMap.get(lineId);

            if (ticksOnThisLine) {
                const crossReason = String((anno as any).reasoning || '').trim().toLowerCase();

                // Always hide strict contradictions (e.g. ✓ B1 and ✗ B1 on the same line)
                const hasStrictDuplicate = ticksOnThisLine.some(t => t.code === markText);
                if (hasStrictDuplicate) {
                    return false;
                }

                // For 0-mark crosses of the same mark family (e.g. ✓ B1 + ✗ B0 on the same line):
                // keep the cross when it provides distinct error feedback (partial credit on a single line),
                // and only hide redundant crosses with empty or identical reasoning.
                const hasEquivalentTick = ticksOnThisLine.some(t =>
                    areMarkCodesEquivalent(t.code, markText)
                );

                if (hasEquivalentTick) {
                    const hasDistinctFeedback =
                        crossReason.length > 0 &&
                        !ticksOnThisLine.some(t => t.reasoning === crossReason);
                    if (!hasDistinctFeedback) {
                        // HIDE THIS CROSS (Positive Dominance)
                        return false;
                    }
                }
            }
        }
        return true; // Keep everything else
    });
};

export const enrichAnnotationsWithPositions = (
    annotations: Annotation[],
    stepsDataForMapping: any[],
    questionId: string,
    defaultPageIndex: number = 0,
    pageDimensions?: Map<number, { width: number; height: number }>,
    classificationBlocks?: any[], // Unused
    task?: MarkingTask,
    visualObservation?: string,
    globalOffsetX: number = 0,
    globalOffsetY: number = 0,
    semanticZones?: Record<string, Array<{ startY: number; endY: number; pageIndex: number; x: number }>>
): EnrichedAnnotation[] => {

    // Helper: Lookup Text or Handwriting blocks (supports [ID-LIE] relative IDs)
    const findInData = (id: string) => stepsDataForMapping.find(s =>
        s.line_id === id ||
        s.globalBlockId === id ||
        s.id === id ||
        s.relative_line_id === id ||
        (s as any).relative_id === id
    );

    const enriched = annotations.map((anno, idx) => {
        let pageIndex = (anno as any).pageIndex ?? defaultPageIndex;

        // 🛡️ [TRUTH-FIRST]: Trust the physical page index if confirmed.
        // Otherwise, resolve relative to task configuration.
        if (!(anno as any).isPhysicalPage) {
            if (task?.pageMap) {
                // Check if pageIndex is a relative index in the map values
                const absPage = Object.entries(task.pageMap).find(([abs, rel]) => rel === pageIndex)?.[0];
                if (absPage !== undefined) {
                    pageIndex = parseInt(absPage);
                }
            } else if (task?.sourcePages && pageIndex < task.sourcePages.length) {
                // Fallback to sourcePages array index
                pageIndex = task.sourcePages[pageIndex];
            }
        }

        let method = "NONE";
        let hasLineData: boolean | undefined = undefined;
        let isSplitBlock: boolean | undefined = (anno as any).isSplitBlock;
        let rawBox: any = null;

        // 1. READ STATUS
        let status = (anno as any).ocr_match_status || "UNMATCHED";
        let lineId = (anno as any).line_id;
        let targetId = (anno as any).linked_ocr_id || (anno.linked_ocr_id as any);
        let activePointer = targetId || lineId; // 🛡️ [PRIORITY]: Prefer the OCR Match (targetId) over the raw line source.
        const rawVisualPos = (anno as any).visual_position || (anno as any).aiPosition;

        // 🛡️ ORPHAN RESCUE: Handle "Unmatched" marks with no handwriting source
        if (status === "UNMATCHED" && !lineId && rawVisualPos) {
            console.warn(`[RESCUE] Annotation ${anno.subQuestion} is UNMATCHED with no line_id. Promoting to VISUAL using AI coordinates.`);
            status = "VISUAL";
        }

        // 🛡️ [HIGH-PAGE PREFERENCE]: For Drawings/Visuals on multi-page questions.
        // If AI didn't provide a specific ID, default to the HIGHEST valid page index.
        // 🚨 [PARENT-AWARE FIX]: Only shift if target page belongs to same main question AND this task's active pages.
        // Never shift neutral `not_attempted` pills.
        const isNotAttempted = (anno as any).action === 'not_attempted';
        if (status === "VISUAL" && !isNotAttempted && !activePointer && semanticZones) {
            const allowedTaskPages: Set<number> | null = task?.pageMap && Object.keys(task.pageMap).length > 0
                ? new Set(Object.keys(task.pageMap).map(k => parseInt(k, 10)).filter(n => !isNaN(n)))
                : (Array.isArray(task?.sourcePages) && task.sourcePages.length > 0
                    ? new Set(task.sourcePages)
                    : null);

            const currentQuestionId = (questionId || "").replace(/\D/g, '');
            const allMatchingZones = ZoneUtils.findAllMatchingZones(anno.subQuestion, semanticZones, currentQuestionId);
            const zones = allowedTaskPages
                ? allMatchingZones.filter(z => allowedTaskPages.has(z.pageIndex))
                : allMatchingZones;
            if (zones.length > 1) {
                const highestPage = Math.max(...zones.map(z => z.pageIndex));

                // Extract parent question number (e.g., "11b" -> "11", "5a" -> "5")
                const getParentQuestion = (label: string) => label.replace(/[a-z()]/gi, '').trim();

                const currentParent = getParentQuestion(anno.subQuestion || '');
                const currentZone = zones.find(z => z.pageIndex === pageIndex);
                const targetZone = zones.find(z => z.pageIndex === highestPage);

                // Check if target page belongs to same parent question
                const targetParent = targetZone ? getParentQuestion(
                    // Try to extract parent from zone label or use current parent as fallback
                    Object.keys(semanticZones).find(key =>
                        semanticZones[key].some((z: any) => z === targetZone)
                    ) || anno.subQuestion || ''
                ) : currentParent;

                const nextPageHasSameParent = currentParent === targetParent && currentParent !== '';

                if (nextPageHasSameParent && pageIndex !== highestPage) {
                    console.log(` 🚀 [HIGH-PAGE] Shifting VISUAL Q${anno.subQuestion} from P${pageIndex} -> P${highestPage} (Drawing preference)`);
                    pageIndex = highestPage;
                    (anno as any).pageIndex = highestPage;
                } else if (!nextPageHasSameParent) {
                    console.log(` 🚫 [HIGH-PAGE-BLOCKED] Q${anno.subQuestion} stays on P${pageIndex} (Parent mismatch: current=${currentParent}, target=${targetParent})`);
                }
            }
        }

        // =====================================================================
        // 🛡️ IRON DOME: SILO & PAGE ENFORCEMENT
        // =====================================================================
        let source = findInData(activePointer);

        if (source && source.subQuestionLabel && anno.subQuestion) {
            const normalize = (s: string) => s.replace(/\d+|question|part/gi, '').trim().toLowerCase();
            const annoLabel = normalize(anno.subQuestion);
            const sourceLabel = normalize(source.subQuestionLabel);

            // 1. DETERMINE TRUTH PAGES
            let trueZonePages: number[] = [];
            if (semanticZones) {
                const currentQuestionId = (questionId || "").replace(/\D/g, '');
                const zones = ZoneUtils.findAllMatchingZones(anno.subQuestion, semanticZones, currentQuestionId);
                trueZonePages = zones.map(z => z.pageIndex);
            }

            // 🛡️ [SMART OVERRIDE]: If Visual + P1 Candidate exists, Trust P1 over Zone Detector (Legacy Rule)
            if ((status === 'VISUAL' || (anno.text || '').includes('B')) && trueZonePages.includes(0)) {
                const p1Candidate = stepsDataForMapping.find(s =>
                    s.subQuestionLabel && normalize(s.subQuestionLabel) === annoLabel && s.pageIndex === 1
                );
                if (p1Candidate && !trueZonePages.includes(1)) trueZonePages.push(1);
            }

            // 2. DETECT VIOLATION
            const labelMismatch = (annoLabel && sourceLabel && annoLabel !== sourceLabel && sourceLabel !== 'main');

            // A mismatch only exists if the found source is on a page that HAS NO ZONE for this question part.
            const pageMismatch = (trueZonePages.length > 0 && source.pageIndex !== undefined && !trueZonePages.includes(source.pageIndex));
            const isRelaxedMatch = !labelMismatch && (annoLabel === sourceLabel || sourceLabel === 'main');

            if (labelMismatch || (pageMismatch && !isRelaxedMatch)) {
                // 3. SEARCH REPLACEMENT
                let candidates = stepsDataForMapping.filter(s =>
                    s.subQuestionLabel && normalize(s.subQuestionLabel) === annoLabel
                );

                // Prioritize Correct Page (Try to find a candidate on ANY of the true zone pages)
                if (pageMismatch) {
                    const pageSpecific = candidates.filter(s => trueZonePages.includes(s.pageIndex));
                    if (pageSpecific.length > 0) candidates = pageSpecific;
                }

                if (candidates.length > 0) {
                    // Sort: Visuals first
                    candidates.sort((a, b) => (a.text?.includes('VISUAL') ? -1 : 1));
                    const best = candidates[0];

                    // 4. SNAP & UPDATE
                    lineId = best.line_id;
                    targetId = best.line_id;

                    (anno as any).line_id = best.line_id;
                    (anno as any).linked_ocr_id = best.line_id;

                    // 🚨 FIX: Don't force MATCHED. Keep VISUAL/UNMATCHED.
                    // This prevents re-linking to a vetoed block.
                    // if (status === "UNMATCHED") status = "MATCHED";

                    console.log(`✅ [IRON-DOME] Snapped mark to: ${lineId} (P${best.pageIndex})`);
                }
            }
        }
        // =====================================================================

        // 1. DIMENSION GROUND TRUTH
        const dims = getPageDims(pageDimensions!, pageIndex);
        const pageWidth = dims.width || 1000;
        const pageHeight = dims.height || 1000;

        // 2. PIXEL NORMALIZATION (The "Pump")
        const rawAiBox = Array.isArray(anno.bbox)
            ? [anno.bbox[0], anno.bbox[1], anno.bbox[2], anno.bbox[3]]
            : [(anno.bbox as any)?.x || 0, (anno.bbox as any)?.y || 0, (anno.bbox as any)?.width || 0, (anno.bbox as any)?.height || 0];

        // 🛡️ STRENGTHEN EXTRACTION: Use multiple potential coordinate sources to avoid "0px Jump"
        const rawX = (anno as any).visual_position?.x ?? (anno as any).aiPosition?.x ?? (anno as any).bbox?.x ?? (Array.isArray((anno as any).bbox) ? (anno as any).bbox[0] : rawAiBox[0]);
        const rawY = (anno as any).visual_position?.y ?? (anno as any).aiPosition?.y ?? (anno as any).bbox?.y ?? (Array.isArray((anno as any).bbox) ? (anno as any).bbox[1] : rawAiBox[1]);

        const intentX = (rawX / 100) * pageWidth;
        const intentY = (rawY / 100) * pageHeight;

        // 3. AUTHORITY SELECTION (Initial Intent)
        let authorityBox: [number, number, number, number] = [
            intentX,
            intentY,
            (rawAiBox[2] / 100) * pageWidth,
            (rawAiBox[3] / 100) * pageHeight || (pageHeight * 0.015) // Height Protection
        ];

        // 4. ZONE PROTECTION (Requirement: AI Intent limited to Intended Zone)
        let finalX = intentX;
        let finalY = intentY;

        if (semanticZones) {
            const currentQuestionId = (questionId || "").replace(/\D/g, '');
            const allMatchingZones = ZoneUtils.findAllMatchingZones(anno.subQuestion, semanticZones, currentQuestionId);
            const zone = allMatchingZones.find(z => z.pageIndex === pageIndex);

            if (!zone && allMatchingZones.length > 0) {
                CoordinateAuditLogger.audit(5, `Enrichment Q${anno.subQuestion}`, `Zone MISS for P${pageIndex}. Available: [${allMatchingZones.map(z => z.pageIndex).join(', ')}]`);
            } else if (!zone) {
                CoordinateAuditLogger.audit(5, `Enrichment Q${anno.subQuestion}`, `NO ZONES FOUND at all for Q${currentQuestionId}`);
            }

            if (zone) {
                const zoneH = zone.endY - zone.startY;

                // DYNAMIC MARGIN: 5% of zone height, capped between 10px and 100px
                const margin = Math.max(10, Math.min(100, zoneH * 0.1));

                // 🕵️ [AUDIT-5-ENRICH]: Final Zone Clamping
                CoordinateAuditLogger.audit(5, `Enrichment Q${anno.subQuestion}`, `Zone P${zone.pageIndex} [${zone.startY}-${zone.endY}] | Pre-Clamp Y: ${intentY.toFixed(0)}`);

                // LIMIT HEIGHT: Cap at 35% to ensure staggering room
                let annoH = (rawAiBox[3] / 100) * pageHeight;
                if (status === 'VISUAL' && annoH > zoneH * 0.35) {
                    annoH = zoneH * 0.35;
                }

                // THE FIX: Move the Y-anchor UP by half the box height
                // This makes the AI's "Center" instruction work as intended
                const centeredY = intentY - (annoH / 2);

                // CLAMP: Keep the box and its dynamic margin inside the zone
                finalY = Math.max(
                    zone.startY + margin,
                    Math.min(centeredY, zone.endY - annoH - margin)
                );

                // console.log(`🛡️ [11b-FIX] Q${anno.subQuestion} | IntentY: ${intentY.toFixed(0)} | Floor: ${(zone.endY - annoH).toFixed(0)} | ResultY: ${finalY.toFixed(0)}`);

                const annoW = (rawAiBox[2] / 100) * pageWidth;
                // PATH 3 recovered positions are already anchored at box.x + box.width + padding (right edge of handwriting):
                // never pull them back left by annoW/2 into student handwriting.
                const isPath3Recovered = Boolean((anno as any)._path3Recovered);
                const rawTargetX = isPath3Recovered ? intentX : (intentX - (annoW / 2));
                const maxPrintableX = Math.round(pageWidth * 0.90) - annoW;
                finalX = Math.max(
                    (zone.x || 0) + margin,
                    Math.min(rawTargetX, Math.min(((zone.x || 0) + (zone.width || pageWidth)) - annoW - margin, maxPrintableX))
                );

                authorityBox = [finalX, finalY, isPath3Recovered ? 0 : annoW, annoH];
            }
        }

        // Update authority box with clamped values
        authorityBox[0] = finalX;
        authorityBox[1] = finalY;

        const linkedOcrBlock = activePointer ? findInData(activePointer) : null;
        const isDrawingPointer = Boolean(activePointer && String(activePointer).includes('visual_drawing'));

        // Helper to normalize any step/OCR bbox into pixel coordinates
        const toPixelBox = (block: any): [number, number, number, number] | null => {
            if (!block?.bbox) return null;
            const b = block.bbox;
            const raw: [number, number, number, number] = Array.isArray(b)
                ? [Number(b[0]) || 0, Number(b[1]) || 0, Number(b[2]) || 0, Number(b[3]) || 0]
                : [Number(b.x) || 0, Number(b.y) || 0, Number(b.width) || 0, Number(b.height) || 0];
            if (raw[2] <= 0 && raw[3] <= 0) return null;
            if (block.unit === 'percentage') {
                return [
                    (raw[0] / 100) * pageWidth,
                    (raw[1] / 100) * pageHeight,
                    (raw[2] / 100) * pageWidth,
                    (raw[3] / 100) * pageHeight
                ];
            }
            return raw;
        };

        // 🎨 [DIAGRAM-ANCHORING]: For ocr_match_status: 'VISUAL', ALWAYS anchor to the diagram bounding box
        // ([DRAWING] / visual_drawing / [VISUAL WORKSPACE]) rather than nearby arithmetic working.
        // Never hijack neutral `not_attempted` pills onto another sub-question's diagram!
        let resolvedDiagramBlock: any = null;
        if (status === 'VISUAL' && !isNotAttempted) {
            if (isDrawingPointer && linkedOcrBlock?.bbox) {
                resolvedDiagramBlock = linkedOcrBlock;
            } else {
                const normSub = (s?: string) => String(s || '').replace(/\d+|question|part/gi, '').trim().toLowerCase();
                const targetSub = normSub(anno.subQuestion);
                const drawingCandidates = (stepsDataForMapping || []).filter(s => {
                    const isDrawStep = Boolean(
                        (s.line_id && String(s.line_id).includes('visual_drawing')) ||
                        (s.text && (String(s.text).includes('[DRAWING]') || String(s.text).includes('[VISUAL WORKSPACE]')))
                    );
                    if (!isDrawStep) return false;
                    const pBox = toPixelBox(s);
                    return pBox !== null && pBox[2] > 5 && pBox[3] > 5;
                });

                // Priority 1: Matching sub-question + same page
                resolvedDiagramBlock =
                    drawingCandidates.find(s => s.pageIndex === pageIndex && targetSub && normSub(s.subQuestionLabel) === targetSub) ||
                    // Priority 2: Matching sub-question on any page
                    drawingCandidates.find(s => targetSub && normSub(s.subQuestionLabel) === targetSub) ||
                    // Priority 3: Any drawing block on the same page
                    drawingCandidates.find(s => s.pageIndex === pageIndex) ||
                    // Priority 4: Any drawing block in the task
                    drawingCandidates[0] ||
                    null;
            }
        }

        // 🛡️ [VISUAL-TO-OCR ANCHOR FALLBACK]:
        // Only promote VISUAL to MATCHED when NO diagram bounding box exists AND no explicit visual_position exists
        // AND the linked OCR block is a diagram/figure prompt (NOT arithmetic working like "3 × 4 = 12").
        const isArithmeticWorkingText = (txt: string) =>
            /[=+\-×÷*/^]|\b\d+\s*[x×÷+\-]\s*\d+/i.test(txt) && !/\b(?:fig(?:ure)?|diagram|graph|grid|table|plot|sketch|draw|shade|region|chart)\b/i.test(txt);

        if (
            status === 'VISUAL' &&
            !resolvedDiagramBlock &&
            !rawVisualPos &&
            !isDrawingPointer &&
            linkedOcrBlock?.bbox &&
            !isArithmeticWorkingText(String(linkedOcrBlock.text || linkedOcrBlock.cleanedText || ''))
        ) {
            status = 'MATCHED';
        }

        if (resolvedDiagramBlock) {
            const diagramPixelBox = toPixelBox(resolvedDiagramBlock);
            if (diagramPixelBox) {
                const vp = (anno as any).visual_position || (anno as any).aiPosition;
                let useSpecificVp = false;
                if (vp && anno.action === 'cross') {
                    const vpX = typeof vp.x === 'number' ? vp.x : Array.isArray(vp) ? vp[0] : 0;
                    const vpY = typeof vp.y === 'number' ? vp.y : Array.isArray(vp) ? vp[1] : 0;
                    const vpPctX = vpX > 1 ? vpX : vpX * 100;
                    const vpPctY = vpY > 1 ? vpY : vpY * 100;
                    const boxPctX = (diagramPixelBox[0] / pageWidth) * 100;
                    const boxPctY = (diagramPixelBox[1] / pageHeight) * 100;
                    const boxPctW = (diagramPixelBox[2] / pageWidth) * 100;
                    const boxPctH = (diagramPixelBox[3] / pageHeight) * 100;

                    if (vpPctX >= boxPctX && vpPctX <= boxPctX + boxPctW &&
                        vpPctY >= boxPctY && vpPctY <= boxPctY + boxPctH) {
                        useSpecificVp = true;
                    }
                }
                if (!useSpecificVp) {
                    authorityBox = diagramPixelBox;
                }
                if (resolvedDiagramBlock.pageIndex !== undefined) {
                    pageIndex = resolvedDiagramBlock.pageIndex;
                    (anno as any).pageIndex = pageIndex;
                }
            }
        } else if ((status === 'MATCHED' || (anno as any).ocr_match_status === 'SPLIT' || isDrawingPointer) && linkedOcrBlock?.bbox) {
            const blockPixelBox = toPixelBox(linkedOcrBlock);
            if (blockPixelBox) {
                // 📐 [ROW-END ANCHORING]: When a matched OCR block shares a horizontal y-band
                // with other student work blocks on the same line, extend its right edge to the
                // rightmost student work block on that y-band so ticks/crosses never stamp over trailing working.
                if (
                    status === 'MATCHED' &&
                    !isDrawingPointer &&
                    anno.action !== 'circle' &&
                    anno.action !== 'underline'
                ) {
                    const [bx, by, bw, bh] = blockPixelBox;
                    const bCenterY = by + bh / 2;
                    let maxRightEdge = bx + bw;

                    for (const candidate of (stepsDataForMapping || [])) {
                        if (candidate.pageIndex !== undefined && candidate.pageIndex !== pageIndex) continue;
                        if (candidate.isHandwritten === false) continue;
                        const cText = String(candidate.text || candidate.cleanedText || '');
                        if (!cText.trim() || cText.includes('[DRAWING]') || cText.includes('[PRINTED_INSTRUCTION')) continue;
                        const cBox = toPixelBox(candidate);
                        if (!cBox || cBox[2] <= 2 || cBox[3] <= 2) continue;

                        const [cx, cy, cw, ch] = cBox;
                        // Must be on the same horizontal y-band
                        const vOverlap = Math.min(by + bh, cy + ch) - Math.max(by, cy);
                        const minH = Math.max(1, Math.min(bh, ch));
                        const cCenterY = cy + ch / 2;
                        const sameYBand =
                            vOverlap >= minH * 0.4 ||
                            Math.abs(bCenterY - cCenterY) <= Math.max(bh, ch) * 0.55;

                        if (sameYBand && cx >= bx - 10 && cx + cw > maxRightEdge) {
                            maxRightEdge = cx + cw;
                        }
                    }

                    authorityBox = [bx, by, maxRightEdge - bx, bh];
                } else {
                    authorityBox = blockPixelBox;
                }
            }
        }

        // 5. FINAL LOGGING
        if (linkedOcrBlock?.isSplitBlock) isSplitBlock = true;

        // console.log(`🛡️ [DESIGN-RESCUE] Q${anno.subQuestion} | Status: ${status} | IntentY: ${intentY.toFixed(0)}px -> SnappedY: ${authorityBox[1].toFixed(0)}px`);

        // 5. EVIDENCE LOG
        // console.log(`🛡️ [ENRICH-AUTHORITY] ${anno.subQuestion} | Status: ${status} | Snapped: [${Math.round(authorityBox[0])}, ${Math.round(authorityBox[1])}]px`);

        // Resolve student/class text as before
        const aiTargetSnippet = ((anno as any).student_text || (anno as any).studentText || '').trim();
        let studentText = "";
        let classText = (anno as any).classification_text || "";

        if (anno.action === 'circle' && activePointer) {
            const match = findInData(activePointer);
            const fullLineText = (match?.text || match?.cleanedText || '').trim();
            if (fullLineText) {
                const lowerLine = fullLineText.toLowerCase();
                const quoteMatches = Array.from(String((anno as any).reasoning || '').matchAll(/'([^']+)'/g)).map(m => m[1].trim());
                // Priority 1: AI's verbatim student_text snippet; Priority 2: quoted words in reasoning
                const candidates = [aiTargetSnippet, ...quoteMatches].filter(c => c && c.length > 0 && c.length < fullLineText.length);

                let matchedStart = -1;
                let matchedLen = 0;

                // 1. Try exact substring match first
                for (const cand of candidates) {
                    const idx = lowerLine.indexOf(cand.toLowerCase());
                    if (idx >= 0) {
                        matchedStart = idx;
                        matchedLen = cand.length;
                        break;
                    }
                }

                // 2. If exact match failed (e.g. 'advice' vs 'advise', 'Holocaust' vs 'Hollacast'), fuzzy-match against words on the line
                if (matchedStart < 0 && candidates.length > 0) {
                    const wordRegex = /[a-zA-Z']+/g;
                    let wordMatch: RegExpExecArray | null;
                    let bestScore = 0;
                    while ((wordMatch = wordRegex.exec(lowerLine)) !== null) {
                        const lineWord = wordMatch[0];
                        if (lineWord.length < 3) continue;
                        for (const cand of candidates) {
                            const target = cand.toLowerCase().replace(/[^a-z']/g, '');
                            if (target.length < 3) continue;
                            // Check shared prefix/characters (e.g. 'advis' in 'advise'/'advice', 'hol' + 'cast' in 'hollacast'/'holocaust')
                            let common = 0;
                            const minLen = Math.min(lineWord.length, target.length);
                            const maxLen = Math.max(lineWord.length, target.length);
                            for (let i = 0; i < minLen; i++) {
                                if (lineWord[i] === target[i]) common++;
                            }
                            const endsSame = lineWord.slice(-2) === target.slice(-2) ? 1.5 : 0;
                            const score = (common + endsSame) / maxLen;
                            if (score >= 0.55 && score > bestScore) {
                                bestScore = score;
                                matchedStart = wordMatch.index;
                                matchedLen = lineWord.length;
                            }
                        }
                    }
                }

                if (matchedStart >= 0 && matchedLen > 0) {
                    const lineLen = Math.max(1, fullLineText.length);
                    const startRatio = Math.max(0, (matchedStart - 0.5) / lineLen);
                    const widthRatio = Math.min(1 - startRatio, Math.max(0.10, (matchedLen + 1) / lineLen));
                    const [bx, by, bw, bh] = authorityBox;
                    authorityBox = [
                        bx + bw * startRatio,
                        by,
                        Math.max(28, bw * widthRatio),
                        bh
                    ];
                }
            }
        }

        if (activePointer) {
            const match = findInData(activePointer);
            if (match) {
                studentText = match.text || match.cleanedText || "";
                classText = match.text || match.cleanedText || "";
                if (studentText.includes('VISUAL') || studentText.includes('DRAWING')) {
                    classText = "";
                    studentText = "[Drawing/Graph]";
                    method = "VISUAL_VALUE";
                } else {
                    method = "POINTED_TEXT";
                }
            }
        } else {
            const rawDesc = (anno as any).contentDesc || (anno as any).content_desc || (anno as any).reasoning || "";
            const cleanDesc = rawDesc.replace('[DRAWING]', '').trim();
            studentText = cleanDesc ? `[DRAWING] ${cleanDesc}` : "[Drawing/Graph]";
            classText = "";
            method = "VISUAL_VALUE";
            if (status === "UNMATCHED") status = "VISUAL";
        }

        if (status === "MATCHED" || status === "SPLIT" || Boolean(linkedOcrBlock?.bbox)) classText = "";

        // 🛡️ [FINAL SIZE SANITY]: Ensure no annotation ever exits with zero width/height.
        // We enforce a 15px floor for both dimensions.
        const finalBox: [number, number, number, number] = [
            authorityBox[0],
            authorityBox[1],
            Math.max(15, authorityBox[2] || 20),
            Math.max(15, authorityBox[3] || (pageHeight * 0.015))
        ];

        // 🛡️ [STATUS-METADATA]: Preserve status for UI border colors.
        const finalIsSplit = isSplitBlock || status === 'SPLIT';

        return {
            ...anno,
            bbox: finalBox,
            snappedBbox: finalBox,
            pageIndex: pageIndex,
            ocr_match_status: status as any,
            linked_ocr_id: activePointer,
            student_text: latexToPlainText(studentText),
            studentText: latexToPlainText(studentText),
            classification_text: latexToPlainText(classText),
            classificationText: latexToPlainText(classText),
            _debug_placement_method: method,
            hasLineData: hasLineData,
            isSplitBlock: finalIsSplit,
            _debug_status: finalIsSplit ? 'GREEN_BORDER' : (status === 'UNMATCHED' ? 'RED_BORDER' : 'BLUE_BORDER'),
            unit: 'pixels'
        } as EnrichedAnnotation;
    });

    // 🚀 Apply Refined Positive Dominance Filter
    const cleanAnnotations = applyPositiveDominance(enriched);

    // Then apply physics to whatever remains
    return AnnotationCollisionService.resolveCollisions(cleanAnnotations, semanticZones);
};