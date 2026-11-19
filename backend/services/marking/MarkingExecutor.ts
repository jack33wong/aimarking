import { MarkingInstructionService } from './MarkingInstructionService.js';
import { sendSseUpdate } from '../../utils/sseUtils.js';
import { MarkingTask, ModelType } from "../../types/index.js";
import type { QuestionResult } from '../../types/marking.js';
import UsageTracker from '../../utils/UsageTracker.js';

// Core Service Imports
import { MarkingTaskFactory } from './core/MarkingTaskFactory.js';
import { ZoneArchitect } from './core/ZoneArchitect.js';
import { MarkingZoneService } from './MarkingZoneService.js';
import { CoordinateAuditLogger } from '../../utils/LoggerUtils.js';
import { AnnotationLinker } from './core/AnnotationLinker.js';
import { ScoreAuditor } from './core/ScoreAuditor.js';

// Utils
import { enrichAnnotationsWithPositions } from './AnnotationEnrichmentService.js';
import { sanitizeAiLineId, getQuestionSortValue } from './MarkingHelpers.js';
import { combineQuestionAndPart } from '../../utils/TextNormalizationUtils.js';

export async function executeMarkingForQuestion(
  task: MarkingTask,
  res: any,
  submissionId: string,
  model: ModelType = 'auto',
  allPagesOcrData?: any[],
  tracker?: UsageTracker
): Promise<QuestionResult> {

  const questionId = task.questionNumber;
  const { createProgressData } = await import('../../utils/sseUtils.js');
  const MULTI_IMAGE_STEPS = ["Input Validation", "Standardization", "Preprocessing", "OCR & Classification", "Question Detection", "Segmentation", "Marking", "Output Generation"];

  sendSseUpdate(res, createProgressData(6, `Marking Question ${questionId}...`, MULTI_IMAGE_STEPS));

  try {
    let stepsDataForMapping: any[] = [];

    // --- 1. DATA MAPPING (TYPE-SANITIZED) ---
    if (task.aiSegmentationResults && task.aiSegmentationResults.length > 0) {
      stepsDataForMapping = task.aiSegmentationResults.map((result, stepIndex) => {
        let bbox: [number, number, number, number] = [0, 0, 0, 0];

        // BBox Recovery
        const rawSource = (result as any).bbox || (result as any).position || (result as any).p || (result as any).lineData?.coordinates || (result as any).lineData?.box || (result as any).lineData?.region;
        if (rawSource) {
          if (Array.isArray(rawSource) && rawSource.length === 4) {
            bbox = rawSource as [number, number, number, number];
          } else if (typeof rawSource.x === 'number') {
            bbox = [rawSource.x, rawSource.y, rawSource.width, rawSource.height];
          }
        } else {
          // Fallback BBox
          let matchingBlock = task.mathBlocks.find(block => block.globalBlockId === result.blockId);
          if (!matchingBlock && result.content && result.content.length > 2) {
            const cleanTarget = result.content.replace(/\s/g, '').toLowerCase();
            matchingBlock = task.mathBlocks.find(block => {
              const raw = block.mathpixLatex || (block as any).googleVisionText || '';
              const cleanRaw = raw.replace(/\s/g, '').toLowerCase();
              return cleanRaw.includes(cleanTarget) || cleanTarget.includes(cleanRaw);
            });
          }
          if (matchingBlock && matchingBlock.coordinates) {
            bbox = [matchingBlock.coordinates.x, matchingBlock.coordinates.y, matchingBlock.coordinates.width, matchingBlock.coordinates.height];
          }
        }

        // ---------------------------------------------------------
        // 🛡️ PAGE MAPPING (STRICT TYPE SAFETY)
        // ---------------------------------------------------------
        const aiPageNum = Number((result as any).pageIndex ?? 0);
        const sourcePagesNum = (task.sourcePages || []).map(p => Number(p));
        let globalPage = aiPageNum;

        // 1. TRUST-FIRST MAPPING: Extract physical page from Global ID prefix
        const idToCheck = (result as any).line_id || (result as any).id || (result as any).lineId;
        if (idToCheck && typeof idToCheck === 'string' && idToCheck.match(/^p(\d+)_/)) {
          const match = idToCheck.match(/^p(\d+)_/);
          if (match) globalPage = parseInt(match[1], 10);
        }
        // 2. FALLBACK: If ID isn't fixed yet but pageIndex is in sourcePages, trust it.
        else if (sourcePagesNum.includes(aiPageNum)) {
          globalPage = aiPageNum;
        }

        const finalId = (result as any).line_id || (result as any).lineId || (result as any).id || (result as any).sequentialId || `p${globalPage}_q${questionId}_line_${stepIndex + 1}`;

        if (globalPage !== aiPageNum) {
          console.log(` 🕵️ [STEP-PAGE-FIX] Step "${finalId}" re-mapped P${aiPageNum} -> P${globalPage}`);
        }

        return {
          line_id: finalId,
          relative_line_id: (result as any).relative_line_id,
          pageIndex: globalPage,
          globalBlockId: result.blockId || finalId,
          text: result.content,
          lineId: finalId,
          cleanedText: (result.content || '').trim(),
          bbox: bbox,
          ocrSource: result.source || 'classification',
          isHandwritten: true,
          unit: (result as any).unit || ((result as any).source === 'classification' ? 'percentage' : 'pixels'),
          subQuestionLabel: (result as any).subQuestionLabel
        };
      }).filter(step => {
        if (step.text.includes('[VISUAL WORKSPACE]') || step.text.includes('[DRAWING]')) return true;
        if (step.line_id && step.text && step.text.trim().length > 0) return true;
        return !(step.bbox[0] === 0 && step.bbox[1] === 0 && step.bbox[2] === 0 && step.bbox[3] === 0);
      });

      // OCR Steps Mapping (Same Strict Logic)
      const ocrSteps = task.mathBlocks.filter(b => b.isHandwritten !== false).map((b, i) => {
        const rawPage = Number((b as any).pageIndex ?? 0);
        const sourcePagesNum = (task.sourcePages || []).map(p => Number(p));
        let gPage = rawPage;

        if (sourcePagesNum.includes(rawPage)) {
          gPage = rawPage;
        } else if (sourcePagesNum.length > 0) {
          if (rawPage < sourcePagesNum.length) {
            gPage = sourcePagesNum[rawPage];
          } else {
            gPage = sourcePagesNum[sourcePagesNum.length - 1];
          }
        }

        const bId = (b as any).id || (b as any).globalBlockId || `p${gPage}_ocr_GEN_${i}`;
        return {
          line_id: bId,
          pageIndex: gPage,
          globalBlockId: (b as any).globalBlockId,
          text: (b as any).text || (b as any).mathpixLatex || '',
          cleanedText: (b as any).text || (b as any).mathpixLatex || '',
          bbox: b.coordinates ? [b.coordinates.x, b.coordinates.y, b.coordinates.width, b.coordinates.height] : [0, 0, 0, 0],
          ocrSource: (b as any).ocrSource,
          isHandwritten: b.isHandwritten,
          unit: 'pixels',
          hasLineData: (b as any).hasLineData,
          isSplitBlock: (b as any).isSplitBlock
        };
      });
      stepsDataForMapping = [...stepsDataForMapping, ...ocrSteps as any];

    } else {
      stepsDataForMapping = task.mathBlocks.map((b, i) => {
        const rawPage = Number((b as any).pageIndex ?? 0);
        const sourcePagesNum = (task.sourcePages || []).map(p => Number(p));
        let gPage = rawPage;
        if (sourcePagesNum.includes(rawPage)) gPage = rawPage;
        else if (sourcePagesNum.length > 0) {
          if (rawPage < sourcePagesNum.length) gPage = sourcePagesNum[rawPage];
          else gPage = sourcePagesNum[sourcePagesNum.length - 1];
        }
        return {
          line_id: `p${gPage}_q${questionId}_line_${i}`, pageIndex: gPage, globalBlockId: (b as any).globalBlockId, text: (b as any).text || (b as any).mathpixLatex || '', cleanedText: (b as any).mathpixLatex || '', bbox: b.coordinates ? [b.coordinates.x, b.coordinates.y, b.coordinates.width, b.coordinates.height] : [0, 0, 0, 0], ocrSource: (b as any).ocrSource, isHandwritten: b.isHandwritten, unit: 'pixels',
          hasLineData: (b as any).hasLineData,
          isSplitBlock: (b as any).isSplitBlock
        };
      }) as any;
    }

    // Generate Prompt
    let ocrTextForPrompt = task.classificationStudentWork || "Student's Work:\n";
    if (ocrTextForPrompt.includes('MANUAL_REVIEW_REQUIRED_TOO_DENSE')) {
      throw new Error("MANUAL_REVIEW_REQUIRED_TOO_DENSE: The student's work or table layout is too dense for auto-marking.");
    }
    if (ocrTextForPrompt.length < 15 && task.aiSegmentationResults?.length > 0) {
      task.aiSegmentationResults.forEach((result, index) => {
        const clean = result.content.replace(/\s+/g, ' ').trim();
        if (clean && clean !== '--') {
          // [TRUTH-FIRST]: Only use the physical ID or the sequential ID.
          const id = (result as any).id || (result as any).lineId || (result as any).sequentialId || `${index + 1}`;
          const idTag = `[ID: ${id}] `;
          ocrTextForPrompt += `${idTag}${clean}\n`;
        }
      });
    }

    // --- 2. ZONE ARCHITECTURE ---
    const semanticZones = task.semanticZones || ZoneArchitect.detectAndRefineZones(task, task.pageDimensions as any);
    MarkingZoneService.backfillInjectedZones(semanticZones, stepsDataForMapping, task.pageDimensions as any);
    const allLabels = Object.keys(semanticZones);

    // --- 2.5 SHORT-CIRCUIT COMPLETELY UNATTEMPTED QUESTIONS TO 0/max ---
    // If a question has zero student work (no handwritten lines, no drawings, no handwritten OCR blocks)
    // and we know its authoritative totalMarks from the DB mark scheme (or printed mark total),
    // short-circuit to 0/max with neutral "Not attempted" pill(s) instead of calling the LLM or stamping red crosses.
    const hasClassificationWork = (task.aiSegmentationResults || []).some(r => {
      const content = (r.content || '').trim();
      return content.length > 0 && content !== '--';
    });
    // Zone-aware handwritten OCR check: on shared pages (e.g. Q12 + blank Q13 on the same page),
    // only count handwritten OCR blocks that actually fall inside THIS question's own semantic zone(s).
    const qIdStr = String(questionId).trim();
    const qKeyRegex = new RegExp(`^${qIdStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[a-z.(])`, 'i');
    const questionZonesFlat = Object.entries(semanticZones || {})
      .filter(([key]) => qKeyRegex.test(String(key).trim()))
      .flatMap(([, list]) => (Array.isArray(list) ? list : []))
      .filter(Boolean);
    const hasHandwrittenOcr = (task.mathBlocks || []).some(b => {
      if (b.isHandwritten !== true) return false;
      const txt = ((b as any).text || (b as any).mathpixLatex || '').trim();
      if (txt.length === 0) return false;
      if (questionZonesFlat.length === 0) return true;
      const bY = b.coordinates?.y ?? (Array.isArray((b as any).bbox) ? (b as any).bbox[1] : undefined);
      const bPage = Number((b as any).pageIndex ?? task.sourcePages?.[0] ?? 0);
      if (bY === undefined) return true;
      return questionZonesFlat.some((z: any) =>
        (z.pageIndex === undefined || Number(z.pageIndex) === bPage) &&
        typeof z.startY === 'number' && typeof z.endY === 'number' &&
        bY >= z.startY - 15 && bY <= z.endY + 15
      );
    });
    const hasCleanedWorkText = (task.classificationStudentWork || '')
      .replace(/^Student's Work:\s*/i, '')
      .replace(/\[SUB-QUESTION[^\]]*\]/gi, '')
      .trim().length > 0;
    const isTaskCompletelyUnattempted = !hasClassificationWork && !hasHandwrittenOcr && !hasCleanedWorkText;

    const schemeTotalMarks = Number(task.markingScheme?.totalMarks || 0);
    if (isTaskCompletelyUnattempted && schemeTotalMarks > 0) {
      console.log(`⚪ [UNATTEMPTED-SHORTCIRCUIT] Q${questionId}: Zero student work detected. Short-circuiting to 0/${schemeTotalMarks} with neutral Not attempted pill.`);
      return buildUnattemptedQuestionResult(task, semanticZones, schemeTotalMarks);
    }

    // --- 3. AI EXECUTION ---
    // [FIXED] OCR Mapping (Same Logic)
    const rawOcrBlocks = task.mathBlocks.map((block, idx) => {
      const rawPage = Number((block as any).pageIndex ?? 0);
      const sourcePagesNum = (task.sourcePages || []).map(p => Number(p));
      let globalPage = rawPage;

      if (sourcePagesNum.includes(rawPage)) {
        globalPage = rawPage;
      } else if (sourcePagesNum.length > 0) {
        if (rawPage < sourcePagesNum.length) {
          globalPage = sourcePagesNum[rawPage];
        } else {
          globalPage = sourcePagesNum[sourcePagesNum.length - 1];
        }
      }

      // [TRUTH-FIRST]: Prioritize globalBlockId (Physical) over others.
      const id = (block as any).globalBlockId || (block as any).id || `p${globalPage}_ocr_${idx}`;
      const text = block.text || (block as any).mathpixLatex || (block as any).latex || (block as any).content || "";
      const bbox = block.coordinates ? [block.coordinates.x, block.coordinates.y, block.coordinates.width, block.coordinates.height] : (block as any).bbox;

      return { ...block, id: id, pageIndex: globalPage, text: text, bbox: bbox };
    });

    const rawOcrText = rawOcrBlocks.map(b => `[${b.id}]: "${b.text}"`).join('\n');
    sendSseUpdate(res, createProgressData(6, `Generating annotations for Question ${questionId}...`, MULTI_IMAGE_STEPS));

    // 🛑 AGGRESSIVE SANITIZER: Nuke stale IDs and tags from the Question Text
    let sanitizedQuestionText = task.markingScheme?.databaseQuestionText || task.questionText || '';
    if (sanitizedQuestionText) {
        sanitizedQuestionText = sanitizedQuestionText
            .replace(/\[ID:\s*[^\]]+\]\s*/g, '')
            .replace(/\[SUB-QUESTION[^\]]+\]\s*/g, '');
    }

    const markingInputs = {
      imageData: task.imageData || '', images: task.images, model: model,
      processedImage: { ocrText: rawOcrText, cleanDataForMarking: { steps: stepsDataForMapping }, rawOcrBlocks: rawOcrBlocks, classificationStudentWork: ocrTextForPrompt } as any,
      questionDetection: task.markingScheme, questionText: sanitizedQuestionText, questionNumber: String(questionId),
      sourceImageIndices: task.sourcePages, subQuestionPageMap: task.subQuestionPageMap, tracker: tracker
    };

    const markingResult = await MarkingInstructionService.executeMarking(markingInputs);

    // 🕵️ [DEBUG-ID-SYNC]: Inspect IDs for Q23
    if (String(questionId).includes("23")) {
      console.log(`🕵️ [DEBUG-ID-SYNC] Q23 Prompt Raw Annotations:`, JSON.stringify(markingResult.annotations.map((a: any) => ({ t: a.text, l: a.line_id, o: a.linked_ocr_id, p: a.pageIndex })), null, 2));
      const sampleBlock17 = rawOcrBlocks.find(b => b.id?.includes('ocr_17'));
      if (sampleBlock17) {
        console.log(`🕵️ [DEBUG-ID-SYNC] Q23 OCR Block 17 Raw:`, JSON.stringify(sampleBlock17));
      }
    }

    if (!markingResult || !markingResult.annotations || !markingResult.studentScore) {
      throw new Error(`MarkingInstructionService returned invalid data for Q${questionId}`);
    }

    // ========================= 🛡️ CLEAN OUTPUT =========================
    // Translation is no longer needed because IDs are Global-by-Design.
    if (markingResult.annotations) {
      const qNumStr = String(questionId);
      markingResult.annotations.forEach((anno: any) => {
        // Safe mapping of sub-question labels (Maintenance)
        // 🛡️ [LABEL-HARMONY]: Preserve the full sub-question label (e.g. "3a", "1.1")
        // We ensure canonical question.part format without leading zeroes or duplicated base prefixes.
        if (anno.subQuestion) {
          const rawSub = String(anno.subQuestion).trim().replace(/^0+(?=\d)/, '');
          anno.subQuestion = combineQuestionAndPart(qNumStr, rawSub);
        }

        // Sync pageIndex from the Global ID (Ground Truth)
        // [TRUTH-FIRST]: Check all possible ID fields for the physical page prefix p{N}_
        const probeIds = [anno.line_id, (anno as any).id, (anno as any).linked_ocr_id, (anno as any).lineId];
        for (const probeId of probeIds) {
          if (typeof probeId === 'string' && probeId.match(/^p(\d+)_/)) {
            const match = probeId.match(/^p(\d+)_/);
            if (match) {
              const extractedPageIndex = parseInt(match[1], 10);

              // 🛑 DO NOT DOUBLE-TRANSLATE: If restorePhysicalTruth already converted IDs to physical page numbers
              // (anno.isPhysicalPage === true), extractedPageIndex IS ALREADY the physical page index!
              if (anno.isPhysicalPage) {
                anno.pageIndex = extractedPageIndex;
              } else {
                anno.pageIndex = (task.sourcePages && task.sourcePages[extractedPageIndex] !== undefined)
                                 ? Number(task.sourcePages[extractedPageIndex])
                                 : extractedPageIndex;
                anno.isPhysicalPage = true;
              }
              break;
            }
          }
        }
      });
    }

    // Detect if this task lives on a separate handwritten answer sheet (where donated questionText is NOT physically printed on the page)
    const isSeparateAnswerSheetTask = Boolean(
      (task as any).isSeparateAnswerSheet ||
      (!task.classificationBlocks || task.classificationBlocks.length === 0)
    );

    // If on a separate handwritten answer sheet, strip false-positive [PRINTED_INSTRUCTION ...] tags
    // that SpatialShield added to student-written question numbers (e.g. "1. e^5", "2. 0.75", "10a. 24,000")
    if (isSeparateAnswerSheetTask) {
      const stripPrintedTag = (str?: string) =>
        typeof str === 'string' ? str.replace(/\s*\[PRINTED_INSTRUCTION[^\]]*\]\s*/gi, '').trim() : str;

      rawOcrBlocks.forEach((b: any) => {
        if (b.text) b.text = stripPrintedTag(b.text);
        if (b.cleanedText) b.cleanedText = stripPrintedTag(b.cleanedText);
        if (b.mathpixLatex) b.mathpixLatex = stripPrintedTag(b.mathpixLatex);
        b.isHandwritten = true;
        b.isPrinted = false;
      });

      if (Array.isArray((markingResult as any).taggedOcrBlocks)) {
        (markingResult as any).taggedOcrBlocks.forEach((b: any) => {
          if (b.text) b.text = stripPrintedTag(b.text);
          if (b.cleanedText) b.cleanedText = stripPrintedTag(b.cleanedText);
          if (b.mathpixLatex) b.mathpixLatex = stripPrintedTag(b.mathpixLatex);
          b.isHandwritten = true;
          b.isPrinted = false;
        });
      }
    }

    // --- 4. VETO LIST ---
    // Only veto printed question text if the printed text actually exists physically on the page!
    const vetoList: string[] = [];
    if (!isSeparateAnswerSheetTask) {
      if (task.questionText) vetoList.push(AnnotationLinker.normalizeForMatching(task.questionText));
      if (task.classificationBlocks) task.classificationBlocks.forEach(cb => cb.text && cb.text.length > 2 && vetoList.push(AnnotationLinker.normalizeForMatching(cb.text)));
      if (task.subQuestionMetadata?.subQuestions) task.subQuestionMetadata.subQuestions.forEach((sq: any) => sq.text && vetoList.push(AnnotationLinker.normalizeForMatching(sq.text)));
    }

    // --- 5. LINKING ---
    if (markingResult.annotations) {
      markingResult.annotations = AnnotationLinker.resolveLinksWithZones(
        markingResult.annotations,
        semanticZones,
        (markingResult as any).taggedOcrBlocks || rawOcrBlocks as any[],
        vetoList,
        String(questionId),
        stepsDataForMapping,
        task.pageDimensions,
        allLabels
      );
    }

    (markingResult.annotations || []).forEach((anno: any) => {
      // 🛡️ [AUDIT-2] AI Raw Response
      CoordinateAuditLogger.audit(2, `AI Marking Q${questionId}`, `Action: ${anno.action} | SubQ: ${anno.subQuestion} | Text: "${anno.text}" | Box: ${JSON.stringify(anno.bbox)}`);

      if (!anno.line_id && (anno.visual_position || anno.ai_visual_position || anno.bbox)) {
        // 🛡️ [AUDIT-3] AI Visual Intent
        CoordinateAuditLogger.audit(3, `AI Visual Q${anno.subQuestion}`, `Text: "${anno.text}" | Pos: ${JSON.stringify(anno.visual_position || anno.ai_visual_position || anno.bbox)}`);
      }
    });

    const rawAnnotationsFromAI = JSON.parse(JSON.stringify(markingResult.annotations || []));

    // --- 6. MARK SPLITTING ---
    markingResult.annotations = AnnotationLinker.preProcess(markingResult.annotations || []);

    // --- 7. POST-PROCESSING ---
    markingResult.annotations = AnnotationLinker.postProcess(
      markingResult.annotations,
      stepsDataForMapping,
      task,
      semanticZones,
      task.pageDimensions
    );

    // --- 8. ENRICHMENT ---
    const defaultPageIndex = (task.sourcePages && task.sourcePages.find(p => p !== 0)) ?? task.sourcePages?.[0] ?? 0;

    const combinedLookupBlocks = [
      ...stepsDataForMapping.map(s => {
        const isClassification = s.ocrSource === 'classification' || (s.line_id && s.line_id.includes('_line_'));
        const detectedUnit = isClassification ? 'percentage' : 'pixels';
        return {
          ...s,
          unit: s.unit || detectedUnit,
          _source: isClassification ? 'CLASSIFICATION' : 'SEGMENTED',
          hasLineData: s.hasLineData ?? !isClassification,
          isSplitBlock: s.isSplitBlock ?? false
        };
      }),
      ...rawOcrBlocks.map(block => ({
        line_id: (block as any).id,
        pageIndex: (block as any).pageIndex ?? 0,
        text: block.text,
        cleanedText: block.text,
        bbox: [
          block.coordinates?.x || 0,
          block.coordinates?.y || 0,
          block.coordinates?.width || 0,
          block.coordinates?.height || 0
        ] as [number, number, number, number],
        unit: 'pixels',
        _source: 'RESCUE_RAW',
        isHandwritten: block.isHandwritten,
        hasLineData: (block as any).hasLineData,
        isSplitBlock: (block as any).isSplitBlock
      }))
    ];

    /*
    // 🕵️ [COORDS-IDENTITY]: Print all OCR blocks to verify IDs vs Coordinates
    if (combinedLookupBlocks.length > 0) {
      console.log(`🕵️ [COORDS-IDENTITY] Q${questionId} OCR Pool Sample (Block 0):`, JSON.stringify(combinedLookupBlocks[0]));
      console.log(`🕵️ [COORDS-IDENTITY] Q${questionId} OCR Pool (${combinedLookupBlocks.length} blocks):`);
      combinedLookupBlocks.forEach(b => {
        if (b.line_id?.includes('ocr') || b.line_id?.includes('_line_')) {
          console.log(`   - ID: ${b.line_id.padEnd(12)} | Coords: ${JSON.stringify(b.bbox).padEnd(25)} | Text: "${(b.text || '').substring(0, 30)}" | S:${b.isSplitBlock} L:${b.hasLineData}`);
        }
      });
    }
    */

    const enrichedAnnotationsRaw = enrichAnnotationsWithPositions(
      markingResult.annotations,
      combinedLookupBlocks,
      String(questionId),
      defaultPageIndex,
      task.pageDimensions,
      task.classificationBlocks,
      task,
      (markingResult as any).visualObservation,
      (markingResult as any).globalOffsetX || 0,
      (markingResult as any).globalOffsetY || 0,
      semanticZones
    ).filter((anno: any) => (anno.text || '').trim() !== '' || anno.action === 'not_attempted' || anno.isUnattempted);

    const enrichedAnnotations = normalizeUnattemptedSubQuestionAnnotations(
      enrichedAnnotationsRaw,
      stepsDataForMapping,
      semanticZones,
      task.markingScheme,
      task.pageDimensions,
      defaultPageIndex
    );

    // Final UI placement patch
    enrichedAnnotations.forEach(anno => {
      const pIdx = anno.pageIndex ?? task.sourcePages?.[0] ?? 0;
      let dims = task.pageDimensions?.get(pIdx);
      if (!dims && task.pageDimensions && task.pageDimensions.size > 0) dims = Array.from(task.pageDimensions.values())[0];
      if (anno.bbox && dims && dims.width > 0 && dims.height > 0) {
        if (String(task.questionNumber).includes("23") && (anno.linked_ocr_id?.includes('ocr_17') || anno.line_id?.includes('ocr_17'))) {
          console.log(`   🎯 [COORD-INTEGRITY] Block 17: BBox ${JSON.stringify(anno.bbox)}, Dims [${dims.width}x${dims.height}], PageIndex: ${pIdx}, Result:`, {
            x: (anno.bbox[0] / dims.width) * 100,
            y: (anno.bbox[1] / dims.height) * 100
          });
        }
        anno.visual_position = {
          x: (anno.bbox[0] / dims.width) * 100,
          y: (anno.bbox[1] / dims.height) * 100,
          width: (anno.bbox[2] / dims.width) * 100,
          height: (anno.bbox[3] / dims.height) * 100
        };
      } else if (!anno.visual_position && (anno as any).ai_visual_position) {
        anno.visual_position = (anno as any).ai_visual_position;
      }

      if (!anno.visual_position) {
        anno.visual_position = { x: 50, y: 50, width: 10, height: 10 };
      }

      // Zone Protection (DEPRECATED: Handled Upstream in EnrichmentService)
    });

    // --- 9. SCORING ---
    const parsedScore = ScoreAuditor.parseScore(markingResult.studentScore);
    const rawRubricEval = (markingResult as any).rubricEvaluation;
    const isLoRQuestion = Boolean(rawRubricEval && rawRubricEval.scoringType !== 'POINT_BASED');

    let finalAnnotationsForSorting = enrichedAnnotations;
    let reconciledRubricEval = rawRubricEval;

    if (isLoRQuestion) {
      const lorReconciled = ScoreAuditor.reconcileLevelOfResponseScore(
        rawRubricEval,
        markingResult.studentScore,
        task.markingScheme,
        enrichedAnnotations,
        questionId
      );
      parsedScore.awardedMarks = lorReconciled.awardedMarks;
      parsedScore.totalMarks = lorReconciled.totalMarks;
      parsedScore.scoreText = lorReconciled.scoreText;
      reconciledRubricEval = lorReconciled.rubricEvaluation;
    } else {
      const strictResult = ScoreAuditor.enforceStrictBudget(enrichedAnnotations, task.markingScheme);
      const schemeTotal = Number(task.markingScheme?.totalMarks || 0);
      if (task.markingScheme?.isGeneric && strictResult.inferredTotalMarks && strictResult.inferredTotalMarks > schemeTotal) {
        parsedScore.totalMarks = strictResult.inferredTotalMarks;
      } else if (schemeTotal > 0) {
        parsedScore.totalMarks = schemeTotal;
      } else if (strictResult.inferredTotalMarks && strictResult.inferredTotalMarks > 0) {
        parsedScore.totalMarks = strictResult.inferredTotalMarks;
      }
      if (parsedScore.totalMarks < strictResult.awardedMarks) {
        parsedScore.totalMarks = strictResult.awardedMarks;
      }
      parsedScore.awardedMarks = strictResult.awardedMarks;
      parsedScore.scoreText = `${strictResult.awardedMarks}/${parsedScore.totalMarks}`;
      finalAnnotationsForSorting = strictResult.annotations;
    }

    const cleanMarkingScheme: Record<string, any> = {};
    if (task.markingScheme) {
      const allowedKeys = [
        'marks', 'totalMarks', 'questionNumber', 'questionLevelAnswer',
        'marksWithAnswers', 'subQuestionNumbers', 'subQuestionMarks',
        'subQuestionMaxScores', 'subQuestionAnswersMap', 'subQuestionTexts',
        'hasAlternatives', 'alternativeMethod', 'parentQuestionMarks',
        'isGeneric', 'guidance', 'subQuestionMetadata',
        'scoringType', 'levels', 'indicativeStandard', 'aoContentBullets',
        'dualAoBreakdown', 'sourceExtracts', 'examinerReport', 'assessmentObjectives'
      ];

      allowedKeys.forEach(key => {
        const source = task.markingScheme as any;
        if (source[key] !== undefined) {
          cleanMarkingScheme[key] = source[key];
        }
      });
    }

    // 🛑 THE LIVE SORT FIX
    const sortedAnnotations = Array.isArray(finalAnnotationsForSorting)
      ? [...finalAnnotationsForSorting].sort((a, b) => getQuestionSortValue(a.subQuestion) - getQuestionSortValue(b.subQuestion))
      : finalAnnotationsForSorting;

    const result = {
      questionNumber: questionId,
      score: parsedScore,
      annotations: sortedAnnotations,
      pageIndex: task.sourcePages?.[0] ?? 0,
      sourceImageIndices: task.sourcePages,
      usageTokens: markingResult.usage?.llmTokens || 0,
      inputTokens: markingResult.usage?.llmInputTokens || 0,
      outputTokens: markingResult.usage?.llmOutputTokens || 0,
      marks: parsedScore.totalMarks,
      awardedMarks: parsedScore.awardedMarks,
      totalMarks: parsedScore.totalMarks,
      mathpixCalls: 0,
      confidence: 0.9,
      markingScheme: markingResult.schemeTextForPrompt || JSON.stringify(cleanMarkingScheme),
      studentWork: (markingResult as any).cleanedOcrText || task.classificationStudentWork,
      databaseQuestionText: task.markingScheme?.databaseQuestionText || task.questionText,
      questionText: markingResult.promptQuestionText || task.questionText || '',
      promptQuestionText: markingResult.promptQuestionText,
      promptMarkingScheme: markingResult.schemeTextForPrompt,
      overallPerformanceSummary: (markingResult as any).overallPerformanceSummary,
      rawAnnotations: rawAnnotationsFromAI,
      semanticZones: semanticZones,
      rubricEvaluation: reconciledRubricEval,
      isError: (markingResult as any).isError,
      hasDensityError: (markingResult as any).hasDensityError,
      errorMessage: (markingResult as any).errorMessage
    };

    return result;
  } catch (error) {
    console.error(`Error executing marking for Q${questionId}:`, error);
    throw error;
  }
}

/**
 * Task Creation Proxy
 */
export function createMarkingTasksFromClassification(
  classificationResult: any,
  allPagesOcrData: any[],
  markingSchemesMap: Map<string, any>,
  pageDimensionsMap: Map<number, { width: number; height: number }>,
  standardizedPages: any[],
  allClassificationResults?: any[],
  metaPageIndices?: number[]
): MarkingTask[] {
  return MarkingTaskFactory.createTasksFromClassification(
    classificationResult,
    allPagesOcrData,
    markingSchemesMap,
    pageDimensionsMap,
    standardizedPages,
    allClassificationResults,
    metaPageIndices
  );
}

const UNATTEMPTED_REASONING_REGEX = /\b(not\s+attempted|no\s+attempt|unattempted|blank\s+(?:answer|response|sub-?question|page)?|no\s+student\s+work|did\s+not\s+attempt|no\s+answer\s+provided|left\s+blank)\b/i;

function resolveSubQuestionMaxMarks(subQuestion: string | undefined, scheme: any): number | undefined {
  if (!scheme) return undefined;
  const subMaxMap = scheme.subQuestionMaxScores || {};
  if (subQuestion) {
    const cleanSubQ = String(subQuestion).trim().replace(/^0+(?=\d)/, '');
    const suffix = cleanSubQ.replace(/^\d+/, '');
    const dotStripped = suffix.replace(/^\./, '');
    const found = subMaxMap[subQuestion] ?? subMaxMap[cleanSubQ] ?? subMaxMap[suffix] ?? subMaxMap[dotStripped];
    if (typeof found === 'number' && found > 0) return found;
  }
  const total = Number(scheme.totalMarks || 0);
  return total > 0 ? total : undefined;
}

function computeAnswerAreaBboxForZone(
  zone: any,
  pageDims?: { width: number; height: number }
): [number, number, number, number] {
  const pw = pageDims?.width || 1650;
  const ph = pageDims?.height || 2339;
  if (zone && typeof zone.startY === 'number' && typeof zone.endY === 'number') {
    const zx = typeof zone.x === 'number' ? zone.x : Math.round(pw * 0.12);
    const zw = typeof zone.width === 'number' && zone.width > 50 ? zone.width : Math.round(pw * 0.72);
    const zh = Math.max(40, zone.endY - zone.startY);
    // Anchor near the answer area (lower-middle of the question zone)
    const answerX = Math.round(zx + zw * 0.15);
    const answerY = Math.round(zone.startY + Math.min(zh * 0.62, Math.max(40, zh - 70)));
    return [answerX, answerY, Math.round(pw * 0.18), Math.round(ph * 0.022)];
  }
  return [Math.round(pw * 0.20), Math.round(ph * 0.45), Math.round(pw * 0.18), Math.round(ph * 0.022)];
}

/**
 * Builds a short-circuited 0/max QuestionResult for completely unattempted questions
 * (zero student work), using neutral `not_attempted` pills instead of red crosses.
 */
export function buildUnattemptedQuestionResult(
  task: MarkingTask,
  semanticZones: Record<string, any[]>,
  totalMarks: number
): QuestionResult {
  const questionId = String(task.questionNumber);
  const defaultPage = task.sourcePages?.[0] ?? 0;
  const subMaxMap = task.markingScheme?.subQuestionMaxScores || {};
  const subKeys = Object.keys(subMaxMap).filter(
    k => k !== questionId && k.startsWith(questionId) && Number(subMaxMap[k]) > 0
  );

  const annotations: any[] = [];
  const targets = subKeys.length > 0 ? subKeys : [questionId];

  for (const label of targets) {
    const suffix = label.replace(/^\d+/, '');
    const zoneList = semanticZones?.[label] || semanticZones?.[suffix] || semanticZones?.[questionId] || [];
    const zone = zoneList[0];
    const pIdx = zone?.pageIndex ?? defaultPage;
    const dims = task.pageDimensions?.get(pIdx) || (task.pageDimensions ? Array.from(task.pageDimensions.values())[0] : undefined);
    const bbox = computeAnswerAreaBboxForZone(zone, dims);
    const subMax = subKeys.length > 0 ? Number(subMaxMap[label]) : totalMarks;
    const pw = dims?.width || 1650;
    const ph = dims?.height || 2339;

    annotations.push({
      action: 'not_attempted',
      text: 'Not attempted',
      reasoning: 'Not attempted',
      isUnattempted: true,
      scoreBadgeText: subMax > 0 ? `0/${subMax}` : undefined,
      subQuestion: label,
      pageIndex: pIdx,
      ocr_match_status: 'UNMATCHED',
      bbox,
      snappedBbox: bbox,
      visual_position: {
        x: (bbox[0] / pw) * 100,
        y: (bbox[1] / ph) * 100,
        width: (bbox[2] / pw) * 100,
        height: (bbox[3] / ph) * 100
      }
    });
  }

  return {
    questionNumber: questionId,
    score: {
      awardedMarks: 0,
      totalMarks,
      scoreText: `0/${totalMarks}`
    },
    annotations,
    pageIndex: defaultPage,
    sourceImageIndices: task.sourcePages,
    usageTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    marks: totalMarks,
    awardedMarks: 0,
    totalMarks,
    mathpixCalls: 0,
    confidence: 1.0,
    markingScheme: JSON.stringify(task.markingScheme || {}),
    studentWork: '',
    databaseQuestionText: task.markingScheme?.databaseQuestionText || task.questionText,
    questionText: task.questionText || '',
    semanticZones
  } as any;
}

/**
 * Converts blank/unattempted sub-question annotations (including AI crosses for blank parts
 * on shared pages) into neutral `not_attempted` pills with `0/max` badges and no red `✗`.
 */
export function normalizeUnattemptedSubQuestionAnnotations(
  annotations: any[],
  stepsDataForMapping: any[],
  semanticZones: Record<string, any[]>,
  markingScheme: any,
  pageDimensions?: Map<number, { width: number; height: number }>,
  defaultPageIndex: number = 0
): any[] {
  const normLabel = (s?: string) => String(s || '').replace(/^0+(?=\d)/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const subQsWithWork = new Set<string>();
  (stepsDataForMapping || []).forEach(s => {
    const txt = (s?.text || s?.cleanedText || '').trim();
    if (!txt || txt === '--') return;
    if (s.subQuestionLabel && s.subQuestionLabel !== 'main') {
      subQsWithWork.add(normLabel(s.subQuestionLabel));
    }
  });

  const seenUnattemptedSubQs = new Set<string>();
  const result: any[] = [];

  for (const anno of annotations) {
    const subKey = normLabel(anno.subQuestion);
    const subSuffix = subKey.replace(/^\d+/, '');
    const hasWorkForSubQ = Boolean(
      (subKey && subQsWithWork.has(subKey)) ||
      (subSuffix && subQsWithWork.has(subSuffix))
    );

    const reasoningStr = String(anno.reasoning || '');
    const textStr = String(anno.text || '');
    const isExplicitUnattempted =
      anno.action === 'not_attempted' ||
      anno.isUnattempted === true ||
      /^not\s+attempted$/i.test(textStr.trim());
    const isBlankCross =
      anno.action === 'cross' &&
      !hasWorkForSubQ &&
      (UNATTEMPTED_REASONING_REGEX.test(reasoningStr) || !anno.line_id && !anno.linked_ocr_id && reasoningStr.trim() === '');

    if (isExplicitUnattempted || isBlankCross) {
      const dedupKey = subKey || `p${anno.pageIndex ?? defaultPageIndex}_main`;
      if (seenUnattemptedSubQs.has(dedupKey)) {
        continue; // Collapse duplicate unattempted marks for the same sub-question into one neutral pill
      }
      seenUnattemptedSubQs.add(dedupKey);

      const pIdx = anno.pageIndex ?? defaultPageIndex;
      const dims = pageDimensions?.get(pIdx) || (pageDimensions ? Array.from(pageDimensions.values())[0] : undefined);
      const zoneList = semanticZones?.[anno.subQuestion] || semanticZones?.[subSuffix] || [];
      const zone = zoneList.find((z: any) => z.pageIndex === pIdx) || zoneList[0];
      const hasValidBbox = Array.isArray(anno.bbox) && anno.bbox[2] > 5 && anno.bbox[3] > 5 && (anno.bbox[0] > 0 || anno.bbox[1] > 0);
      const bbox = hasValidBbox ? anno.bbox : computeAnswerAreaBboxForZone(zone, dims);
      const subMax = resolveSubQuestionMaxMarks(anno.subQuestion, markingScheme);

      result.push({
        ...anno,
        action: 'not_attempted',
        text: 'Not attempted',
        reasoning: 'Not attempted',
        isUnattempted: true,
        scoreBadgeText: anno.scoreBadgeText || (subMax && subMax > 0 ? `0/${subMax}` : undefined),
        bbox,
        snappedBbox: bbox
      });
    } else {
      result.push(anno);
    }
  }

  return result;
}