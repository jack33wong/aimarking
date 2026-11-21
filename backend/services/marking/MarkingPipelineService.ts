import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';
import type { ModelType, MarkingTask, EnrichedAnnotation, MathBlock } from '../../types/index.js';
import PdfProcessingService from '../pdf/PdfProcessingService.js';
import sharp from 'sharp';
import { ImageUtils } from '../../utils/ImageUtils.js';
import { MarkingInstructionService } from './MarkingInstructionService.js';
import { MarkingOutputService } from './MarkingOutputService.js';
import { MarkingPersistenceService } from './MarkingPersistenceService.js';
import { ImageGeometryService, isRecognizedAcademicSubject } from './ImageGeometryService.js';
import { PreInspectService } from './PreInspectService.js';
import {
    resolvePageLimits,
    filterAcademicUnsupportedPages,
    extractDistinctUnsupportedSubjects,
    lookupCatalogedOfficialSchemeIfEligible,
    rescueMinorityUnsupportedPagesInSupportedBatch
} from './PreFlightRules.js';
import { createProgressData } from '../../utils/sseUtils.js';
import axios from 'axios';
import { getFirestore } from '../../config/firebase.js';
import { GradeBoundaryService } from './GradeBoundaryService.js';
import { ChatContextBuilder } from './ChatContextBuilder.js';
import {
    logPerformanceSummary,
    extractQuestionsFromClassification,
    logAnnotationSummary,
    getQuestionSortValue,
    getSuggestedFollowUps,
    calculateOverallScore,
    collapseCompatibleSubjectAliases,
    hasUnofficialPaperIndicators
} from './MarkingHelpers.js';
import { withPerformanceLogging } from '../../utils/markingRouterHelpers.js';
import UsageTracker from '../../utils/UsageTracker.js';
import { UserFacingError, type DetectedPaperGroup } from '../../utils/UserFacingError.js';

import type { MarkingSessionContext, QuestionSessionContext } from '../../types/sessionManagement.js';
import { getBaseQuestionNumber, extractQuestionNumberFromFilename } from '../../utils/TextNormalizationUtils.js';
import { formatMarkingSchemeAsBullets } from '../../config/prompts.js';

import { resolveModelTier, resolveExecutionPlan, getDefaultModel } from '../../config/aiModels.js';
import { checkCredits } from '../creditService.js';
import { AdminAlertService } from '../AdminAlertService.js';

// Helper functions for real model and API names
function getRealModelName(modelType: string): string {
    return resolveExecutionPlan(modelType, 'marking').modelName;
}

function getRealApiName(modelName: string): string {
    if (modelName.includes('gemini') || modelName.includes('argon')) {
        return 'Google Gemini API';
    }
    if (modelName.includes('gpt') || modelName.includes('openai')) {
        return 'OpenAI API';
    }
    return 'Google Gemini API';
}

import type { StandardizedPage, PageOcrResult } from '../../types/markingRouter.js';

import { OCRService } from '../ocr/OCRService.js';
import { ClassificationService } from './ClassificationService.js';
import type { QuestionResult } from '../../types/marking.js';
import { executeMarkingForQuestion, createMarkingTasksFromClassification } from './MarkingExecutor.js';
import { MarkingSchemeOrchestrationService } from './MarkingSchemeOrchestrationService.js';
import { PaperSplitterService, type PaperBucket, type InterceptedSchemeImageMeta } from './PaperSplitterService.js';
import { QuestionModeHandlerService } from './QuestionModeHandlerService.js';
import { ModeSplitService } from './ModeSplitService.js';
import {
    parseMarkingScope,
    applyScopeAndBlankPageHandling,
    hasValidMappedQuestions
} from './MarkingScopeUtils.js';
import { SessionManagementService } from '../sessionManagementService.js';
import { createUserMessage, createAIMessage } from '../../utils/messageUtils.js';
import {
    resolveSubjectProfile,
    isLevelOfResponseQuestion,
    computeSubjectGate,
    type SubjectProfile,
    type SubjectGate,
    SUBJECT_PROFILES
} from '../../config/subjectProfiles.js';

// Define the steps for multi-image processing
const MULTI_IMAGE_STEPS = [
    'Input Validation',
    'Standardization',
    'Preprocessing',
    'OCR & Classification',
    'Question Detection',
    'Segmentation',
    'Marking',
    'Output Generation'
];

export function isValidExamPaperHint(text?: string | null): boolean {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.length < 3 || trimmed.length > 120) return false;
    // 1. Preserve explicit General Rubric / No Official Scheme sentinel strings
    if (/general\s+rubric|no\s+official\s+marking\s+scheme|generic\s+mode/i.test(trimmed)) {
        return true;
    }
    // 2. Recognized exam board or qualification
    const hasBoardOrQual = /\b(aqa|edexcel|pearson|ocr|wjec|eduqas|cie|cambridge|ccea|gcse|igcse|a-?level|as-?level)\b/i.test(trimmed);
    // 3. Paper code pattern: MUST contain at least one digit (prevents matching hyphenated words like "mark-this" or "non-calc")
    const hasPaperCode = /\b(?=[0-9a-z]*\d)[0-9a-z]{3,6}[\/\-_][0-9a-z]{1,4}\b|\b(?=[0-9a-z]*\d)(?:[0-9]{4}|[0-9][a-z]{2}[0-9]|[a-z][0-9]{3}|wma\d+|wme\d+|wst\d+|wfm\d+|1ma1|8300|9ma0|8ma0|j560|h240|h230|7357|7356|8700|1en0|j351)\b/i.test(trimmed);
    return hasBoardOrQual || hasPaperCode;
}

const PAPER_CODE_PATTERN = /(?<![a-z0-9])((?=[0-9a-z]*\d)[0-9a-z]{3,6}[\/\-_][0-9a-z]{1,4}|(?=[0-9a-z]*\d)(?:[0-9][a-z]{2}[0-9]|[a-z][0-9]{3}|wma\d+|wme\d+|wst\d+|wfm\d+|1ma1|8300|9ma0|8ma0|j560|h240|h230|7357|7356|8700|1en0|j351))(?![a-z0-9])/i;

export function extractCoverPaperMetadata(params: {
    geometryResults?: Array<{
        is_marking_scheme?: boolean;
        paper_code_hint?: string;
        visual_observations?: string;
        evidence_text_snippet?: string;
    } | null | undefined>;
    classificationReasoning?: string;
    uploadedFileNames?: string[];
    extractedGeoPaperCode?: string;
    cleanGeoPaperHint?: string;
    effectiveExamPaperHint?: string;
}): {
    detectedBoard?: string;
    detectedPaperCode?: string;
    detectedExamSeries?: string;
    hasFourDigitYear: boolean;
    hasCoverVerifiedMetadata: boolean;
} {
    const {
        geometryResults = [],
        classificationReasoning = '',
        uploadedFileNames = [],
        extractedGeoPaperCode,
        cleanGeoPaperHint,
        effectiveExamPaperHint
    } = params;

    const coverSnippets = [
        ...geometryResults
            .filter(g => !g?.is_marking_scheme)
            .map(g => `${g?.paper_code_hint || ''} ${g?.visual_observations || ''} ${g?.evidence_text_snippet || ''}`),
        classificationReasoning
    ].filter(Boolean);

    const fileNameTexts = (uploadedFileNames || []).filter(Boolean);
    const sanitizedFileNames = fileNameTexts
        .join(' ')
        .replace(/(?<![a-z0-9])20\d{2}[-_](?:0[1-9]|1[0-2])[-_](?:0[1-9]|[12]\d|3[01])(?![a-z0-9])/gi, ' ');
    const coverTextOnly = coverSnippets.join(' ');
    const allCoverText = [coverTextOnly, sanitizedFileNames].filter(Boolean).join(' ');

    const boardRegex = /(?<![a-z0-9])(Edexcel|Pearson|AQA|OCR|WJEC|Eduqas|CIE|Cambridge|CCEA)(?![a-z0-9])/i;
    const coverBoard = coverTextOnly.match(boardRegex)?.[1];
    const detectedBoard = coverBoard || sanitizedFileNames.match(boardRegex)?.[1];

    const hintPaperCode = effectiveExamPaperHint
        ? effectiveExamPaperHint.match(PAPER_CODE_PATTERN)?.[1]
        : undefined;
    const coverOnlyPaperCode = coverTextOnly.match(PAPER_CODE_PATTERN)?.[1];
    const coverPaperCode = coverOnlyPaperCode || sanitizedFileNames.match(PAPER_CODE_PATTERN)?.[1];
    const detectedPaperCode = extractedGeoPaperCode || cleanGeoPaperHint || hintPaperCode || coverPaperCode;

    // Only accept explicit "<Month/Season/Series> <Year>" for the zero-probe fast-fail;
    // bare years (e.g. copyright notices or filenames) fall through to the 3-question probe.
    const explicitSeriesRegex = /(?<![a-z0-9])((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|summer|autumn|winter|spring|series[\s_-]+\d+)[\s_-]*(?:20\d{2}))(?![a-z0-9])/i;

    const coverSeriesMatch = coverTextOnly.match(explicitSeriesRegex)?.[1];
    const rawExamSeries =
        coverSeriesMatch ||
        sanitizedFileNames.match(explicitSeriesRegex)?.[1];
    const detectedExamSeries = rawExamSeries ? rawExamSeries.replace(/[-_]+/g, ' ').trim() : undefined;

    const hasFourDigitYear = Boolean(detectedExamSeries && /(?<![0-9])20\d{2}(?![0-9])/.test(detectedExamSeries));
    const hasCoverVerifiedPaperCode = Boolean(extractedGeoPaperCode || coverOnlyPaperCode);
    const hasCoverVerifiedMetadata = Boolean(
        coverBoard &&
        hasCoverVerifiedPaperCode &&
        coverSeriesMatch &&
        hasFourDigitYear
    );

    return {
        detectedBoard,
        detectedPaperCode,
        detectedExamSeries,
        hasFourDigitYear,
        hasCoverVerifiedMetadata
    };
}

export interface FastDbPreCheckLookupResult {
    markingSchemesMap: Map<string, any>;
    detectionStats?: any;
    updatedClassificationResult?: any;
    detectionResults?: any[];
    [key: string]: any;
}

function mergeMarkingSchemeEntries(existing: any, incoming: any): any {
    if (!existing) return incoming;
    if (!incoming) return existing;
    if (!existing.isGeneric && incoming.isGeneric) return existing;
    if (existing.isGeneric && !incoming.isGeneric) return incoming;

    const mergedSubNumbers = Array.from(new Set([
        ...(Array.isArray(existing.subQuestionNumbers) ? existing.subQuestionNumbers : []),
        ...(Array.isArray(incoming.subQuestionNumbers) ? incoming.subQuestionNumbers : [])
    ])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const mergedSubMaxScores = {
        ...(existing.subQuestionMaxScores || {}),
        ...(incoming.subQuestionMaxScores || {})
    };

    const mergedSubMarks = {
        ...(existing.questionMarks?.subQuestionMarks || {}),
        ...(incoming.questionMarks?.subQuestionMarks || {})
    };

    const mergedSubAnswersMap = {
        ...(existing.questionMarks?.subQuestionAnswersMap || {}),
        ...(incoming.questionMarks?.subQuestionAnswersMap || {})
    };

    const mergedSubMetadata = {
        ...(existing.subQuestionMetadata || existing.questionMarks?.subQuestionMetadata || {}),
        ...(incoming.subQuestionMetadata || incoming.questionMarks?.subQuestionMetadata || {})
    };

    const mergedSubGuidanceMap = {
        ...(existing.subQuestionGuidanceMap || existing.questionMarks?.subQuestionGuidanceMap || {}),
        ...(incoming.subQuestionGuidanceMap || incoming.questionMarks?.subQuestionGuidanceMap || {})
    };

    const mergedSubAnswers = Array.from(new Set([
        ...(Array.isArray(existing.subQuestionAnswers) ? existing.subQuestionAnswers : []),
        ...(Array.isArray(incoming.subQuestionAnswers) ? incoming.subQuestionAnswers : [])
    ]));

    const mergedSubTexts = (existing.subQuestionTexts || incoming.subQuestionTexts)
        ? { ...(existing.subQuestionTexts || {}), ...(incoming.subQuestionTexts || {}) }
        : undefined;

    const hasIncompleteSubQuestionBudgets = Boolean(
        existing.hasIncompleteSubQuestionBudgets || incoming.hasIncompleteSubQuestionBudgets
    );

    const subScoreSum = Object.values(mergedSubMaxScores).reduce<number>(
        (sum, val) => sum + (typeof val === 'number' && val > 0 ? val : 0),
        0
    );

    let mergedTotalMarks: number;
    if (existing.isGeneric && incoming.isGeneric) {
        mergedTotalMarks = hasIncompleteSubQuestionBudgets
            ? 0
            : (subScoreSum > 0 ? subScoreSum : (Number(existing.totalMarks) || 0) + (Number(incoming.totalMarks) || 0));
    } else {
        mergedTotalMarks = Math.max(
            Number(existing.totalMarks) || 0,
            Number(incoming.totalMarks) || 0,
            subScoreSum
        );
    }

    const mergedParentQuestionMarks = existing.isGeneric && incoming.isGeneric
        ? mergedTotalMarks
        : Math.max(
            Number(existing.parentQuestionMarks) || 0,
            Number(incoming.parentQuestionMarks) || 0,
            mergedTotalMarks
        );

    return {
        ...existing,
        ...incoming,
        questionMarks: {
            ...(existing.questionMarks || {}),
            ...(incoming.questionMarks || {}),
            subQuestionMarks: mergedSubMarks,
            ...(Object.keys(mergedSubAnswersMap).length > 0 ? { subQuestionAnswersMap: mergedSubAnswersMap } : {}),
            ...(Object.keys(mergedSubMetadata).length > 0 ? { subQuestionMetadata: mergedSubMetadata } : {}),
            ...(Object.keys(mergedSubGuidanceMap).length > 0 ? { subQuestionGuidanceMap: mergedSubGuidanceMap } : {})
        },
        subQuestionNumbers: mergedSubNumbers,
        subQuestionMaxScores: mergedSubMaxScores,
        subQuestionAnswers: mergedSubAnswers,
        ...(mergedSubTexts ? { subQuestionTexts: mergedSubTexts } : {}),
        ...(Object.keys(mergedSubMetadata).length > 0 ? { subQuestionMetadata: mergedSubMetadata } : {}),
        ...(Object.keys(mergedSubGuidanceMap).length > 0 ? { subQuestionGuidanceMap: mergedSubGuidanceMap } : {}),
        hasIncompleteSubQuestionBudgets,
        totalMarks: mergedTotalMarks,
        parentQuestionMarks: mergedParentQuestionMarks,
        questionDetection: existing.questionDetection?.found ? existing.questionDetection : incoming.questionDetection,
        sourceImageIndex: existing.sourceImageIndex ?? incoming.sourceImageIndex
    };
}

function mergeDetectionStats(probeStats: any, remainingStats: any): any {
    if (!probeStats && !remainingStats) return undefined;
    if (!probeStats) return remainingStats;
    if (!remainingStats) return probeStats;

    const mergedQuestionDetails = [
        ...(Array.isArray(probeStats.questionDetails) ? probeStats.questionDetails : []),
        ...(Array.isArray(remainingStats.questionDetails) ? remainingStats.questionDetails : [])
    ];

    const probeHint = probeStats.hintInfo;
    const remHint = remainingStats.hintInfo;
    const mergedHintInfo = (probeHint || remHint)
        ? {
            hintUsed: remHint?.hintUsed || probeHint?.hintUsed || '',
            matchedPapersCount: Math.max(probeHint?.matchedPapersCount || 0, remHint?.matchedPapersCount || 0),
            ...(remHint?.matchedPaperTitle || probeHint?.matchedPaperTitle
                ? { matchedPaperTitle: remHint?.matchedPaperTitle || probeHint?.matchedPaperTitle }
                : {}),
            thresholdRelaxed: Boolean(probeHint?.thresholdRelaxed || remHint?.thresholdRelaxed),
            ...(probeHint?.deepSearchActive || remHint?.deepSearchActive ? { deepSearchActive: true } : {}),
            ...(Math.max(probeHint?.poolSize || 0, remHint?.poolSize || 0) > 0
                ? { poolSize: Math.max(probeHint?.poolSize || 0, remHint?.poolSize || 0) }
                : {}),
            ...((probeHint?.rescuedQuestions || remHint?.rescuedQuestions)
                ? {
                    rescuedQuestions: Array.from(new Set([
                        ...(probeHint?.rescuedQuestions || []),
                        ...(remHint?.rescuedQuestions || [])
                    ]))
                }
                : {})
        }
        : undefined;

    return {
        totalQuestions: (probeStats.totalQuestions || 0) + (remainingStats.totalQuestions || 0),
        detected: (probeStats.detected || 0) + (remainingStats.detected || 0),
        notDetected: (probeStats.notDetected || 0) + (remainingStats.notDetected || 0),
        withMarkingScheme: (probeStats.withMarkingScheme || 0) + (remainingStats.withMarkingScheme || 0),
        withoutMarkingScheme: (probeStats.withoutMarkingScheme || 0) + (remainingStats.withoutMarkingScheme || 0),
        bySimilarityRange: {
            high: (probeStats.bySimilarityRange?.high || 0) + (remainingStats.bySimilarityRange?.high || 0),
            medium: (probeStats.bySimilarityRange?.medium || 0) + (remainingStats.bySimilarityRange?.medium || 0),
            low: (probeStats.bySimilarityRange?.low || 0) + (remainingStats.bySimilarityRange?.low || 0)
        },
        questionDetails: mergedQuestionDetails,
        hintInfo: mergedHintInfo
    };
}

function mergeUpdatedClassificationResult(
    probeUcr: any,
    remainingUcr: any,
    fallback: any,
    totalQuestionsCount: number
): any {
    if (!probeUcr && !remainingUcr) return fallback;
    if (!probeUcr) return remainingUcr;
    if (!remainingUcr) return probeUcr;
    if (probeUcr === remainingUcr) return remainingUcr;

    const merged: any = { ...probeUcr, ...remainingUcr };
    if (
        Array.isArray(probeUcr.questions) &&
        Array.isArray(remainingUcr.questions) &&
        probeUcr.questions.length < totalQuestionsCount &&
        probeUcr.questions.length + remainingUcr.questions.length === totalQuestionsCount
    ) {
        merged.questions = [...probeUcr.questions, ...remainingUcr.questions];
    }
    return merged;
}

export async function runFastDbPreCheck(params: {
    individualQuestions: any[];
    classificationResult: any;
    effectiveExamPaperHint?: string;
    geometryResults?: any[];
    uploadedFileNames?: string[];
    extractedGeoPaperCode?: string;
    cleanGeoPaperHint?: string;
    isVisionVerbatim?: boolean;
    subjectProfile?: any;
    paperExistsInDatabaseFn: (board?: string, paperCode?: string, examSeries?: string) => Promise<boolean>;
    orchestrateLookupFn: (
        questions: any[],
        classificationResult: any,
        examPaperHint?: string,
        unused?: any,
        isVisionVerbatim?: boolean,
        subjectProfile?: any
    ) => Promise<FastDbPreCheckLookupResult>;
}): Promise<FastDbPreCheckLookupResult | null> {
    const {
        individualQuestions,
        classificationResult,
        effectiveExamPaperHint,
        geometryResults,
        uploadedFileNames,
        extractedGeoPaperCode,
        cleanGeoPaperHint,
        isVisionVerbatim,
        subjectProfile,
        paperExistsInDatabaseFn,
        orchestrateLookupFn
    } = params;

    if (!individualQuestions || individualQuestions.length === 0) return null;

    const { detectedBoard, detectedPaperCode, detectedExamSeries, hasFourDigitYear, hasCoverVerifiedMetadata } = extractCoverPaperMetadata({
        geometryResults,
        classificationReasoning: classificationResult?.reasoning,
        uploadedFileNames,
        extractedGeoPaperCode,
        cleanGeoPaperHint,
        effectiveExamPaperHint
    });

    // 1. Fast-fail by paper metadata ONLY when verified from cover/geometry text (not filename alone)
    if (hasCoverVerifiedMetadata && detectedBoard && detectedPaperCode && detectedExamSeries && hasFourDigitYear) {
        const existsInDb = await paperExistsInDatabaseFn(
            detectedBoard,
            detectedPaperCode,
            detectedExamSeries
        );
        if (!existsInDb) {
            console.log(
                `⚡ [FAST-DB-PRECHECK] Paper ${detectedBoard} ${detectedPaperCode} (${detectedExamSeries}) not found in DB. Fast-failing pre-check to rasterize/parse uploaded mark scheme!`
            );
            return null;
        }
    }

    // 2. If examSeries is not verified from the cover page, sample at most the first 3 questions first.
    // If 0/3 match in DB, abort immediately without running the remaining questions.
    // If >= 1 matches, query only the remaining questions and merge so the first 3 are not queried twice.
    let dbPreCheck: FastDbPreCheckLookupResult;
    if (!hasCoverVerifiedMetadata && individualQuestions.length > 3) {
        const probeQuestions = individualQuestions.slice(0, 3).map(q => ({ ...q }));
        const probeResult = await orchestrateLookupFn(
            probeQuestions,
            classificationResult,
            effectiveExamPaperHint,
            undefined,
            isVisionVerbatim,
            subjectProfile
        );
        const probeMatches = Array.from(probeResult.markingSchemesMap.values()).filter(
            (s: any) => !s?.isGeneric && s?.questionDetection?.found && s?.questionDetection?.match?.markingScheme
        );
        if (probeMatches.length === 0) {
            console.log(
                `⚡ [FAST-DB-PRECHECK] 0/${probeQuestions.length} sample questions matched in DB (Hint="${effectiveExamPaperHint || 'none'}"). Aborting pre-check and proceeding directly to uploaded mark scheme!`
            );
            return null;
        }

        const remainingQuestions = individualQuestions.slice(3).map(q => ({ ...q }));
        const remainingResult = await orchestrateLookupFn(
            remainingQuestions,
            classificationResult,
            effectiveExamPaperHint,
            undefined,
            isVisionVerbatim,
            subjectProfile
        );
        const mergedMap = new Map<string, any>(probeResult.markingSchemesMap);
        for (const [k, v] of remainingResult.markingSchemesMap.entries()) {
            if (mergedMap.has(k)) {
                mergedMap.set(k, mergeMarkingSchemeEntries(mergedMap.get(k), v));
            } else {
                mergedMap.set(k, v);
            }
        }
        const mergedDetectionResults = (probeResult.detectionResults || remainingResult.detectionResults)
            ? [...(probeResult.detectionResults || []), ...(remainingResult.detectionResults || [])]
            : undefined;
        const mergedDetectionStats = mergeDetectionStats(probeResult.detectionStats, remainingResult.detectionStats);
        const mergedUpdatedClassificationResult = mergeUpdatedClassificationResult(
            probeResult.updatedClassificationResult,
            remainingResult.updatedClassificationResult,
            classificationResult,
            individualQuestions.length
        );
        dbPreCheck = {
            ...probeResult,
            ...remainingResult,
            markingSchemesMap: mergedMap,
            ...(mergedDetectionResults !== undefined ? { detectionResults: mergedDetectionResults } : {}),
            ...(mergedDetectionStats !== undefined ? { detectionStats: mergedDetectionStats } : {}),
            ...(mergedUpdatedClassificationResult !== undefined ? { updatedClassificationResult: mergedUpdatedClassificationResult } : {})
        };
    } else {
        dbPreCheck = await orchestrateLookupFn(
            individualQuestions.map(q => ({ ...q })),
            classificationResult,
            effectiveExamPaperHint,
            undefined,
            isVisionVerbatim,
            subjectProfile
        );
    }
    const totalGroups = dbPreCheck.markingSchemesMap.size;
    const matchedDbSchemes = Array.from(dbPreCheck.markingSchemesMap.values()).filter(
        (s: any) => !s?.isGeneric && s?.questionDetection?.found && s?.questionDetection?.match?.markingScheme
    );
    if (totalGroups > 0 && matchedDbSchemes.length > 0 && (matchedDbSchemes.length / totalGroups) >= 0.7) {
        const matchedTitle = matchedDbSchemes[0]?.questionDetection?.match?.paperTitle || 'Official Past Paper';
        console.log(`⚡ [FAST-DB-SCHEME] Official marking scheme already exists in DB ("${matchedTitle}", ${matchedDbSchemes.length}/${totalGroups} question groups). Skipping LLM extraction of uploaded mark scheme!`);
        return dbPreCheck;
    }

    return null;
}

export function computeGeoSubjectVote(
    geometryResults: Array<{ is_marking_scheme?: boolean; detected_subject?: string } | null | undefined>
): string | undefined {
    const nonSchemeGeo = geometryResults.filter(g => g && !g.is_marking_scheme);
    const subjectVoteCounts = new Map<string, number>();
    nonSchemeGeo.forEach(g => {
        const s = g?.detected_subject || 'MATHS';
        subjectVoteCounts.set(s, (subjectVoteCounts.get(s) || 0) + 1);
    });
    let geoSubjectVote: string | undefined = undefined;
    let maxVotes = 0;
    subjectVoteCounts.forEach((cnt, subj) => {
        if (cnt > maxVotes) {
            maxVotes = cnt;
            geoSubjectVote = subj;
        }
    });
    return geoSubjectVote;
}

export function detectIsFrontCover(params: {
    isGeoCover: boolean;
    originalIdx: number;
    isMeta: boolean;
    pageOcrText: string;
    mapperCategory?: string;
    geoTextSnippet?: string;
}): boolean {
    const { isGeoCover, originalIdx, isMeta, pageOcrText, mapperCategory, geoTextSnippet } = params;
    const combinedText = `${pageOcrText || ''} ${geoTextSnippet || ''}`;
    const isBlankFiller = /no\s*questions\s*printed|blank\s*page/i.test(combinedText);
    if (isBlankFiller) {
        return false;
    }
    const hasCoverLandmarks = /candidate\s*surname|centre\s*number|instructions\s*to\s*candidates|paper\s*reference|total\s*mark\s*for\s*this\s*paper|you\s*must\s*have/i.test(combinedText);
    const isMapperFrontPage = isMeta && mapperCategory === 'frontPage';
    return (isGeoCover && (originalIdx === 0 || isMeta || hasCoverLandmarks)) || (isMeta && hasCoverLandmarks) || isMapperFrontPage;
}

export function hasVerifiedFrontCoverEvidence(params: {
    isGeoCover: boolean;
    pageOcrText: string;
    geoTextSnippet?: string;
}): boolean {
    const combinedText = `${params.pageOcrText || ''} ${params.geoTextSnippet || ''}`;
    if (/no\s*questions\s*printed|blank\s*page/i.test(combinedText)) return false;
    const hasCoverLandmarks = /candidate\s*surname|centre\s*number|instructions\s*to\s*candidates|paper\s*reference|total\s*mark\s*for\s*this\s*paper|you\s*must\s*have/i.test(combinedText);
    return Boolean(params.isGeoCover || hasCoverLandmarks);
}

export function demoteSpuriousFrontCovers<T extends { isFrontCover: boolean; minQ: number; hasVerifiedCoverEvidence?: boolean }>(
    pageSortMap: T[]
): void {
    const frontCoverCandidates = pageSortMap.filter(p => p.isFrontCover && p.minQ === 999999);
    if (frontCoverCandidates.length <= 1) return;
    // A single exam booklet cannot have multiple unverified front covers.
    // Demote any candidate that was only flagged via Mapper's 'frontPage' category without cover landmarks or geometry confirmation.
    frontCoverCandidates.forEach(p => {
        if (!p.hasVerifiedCoverEvidence) {
            p.isFrontCover = false;
        }
    });
}

export function isContinuationHeaderOnly(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return true;
    return /^(?:question|q\.?)\s*\d+[a-z]?(?:\s*\([a-z0-9]+\))*\s*(?:continued|\(continued\))\.?$/i.test(t) ||
        /^continued\.?$/i.test(t) ||
        /^leave\s+blank$/i.test(t) ||
        /^do\s+not\s+write\s+in\s+this\s+area$/i.test(t);
}

export function extractBookletPageNumber(pageOcrBlocks: any[], baseQuestionNumber?: number): number | null {
    if (!Array.isArray(pageOcrBlocks) || pageOcrBlocks.length === 0) return null;

    // 1. Highest confidence: Pearson Edexcel footer barcode (e.g. "P 86176 A 0244" -> page 2 of 44, "P86176A03044" -> page 30 of 44)
    const footerStart = Math.max(0, pageOcrBlocks.length - 4);
    for (let i = footerStart; i < pageOcrBlocks.length; i++) {
        const raw = (pageOcrBlocks[i]?.googleVisionText || pageOcrBlocks[i]?.mathpixLatex || pageOcrBlocks[i]?.text || '').trim();
        const barcodeMatch = raw.match(/P\s*\d{5}\s*[A-Z]\s*0(\d{2})(\d{2})\b/i);
        if (barcodeMatch) {
            const pageNum = parseInt(barcodeMatch[1], 10);
            const totalNum = parseInt(barcodeMatch[2], 10);
            if (pageNum >= 1 && pageNum <= 100 && totalNum >= pageNum && totalNum <= 100) {
                return pageNum;
            }
        }
    }

    // 2. Footer standalone page number (scan forward in last 4 blocks, excluding top header index 0,
    // so page number precedes trailing total-marks box, e.g. "43" before "4")
    if (pageOcrBlocks.length > 3) {
        const footerNumStart = Math.max(1, pageOcrBlocks.length - 4);
        for (let i = footerNumStart; i < pageOcrBlocks.length; i++) {
            const raw = (pageOcrBlocks[i]?.googleVisionText || pageOcrBlocks[i]?.text || '').trim();
            const txt = raw.replace(/\s+/g, '');
            if (/^\d{1,2}$/.test(txt)) {
                const num = parseInt(txt, 10);
                if (num >= 1 && num <= 100 && !(i < 2 && num === baseQuestionNumber)) {
                    return num;
                }
            }
        }
    }

    // 3. Header standalone page number (first 4 blocks, skipping standalone numbers equal to the page's base question number)
    for (let i = 0; i < Math.min(4, pageOcrBlocks.length); i++) {
        const txt = (pageOcrBlocks[i]?.googleVisionText || pageOcrBlocks[i]?.text || '').trim();
        if (/^\d{1,2}$/.test(txt)) {
            const num = parseInt(txt, 10);
            if (num >= 1 && num <= 100 && num !== baseQuestionNumber) {
                return num;
            }
        }
    }

    return null;
}

export function comparePageSortEntries(
    a: { isFrontCover: boolean; minQ: number; bookletPage: number | null; hasPrintedStem: boolean; originalIdx: number },
    b: { isFrontCover: boolean; minQ: number; bookletPage: number | null; hasPrintedStem: boolean; originalIdx: number }
): number {
    // Rule 1: ONLY true Exam Front Covers (isFrontCover === true) go before Q1.
    // Unattempted/unresolved metadata pages (isMeta && minQ === 999999 && !isFrontCover) go to the END!
    const aIsTrueCover = a.isFrontCover && a.minQ === 999999;
    const bIsTrueCover = b.isFrontCover && b.minQ === 999999;
    if (aIsTrueCover && !bIsTrueCover) return -1;
    if (!aIsTrueCover && bIsTrueCover) return 1;

    // Push non-cover unresolved metadata pages (minQ === 999999) to the end of the upload
    if (a.minQ === 999999 && b.minQ !== 999999) return 1;
    if (a.minQ !== 999999 && b.minQ === 999999) return -1;

    // Rule 2: Logical Base Question Order (Q1..Q15)
    const aBaseQ = Math.floor(a.minQ);
    const bBaseQ = Math.floor(b.minQ);
    if (aBaseQ !== bBaseQ) {
        return aBaseQ - bBaseQ;
    }

    // Rule 2.1: Intra-Question Ordering by Printed Booklet Page Number (takes precedence over sub-part weights
    // when two pages belong to the same base question, e.g. two "Question 9 continued" pages)
    if (a.bookletPage !== null && b.bookletPage !== null && a.bookletPage !== b.bookletPage) {
        return a.bookletPage - b.bookletPage;
    }

    // Rule 2.2: Sub-Question Weight Order when bookletPage is unavailable
    if (Math.abs(a.minQ - b.minQ) > 0.00001) {
        return a.minQ - b.minQ;
    }

    // Rule 2.3: Printed Question Stem Precedes Continuation Pages
    if (a.hasPrintedStem && !b.hasPrintedStem) return -1;
    if (!a.hasPrintedStem && b.hasPrintedStem) return 1;

    // Rule 3: Physical Tie-breaker (Original Upload Order)
    return a.originalIdx - b.originalIdx;
}

/**
 * Option A (Safe Hybrid): Anchor unresolved interior blank/continuation pages (`minQ === 999999 && !isFrontCover`)
 * into their exact physical booklet slot using:
 *   1. `bookletPage` interpolation against known question pages (works even when loose photos are uploaded shuffled!)
 *   2. `geoFirstQuestionNumber` fallback (e.g. pre-flight read "Question 13 continued" -> 13)
 */
export function anchorUnresolvedMetaPagesByBooklet<T extends {
    minQ: number;
    isMeta: boolean;
    isFrontCover: boolean;
    bookletPage: number | null;
    geoFirstQuestionNumber?: number | null;
}>(pageSortMap: T[]): void {
    const anchoredByBooklet = pageSortMap
        .filter(p => p.minQ < 999999 && p.bookletPage !== null)
        .sort((a, b) => (a.bookletPage as number) - (b.bookletPage as number));

    for (const current of pageSortMap) {
        if (current.minQ !== 999999 || current.isFrontCover) continue;

        // 1. Interpolate using printed bookletPage relative to the closest preceding anchored question page
        if (current.bookletPage !== null && anchoredByBooklet.length > 0) {
            let prevAnchor: T | null = null;
            for (const anchor of anchoredByBooklet) {
                if ((anchor.bookletPage as number) < current.bookletPage) {
                    prevAnchor = anchor;
                } else {
                    break;
                }
            }
            if (prevAnchor) {
                const pageDelta = current.bookletPage - (prevAnchor.bookletPage as number);
                const baseQ = Math.floor(prevAnchor.minQ);
                current.minQ = baseQ + 0.99 + Math.min(0.0099, pageDelta * 0.0001);
                continue;
            }
        }

        // 2. Pre-flight first_question_number fallback (e.g. "Question 13 continued" -> 13.995)
        if (
            typeof current.geoFirstQuestionNumber === 'number' &&
            Number.isInteger(current.geoFirstQuestionNumber) &&
            current.geoFirstQuestionNumber >= 1 &&
            current.geoFirstQuestionNumber <= 100
        ) {
            current.minQ = current.geoFirstQuestionNumber + 0.995;
        }
    }
}

export function computeIsScrambledPdf(params: {
    pageSortMap: Array<{ minQ: number; isFrontCover: boolean; bookletPage?: number | null }>;
    isPdf: boolean;
    isMultiplePdfs: boolean;
}): { majorQuestionInversions: number; hasDisplacedFrontCover: boolean; isScrambledPdf: boolean } {
    const { pageSortMap, isPdf, isMultiplePdfs } = params;
    const questionPagesInOrder = pageSortMap.filter(p => p.minQ < 999999 && !p.isFrontCover);
    let majorQuestionInversions = 0;
    for (let i = 1; i < questionPagesInOrder.length; i++) {
        if (questionPagesInOrder[i].minQ + 0.5 < questionPagesInOrder[i - 1].minQ) {
            majorQuestionInversions++;
        }
    }
    const firstQuestionPageIdx = pageSortMap.findIndex(p => p.minQ < 999999 && !p.isFrontCover);
    const hasDisplacedFrontCover = pageSortMap.some(
        (p, idx) => p.isFrontCover && p.minQ === 999999 && firstQuestionPageIdx >= 0 && idx > firstQuestionPageIdx
    );

    const bookletPages = pageSortMap
        .filter(p => typeof p.bookletPage === 'number' && p.bookletPage > 0)
        .map(p => p.bookletPage as number);
    let hasStrictlyIncreasingBookletPages =
        isPdf &&
        !isMultiplePdfs &&
        !hasDisplacedFrontCover &&
        bookletPages.length >= Math.max(3, Math.floor(pageSortMap.length * 0.5));
    if (hasStrictlyIncreasingBookletPages) {
        for (let i = 1; i < bookletPages.length; i++) {
            if (bookletPages[i] <= bookletPages[i - 1]) {
                hasStrictlyIncreasingBookletPages = false;
                break;
            }
        }
    }

    const isScrambledPdf = (isPdf || isMultiplePdfs) && !hasStrictlyIncreasingBookletPages && (
        majorQuestionInversions >= 2 ||
        (majorQuestionInversions >= 1 && hasDisplacedFrontCover)
    );
    return { majorQuestionInversions, hasDisplacedFrontCover, isScrambledPdf };
}

export function recoverGenericTotalMarks(params: {
    task: any;
    result: any;
    finalizedAnnotations: any[];
    newAwarded: number;
    aiStatedTotalMarks?: number;
    isGenericScheme?: boolean;
    hasIncompleteBudgets?: boolean;
    aiReportedTotalMarks?: number;
    aiReportedAwardedMarks?: number;
}): void {
    const {
        task,
        result,
        finalizedAnnotations,
        newAwarded,
        aiStatedTotalMarks = 0,
        isGenericScheme = Boolean(task?.markingScheme?.isGeneric),
        hasIncompleteBudgets = false,
        aiReportedTotalMarks = aiStatedTotalMarks,
        aiReportedAwardedMarks = 0
    } = params;

    const effectiveAiTotal = Math.max(aiReportedTotalMarks, aiStatedTotalMarks);

    if (isGenericScheme || effectiveAiTotal > 0 || !result.score.totalMarks || result.score.totalMarks <= 0) {
        const inferredTotalFromAnnotations = finalizedAnnotations.reduce((sum: number, a: any) => {
            const text = (a.text || '').trim();
            const isMath = /[\\{}=\^_\(\)]/.test(text) || text.includes('sqrt') || text.includes('frac');
            if (!isMath) {
                const clean = text.replace(/[^a-zA-Z0-9]/g, '');
                const m = clean.match(/^([BMAPC])(\d+)$/i);
                if (m) {
                    const num = parseInt(m[2], 10);
                    return sum + (num > 0 ? num : 1);
                }
            }
            if (a.action === 'tick' || a.action === 'cross' || a.action === 'mark') {
                return sum + 1;
            }
            return sum;
        }, 0);

        if (isGenericScheme) {
            if (hasIncompleteBudgets && effectiveAiTotal >= inferredTotalFromAnnotations && effectiveAiTotal > 0) {
                result.score.totalMarks = effectiveAiTotal;
            } else {
                result.score.totalMarks = Math.max(effectiveAiTotal, inferredTotalFromAnnotations, newAwarded);
            }
        } else {
            result.score.totalMarks = Math.max(effectiveAiTotal, inferredTotalFromAnnotations, newAwarded);
        }

        (result as any).totalMarks = result.score.totalMarks;
        if (isGenericScheme && effectiveAiTotal > 0) {
            (result.score as any)._authoritativeGenericScore = true;
        }
        if (task.markingScheme && result.score.totalMarks > 0) {
            task.markingScheme.totalMarks = result.score.totalMarks;
            task.markingScheme.parentQuestionMarks = result.score.totalMarks;
        }

        if (
            isGenericScheme &&
            hasIncompleteBudgets &&
            aiReportedAwardedMarks > newAwarded &&
            aiReportedAwardedMarks <= result.score.totalMarks
        ) {
            const crossCount = finalizedAnnotations.filter(
                (a: any) => a.action === 'cross' || /\b(?:M0|A0|B0)\b/i.test(String(a.text || ''))
            ).length;
            if (crossCount === 0 || newAwarded + crossCount < result.score.totalMarks) {
                result.score.awardedMarks = Math.min(
                    Math.max(0, result.score.totalMarks - crossCount),
                    Math.max(newAwarded, aiReportedAwardedMarks)
                );
            }
        }
    }
}

export function extractLeadingBaseQNum(qNum: unknown): string {
    if (qNum === null || qNum === undefined) return '';
    const str = String(qNum).trim();
    if (!str) return '';
    const cleaned = str.replace(/^(?:question|q)[.\s:]*/i, '');
    const match = cleaned.match(/^(\d+)/);
    return match ? match[1] : '';
}

export function resolvePageMinSortWeight(params: {
    questions?: any[];
    mapperHints?: string[];
    isIntroStem?: boolean;
}): { minSortWeight: number; pageWeights: Array<{ q: string; w: number }>; debugQList: string[] } {
    const { questions, mapperHints, isIntroStem = false } = params;
    const pageWeights: Array<{ q: string; w: number }> = [];
    const debugQList: string[] = [];

    const checkWeightRecursive = (node: any, parentQNum: string = '') => {
        if (!node) return;
        let qNumContext = parentQNum;

        if (!parentQNum) {
            const rootQNum = typeof node === 'string' ? node : (node.questionNumber || node.part || '');
            qNumContext = String(rootQNum || '').trim();
        } else {
            const rawPart = typeof node === 'string' ? node : (node.part || node.questionNumber || '');
            const cleanPart = String(rawPart || '').replace(/[()\s]/g, '').trim();
            if (cleanPart) {
                const isAlreadyPrefixed =
                    cleanPart.toLowerCase().startsWith(parentQNum.toLowerCase()) &&
                    (cleanPart.length === parentQNum.length || /^[^0-9]/.test(cleanPart.slice(parentQNum.length)));
                if (isAlreadyPrefixed) {
                    qNumContext = cleanPart;
                } else if (/^\d/.test(cleanPart)) {
                    // Numeric or decimal sub-part (e.g. "1", "1.1", "1.2", "2.1") must NEVER overwrite parentQNum
                    qNumContext = parentQNum.endsWith('.') ? `${parentQNum}${cleanPart}` : `${parentQNum}.${cleanPart}`;
                } else {
                    // Alpha/roman sub-part (e.g. "a", "b", "i", "ii")
                    qNumContext = `${parentQNum}${cleanPart}`;
                }
            }
        }

        if (qNumContext) {
            debugQList.push(qNumContext);
            const weight = getQuestionSortValue(qNumContext);
            pageWeights.push({ q: qNumContext, w: weight });
        }

        if (typeof node === 'object' && Array.isArray(node.subQuestions)) {
            node.subQuestions.forEach((sub: any) => checkWeightRecursive(sub, qNumContext));
        }
    };

    if (Array.isArray(questions) && questions.length > 0) {
        questions.forEach((q: any) => checkWeightRecursive(q));
    } else if (Array.isArray(mapperHints) && mapperHints.length > 0) {
        let currentParentBase = '';
        mapperHints.forEach((rawHint: string) => {
            const qStr = String(rawHint || '').trim();
            if (!qStr) return;
            let effectiveQStr = qStr;
            if (/^\d+\.\d+/.test(qStr) && currentParentBase && !qStr.startsWith(`${currentParentBase}.`)) {
                // Decimal sub-part (e.g. "1.1", "2.1") following a parent question in mapperHints
                effectiveQStr = `${currentParentBase}.${qStr}`;
            } else {
                const leading = extractLeadingBaseQNum(qStr);
                if (leading && !/^\d+\.\d+/.test(qStr)) {
                    currentParentBase = leading;
                }
            }
            debugQList.push(effectiveQStr);
            pageWeights.push({ q: effectiveQStr, w: getQuestionSortValue(effectiveQStr) });
        });
    }

    let minSortWeight = Infinity;
    if (pageWeights.length > 0) {
        const specificWeights = pageWeights.filter(pw => pw.w % 1 !== 0);
        const genericWeights = pageWeights.filter(pw => pw.w % 1 === 0);

        if (specificWeights.length > 0) {
            minSortWeight = Math.min(...specificWeights.map(pw => pw.w));
        } else if (genericWeights.length > 0) {
            const baseWeight = Math.min(...genericWeights.map(pw => pw.w));
            minSortWeight = isIntroStem ? (baseWeight + 0.00005) : (baseWeight + 0.9);
        }
    }

    return { minSortWeight, pageWeights, debugQList };
}

export function getInstanceMinWeight(q: any, questionNumber: string): number {
    const qNumClean = String(questionNumber || '').trim();
    const weights: number[] = [];

    const collectWeights = (subs: any[], parentPrefix: string) => {
        if (!Array.isArray(subs)) return;
        for (const sq of subs) {
            if (!sq) continue;
            const rawPart = String(sq.part || sq.questionNumber || '').trim();
            let currentFull = parentPrefix;
            if (rawPart) {
                const cleanPart = rawPart.replace(/[()\s]/g, '');
                if (cleanPart) {
                    const isAlreadyPrefixed =
                        parentPrefix.length > 0 &&
                        cleanPart.toLowerCase().startsWith(parentPrefix.toLowerCase()) &&
                        (cleanPart.length === parentPrefix.length || /^[^0-9]/.test(cleanPart.slice(parentPrefix.length)));
                    if (isAlreadyPrefixed) {
                        currentFull = cleanPart;
                    } else if (/^\d/.test(cleanPart)) {
                        currentFull = parentPrefix.endsWith('.') ? `${parentPrefix}${cleanPart}` : `${parentPrefix}.${cleanPart}`;
                    } else {
                        currentFull = `${parentPrefix}${cleanPart}`;
                    }
                    const w = getQuestionSortValue(currentFull);
                    if (Number.isFinite(w)) weights.push(w);
                }
            }
            if (Array.isArray(sq.subQuestions) && sq.subQuestions.length > 0) {
                collectWeights(sq.subQuestions, currentFull);
            }
        }
    };

    if (Array.isArray(q?.subQuestions) && q.subQuestions.length > 0) {
        collectWeights(q.subQuestions, qNumClean);
    }

    if (weights.length > 0) {
        return Math.min(...weights);
    }

    const baseW = getQuestionSortValue(qNumClean);
    return Number.isFinite(baseW) ? baseW : Infinity;
}

export function getAnnotationMarkVal(a: any): number {
    if (!a || a.action === 'cross') return 0;
    const text = (a.text || '').trim();
    const isAwardedAction = a.action === 'tick' || a.action === 'mark';
    const isMath = /[\\{}=\^_\(\)]/.test(text) || text.includes('sqrt') || text.includes('frac');
    if (!isMath) {
        const clean = text.replace(/[^a-zA-Z0-9]/g, '');
        if (/^[BMAPC]0$/i.test(clean)) return 0;
        if (/^[BMAPC][1-9]\d*$/i.test(clean)) {
            return parseInt(clean.match(/\d+$/)?.[0] || '1', 10);
        }
    }
    return isAwardedAction ? 1 : 0;
}

export function applyPointBasedGuillotine(params: {
    annotations: any[];
    questionNumber: string;
    subQuestionBudgets: Record<string, number>;
    totalBudget: number;
    isGenericScheme: boolean;
    hasIncompleteBudgets: boolean;
}): {
    finalizedAnnotations: any[];
    rawTotalAwardedMarks: number;
    hasAnyCrossOrZero: boolean;
    bypassSubGuillotineForGeneric: boolean;
} {
    const {
        annotations,
        questionNumber,
        subQuestionBudgets,
        totalBudget,
        isGenericScheme,
        hasIncompleteBudgets
    } = params;

    const rawTotalAwardedMarks = annotations.reduce((sum: number, a: any) => sum + getAnnotationMarkVal(a), 0);
    const hasAnyCrossOrZero = annotations.some((a: any) =>
        a?.action === 'cross' || /\b[BMAPC]0\b/i.test((a?.text || '').trim())
    );
    const bypassSubGuillotineForGeneric = Boolean(
        isGenericScheme && (
            hasIncompleteBudgets ||
            totalBudget <= 0 ||
            rawTotalAwardedMarks <= totalBudget
        )
    );

    const priorityMap: Record<string, number> = { 'A': 3, 'B': 2, 'M': 1 };
    let finalizedAnnotations: any[] = [];

    if (bypassSubGuillotineForGeneric) {
        finalizedAnnotations = [...annotations];
    } else {
        // 1. Group by subQuestion
        const groups = new Map<string, any[]>();
        annotations.forEach(a => {
            const rawSq = (a.subQuestion || 'root').toLowerCase();
            const sq = rawSq.replace(/^\d+/, '').replace(/[()\s]/g, '');
            if (!groups.has(sq)) groups.set(sq, []);
            groups.get(sq)!.push(a);
        });

        // 2. Process each group (Sub-Question Guillotine)
        for (const [sq, annos] of groups.entries()) {
            const cleanDotSq = sq.replace(/^\./, '');
            let subBudget =
                subQuestionBudgets[sq] ??
                subQuestionBudgets[`${questionNumber}${sq}`] ??
                subQuestionBudgets[`${questionNumber}.${cleanDotSq}`] ??
                99;

            if (!subBudget || subBudget <= 0) {
                subBudget = 99;
            }

            annos.sort((a: any, b: any) => {
                const pA = priorityMap[(a.text || '').charAt(0).toUpperCase()] || 0;
                const pB = priorityMap[(b.text || '').charAt(0).toUpperCase()] || 0;
                return pB - pA;
            });

            const kept: any[] = [];
            let currentSubScore = 0;

            annos.forEach(a => {
                const val = getAnnotationMarkVal(a);
                if (val <= 0) {
                    kept.push(a);
                    return;
                }

                if (currentSubScore + val <= subBudget) {
                    kept.push(a);
                    currentSubScore += val;
                } else if (currentSubScore < subBudget) {
                    console.log(`[GUILLOTINE] Q${questionNumber}${sq} Cutting mark '${a.text}' to stay within budget ${subBudget}`);
                }
            });

            if (kept.length < annos.length) {
                console.log(`[GUILLOTINE] Q${questionNumber}${sq} exceeded budget! Kept ${kept.length}/${annos.length}, Budget ${subBudget}.`);
            }
            finalizedAnnotations.push(...kept);
        }
    }

    // 3. Final Global Guillotine (just in case sum of subs > total)
    const currentTotalAwarded = finalizedAnnotations.reduce((sum: number, a: any) => sum + getAnnotationMarkVal(a), 0);
    if (totalBudget > 0 && currentTotalAwarded > totalBudget) {
        console.log(`[GUILLOTINE] Q${questionNumber} GLOBAL exceeded budget! Total ${totalBudget}. Executing final cut...`);
        finalizedAnnotations.sort((a, b) => {
            const pA = priorityMap[(a.text || '').charAt(0).toUpperCase()] || 0;
            const pB = priorityMap[(b.text || '').charAt(0).toUpperCase()] || 0;
            return pB - pA;
        });

        let runningGlobal = 0;
        const globalKept: any[] = [];
        finalizedAnnotations.forEach(a => {
            const val = getAnnotationMarkVal(a);
            const isAwarded = val > 0;
            if (!isAwarded || (runningGlobal + val <= totalBudget)) {
                globalKept.push(a);
                if (isAwarded) runningGlobal += val;
            }
        });
        finalizedAnnotations = globalKept;
    }

    return {
        finalizedAnnotations,
        rawTotalAwardedMarks,
        hasAnyCrossOrZero,
        bypassSubGuillotineForGeneric
    };
}

// Define the steps for re-marking processing
const REMARK_STEPS = [
    'Loading cached student work...',
    'Fetching official mark scheme...',
    'Re-marking with official rubric...',
    'Updating grade boundaries & annotations...'
];

// Helper to format marking scheme required message for genuine academic subjects
const formatMarkSchemeRequiredMessage = (rawReasonOrSubject: string): string => {
    let subjectName = rawReasonOrSubject.trim();
    const subjectMatch = rawReasonOrSubject.match(/Unsupported subject\s*\(([^)]+)\)/i);
    if (subjectMatch) {
        subjectName = subjectMatch[1].trim();
    }
    if (!subjectName || /^(this subject|other|unknown|none)$/i.test(subjectName)) {
        subjectName = 'this subject';
    }

    return `📋 **Marking Scheme Required (${subjectName}):** AI Marking includes built-in official past paper mark schemes for **GCSE & A-Level Mathematics** and **GCSE English Language**. For **${subjectName}** (and all other subjects), we support full AI grading as soon as you provide the marking scheme!\n\n💡 **Want me to mark this paper right now?** Click **Attach Marking Scheme** below to upload the official or teacher marking scheme (marking scheme pages are free and do not count toward your page limit!).`;
};

export interface MarkingOptions {
    model?: string;
    examType?: string;
    subject?: string;
    level?: string;
    examBoard?: string;
    paper?: string;
    year?: string;
    season?: string;
    questionNumber?: string;
    markingScheme?: string;
    userId?: string;
    sessionId?: string;
    customText?: string;
    allowGenericSubjectMarking?: boolean;
    selectedRawPageIndices?: number[];
}

export function filterPagesBySelectedRawIndices(params: {
    standardizedPages: StandardizedPage[];
    selectedRawPageIndices?: number[];
    files: Express.Multer.File[];
    isExplicitMarkSchemePdfFile: (f: Express.Multer.File) => boolean;
}): { standardizedPages: StandardizedPage[]; isUserSelectedPageChunk: boolean } {
    const { standardizedPages, selectedRawPageIndices, files, isExplicitMarkSchemePdfFile } = params;
    if (!Array.isArray(selectedRawPageIndices) || selectedRawPageIndices.length === 0) {
        return { standardizedPages, isUserSelectedPageChunk: false };
    }
    const selectedSet = new Set(
        selectedRawPageIndices.map(Number).filter(n => Number.isFinite(n))
    );
    if (selectedSet.size === 0) {
        return { standardizedPages, isUserSelectedPageChunk: false };
    }
    const filteredPages = standardizedPages.filter(page => {
        const rawIdx = (page as any)._rawPageIndex ?? page.pageIndex;
        if (selectedSet.has(rawIdx)) return true;
        const srcIdx = (page as any)._sourceIndex ?? (page as any)._fileIndex;
        const sourceFile = typeof srcIdx === 'number' ? files[srcIdx] : undefined;
        return Boolean(sourceFile && isExplicitMarkSchemePdfFile(sourceFile));
    });
    if (filteredPages.length > 0) {
        return { standardizedPages: filteredPages, isUserSelectedPageChunk: true };
    }
    return { standardizedPages, isUserSelectedPageChunk: false };
}

export interface FilePreRasterizationPlan {
    fileIndex: number;
    isDeferredMarkScheme: boolean;
    isExplicitMarkScheme: boolean;
    rawPageCount: number | null;
    globalRawOffset: number | null;
    selectedLocalPageIndices?: number[];
}

export async function buildPreRasterizationPlan(params: {
    files: Express.Multer.File[];
    isExplicitMarkSchemePdfFile: (f: Express.Multer.File) => boolean;
    hasNonSchemeStudentFiles: boolean;
    selectedRawPageIndices?: number[];
    getPdfPageCountFn?: (buf: Buffer) => Promise<number | null>;
}): Promise<{
    plans: FilePreRasterizationPlan[];
    totalKnownRawPages: number;
    hasUnknownPageCount: boolean;
    hasValidSelectedRawPages: boolean;
}> {
    const {
        files,
        isExplicitMarkSchemePdfFile,
        hasNonSchemeStudentFiles,
        selectedRawPageIndices,
        getPdfPageCountFn = PdfProcessingService.getPdfPageCount.bind(PdfProcessingService)
    } = params;

    const plans: FilePreRasterizationPlan[] = await Promise.all(
        files.map(async (file, fileIndex): Promise<FilePreRasterizationPlan> => {
            const isExplicitMarkScheme = isExplicitMarkSchemePdfFile(file);
            const isDeferredMarkScheme = hasNonSchemeStudentFiles && isExplicitMarkScheme;
            let rawPageCount: number | null = 0;

            if (isDeferredMarkScheme) {
                rawPageCount = 0;
            } else if (file?.mimetype === 'application/pdf') {
                rawPageCount = await getPdfPageCountFn(file.buffer);
            } else if (file?.mimetype?.startsWith('image/')) {
                rawPageCount = 1;
            }

            return {
                fileIndex,
                isDeferredMarkScheme,
                isExplicitMarkScheme,
                rawPageCount,
                globalRawOffset: null
            };
        })
    );

    let runningOffset = 0;
    let offsetUnknown = false;
    for (const plan of plans) {
        if (plan.isDeferredMarkScheme || plan.rawPageCount === 0) {
            plan.globalRawOffset = offsetUnknown ? null : runningOffset;
        } else if (plan.rawPageCount === null) {
            plan.globalRawOffset = null;
            offsetUnknown = true;
        } else {
            plan.globalRawOffset = offsetUnknown ? null : runningOffset;
            if (!offsetUnknown) {
                runningOffset += plan.rawPageCount;
            }
        }
    }

    const totalKnownRawPages = plans.reduce((sum, p) => sum + (p.rawPageCount ?? 0), 0);
    const hasUnknownPageCount = plans.some(p => p.rawPageCount === null);

    let hasValidSelectedRawPages = false;
    if (!hasUnknownPageCount && Array.isArray(selectedRawPageIndices) && selectedRawPageIndices.length > 0) {
        const selectedSet = new Set(
            selectedRawPageIndices.map(Number).filter(n => Number.isInteger(n) && n >= 0)
        );
        hasValidSelectedRawPages = Array.from(selectedSet).some(idx => idx < totalKnownRawPages);

        if (hasValidSelectedRawPages) {
            for (const plan of plans) {
                if (plan.isDeferredMarkScheme || plan.rawPageCount === 0 || plan.isExplicitMarkScheme) {
                    continue;
                }
                if (plan.globalRawOffset !== null && plan.rawPageCount !== null) {
                    const localIndices: number[] = [];
                    for (let localIdx = 0; localIdx < plan.rawPageCount; localIdx++) {
                        if (selectedSet.has(plan.globalRawOffset + localIdx)) {
                            localIndices.push(localIdx);
                        }
                    }
                    plan.selectedLocalPageIndices = localIndices;
                }
            }
        }
    }

    return {
        plans,
        totalKnownRawPages,
        hasUnknownPageCount,
        hasValidSelectedRawPages
    };
}

export function assertNoEarlyMultiCoverPdf(params: {
    standardizedPages: StandardizedPage[];
    geometryResults: any[];
}): void {
    const { standardizedPages, geometryResults } = params;
    const isPdfPage = (p: StandardizedPage) =>
        /\.pdf$/i.test(p.originalFileName || '') && (p as any)._sourceIndex !== undefined;
    const studentPdfSourceIndices = new Set(
        standardizedPages.filter(isPdfPage).map(p => Number((p as any)._sourceIndex))
    );
    const isSingleStudentPdf =
        studentPdfSourceIndices.size === 1 &&
        standardizedPages.length > 0 &&
        standardizedPages.every(isPdfPage);

    const coverIndices: number[] = [];
    (geometryResults || []).forEach((g, idx) => {
        if (g?.is_cover_page && !g?.is_marking_scheme) {
            coverIndices.push(idx);
        }
    });

    if (
        isSingleStudentPdf &&
        coverIndices.length >= 2 &&
        (coverIndices[coverIndices.length - 1] - coverIndices[0]) >= 3
    ) {
        const fileName = standardizedPages[0]?.originalFileName;
        throw new UserFacingError({
            code: 'COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED',
            category: 'user_fixable',
            shouldAlertAdmin: false,
            userMessage:
                `This PDF${fileName ? ` ("${fileName}")` : ''} appears to contain **multiple exam papers combined into a single file** (${coverIndices.length} separate exam cover pages detected).\n\n` +
                `**How to fix:** Please upload **each exam paper as a separate PDF file** (e.g. Paper 1 PDF, Paper 2 PDF, Paper 3 PDF) so they can be graded accurately in parallel.`,
            technicalMessage: `Combined multi-paper PDF rejected before page gating: ${coverIndices.length} cover pages detected at indices [${coverIndices.join(', ')}].`
        });
    }
}

export function buildDetectedPaperGroupsHelper(params: {
    paperBuckets: PaperBucket[];
    studentRawPageCount: number;
    maxFreePages: number;
    files: Express.Multer.File[];
    interceptedSchemeMeta: InterceptedSchemeImageMeta[];
    computeSubjectVote: (geos: any[]) => string | undefined;
}): DetectedPaperGroup[] | undefined {
    const {
        paperBuckets,
        studentRawPageCount,
        maxFreePages,
        files,
        interceptedSchemeMeta,
        computeSubjectVote
    } = params;

    const formatPrettySubject = (subj: string | undefined, geos: any[]): string | undefined => {
        if (!subj) return undefined;
        if (subj === 'ENGLISH_LANGUAGE') return 'English Language';
        if (subj === 'ENGLISH_LITERATURE') return 'English Literature';
        if (subj === 'MATHS') return 'Mathematics';
        return geos.find((g: any) => g?.unsupported_subject_name)?.unsupported_subject_name || subj;
    };

    const ejectedSchemeRawPageIndices = Array.from(
        new Set(
            interceptedSchemeMeta
                .map(m => m.rawPageIndex)
                .filter((idx): idx is number => typeof idx === 'number' && Number.isFinite(idx))
        )
    ).sort((a, b) => a - b);

    const ejectedSchemeFileIndices = Array.from(
        new Set(
            interceptedSchemeMeta
                .map(m => m.sourceIndex)
                .filter((idx): idx is number => typeof idx === 'number' && Number.isFinite(idx))
        )
    ).sort((a, b) => a - b);

    if (paperBuckets.length === 1 && studentRawPageCount > maxFreePages) {
        const CHUNK_SIZE = 25;
        const b = paperBuckets[0];
        const studentRawIndices = Array.from(
            new Set(b.standardizedPages.map(p => (p as any)._rawPageIndex ?? p.pageIndex))
        ).sort((a, c) => a - c);
        const schemeFileIndices = (b.deferredSchemePdfFiles || [])
            .map(msFile => files.indexOf(msFile))
            .filter(i => i >= 0);
        const allFileIndices = Array.from(
            new Set([
                ...b.standardizedPages.map(
                    p => (p as any)._fileIndex ?? (p as any)._sourceIndex ?? (p as any)._rawPageIndex ?? p.pageIndex
                ),
                ...schemeFileIndices,
                ...ejectedSchemeFileIndices
            ])
        ).sort((a, c) => a - c);
        const subj = computeSubjectVote(b.geometryResults) || b.subjectHint;
        const prettySubj = formatPrettySubject(subj, b.geometryResults);
        const markSchemeCount =
            (b.deferredSchemePdfFiles?.length || 0) +
            ((b.interceptedSchemeImages?.length || 0) > 0 ? 1 : 0);

        const chunks: DetectedPaperGroup[] = [];
        for (let start = 0; start < studentRawIndices.length; start += CHUNK_SIZE) {
            const slice = studentRawIndices.slice(start, start + CHUNK_SIZE);
            const combinedRawIndices = Array.from(
                new Set([...slice, ...ejectedSchemeRawPageIndices])
            ).sort((a, c) => a - c);
            chunks.push({
                paperIndex: chunks.length,
                label: `Pages ${start + 1}–${start + slice.length}`,
                subject: prettySubj,
                pageCount: slice.length,
                fileIndices: allFileIndices,
                rawPageIndices: combinedRawIndices,
                canGradeOnFree: slice.length <= maxFreePages,
                hasMarkScheme: markSchemeCount > 0,
                markSchemeCount,
                isPageChunk: true
            });
        }
        return chunks.length > 1 ? chunks : undefined;
    }

    if (paperBuckets.length <= 1) return undefined;

    return paperBuckets.map((b, idx) => {
        const rawPageIndices = Array.from(
            new Set(b.standardizedPages.map(p => (p as any)._rawPageIndex ?? p.pageIndex))
        ).sort((a, c) => a - c);
        const schemeFileIndices = (b.deferredSchemePdfFiles || [])
            .map(msFile => files.indexOf(msFile))
            .filter(i => i >= 0);
        const fileIndices = Array.from(
            new Set([
                ...b.standardizedPages.map(
                    p => (p as any)._fileIndex ?? (p as any)._sourceIndex ?? (p as any)._rawPageIndex ?? p.pageIndex
                ),
                ...schemeFileIndices,
                ...(ejectedSchemeFileIndices.length === 1 ? ejectedSchemeFileIndices : [])
            ])
        ).sort((a, c) => a - c);
        const subj = computeSubjectVote(b.geometryResults) || b.subjectHint;
        const prettySubj = formatPrettySubject(subj, b.geometryResults);
        const markSchemeCount =
            (b.deferredSchemePdfFiles?.length || 0) +
            ((b.interceptedSchemeImages?.length || 0) > 0 ? 1 : 0);
        return {
            paperIndex: idx,
            label: b.paperLabel,
            subject: prettySubj,
            pageCount: rawPageIndices.length,
            fileIndices,
            rawPageIndices,
            canGradeOnFree: rawPageIndices.length <= maxFreePages,
            hasMarkScheme: markSchemeCount > 0,
            markSchemeCount
        };
    });
}

export function buildFreePageLimitExceededMessage(params: {
    studentRawPageCount: number;
    maxFreePages: number;
    detectedPaperGroups?: DetectedPaperGroup[];
}): string {
    const { studentRawPageCount, maxFreePages, detectedPaperGroups } = params;
    const isChunkedWorkbook = Boolean(detectedPaperGroups?.some(g => g.isPageChunk));
    const hasGroups = Boolean(detectedPaperGroups && detectedPaperGroups.length > 1);
    const paperBreakdownMd = hasGroups
        ? (isChunkedWorkbook
            ? `\n\nWe split your **${studentRawPageCount}-page** upload into **${detectedPaperGroups!.length} sections** (up to 25 pages each):\n`
            : `\n\nWe detected **${detectedPaperGroups!.length} papers** in your upload:\n`) +
          detectedPaperGroups!.map(g => `- **${g.label}:** ${g.pageCount} pages${g.hasMarkScheme ? ' (+ Mark Scheme)' : ''}`).join('\n')
        : '';
    const actionStepsMd = hasGroups
        ? (isChunkedWorkbook
            ? `**How to continue (no re-upload needed):**\n` +
              `1. **Grade 1 section now for free:** Select a page range below to mark it immediately without uploading again.\n` +
              `2. **Grade all ${studentRawPageCount} pages together:** Upgrade to Pro to unlock unlimited page limits.`
            : `**How to continue (no re-upload needed):**\n` +
              `1. **Grade 1 paper now for free:** Select a paper below to mark it immediately without uploading again.\n` +
              `2. **Grade all ${detectedPaperGroups!.length} papers together:** Upgrade to Pro to unlock unlimited page limits and multi-paper marking.`)
        : `**How to continue:**\n` +
          `1. **Grade for free (1 paper at a time):** Upload 1 paper per submission (up to ${maxFreePages} pages each).\n` +
          `2. **Grade multiple papers together:** Upgrade to Pro to unlock unlimited page limits and multi-paper marking.`;

    return (
        `You uploaded **${studentRawPageCount} pages**, which exceeds the **${maxFreePages}-page limit** per submission on the Free plan.${paperBreakdownMd}\n\n` +
        actionStepsMd
    );
}

export function buildOverdraftLimitExceededMessage(params: {
    studentRawPageCount: number;
    creditsNeeded: number;
    remainingCredits: number;
    detectedPaperGroups?: DetectedPaperGroup[];
}): string {
    const { studentRawPageCount, creditsNeeded, remainingCredits, detectedPaperGroups } = params;
    const isChunkedWorkbook = Boolean(detectedPaperGroups?.some(g => g.isPageChunk));
    const hasGroups = Boolean(detectedPaperGroups && detectedPaperGroups.length > 1);
    const paperBreakdownMd = hasGroups
        ? (isChunkedWorkbook
            ? `\n\nWe split your **${studentRawPageCount}-page** upload into **${detectedPaperGroups!.length} sections** (up to 25 pages each):\n`
            : `\n\nWe detected **${detectedPaperGroups!.length} papers** in your upload:\n`) +
          detectedPaperGroups!.map(g => `- **${g.label}:** ${g.pageCount} pages${g.hasMarkScheme ? ' (+ Mark Scheme)' : ''}`).join('\n')
        : '';
    const continueActionMd = isChunkedWorkbook
        ? `**How to continue:** Select **1 section** below to mark now without re-uploading, or top up / upgrade your plan to mark all ${studentRawPageCount} pages together.`
        : `**How to continue:** Select **1 paper** below to mark now without re-uploading, or top up / upgrade your plan to mark all papers together.`;

    return (
        `This upload (${studentRawPageCount} student pages, estimated **${creditsNeeded} credits**) exceeds your remaining balance (**${remainingCredits.toFixed(0)} credits**) and the 100-credit overdraft safety limit.${paperBreakdownMd}\n\n` +
        continueActionMd
    );
}

export function buildRawCombinedPageLimitError(
    totalRawPages: number,
    maxRawCombinedPages = 100
): UserFacingError {
    return new UserFacingError({
        code: 'PDF_PAGE_LIMIT_EXCEEDED',
        category: 'user_fixable',
        shouldAlertAdmin: false,
        requiresUpgrade: false,
        userMessage:
            `You uploaded **${totalRawPages} pages**, which exceeds the maximum limit of **${maxRawCombinedPages} pages/images** per submission.\n\n` +
            `**How to fix:**\n` +
            `1. Please upload **1 paper at a time** (a single unique exam paper with unique question numbers, up to ${maxRawCombinedPages} total pages including any mark scheme).\n` +
            `2. If your PDF is a combined booklet or workbook, split it into individual papers or smaller page ranges before uploading.`,
        technicalMessage: `Upload exceeds the maximum limit of ${maxRawCombinedPages} pages/images (uploaded ${totalRawPages} pages).`
    });
}

export class MarkingPipelineService {

    static async executePipeline(
        req: Request,
        files: Express.Multer.File[],
        submissionId: string,
        options: MarkingOptions,
        progressCallback: (data: any) => void,
        usageTracker: UsageTracker
    ): Promise<any> {
        // --- Basic Setup ---
        // submissionId is passed in
        const startTime = Date.now();

        // Reset debug log flag for new marking session
        MarkingInstructionService.resetDebugLog();

        // Performance tracking variables
        let stepTimings: { [key: string]: { start: number; duration?: number; subSteps?: { [key: string]: number } } } = {};
        let totalLLMTokens = 0;
        let actualModel = 'auto'; // Will be updated when model is determined
        let questionOnlyResult: any = null; // Hoisted for scope access in fallback blocks

        // Performance tracking function
        const logStep = (stepName: string, modelInfo: string) => {
            const stepKey = stepName.toLowerCase().replace(/\s+/g, '_');
            stepTimings[stepKey] = { start: Date.now() };

            return () => {
                if (stepTimings[stepKey]) {
                    stepTimings[stepKey].duration = Date.now() - stepTimings[stepKey].start;
                    const green = '\x1b[32m';
                    const bold = '\x1b[1m';
                    const reset = '\x1b[0m';
                    const duration = stepTimings[stepKey].duration;
                    const durationSec = (duration / 1000).toFixed(1);
                    const stepNameUpper = stepName.toUpperCase();
                    const modelInfoUpper = modelInfo.toUpperCase();
                    console.log(`${bold}${green}✅ [${stepNameUpper}]${reset} ${bold}COMPLETED${reset} in ${bold}${durationSec}s${reset} (${green}${bold}${modelInfoUpper}${reset})`);
                }
            };
        };

        console.log(`\n🔄 ========== UNIFIED PIPELINE START ==========`);
        console.log(`🔄 ============================================\n`);

        // Send initial message
        progressCallback(createProgressData(0, 'Processing started', MULTI_IMAGE_STEPS));

        try {
            // Determine authentication status early
            const userId = options.userId || null;
            const isAuthenticated = !!userId;

            // Extract options
            let model = options.model || 'auto';
            const examType = options.examType || 'GCE';
            const subject = options.subject || 'Mathematics';
            const level = options.level || 'A Level';
            const examBoard = options.examBoard || 'Edexcel';
            const paper = options.paper || '1';
            const year = options.year || '2023';
            const season = options.season || 'June';
            const inputQuestionNumber = options.questionNumber;
            let inputMarkingScheme = options.markingScheme;

            // Determine selected tier (preserves 'fast' | 'thinking' | 'pro')
            const selectedTier = (options.model && options.model !== 'auto') ? options.model : getDefaultModel();
            actualModel = selectedTier;

            const debugClassification = process.env.DEBUG_RAW_CLASSIFICATION_RESPONSE === 'true';

            // Input Validation
            const logValidation = logStep('Input Validation', 'Validation');
            if (!files || files.length === 0) {
                throw new Error('No files uploaded.');
            }
            logValidation();

            // Sanitize and detect actual file types from binary magic bytes (protects against misnamed uploads / canvas exports)
            files.forEach(file => {
                if (file.buffer && file.buffer.length >= 4) {
                    const buf = file.buffer;
                    const pdfIdx = buf.indexOf('%PDF-');
                    const isRealPdf = pdfIdx >= 0 && pdfIdx < 2048;
                    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
                    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
                    const isWebp = buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';

                    if (isRealPdf && file.mimetype !== 'application/pdf') {
                        console.log(`🧼 [MIME-REPAIR] Corrected "${file.originalname}" to application/pdf based on %PDF- header.`);
                        file.mimetype = 'application/pdf';
                    } else if (file.mimetype === 'application/pdf' && !isRealPdf) {
                        if (isJpeg) {
                            console.warn(`🧼 [MIME-REPAIR] File "${file.originalname}" declared as PDF but buffer is JPEG. Correcting to image/jpeg.`);
                            file.mimetype = 'image/jpeg';
                        } else if (isPng) {
                            console.warn(`🧼 [MIME-REPAIR] File "${file.originalname}" declared as PDF but buffer is PNG. Correcting to image/png.`);
                            file.mimetype = 'image/png';
                        } else if (isWebp) {
                            console.warn(`🧼 [MIME-REPAIR] File "${file.originalname}" declared as PDF but buffer is WebP. Correcting to image/webp.`);
                            file.mimetype = 'image/webp';
                        }
                    }
                }
            });

            // Determine Input Type
            const firstMime = files[0].mimetype;
            const isPdf = files.length === 1 && firstMime === 'application/pdf';
            const isMultiplePdfs = files.length > 1 && files.every(f => f.mimetype === 'application/pdf');
            const isSingleImage = files.length === 1 && !isPdf && firstMime.startsWith('image/');
            const isMultipleImages = files.length > 1 && files.every(f => f.mimetype?.startsWith('image/'));
            const isMixedUpload = files.length > 1 && !isMultiplePdfs && !isMultipleImages && files.every(f =>
                f.mimetype === 'application/pdf' || f.mimetype?.startsWith('image/')
            );

            const inputType = isPdf
                ? 'PDF'
                : isMultiplePdfs
                    ? 'Multiple PDFs'
                    : isSingleImage
                        ? 'Single Image'
                        : isMultipleImages
                            ? 'Multiple Images'
                            : isMixedUpload
                                ? 'Mixed (Images + PDFs)'
                                : 'Unknown';
            console.log(`[INPUT TYPE] Detected: ${inputType} (${files.length} files)`);

            // --- Hoisted Page Limits (shared DRY rule via PreFlightRules.ts) ---
            const pageLimits = resolvePageLimits(userId, (req as any).userPlan);
            const {
                userPlan,
                isFreeUser,
                isProOrUltra,
                maxPagesLimit: MAX_PAGES_LIMIT,
                maxFreePages: MAX_FREE_PAGES,
                maxRawCombinedPages: MAX_RAW_COMBINED_PAGES,
                effectiveMaxPages,
            } = pageLimits;
            const buildRawCombinedLimitError = (totalRawPages: number) =>
                buildRawCombinedPageLimitError(totalRawPages, MAX_RAW_COMBINED_PAGES);
            const pdfMaxPagesOption = isProOrUltra ? undefined : MAX_RAW_COMBINED_PAGES;
            const getPageLimitErrorMessage = (count?: number) =>
                buildRawCombinedLimitError(count || MAX_RAW_COMBINED_PAGES + 1).userMessage;

            const preFlightBucket = (options as any)?._preFlightPaperBucket;

            // --- Fast Pre-Rasterization Credit Balance Gate (10ms fail-fast if balance <= 0) ---
            if (!preFlightBucket && userId && userId !== 'anonymous') {
                const preFlightCreditCheck = await checkCredits(userId, 0.020, userPlan);
                if (!preFlightCreditCheck.canProceed) {
                    throw new Error(preFlightCreditCheck.warning);
                }
            }

            // --- Declare variables at proper scope ---
            let standardizedPages: StandardizedPage[] = [];
            let lightweightPages: StandardizedPage[] = [];
            let geometryResults: any[] = [];
            let interceptedSchemeImages: string[] = [];
            const interceptedSchemeMeta: InterceptedSchemeImageMeta[] = [];
            let isUserSelectedPageChunk = false;
            let pagesEjected = false;
            let preUploadedOriginalFilesPromise: Promise<any> | undefined = undefined;
            let allPagesOcrData: PageOcrResult[] = [];
            let markingTasks: MarkingTask[] = [];
            let pdfContext: any = null;
            let pageDimensionsMap = new Map<number, { width: number; height: number }>();
            const earlyMarkingScope = parseMarkingScope(options.customText);
            let earlyPrunedPdfMarkingScope: ReturnType<typeof parseMarkingScope> = null;
            const sseThumbnailCache = new Map<number, string>();
            const MARK_SCHEME_FILENAME_REGEX = /(^|[-_\s.])(rms|ms|mark[-_\s]?scheme|marking[-_\s]?scheme)([-_\s.]|$)/i;
            // Zero-API-cost PDF page 1-2 text peek via Ghostscript (~15-40ms in parallel)
            // Classifies digital mark schemes by actual PDF content rather than filename alone.
            const pdfHeaderPeekMap = new Map<Express.Multer.File, Awaited<ReturnType<typeof PdfProcessingService.peekPdfMarkSchemeMetadata>>>();
            if (!preFlightBucket && Array.isArray(files) && files.length > 0) {
                await Promise.all(
                    files
                        .filter(f => f?.mimetype === 'application/pdf' && f?.buffer)
                        .map(async (f) => {
                            const peek = await PdfProcessingService.peekPdfMarkSchemeMetadata(f.buffer);
                            pdfHeaderPeekMap.set(f, peek);
                            if (peek.headerText) {
                                (f as any)._pdfHeaderText = peek.headerText;
                            }
                        })
                );
            }
            const isExplicitMarkSchemePdfFile = (f: Express.Multer.File) => {
                if (f?.mimetype !== 'application/pdf') return false;
                const peek = pdfHeaderPeekMap.get(f);
                if (peek?.hasTextLayer) {
                    return peek.isDigitalMarkScheme;
                }
                // Scanned PDF with no text layer: fall back to filename pattern
                return MARK_SCHEME_FILENAME_REGEX.test((f.originalname || '').replace(/\.pdf$/i, ''));
            };
            const hasNonSchemeStudentFiles = files.some(f => !isExplicitMarkSchemePdfFile(f));
            const deferredSchemePdfFiles: Express.Multer.File[] = [];

            if (preFlightBucket) {
                standardizedPages = preFlightBucket.standardizedPages || [];
                lightweightPages = preFlightBucket.lightweightPages || [];
                geometryResults = preFlightBucket.geometryResults || [];
                interceptedSchemeImages = preFlightBucket.interceptedSchemeImages || [];
                if (Array.isArray(preFlightBucket.deferredSchemePdfFiles)) {
                    deferredSchemePdfFiles.push(...preFlightBucket.deferredSchemePdfFiles);
                }
                pagesEjected = interceptedSchemeImages.length > 0 || deferredSchemePdfFiles.length > 0;
            } else {
            // --- Conditional Routing (PDF first) ---
            if (isPdf || isMultiplePdfs) {
                // --- Multi-File / PDF Path ---
                progressCallback(createProgressData(1, `Preparing ${inputType} processing...`, MULTI_IMAGE_STEPS));

                // Stage 1: Standardization
                const preRasterPlan = await buildPreRasterizationPlan({
                    files,
                    isExplicitMarkSchemePdfFile,
                    hasNonSchemeStudentFiles,
                    selectedRawPageIndices: options.selectedRawPageIndices
                });

                if (isPdf) {
                    const filePlan = preRasterPlan.plans[0];
                    let effectiveSelectedPageIndices: number[] | undefined = filePlan?.selectedLocalPageIndices?.length
                        ? filePlan.selectedLocalPageIndices
                        : undefined;

                    // Early page-range pruning for single PDF uploads when user explicitly requests physical page range (e.g. "mark page 1 to 3")
                    if (
                        !effectiveSelectedPageIndices &&
                        earlyMarkingScope?.type === 'pages' &&
                        earlyMarkingScope.minPage !== undefined &&
                        earlyMarkingScope.maxPage !== undefined
                    ) {
                        const maxKnownPages = preRasterPlan.totalKnownRawPages || earlyMarkingScope.maxPage;
                        const clampedStart = Math.max(1, earlyMarkingScope.minPage);
                        const clampedEnd = Math.min(earlyMarkingScope.maxPage, maxKnownPages);
                        if (clampedStart <= clampedEnd && clampedEnd < maxKnownPages) {
                            const indices: number[] = [];
                            const includeCoverForMetadata = clampedStart > 1;
                            if (includeCoverForMetadata) {
                                indices.push(0); // Preserve cover page (index 0) for exam paper code detection
                            }
                            for (let p = clampedStart; p <= clampedEnd; p++) {
                                indices.push(p - 1);
                            }
                            effectiveSelectedPageIndices = indices;
                            earlyPrunedPdfMarkingScope = includeCoverForMetadata
                                ? {
                                    ...earlyMarkingScope,
                                    minPage: 2,
                                    maxPage: indices.length
                                }
                                : earlyMarkingScope;
                            console.log(`✂️ [EARLY-PDF-SCOPE] Pruning single PDF rasterization to ${indices.length}/${maxKnownPages} page(s) for scope "${earlyMarkingScope.label}" (0-based indices: ${indices.join(', ')}).`);
                        }
                    }

                    const effectivePreRasterRawPages = effectiveSelectedPageIndices
                        ? effectiveSelectedPageIndices.length
                        : preRasterPlan.hasValidSelectedRawPages
                            ? preRasterPlan.plans.reduce((sum, p) => sum + (p.selectedLocalPageIndices?.length ?? 0), 0)
                            : preRasterPlan.totalKnownRawPages;
                    if (!isProOrUltra && effectivePreRasterRawPages > MAX_RAW_COMBINED_PAGES) {
                        throw buildRawCombinedLimitError(effectivePreRasterRawPages);
                    }
                    const expectedThumbnailCount = Math.min(
                        25,
                        earlyPrunedPdfMarkingScope?.type === 'pages' && (earlyPrunedPdfMarkingScope.minPage ?? 1) > 1
                            ? Math.max(1, effectivePreRasterRawPages - 1)
                            : effectivePreRasterRawPages
                    );
                    progressCallback({
                        ...createProgressData(1, 'Converting PDF...', MULTI_IMAGE_STEPS),
                        ...(expectedThumbnailCount > 0 ? { expectedThumbnailCount } : {})
                    } as any);
                    const pdfBuffer = files[0].buffer;
                    const originalFileName = files[0].originalname || 'document.pdf';
                    const hasSelectedPages = Boolean(effectiveSelectedPageIndices?.length);
                    stepTimings['pdf_conversion'] = { start: Date.now() };

                    // Use pdfMaxPagesOption so Pro/Ultra have no limit and Free combined Question + Mark Scheme PDFs can exempt MS pages in Stage 2
                    standardizedPages = await PdfProcessingService.convertPdfToImages(pdfBuffer, {
                        ...(hasSelectedPages ? {} : { maxPages: pdfMaxPagesOption, maxPagesErrorMessage: getPageLimitErrorMessage }),
                        ...(hasSelectedPages ? { selectedPageIndices: effectiveSelectedPageIndices } : {})
                    });

                    // Enforce Raw Combined Page Limit before Stage 2 mark-scheme exemption
                    if (standardizedPages.length > MAX_RAW_COMBINED_PAGES) {
                        throw buildRawCombinedLimitError(standardizedPages.length);
                    }
                    // Set originalFileName, _sourceIndex, and preserve global _rawPageIndex
                    standardizedPages.forEach((page, idx) => {
                        page.originalFileName = originalFileName;
                        (page as any)._sourceIndex = 0;
                        (page as any)._rawPageIndex = effectiveSelectedPageIndices
                            ? effectiveSelectedPageIndices[idx]
                            : (filePlan?.globalRawOffset ?? 0) + page.pageIndex;
                        page.pageIndex = idx;
                    });

                    if (stepTimings['pdf_conversion']) {
                        stepTimings['pdf_conversion'].duration = Date.now() - stepTimings['pdf_conversion'].start;
                    }
                    if (standardizedPages.length === 0) throw new Error('PDF conversion yielded no pages.');
                    progressCallback(createProgressData(1, `Converted PDF to ${standardizedPages.length} pages.`, MULTI_IMAGE_STEPS));
                } else if (isMultiplePdfs) {
                    // Fast pre-rasterization combined page-count gate for multi-PDF uploads
                    const effectivePreRasterRawPages = preRasterPlan.hasValidSelectedRawPages
                        ? preRasterPlan.plans.reduce((sum, p) => sum + (p.selectedLocalPageIndices?.length ?? 0), 0)
                        : preRasterPlan.totalKnownRawPages;
                    if (!isProOrUltra && effectivePreRasterRawPages > MAX_RAW_COMBINED_PAGES) {
                        throw buildRawCombinedLimitError(effectivePreRasterRawPages);
                    }

                    // Multiple PDFs processing
                    const expectedMultiPdfThumbnailCount = Math.min(
                        25,
                        files.reduce((sum, file, idx) => {
                            if (hasNonSchemeStudentFiles && isExplicitMarkSchemePdfFile(file)) return sum;
                            const plan = preRasterPlan.plans[idx];
                            const pages = preRasterPlan.hasValidSelectedRawPages
                                ? (plan?.selectedLocalPageIndices?.length ?? 0)
                                : (plan?.rawPageCount ?? 0);
                            return sum + pages;
                        }, 0)
                    );
                    progressCallback({
                        ...createProgressData(1, `Converting ${files.length} PDFs in parallel...`, MULTI_IMAGE_STEPS),
                        ...(expectedMultiPdfThumbnailCount > 0 ? { expectedThumbnailCount: expectedMultiPdfThumbnailCount } : {})
                    } as any);
                    stepTimings['pdf_conversion'] = { start: Date.now() };

                    const pdfConversionPromises = files.map(async (file, index) => {
                        if (hasNonSchemeStudentFiles && isExplicitMarkSchemePdfFile(file)) {
                            deferredSchemePdfFiles.push(file);
                            console.log(`⏭️  [DEFERRED-MS-PDF] Holding Mark Scheme PDF "${file.originalname}" off Stage 1 rasterization until DB pre-check.`);
                            return { index, pdfPages: [] };
                        }
                        const filePlan = preRasterPlan.plans[index];
                        if (Array.isArray(filePlan?.selectedLocalPageIndices) && filePlan.selectedLocalPageIndices.length === 0) {
                            console.log(`⏭️  [PAGE-CHUNK] Skipping PDF ${index + 1} (${file.originalname}) before rasterization — 0 pages in selectedRawPageIndices.`);
                            return { index, pdfPages: [] };
                        }
                        try {
                            const hasSelectedPages = Boolean(filePlan?.selectedLocalPageIndices?.length);
                            const pdfPages = await PdfProcessingService.convertPdfToImages(file.buffer, {
                                ...(hasSelectedPages ? {} : { maxPages: pdfMaxPagesOption, maxPagesErrorMessage: getPageLimitErrorMessage }),
                                ...(hasSelectedPages ? { selectedPageIndices: filePlan!.selectedLocalPageIndices } : {})
                            });
                            if (pdfPages.length === 0) {
                                console.warn(`PDF ${index + 1} (${file.originalname}) yielded no pages.`);
                                return { index, pdfPages: [] };
                            }

                            // Enforce Raw Combined Page Limit per PDF
                            if (pdfPages.length > MAX_RAW_COMBINED_PAGES) {
                                throw buildRawCombinedLimitError(pdfPages.length);
                            }

                            // Store original index and preserve global _rawPageIndex before sequential re-indexing
                            pdfPages.forEach((page) => {
                                page.originalFileName = file.originalname || `pdf-${index + 1}.pdf`;
                                (page as any)._sourceIndex = index;
                                if (filePlan?.globalRawOffset !== null && filePlan?.globalRawOffset !== undefined) {
                                    (page as any)._rawPageIndex = filePlan.globalRawOffset + page.pageIndex;
                                }
                            });

                            return { index, pdfPages };
                        } catch (error: any) {
                            console.error(`❌ Failed to convert PDF ${index + 1} (${file.originalname}):`, error);
                            
                            // 🛡️ LET CUSTOM UNREADABLE / USER-FACING ERRORS BUBBLE UP TO THE CONTROLLER
                            if (error instanceof UserFacingError || error.message?.includes('PDF_UNREADABLE') || error.message?.includes('limited to grading') || error.message?.includes('exceeds the maximum limit')) {
                                throw error;
                            }
                            
                            // 🚨 Fallback for generic size/complexity failures
                            throw new Error(`Failed to process document "${file.originalname}". The file may be too large or complex. Please try uploading it in smaller batches.`);
                        }
                    });

                    const results = await Promise.all(pdfConversionPromises);

                    // Combine results and maintain sequential page indices
                    const allPdfPages: StandardizedPage[] = [];
                    results.forEach((result: any) => {
                        if (result && result.pdfPages && result.pdfPages.length > 0) {
                            result.pdfPages.forEach((page: any) => {
                                page.pageIndex = allPdfPages.length;
                                allPdfPages.push(page);
                            });
                        }
                    });

                    if (stepTimings['pdf_conversion']) {
                        stepTimings['pdf_conversion'].duration = Date.now() - stepTimings['pdf_conversion'].start;
                    }

                    standardizedPages = allPdfPages;

                    // Enforce Raw Combined Ceiling for Multiple PDFs (Mark Scheme pages are exempted after Stage 2 Geometry)
                    if (standardizedPages.length > MAX_RAW_COMBINED_PAGES) {
                        throw buildRawCombinedLimitError(standardizedPages.length);
                    }

                    if (standardizedPages.length === 0) throw new Error('All PDF conversions yielded no pages.');
                    progressCallback(createProgressData(1, `Converted ${files.length} PDFs to ${standardizedPages.length} total pages.`, MULTI_IMAGE_STEPS));
                }

                // Dimension extraction after conversion (reliable via sharp on buffers)
                progressCallback(createProgressData(1, `Extracting dimensions for ${standardizedPages.length} converted page(s)...`, MULTI_IMAGE_STEPS));
                try {
                    await Promise.all(standardizedPages.map(async (page, i) => {
                        if (page.width && page.height) return; // Already populated by PdfProcessingService
                        const base64Data = page.imageData.split(',')[1];
                        if (!base64Data) {
                            console.warn(`[DIMENSIONS - PDF Path] Invalid base64 data for page ${i}, skipping.`);
                            page.width = 0; page.height = 0; return;
                        }
                        const imageBuffer = Buffer.from(base64Data, 'base64');
                        const metadata = await sharp(imageBuffer).metadata();
                        if (!metadata.width || !metadata.height) {
                            console.warn(`[DIMENSIONS - PDF Path] Sharp failed to get valid dimensions for page ${i}.`);
                        }
                        page.width = metadata.width || 0;
                        page.height = metadata.height || 0;
                    }));
                    progressCallback(createProgressData(1, 'Dimension extraction complete.', MULTI_IMAGE_STEPS));
                } catch (dimensionError) {
                    console.error('❌ Error during PDF dimension extraction:', dimensionError);
                    throw new Error(`Failed during PDF dimension extraction: ${dimensionError instanceof Error ? dimensionError.message : 'Unknown error'}`);
                }

                // Handle PDF upload and context setup
                if (isPdf && !isMultiplePdfs) {
                    // Single PDF (single-page or multi-page) - set pdfContext
                    const pageCount = standardizedPages.length;
                    progressCallback(createProgressData(2, pageCount === 1 ? 'Processing as single converted page...' : 'Processing multi-page PDF...', MULTI_IMAGE_STEPS));

                    // Defer original PDF upload to background (preUploadedOriginalFilesPromise) so Stage 1 doesn't block 2-5s
                    const originalPdfLink = null;
                    const originalPdfDataUrl = null;

                    // Calculate file size for single PDF
                    const fileSizeBytes = files[0].buffer.length;
                    const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

                    // Store PDF context for later use in the unified pipeline (originalPdfLink is back-filled by background upload)
                    pdfContext = {
                        originalFileType: 'pdf' as const,
                        originalPdfLink,
                        originalPdfDataUrl,
                        originalFileName: files[0].originalname || 'document.pdf',
                        fileSize: fileSizeBytes,
                        fileSizeMB: fileSizeMB + ' MB'
                    };
                } else if (isMultiplePdfs) {
                    // Multiple PDFs - store all PDFs for later use (uploads deferred to background preUploadedOriginalFilesPromise)
                    progressCallback(createProgressData(2, 'Processing multiple PDFs...', MULTI_IMAGE_STEPS));

                    const pdfContexts: any[] = [];

                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        const originalPdfLink = null;
                        // Always create base64 URL for immediate display
                        const originalPdfDataUrl = `data:application/pdf;base64,${file.buffer.toString('base64')}`;

                        // Calculate file size
                        const fileSizeBytes = file.buffer.length;
                        const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

                        const pdfContextItem = {
                            originalFileType: 'pdf' as const,
                            originalPdfLink,
                            originalPdfDataUrl,
                            originalFileName: file.originalname || `document-${i + 1}.pdf`,
                            fileSize: fileSizeBytes, // Store as bytes (number) to match simplified structure
                            fileSizeMB: fileSizeMB + ' MB', // Keep for display if needed
                            fileIndex: i
                        };

                        pdfContexts.push(pdfContextItem);
                    }

                    // Store multiple PDF contexts for later use in the unified pipeline
                    pdfContext = {
                        isMultiplePdfs: true,
                        pdfContexts
                    };
                }

                // Multi-page PDF or Multiple PDFs – Continue to common processing logic

                // One-line dimension logs per page
                standardizedPages.forEach((p: any) => {
                    const ratio = p.height ? (p.width / p.height).toFixed(3) : '0.000';
                });

                // Fallback warning if any page still lacks dimensions
                standardizedPages.forEach((p: any, i: number) => {
                    if (!p.width || !p.height) {
                        console.warn(`[DIMENSIONS] Dimensions for page ${i} not set during standardization. Extraction needed (TODO).`);
                        p.width = p.width || 0;
                        p.height = p.height || 0;
                    }
                });

            } else if (isSingleImage) {
                // ========================= START OF FIX =========================
                // --- Route Single Image to Unified Pipeline for Multi-Question Support ---
                progressCallback(createProgressData(2, 'Processing as single image with multi-question detection...', MULTI_IMAGE_STEPS));

                // Convert single image to standardized format for unified pipeline
                const rawFileData = `data:${files[0].mimetype};base64,${files[0].buffer.toString('base64')}`;
                const singleFileData = await ImageUtils.normalizeOrientation(rawFileData);

                // Standardize the single image as if it were a multi-image input
                standardizedPages = [{
                    pageIndex: 0,
                    imageData: singleFileData,
                    originalFileName: files[0].originalname || 'single-image.png'
                }];

                // Extract dimensions for the single image
                progressCallback(createProgressData(2, 'Extracting image dimensions...', MULTI_IMAGE_STEPS));
                try {
                    const base64Data = singleFileData.split(',')[1];
                    if (base64Data) {
                        const imageBuffer = Buffer.from(base64Data, 'base64');
                        const metadata = await sharp(imageBuffer).metadata();
                        if (metadata.width && metadata.height) {
                            standardizedPages[0].width = metadata.width;
                            standardizedPages[0].height = metadata.height;
                        }
                    }
                } catch (error) {
                    console.warn(`[DIMENSIONS - Single Image] Failed to extract dimensions:`, error);
                }

                // Continue to unified pipeline processing (don't return here)
                // ========================== END OF FIX ==========================

            } else if (isMultipleImages) {
                // --- Multi-File / PDF Path (This code only runs if NOT isSingleImage) ---
                const selectedImageSet = Array.isArray(options.selectedRawPageIndices) && options.selectedRawPageIndices.length > 0
                    ? new Set(options.selectedRawPageIndices.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < files.length))
                    : null;
                const hasValidSelectedImagePages = Boolean(selectedImageSet && selectedImageSet.size > 0);
                const effectiveImageCount = hasValidSelectedImagePages ? selectedImageSet!.size : files.length;
                if (!isProOrUltra && effectiveImageCount > MAX_RAW_COMBINED_PAGES) {
                    throw buildRawCombinedLimitError(effectiveImageCount);
                }

                progressCallback(createProgressData(1, `Preparing ${inputType} processing...`, MULTI_IMAGE_STEPS));

                // 1. Collect Images & Extract Dimensions in Parallel
                progressCallback(createProgressData(1, `Extracting dimensions for ${files.length} images...`, MULTI_IMAGE_STEPS));
                standardizedPages = await Promise.all(files.map(async (file, index): Promise<StandardizedPage | null> => {
                    if (!file.mimetype.startsWith('image/')) return null;
                    if (hasValidSelectedImagePages && !selectedImageSet!.has(index)) return null;
                    try {
                        const rawData = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
                        const normalizedImageData = await ImageUtils.normalizeOrientation(rawData);
                        
                        const base64Data = normalizedImageData.split(',')[1];
                        const imageBuffer = Buffer.from(base64Data, 'base64');
                        const metadata = await sharp(imageBuffer).metadata();
                        
                        if (!metadata.width || !metadata.height) return null;
                        const pageObj: StandardizedPage = {
                            pageIndex: index,
                            imageData: normalizedImageData,
                            originalFileName: file.originalname,
                            width: metadata.width,
                            height: metadata.height
                        };
                        (pageObj as any)._fileIndex = index;
                        (pageObj as any)._rawPageIndex = index;
                        return pageObj;
                    } catch (imgDimError) {
                        console.warn(`[DIMENSIONS - MultiImg Path] Failed to extract dimensions for image ${index}:`, imgDimError);
                        return null;
                    }
                }));
                standardizedPages = standardizedPages.filter((page): page is StandardizedPage => page !== null);

                // Re-assign pageIndex based on upload order (User Design)
                standardizedPages.forEach((page, index) => {
                    page.pageIndex = index;
                });

                // Enforce Raw Combined Ceiling for Multiple Images (Mark Scheme pages are exempted after Stage 2 Geometry)
                if (!isProOrUltra && standardizedPages.length > MAX_RAW_COMBINED_PAGES) {
                    throw buildRawCombinedLimitError(standardizedPages.length);
                }

                progressCallback(createProgressData(1, `Collected ${standardizedPages.length} image(s).`, MULTI_IMAGE_STEPS));

            } else if (isMixedUpload) {
                // --- Mixed Upload Path (Images + PDFs in the same batch) ---
                // NOTE: isPdf / isMultiplePdfs stay false so downstream image sorting still applies.
                const preRasterPlan = await buildPreRasterizationPlan({
                    files,
                    isExplicitMarkSchemePdfFile,
                    hasNonSchemeStudentFiles,
                    selectedRawPageIndices: options.selectedRawPageIndices
                });

                const effectivePreRasterRawPages = preRasterPlan.hasValidSelectedRawPages
                    ? preRasterPlan.plans.reduce((sum, p) => sum + (p.selectedLocalPageIndices?.length ?? 0), 0)
                    : preRasterPlan.totalKnownRawPages;
                if (!isProOrUltra && effectivePreRasterRawPages > MAX_RAW_COMBINED_PAGES) {
                    throw buildRawCombinedLimitError(effectivePreRasterRawPages);
                }

                progressCallback(createProgressData(1, `Preparing mixed files (${files.length} files)...`, MULTI_IMAGE_STEPS));
                stepTimings['pdf_conversion'] = { start: Date.now() };

                const mixedConversionPromises = files.map(async (file, index): Promise<StandardizedPage[]> => {
                    const filePlan = preRasterPlan.plans[index];
                    if (file.mimetype === 'application/pdf') {
                        if (hasNonSchemeStudentFiles && isExplicitMarkSchemePdfFile(file)) {
                            deferredSchemePdfFiles.push(file);
                            console.log(`⏭️  [DEFERRED-MS-PDF] Holding Mark Scheme PDF "${file.originalname}" off Stage 1 rasterization until DB pre-check.`);
                            return [];
                        }
                        if (Array.isArray(filePlan?.selectedLocalPageIndices) && filePlan.selectedLocalPageIndices.length === 0) {
                            console.log(`⏭️  [PAGE-CHUNK] Skipping PDF ${index + 1} (${file.originalname}) before rasterization — 0 pages in selectedRawPageIndices.`);
                            return [];
                        }
                        try {
                            const hasSelectedPages = Boolean(filePlan?.selectedLocalPageIndices?.length);
                            const pdfPages = await PdfProcessingService.convertPdfToImages(file.buffer, {
                                ...(hasSelectedPages ? {} : { maxPages: pdfMaxPagesOption, maxPagesErrorMessage: getPageLimitErrorMessage }),
                                ...(hasSelectedPages ? { selectedPageIndices: filePlan!.selectedLocalPageIndices } : {})
                            });
                            await Promise.all(pdfPages.map(async (page) => {
                                page.originalFileName = file.originalname || `pdf-${index + 1}.pdf`;
                                (page as any)._sourceIndex = index;
                                if (filePlan?.globalRawOffset !== null && filePlan?.globalRawOffset !== undefined) {
                                    (page as any)._rawPageIndex = filePlan.globalRawOffset + page.pageIndex;
                                }
                                if (page.width && page.height) return; // Already populated by PdfProcessingService
                                const base64Data = page.imageData.split(',')[1];
                                if (base64Data) {
                                    const metadata = await sharp(Buffer.from(base64Data, 'base64')).metadata();
                                    page.width = metadata.width || 0;
                                    page.height = metadata.height || 0;
                                }
                            }));
                            return pdfPages;
                        } catch (error: any) {
                            console.error(`❌ Failed to convert PDF in mixed batch (${file.originalname}):`, error);
                            if (error instanceof UserFacingError || error.message?.includes('PDF_UNREADABLE') || error.message?.includes('limited to grading') || error.message?.includes('exceeds the maximum limit')) throw error;
                            throw new Error(`Failed to process PDF "${file.originalname}".`);
                        }
                    } else if (file.mimetype?.startsWith('image/')) {
                        if (Array.isArray(filePlan?.selectedLocalPageIndices) && filePlan.selectedLocalPageIndices.length === 0) {
                            return [];
                        }
                        try {
                            const rawData = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
                            const normalizedImageData = await ImageUtils.normalizeOrientation(rawData);
                            const base64Data = normalizedImageData.split(',')[1];
                            const metadata = await sharp(Buffer.from(base64Data, 'base64')).metadata();
                            if (!metadata.width || !metadata.height) return [];
                            const imgPage: StandardizedPage = {
                                pageIndex: 0, // Re-indexed sequentially below
                                imageData: normalizedImageData,
                                originalFileName: file.originalname || `image-${index + 1}.jpg`,
                                width: metadata.width,
                                height: metadata.height
                            };
                            (imgPage as any)._sourceIndex = index;
                            if (filePlan?.globalRawOffset !== null && filePlan?.globalRawOffset !== undefined) {
                                (imgPage as any)._rawPageIndex = filePlan.globalRawOffset;
                            }
                            return [imgPage];
                        } catch (imgErr) {
                            console.warn(`[MIXED UPLOAD] Failed to process image ${file.originalname}:`, imgErr);
                            return [];
                        }
                    }
                    return [];
                });

                const nestedPages = await Promise.all(mixedConversionPromises);
                if (stepTimings['pdf_conversion']) {
                    stepTimings['pdf_conversion'].duration = Date.now() - stepTimings['pdf_conversion'].start;
                }

                // Flatten in original upload order and re-index sequentially
                standardizedPages = nestedPages.flat().map((page, idx) => ({
                    ...page,
                    pageIndex: idx
                }));

                if (standardizedPages.length > MAX_RAW_COMBINED_PAGES) {
                    throw buildRawCombinedLimitError(standardizedPages.length);
                }

                // Store PDF context for any PDFs included in the mixed batch (upload deferred to background preUploadedOriginalFilesPromise)
                const pdfFiles = files.filter(f => f.mimetype === 'application/pdf');
                if (pdfFiles.length > 0) {
                    const pdfContexts: any[] = [];
                    for (let i = 0; i < pdfFiles.length; i++) {
                        const file = pdfFiles[i];
                        const originalFileIdx = files.indexOf(file);
                        const originalPdfLink = null;
                        const originalPdfDataUrl = `data:application/pdf;base64,${file.buffer.toString('base64')}`;

                        const fileSizeBytes = file.buffer.length;
                        const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
                        pdfContexts.push({
                            originalFileType: 'pdf' as const,
                            originalPdfLink,
                            originalPdfDataUrl,
                            originalFileName: file.originalname || `document-${i + 1}.pdf`,
                            fileSize: fileSizeBytes,
                            fileSizeMB: fileSizeMB + ' MB',
                            fileIndex: originalFileIdx >= 0 ? originalFileIdx : i
                        });
                    }
                    pdfContext = {
                        isMultiplePdfs: true,
                        pdfContexts
                    };
                }

                progressCallback(createProgressData(1, `Prepared ${standardizedPages.length} total page(s) from mixed upload.`, MULTI_IMAGE_STEPS));

            } else {
                // This case should technically be caught by initial validation, but belt-and-suspenders.
                throw new Error("Unhandled submission type.");
            }

            // --- Guard against empty standardization ---
            if (standardizedPages.length === 0) {
                throw new Error('Standardization failed: No processable pages/images found.');
            }

            // Stamp pre-split raw page index (if not already stamped by pre-rasterization chunking) & detect 100% solid-black corrupted client canvas exports (<1ms via sharp.stats)
            await Promise.all(standardizedPages.map(async (page, idx) => {
                if ((page as any)._rawPageIndex === undefined) {
                    (page as any)._rawPageIndex = idx;
                }
                if ((page as any)._sourceIndex === undefined) {
                    try {
                        const base64Data = page.imageData.split(',')[1];
                        if (base64Data) {
                            const buf = Buffer.from(base64Data, 'base64');
                            const stats = await sharp(buf).stats();
                            if (stats.channels.length > 0 && stats.channels.every(c => c.max <= 2)) {
                                (page as any)._isSolidBlackCorrupted = true;
                                console.warn(`🖤 [CORRUPT-IMAGE GUARD] Page ${idx} (${page.originalFileName}) is 100% solid black (Safari canvas memory limit). Marking for ejection.`);
                            }
                        }
                    } catch {}
                }
            }));

            if (Array.isArray(options.selectedRawPageIndices) && options.selectedRawPageIndices.length > 0) {
                const filtered = filterPagesBySelectedRawIndices({
                    standardizedPages,
                    selectedRawPageIndices: options.selectedRawPageIndices,
                    files,
                    isExplicitMarkSchemePdfFile
                });
                if (filtered.isUserSelectedPageChunk) {
                    standardizedPages = filtered.standardizedPages;
                    isUserSelectedPageChunk = true;
                    console.log(`✂️ [PAGE-CHUNK] Filtered to ${standardizedPages.length} user-selected page(s) (including any explicit Mark Scheme PDF pages).`);
                }
            }

            console.log(`📊 [RAW UPLOAD] User ${userId || 'anonymous'} (${userPlan}) uploaded ${standardizedPages.length} raw page(s) pre-geometry.`);

            // Stream lightweight converted PDF page thumbnails immediately so frontend animation shows actual PDF pages instead of a blank placeholder
            if (!preFlightBucket && (isPdf || isMultiplePdfs || isMixedUpload) && standardizedPages.length > 0) {
                try {
                    const hasMetadataCoverOffset =
                        earlyPrunedPdfMarkingScope?.type === 'pages' && (earlyPrunedPdfMarkingScope.minPage ?? 1) > 1;
                    const scopedPreviewSource = hasMetadataCoverOffset
                        ? standardizedPages.slice(1)
                        : standardizedPages;
                    const previewPages = scopedPreviewSource.slice(0, 25);
                    const convertedThumbnails = await Promise.all(
                        previewPages.map(async (p, previewIdx) => {
                            const thumb = await ImageUtils.createLightweightCopy(p.imageData, 260);
                            const pageIdx = hasMetadataCoverOffset ? previewIdx + 1 : previewIdx;
                            sseThumbnailCache.set(pageIdx, thumb);
                            return thumb;
                        })
                    );
                    progressCallback({
                        ...createProgressData(1, `Converted PDF to ${standardizedPages.length} page(s)...`, MULTI_IMAGE_STEPS),
                        convertedThumbnails
                    } as any);
                } catch (thumbErr) {
                    console.warn('[PDF-THUMBNAILS] Failed to generate SSE preview thumbnails:', thumbErr);
                }
            }

            // --- 1. Vision Orientation Fix (Deterministic) ---
            // P3 Optimization: When raw pages exceed effectiveMaxPages (e.g. 65 > 50), defer Vision Orientation until
            // AFTER ImageGeometryService and the Page Gate so >50-page student batches fail-fast in ~2s instead of wasting 8.4s on Vision.
            // Normal batches (<= effectiveMaxPages) run Vision Orientation BEFORE Geometry to preserve sideways 2-page spread splitting.
            const deferVisionUntilAfterPageGate = standardizedPages.length > effectiveMaxPages;

            const runVisionOrientationOnPages = async (targetPages: StandardizedPage[]) => {
                progressCallback(createProgressData(2, `Detecting orientation via Google Vision for ${targetPages.length} image(s)...`, MULTI_IMAGE_STEPS));
                const logOrientationComplete = logStep('Vision Orientation Check', 'Google Cloud Vision');

                const { GoogleVisionService } = await import('../ocr/GoogleVisionService.js');

                // ⚡ Skip orientation for pages from verified digital official Mark Scheme PDFs (>= 5 pages)
                // and for solid-black corrupted canvas exports.
                const pdfPageCountByName = new Map<string, number>();
                targetPages.forEach(p => {
                    const name = p.originalFileName || '';
                    if ((p as any)._sourceIndex !== undefined && /\.pdf$/i.test(name)) {
                        pdfPageCountByName.set(name, (pdfPageCountByName.get(name) || 0) + 1);
                    }
                });
                const isUprightMarkSchemePdfPage = (p: StandardizedPage) => {
                    const name = p.originalFileName || '';
                    if ((pdfPageCountByName.get(name) || 0) < 5) return false;
                    const srcIdx = (p as any)._sourceIndex;
                    const srcFile = typeof srcIdx === 'number' ? files[srcIdx] : undefined;
                    if (srcFile) {
                        const peek = pdfHeaderPeekMap.get(srcFile);
                        if (peek?.hasTextLayer) {
                            return peek.isDigitalMarkScheme;
                        }
                    }
                    return MARK_SCHEME_FILENAME_REGEX.test(name.replace(/\.pdf$/i, ''));
                };

                const orientationTargets = targetPages.filter(
                    p => !isUprightMarkSchemePdfPage(p) && !(p as any)._isSolidBlackCorrupted
                );
                const skippedOrientationCount = targetPages.length - orientationTargets.length;
                if (skippedOrientationCount > 0) {
                    console.log(`⏭️  [VISION ORIENTATION] Skipped ${skippedOrientationCount} upright Mark Scheme / corrupted page(s).`);
                }

                const ORIENTATION_BATCH_SIZE = 8;
                for (let b = 0; b < orientationTargets.length; b += ORIENTATION_BATCH_SIZE) {
                    const batch = orientationTargets.slice(b, b + ORIENTATION_BATCH_SIZE);
                    await Promise.all(batch.map(async (page) => {
                        const base64Data = page.imageData.replace(/^data:image\/\w+;base64,/, '');
                        const imageBuffer = Buffer.from(base64Data, 'base64');

                        const rotationNeeded = await GoogleVisionService.detectOrientation(imageBuffer);

                        if (rotationNeeded > 0) {
                            console.log(`🔄 [VISION ORIENTATION] Page ${page.pageIndex} needs ${rotationNeeded} degrees. Rotating...`);
                            const rotatedBuffer = await ImageUtils.rotateImage(page.imageData, rotationNeeded);
                            const mimeType = page.imageData.startsWith('data:') ? page.imageData.split(';')[0] : 'data:image/jpeg';
                            page.imageData = `${mimeType};base64,${rotatedBuffer.toString('base64')}`;

                            if (rotationNeeded === 90 || rotationNeeded === 270) {
                                const temp = page.width;
                                page.width = page.height;
                                page.height = temp;
                            }
                        }

                        (page as any)._lightweightImageData = await ImageUtils.createLightweightCopy(page.imageData, 800);
                    }));
                }
                logOrientationComplete();
            };

            if (!deferVisionUntilAfterPageGate) {
                await runVisionOrientationOnPages(standardizedPages);
            } else {
                console.log(`⚡ [FAST-GATE] Raw upload (${standardizedPages.length} pages) exceeds ${effectiveMaxPages}-page limit. Running Semantic Geometry before Vision Orientation to check for Mark Scheme exemptions.`);
            }

            // --- 2. AI Semantic Geometry & Quality Check ---
            progressCallback(createProgressData(2, `Running semantic quality check on ${standardizedPages.length} image(s)...`, MULTI_IMAGE_STEPS));
            const logGeometryComplete = logStep('Semantic Geometry Check', 'FAST (HARDCODED)');
            
            const newStandardizedPages: StandardizedPage[] = [];
            const newLightweightPages: StandardizedPage[] = [];
            const newGeometryResults: any[] = [];
            pagesEjected = deferredSchemePdfFiles.length > 0;
            
            // --- 1.5 Create Tier 2 (Low-Res WEBP) for Gemini ---
            // Reuse pre-generated _lightweightImageData from Vision Orientation batch, or generate for skipped upright pages
            lightweightPages = await Promise.all(
                standardizedPages.map(async page => {
                    const precomputedLight = (page as any)._lightweightImageData;
                    delete (page as any)._lightweightImageData;
                    return {
                        ...page,
                        imageData: (page as any)._isSolidBlackCorrupted
                            ? page.imageData
                            : (precomputedLight || await ImageUtils.createLightweightCopy(page.imageData, 800))
                    };
                })
            );

            // ⚡ [EARLY DUPLICATE-QUESTION PRE-CHECK FOR >50-PAGE PDFs]:
            // Before burning 50+ individual preFlight Semantic Geometry calls (~$0.12), sample ONLY the first
            // 10 pages (1 Mapper batch, ~$0.011) to reject topic packs / duplicate-question PDFs immediately.
            // (Bundled Exam+MarkScheme PDFs have unique questions in pages 0..9, so they pass through cleanly.)
            if (deferVisionUntilAfterPageGate && lightweightPages.length > effectiveMaxPages) {
                const earlySamplePages = lightweightPages.slice(0, 10)
                    .filter(p => Boolean(p.imageData))
                    .map(p => ({
                        imageData: p.imageData,
                        fileName: p.originalFileName,
                        pageIndex: p.pageIndex ?? 0
                    }));
                if (earlySamplePages.length >= 2) {
                    const { ClassificationMapper } = await import('./ClassificationMapper.js');
                    const earlyMapperResults = await ClassificationMapper.mapQuestionsToPages(
                        earlySamplePages,
                        usageTracker,
                        'fast',
                        debugClassification
                    );
                    PaperSplitterService.assertNoDuplicateQuestionsInMapperResults(earlyMapperResults, {
                        isPdf: standardizedPages.length > 0 && standardizedPages.every(p => /\.pdf$/i.test(p.originalFileName || '')),
                        pageCount: standardizedPages.length,
                        fileName: standardizedPages[0]?.originalFileName
                    });
                }
            }

            const preInspectToken =
                (options as any)?.preInspectToken ||
                (typeof req.body?.preInspectToken === 'string' ? req.body.preInspectToken.trim() : undefined);
            const preInspectReuse = PreInspectService.consumeCachedGeometry({
                preInspectToken,
                userId: userId || (req as any).user?.uid,
                files,
                usageTracker,
                targetSessionId: options.sessionId || submissionId,
            });

            geometryResults = await Promise.all(
                lightweightPages.map(async (page, idx) => {
                    const stdPage = standardizedPages[idx] as any;
                    if (stdPage?._isSolidBlackCorrupted) {
                        return {
                            is_acceptable_quality: false,
                            rejection_reason: 'Image is blank or solid black due to browser memory limits during upload.',
                            needs_rotation: 0,
                            is_two_page_spread: false,
                            is_marking_scheme: false,
                            is_supported_doc: false
                        };
                    }
                    if (preInspectReuse.reusedPageCount > 0) {
                        const fileIdx = stdPage?._sourceIndex ?? stdPage?._fileIndex ?? 0;
                        const isPdfSource = /\.pdf$/i.test(stdPage?.originalFileName || '') && stdPage?._sourceIndex !== undefined;
                        const localRawPageIdx = isPdfSource
                            ? (stdPage?.pageIndex ?? idx)
                            : 0;
                        const globalRawPageIdx = stdPage?._rawPageIndex ?? stdPage?.pageIndex ?? idx;
                        const cachedGeo =
                            preInspectReuse.reusedByFileAndPage.get(`${fileIdx}:${localRawPageIdx}`) ||
                            preInspectReuse.reusedByFileAndPage.get(`${fileIdx}:${globalRawPageIdx}`);
                        if (cachedGeo) {
                            const isPhysicallyLandscape = (page.width && page.height) ? (page.width > page.height * 1.05) : true;
                            return {
                                ...cachedGeo,
                                is_two_page_spread: Boolean(cachedGeo.is_two_page_spread) && isPhysicallyLandscape,
                            };
                        }
                    }
                    return ImageGeometryService.analyze(page.imageData, page.width, page.height, 'fast', usageTracker);
                })
            );

            let lastRejectionReason = 'Image is blurry, blank, unreadable, or not mathematics content.';

            // 🛡️ [SPREAD CONSISTENCY SWEEP]:
            // If >= 50% of student images in a multi-image upload (at least 3 student images) are 2-page booklet spreads,
            // any remaining landscape student image (width > height * 1.1, e.g. Page 0 with Cover + Page 2)
            // that missed spread detection due to lacking a dark center crease is also a 2-page spread.
            // Note: Exclude Marking Scheme pages so a 29-page portrait Mark Scheme PDF does not dilute the student spread ratio!
            const isPageLandscape = (p?: StandardizedPage) =>
                Boolean(p?.width && p?.height && p.width > p.height * 1.1);

            const nonSchemeIndices = standardizedPages
                .map((_, idx) => idx)
                .filter(idx => !geometryResults[idx]?.is_marking_scheme);
            const spreadCount = nonSchemeIndices.filter(
                idx => geometryResults[idx]?.is_two_page_spread && isPageLandscape(standardizedPages[idx])
            ).length;
            const isMajoritySpreadBatch =
                nonSchemeIndices.length >= 3 && (spreadCount / nonSchemeIndices.length) >= 0.5;

            // 🛡️ [MARK-SCHEME FALSE-POSITIVE GUARD]:
            // In a multi-spread photographed exam booklet (e.g. 23 loose spreads of a teacher-marked script),
            // preFlight can occasionally misclassify 1 isolated spread as `is_marking_scheme: true` due to red
            // teacher annotations (M1/A1/B1) or "Question X continued" footers. If the flagged page is itself
            // a landscape spread (matching the student booklet) and no explicit mark-scheme PDF was uploaded,
            // rescue it so the question isn't silently dropped and BYOMS mode isn't falsely triggered.
            if (isMajoritySpreadBatch && deferredSchemePdfFiles.length === 0) {
                const flaggedSchemeIndices = standardizedPages
                    .map((_, idx) => idx)
                    .filter(idx => geometryResults[idx]?.is_marking_scheme === true);
                const isSmallIsolatedFraction =
                    flaggedSchemeIndices.length > 0 &&
                    flaggedSchemeIndices.length <= Math.max(1, Math.floor(standardizedPages.length * 0.1));
                if (isSmallIsolatedFraction) {
                    flaggedSchemeIndices.forEach(idx => {
                        const geo = geometryResults[idx];
                        const page = standardizedPages[idx];
                        const text = `${geo?.visual_observations || ''} ${geo?.evidence_text_snippet || ''}`;
                        const hasExplicitSchemeKeyword = /\b(?:mark(?:ing)?\s*scheme|rubric|mark\s*grid|examiner\s*guidance|level\s*descriptors)\b/i.test(text);
                        if (geo && !hasExplicitSchemeKeyword && (isPageLandscape(page) || geo.is_two_page_spread || geo.has_handwriting)) {
                            console.log(`🛡️ [MARK-SCHEME FALSE-POSITIVE GUARD] Rescued Page ${idx} from false-positive is_marking_scheme inside a ${standardizedPages.length}-page student booklet spread batch.`);
                            geo.is_marking_scheme = false;
                        }
                    });
                }
            }

            // 🛡️ [BYOMS DETECTION & DOCUMENT-LEVEL SUBJECT CONSENSUS]:
            // Check if any uploaded page in the batch is a Marking Scheme (or if a custom marking scheme was provided).
            // When a Marking Scheme is present, Universal BYOMS mode is enabled for any academic subject!
            const allowGenericSubject = Boolean(
                options.allowGenericSubjectMarking ||
                req.body?.allowGenericSubjectMarking === true ||
                req.body?.allowGenericSubjectMarking === 'true'
            );

            let hasUploadedMarkingScheme =
                deferredSchemePdfFiles.length > 0 ||
                geometryResults.some(g => g?.is_marking_scheme === true) ||
                Boolean(options.markingScheme);

            const isMultiPageUpload = standardizedPages.length >= 2;
            const minorityRescue = (!hasUploadedMarkingScheme && !allowGenericSubject && isMultiPageUpload)
                ? rescueMinorityUnsupportedPagesInSupportedBatch(geometryResults)
                : { rescuedCount: 0 };
            if (minorityRescue.rescuedCount > 0) {
                console.log(
                    `🛡️ [SUBJECT CONSENSUS RESCUE] Rescued ${minorityRescue.rescuedCount} minority non-Maths/English page(s) to match batch consensus subject "${minorityRescue.dominantSupportedSubject}".`
                );
            }
            const unsupportedPageResults = filterAcademicUnsupportedPages(geometryResults);
            const nonSchemePageCount = Math.max(1, geometryResults.filter(g => !g?.is_marking_scheme).length);
            const unsupportedRatio = unsupportedPageResults.length / nonSchemePageCount;

            const distinctUnsupportedSubjects = extractDistinctUnsupportedSubjects(unsupportedPageResults);

            // 📚 [AUTO-CATALOGED OFFICIAL SCHEME LOOKUP] (shared DRY rule via PreFlightRules.ts):
            const studentPdfCount = files.filter(f => f?.mimetype === 'application/pdf' && !isExplicitMarkSchemePdfFile(f)).length;
            if (!hasUploadedMarkingScheme && unsupportedPageResults.length > 0 && distinctUnsupportedSubjects.length <= 1 && studentPdfCount <= 1) {
                const { catalogedScheme, skippedUnofficial } = await lookupCatalogedOfficialSchemeIfEligible({
                    geometryResults,
                    unsupportedPages: unsupportedPageResults,
                    distinctUnsupportedSubjects,
                    customText: options.customText
                });
                if (skippedUnofficial) {
                    console.log(
                        `🛡️ [AUTO-CATALOG SCHEME] Skipped official DB scheme lookup — uploaded document contains unofficial/practice paper indicators.`
                    );
                } else if (catalogedScheme) {
                    inputMarkingScheme = catalogedScheme;
                    hasUploadedMarkingScheme = true;
                    const primarySubjName = distinctUnsupportedSubjects[0] || unsupportedPageResults[0]?.unsupported_subject_name || undefined;
                    console.log(
                        `📚 [AUTO-CATALOG SCHEME] Found official ${catalogedScheme.examDetails?.subject || primarySubjName} marking scheme in DB for "${catalogedScheme.examDetails?.paperCode}" (${catalogedScheme.examDetails?.exam_series || 'N/A'})! Grading automatically without requiring user mark scheme upload.`
                    );
                }
            }

            if (allowGenericSubject && unsupportedPageResults.length > 0) {
                const primarySubjName = unsupportedPageResults[0]?.unsupported_subject_name || undefined;
                if (!options.subject && primarySubjName && distinctUnsupportedSubjects.length <= 1) {
                    options.subject = primarySubjName;
                }
                geometryResults.forEach(g => {
                    if (g && (g.detected_subject === 'UNSUPPORTED_SUBJECT' || g.detected_subject === 'ENGLISH_LITERATURE')) {
                        g.is_supported_doc = true;
                    }
                });
                console.log(
                    `🤖 [GENERIC SUBJECT MODE] User opted into AI marking with general rubric (${distinctUnsupportedSubjects.join(' & ') || options.subject || 'General'}) without an official scheme. Unblocking ${unsupportedPageResults.length} page(s)...`
                );
            }

            if (!hasUploadedMarkingScheme && !allowGenericSubject && isMultiPageUpload && (unsupportedPageResults.length >= 2 || unsupportedRatio >= 0.4)) {
                const primaryUnsupported = unsupportedPageResults.find(g => g.rejection_reason && g.rejection_reason.trim()) || unsupportedPageResults[0];
                const combinedSubjLabel = distinctUnsupportedSubjects.join(' & ');
                const consensusRejectionReason = distinctUnsupportedSubjects.length > 1
                    ? `Unsupported subjects (${combinedSubjLabel}): Marking schemes required for these subjects.`
                    : (primaryUnsupported?.rejection_reason ||
                        'The uploaded document belongs to an unsupported subject (e.g. Sciences, Humanities, or English Literature). AI Marking currently supports GCSE & A-Level Mathematics and GCSE English Language with official mark schemes and grade boundaries.');

                console.log(
                    `🛡️ [SUBJECT CONSENSUS] Multi-page document consensus triggered (${unsupportedPageResults.length}/${standardizedPages.length} pages flagged as unsupported). Marking entire upload as unsupported: "${consensusRejectionReason}"`
                );

                geometryResults.forEach(g => {
                    if (g && !g.is_marking_scheme) {
                        g.is_supported_doc = false;
                        g.rejection_reason = consensusRejectionReason;
                        if (primaryUnsupported?.detected_subject && !g.detected_subject) {
                            g.detected_subject = primaryUnsupported.detected_subject;
                        }
                        if (primaryUnsupported?.unsupported_subject_name && !g.unsupported_subject_name) {
                            g.unsupported_subject_name = primaryUnsupported.unsupported_subject_name;
                        }
                    }
                });
                lastRejectionReason = consensusRejectionReason;
            } else if ((hasUploadedMarkingScheme || allowGenericSubject) && unsupportedPageResults.length > 0) {
                console.log(
                    `🛡️ [${hasUploadedMarkingScheme ? 'BYOMS' : 'GENERIC SUBJECT'} MODE] ${hasUploadedMarkingScheme ? 'Uploaded Marking Scheme' : 'General AI Rubric'} enabled alongside ${unsupportedPageResults.length} non-Maths/English page(s). Enabling Universal Subject Marking!`
                );
            }

            for (let i = 0; i < standardizedPages.length; i++) {
                const stdPage = standardizedPages[i];
                const lightPage = lightweightPages[i];
                const geo = geometryResults[i];

                // 1. Always drop unreadable / non-educational junk pages
                if (!geo.is_acceptable_quality) {
                    lastRejectionReason = geo.rejection_reason || lastRejectionReason;
                    const evidence = geo.evidence_text_snippet ? `\n   📄 Evidence: "${geo.evidence_text_snippet}"` : "";
                    console.warn(`⚠️ [GEOMETRY] Dropping Page ${stdPage.pageIndex + 1} (quality check): ${lastRejectionReason}${evidence}`);
                    continue;
                }

                // 2. 🛡️ THE INTERCEPTOR: Always eject marking scheme pages BEFORE subject rejection
                if (geo.is_marking_scheme) {
                    console.log(`📄 [INTERCEPTOR] Page ${stdPage.pageIndex} is a Marking Scheme`);
                    pagesEjected = true;
                    interceptedSchemeImages.push(stdPage.imageData);
                    interceptedSchemeMeta.push({
                        imageData: stdPage.imageData,
                        sourceIndex: (stdPage as any)._sourceIndex ?? (stdPage as any)._fileIndex,
                        rawPageIndex: (stdPage as any)._rawPageIndex ?? stdPage.pageIndex,
                        originalFileName: stdPage.originalFileName,
                        paperCodeHint: geo.paper_code_hint || undefined,
                        evidenceText: geo.evidence_text_snippet || undefined,
                        detectedSubject: geo.detected_subject === 'UNSUPPORTED_SUBJECT'
                            ? (geo.unsupported_subject_name || undefined)
                            : geo.detected_subject
                    });
                    continue; // Skip pushing to student pages (exempt from student page quota)
                }

                // 3. Always drop explicitly non-academic pages (selfies, receipts, parking notices, etc.)
                if (geo.detected_subject === 'NON_ACADEMIC') {
                    const rawReason = (geo.rejection_reason || '').trim();
                    lastRejectionReason = rawReason || 'Not educational exam content: Please upload an academic exam question or student homework.';
                    const evidence = geo.evidence_text_snippet ? `\n   📄 Evidence: "${geo.evidence_text_snippet}"` : "";
                    console.warn(`⚠️ [GEOMETRY] Dropping Page ${stdPage.pageIndex + 1} (non-academic): ${lastRejectionReason}${evidence}`);
                    continue;
                }

                // 4. Reject other academic subjects ONLY when NO marking scheme was uploaded AND user did not opt into general rubric
                if (geo.is_supported_doc === false && !hasUploadedMarkingScheme && !allowGenericSubject) {
                    const rawReason = (geo.rejection_reason || '').trim();
                    lastRejectionReason = rawReason || 'A marking scheme is required to grade this subject. Please upload the official marking scheme alongside your question paper or student answers (Maths and English Language can be marked without a marking scheme).';
                    
                    const reason = lastRejectionReason;
                    const evidence = geo.evidence_text_snippet ? `\n   📄 Evidence: "${geo.evidence_text_snippet}"` : "";
                    console.warn(`⚠️ [GEOMETRY] Dropping Page ${stdPage.pageIndex + 1} from grading pipeline (detected_subject=${geo.detected_subject || 'unknown'}, unsupported_subject=${geo.unsupported_subject_name || 'N/A'}): ${reason}${evidence}`);
                    
                    continue; // Gracefully filter out the page until mark scheme is provided
                }

                const isLandscapeAspect = isPageLandscape(stdPage);
                if (geo.is_two_page_spread && !isLandscapeAspect) {
                    console.log(
                        `🛡️ [GEOMETRY GUARD] Ignoring false-positive 2-page spread on Portrait Page ${stdPage.pageIndex} (${stdPage.width}x${stdPage.height}).`
                    );
                }
                const shouldSplitSpread = Boolean(isLandscapeAspect && (geo.is_two_page_spread || isMajoritySpreadBatch));

                // Handle 2-page spread splitting
                if (shouldSplitSpread) {
                    console.log(`✂️ [GEOMETRY] Splitting 2-page spread for Page ${stdPage.pageIndex}${!geo.is_two_page_spread ? ' (Batch Landscape Spread Sweep)' : ''}.`);
                    const splitStdImages = await ImageUtils.splitImageVertically(stdPage.imageData);
                    // Generate full 800px lightweight copies from each split half-page (instead of cutting an 800px image into two tiny 400px halves!)
                    const splitLightImages = await Promise.all([
                        ImageUtils.createLightweightCopy(splitStdImages[0], 800),
                        ImageUtils.createLightweightCopy(splitStdImages[1], 800)
                    ]);
                    
                    newStandardizedPages.push({ ...stdPage, imageData: splitStdImages[0], width: Math.round((stdPage.width || 0) / 2) }); // Left (Canonical)
                    newStandardizedPages.push({ ...stdPage, imageData: splitStdImages[1], width: Math.round((stdPage.width || 0) / 2) }); // Right (Canonical)
                    
                    newLightweightPages.push({ ...lightPage, imageData: splitLightImages[0], width: Math.round((lightPage.width || 0) / 2) }); // Left (Lightweight 800px)
                    newLightweightPages.push({ ...lightPage, imageData: splitLightImages[1], width: Math.round((lightPage.width || 0) / 2) }); // Right (Lightweight 800px)

                    const rawSpreadBookletPage =
                        typeof geo?.booklet_page_number === 'number' &&
                        geo.booklet_page_number >= 1 &&
                        geo.booklet_page_number <= 100
                            ? geo.booklet_page_number
                            : undefined;
                    let leftBookletPage = rawSpreadBookletPage;
                    let rightBookletPage = rawSpreadBookletPage;
                    if (rawSpreadBookletPage !== undefined) {
                        if (rawSpreadBookletPage === 1) {
                            leftBookletPage = 1;
                            rightBookletPage = 2;
                        } else if (rawSpreadBookletPage % 2 === 0) {
                            // Standard UK exam spread: even page on left (e.g. 36), odd page on right (e.g. 37)
                            leftBookletPage = rawSpreadBookletPage;
                            rightBookletPage = Math.min(100, rawSpreadBookletPage + 1);
                        } else {
                            // Pre-flight read the right-hand odd page (e.g. 37) -> left half is 36
                            leftBookletPage = rawSpreadBookletPage - 1;
                            rightBookletPage = rawSpreadBookletPage;
                        }
                    }

                    newGeometryResults.push({ ...geo, booklet_page_number: leftBookletPage });
                    newGeometryResults.push({ ...geo, is_cover_page: false, booklet_page_number: rightBookletPage });
                } else {
                    newStandardizedPages.push(stdPage);
                    newLightweightPages.push(lightPage);
                    newGeometryResults.push(geo);
                }
            }

            // 🛡️ [PURE MARKING SCHEME SWEEP]:
            // If >= 75% of pages from a single multi-page source file (with at least 3 pages) were flagged as a Marking Scheme,
            // any remaining 1-2 pages from that same file are almost certainly diagram/formula pages of the scheme itself
            // that suffered a false negative. Sweep them into interceptedSchemeImages so they aren't graded as student work!
            if (interceptedSchemeImages.length >= 2 && newStandardizedPages.length > 0) {
                const getFileKey = (p: StandardizedPage) => `${(p as any)._sourceIndex ?? 'img'}_${p.originalFileName || 'default'}`;

                const fileStats = new Map<string, { total: number; scheme: number; name: string }>();
                for (let i = 0; i < standardizedPages.length; i++) {
                    const key = getFileKey(standardizedPages[i]);
                    const stat = fileStats.get(key) || { total: 0, scheme: 0, name: standardizedPages[i].originalFileName || 'default' };
                    stat.total++;
                    if (geometryResults[i]?.is_marking_scheme) {
                        stat.scheme++;
                    }
                    fileStats.set(key, stat);
                }

                const pureSchemeFileKeys = new Set<string>();
                fileStats.forEach((stat, key) => {
                    if (stat.total >= 3 && (stat.scheme / stat.total) >= 0.75) {
                        pureSchemeFileKeys.add(key);
                        console.log(`🧹 [INTERCEPTOR SWEEP] File "${stat.name}" is ${(stat.scheme / stat.total * 100).toFixed(0)}% Marking Scheme (${stat.scheme}/${stat.total}). Sweeping remaining leaked pages into scheme parser.`);
                    }
                });

                if (pureSchemeFileKeys.size > 0) {
                    const filteredStd: StandardizedPage[] = [];
                    const filteredLight: StandardizedPage[] = [];
                    const filteredGeo: any[] = [];
                    for (let i = 0; i < newStandardizedPages.length; i++) {
                        const page = newStandardizedPages[i];
                        if (pureSchemeFileKeys.has(getFileKey(page))) {
                            console.log(`📄 [INTERCEPTOR SWEEP] Ejecting leaked scheme page ${page.pageIndex} from "${page.originalFileName}"`);
                            pagesEjected = true;
                            interceptedSchemeImages.push(page.imageData);
                            const sweptGeo = newGeometryResults[i];
                            interceptedSchemeMeta.push({
                                imageData: page.imageData,
                                sourceIndex: (page as any)._sourceIndex ?? (page as any)._fileIndex,
                                rawPageIndex: (page as any)._rawPageIndex ?? page.pageIndex,
                                originalFileName: page.originalFileName,
                                paperCodeHint: sweptGeo?.paper_code_hint || undefined,
                                evidenceText: sweptGeo?.evidence_text_snippet || undefined,
                                detectedSubject: sweptGeo?.detected_subject === 'UNSUPPORTED_SUBJECT'
                                    ? (sweptGeo?.unsupported_subject_name || undefined)
                                    : sweptGeo?.detected_subject
                            });
                        } else {
                            filteredStd.push(page);
                            filteredLight.push(newLightweightPages[i]);
                            filteredGeo.push(newGeometryResults[i]);
                        }
                    }
                    newStandardizedPages.length = 0;
                    newStandardizedPages.push(...filteredStd);
                    newLightweightPages.length = 0;
                    newLightweightPages.push(...filteredLight);
                    newGeometryResults.length = 0;
                    newGeometryResults.push(...filteredGeo);
                }
            }

            // If ALL pages were ejected because the user ONLY uploaded a Marking Scheme (no student work or questions):
            if (newStandardizedPages.length === 0 && interceptedSchemeImages.length > 0) {
                lastRejectionReason = 'It looks like you uploaded a Marking Scheme without any exam questions or student answers! Please upload your question paper or handwritten answers along with the marking scheme so I can grade them.';
            }

            // CRITICAL FIX: We MUST re-assign pageIndex = index for ALL files (PDFs and Images).
            // A previous developer incorrectly assumed the frontend uses a native PDF viewer that relies on physical page mapping.
            // In reality, PDFs are rasterized into images and the frontend displays the annotated *images*.
            // If we don't re-index after splitting/ejecting, downstream AI passes collapse duplicate indices, causing a fatal Merge Mismatch.
            standardizedPages = newStandardizedPages.map((page, index) => ({
                ...page,
                pageIndex: index
            }));
            
            lightweightPages = newLightweightPages.map((page, index) => ({
                ...page,
                pageIndex: index
            }));
            if (newStandardizedPages.length > 0) {
                geometryResults = newGeometryResults;
            }

            if (standardizedPages.length === 0) {
                console.log(`⚠️ [PIPELINE] All pages rejected by Geometry check. Short-circuiting gracefully.`);
                progressCallback(createProgressData(2, 'Content rejected by quality inspector.', MULTI_IMAGE_STEPS));

                const academicSubjectPages = geometryResults.filter(
                    g => g && g.is_acceptable_quality !== false && g.is_supported_doc === false &&
                    g.detected_subject !== 'NON_ACADEMIC' &&
                    !/not educational|please upload an academic exam|non-academic/i.test(g.rejection_reason || '') &&
                    (g.detected_subject === 'ENGLISH_LITERATURE' ||
                     (g.detected_subject === 'UNSUPPORTED_SUBJECT' && isRecognizedAcademicSubject(g.unsupported_subject_name)))
                );
                const academicSubjectGeo = academicSubjectPages[0];

                const nonAcademicPages = geometryResults.filter(g => g && (
                    g.detected_subject === 'NON_ACADEMIC' ||
                    /not educational|please upload an academic exam|non-academic|invoice|receipt|selfie/i.test(g.rejection_reason || '')
                ));

                // A document is non-educational ONLY when no recognized academic subject pages were detected
                const isNonEducational =
                    academicSubjectPages.length === 0 && (
                        /not educational|please upload an academic exam|non-academic|invoice|receipt|selfie/i.test(lastRejectionReason) ||
                        nonAcademicPages.length > 0
                    );

                const isUnsupportedWithoutScheme =
                    !isNonEducational &&
                    interceptedSchemeImages.length === 0 &&
                    Boolean(academicSubjectGeo);

                const detectedAcademicSubjectName = distinctUnsupportedSubjects.length > 1
                    ? distinctUnsupportedSubjects.join(' & ')
                    : (academicSubjectGeo?.detected_subject === 'ENGLISH_LITERATURE'
                        ? 'English Literature'
                        : (academicSubjectGeo?.unsupported_subject_name || 'this subject'));

                // Only trigger Admin Alert email when NO marking scheme was uploaded and NOT educational content
                if (interceptedSchemeImages.length === 0 && !isUnsupportedWithoutScheme) {
                    void AdminAlertService.notifyCrash('MARKING', req, new Error(lastRejectionReason));
                }

                // If rejected due to an unsupported subject without a marking scheme, guide the user to attach their mark scheme
                const guidedRejectionReason = isUnsupportedWithoutScheme
                    ? formatMarkSchemeRequiredMessage(detectedAcademicSubjectName)
                    : (lastRejectionReason || 'Not educational exam content: Please upload an academic exam question or student homework.');

                // Persist the rejected session so it shows in Library and chat history
                try {
                    const uploadResult = await SessionManagementService.uploadOriginalFiles(
                        files,
                        userId || 'anonymous',
                        submissionId,
                        !!userId,
                        pdfContext
                    );
                    const { structuredImageDataArray, structuredPdfContexts } = SessionManagementService.createStructuredData(
                        files,
                        isPdf,
                        isMultiplePdfs || isMixedUpload,
                        pdfContext
                    );
                    const userMessage = SessionManagementService.createUserMessageForDatabase(
                        {
                            content: options.customText || 'Uploaded document for analysis',
                            files,
                            isPdf,
                            isMultiplePdfs: isMultiplePdfs || isMixedUpload,
                            sessionId: options.sessionId || submissionId,
                            model: actualModel,
                            pdfContext
                        },
                        structuredImageDataArray,
                        structuredPdfContexts,
                        uploadResult.originalImageLinks
                    );
                    
                    const aiMessage: any = createAIMessage({
                        content: guidedRejectionReason || 'The uploaded image could not be processed because it is blurry, unreadable, or does not contain educational content.',
                        messageId: req.body?.aiMessageId
                    });
                    if (isUnsupportedWithoutScheme) {
                        aiMessage.requiresMarkingScheme = true;
                    }

                    const markingContext: MarkingSessionContext = {
                        req,
                        submissionId,
                        startTime,
                        userMessage,
                        aiMessage,
                        questionDetection: options.markingScheme,
                        // 🛡️ SAFE TITLE FALLBACK: Use custom text, OR the filename, OR a safe default
                        globalQuestionText: options.customText || (files && files[0] ? files[0].originalname : 'Rejected Document'),
                        mode: 'Question', // Fallback to Question Mode so no marking UI is rendered
                        allQuestionResults: [],
                        files,
                        usageTokens: usageTracker.getTotalTokens(),
                        apiRequests: usageTracker.getTotalRequests(),
                        model: actualModel,
                        mathpixCallCount: 0, // Bypassed Mathpix!
                        totalCost: usageTracker.calculateCost(actualModel).total,
                        detectionResults: []
                    };

                    const sessionResult = await SessionManagementService.persistMarkingSession(markingContext);
                    
                    const finalOutput = {
                        success: true,
                        submissionId,
                        mode: 'Question',
                        sessionId: sessionResult.sessionId,
                        sessionTitle: sessionResult.sessionTitle,
                        unifiedSession: sessionResult.unifiedSession,
                        aiMessage,
                        requiresMarkingScheme: isUnsupportedWithoutScheme,
                        annotatedOutput: [],
                        results: [],
                        warning: "CONTENT_REJECTED",
                        processingStats: {
                            totalLLMTokens: usageTracker.getTotalTokens(),
                            mathpixCalls: 0
                        },
                        // Attach the PDF/File context so the frontend renders the user's upload card
                        ...(pdfContext && {
                            originalFileType: pdfContext.originalFileType,
                            originalPdfLink: pdfContext.originalPdfLink,
                            originalPdfDataUrl: pdfContext.originalPdfDataUrl,
                            originalFileName: pdfContext.originalFileName,
                            ...(pdfContext.pdfContexts && {
                                pdfContexts: pdfContext.pdfContexts
                            })
                        })
                    };

                    progressCallback({ type: 'complete', result: finalOutput });
                    console.log(`✅ [EARLY EXIT] Persisted rejected session: ${sessionResult.sessionId} | Reason: ${lastRejectionReason}`);
                    return finalOutput;

                } catch (persistError) {
                    console.error('❌ [EARLY EXIT] Failed to persist rejected session:', persistError);
                    throw new Error(lastRejectionReason); // Fallback to hard crash if database fails
                }
            }

            logGeometryComplete();

            // 📚 [DETERMINISTIC MULTI-PAPER VALIDATION & BUCKETING]:
            // Run before Page/Credit gating so multi-paper loose-image uploads and combined multi-paper PDFs
            // fail-fast cleanly, and multi-PDF uploads reuse paperBuckets for both P2 picker and P5 fan-out.
            const paperBuckets = PaperSplitterService.splitIntoPaperBuckets({
                standardizedPages,
                lightweightPages,
                geometryResults,
                interceptedSchemeImages: interceptedSchemeMeta.length > 0 ? interceptedSchemeMeta : interceptedSchemeImages,
                deferredSchemePdfFiles,
                files
            });

            // Early multi-cover-page rejection for single combined student PDFs (even when paired with a separate MS PDF)
            assertNoEarlyMultiCoverPdf({
                standardizedPages,
                geometryResults
            });

            // --- Post-Geometry Input Page & Credit Gating (Mark Scheme & ejected pages are exempt!) ---
            const studentRawPageCount = new Set(
                standardizedPages.map(p => (p as any)._rawPageIndex ?? p.pageIndex)
            ).size;
            console.log(`📊 [PAGE GATING] User ${userId || 'anonymous'} (${userPlan}): ${studentRawPageCount} student page(s) to grade (${standardizedPages.length} post-split page(s), ${interceptedSchemeImages.length} mark scheme page(s) exempted).`);

            // Pre-gate duplicate-question check for >50-page single-bucket uploads (before FREE_PAGE_LIMIT_EXCEEDED offers 25-page split buttons)
            const willTriggerOver50Gate =
                (isFreeUser && studentRawPageCount > MAX_FREE_PAGES) ||
                (!isProOrUltra && studentRawPageCount > MAX_PAGES_LIMIT);
            if (paperBuckets.length === 1 && willTriggerOver50Gate && lightweightPages.length > 0) {
                const firstWindow = lightweightPages.slice(0, 10);
                const midIdx = Math.max(10, Math.floor(lightweightPages.length / 2));
                const middleWindow = lightweightPages.slice(midIdx, midIdx + 10);
                const sampleMap = new Map<number, { imageData: string; fileName?: string; pageIndex: number }>();
                for (const p of [...firstWindow, ...middleWindow]) {
                    const idx = p.pageIndex ?? 0;
                    if (!sampleMap.has(idx) && p.imageData) {
                        sampleMap.set(idx, {
                            imageData: p.imageData,
                            fileName: p.originalFileName,
                            pageIndex: idx
                        });
                    }
                }
                const sampleLightPages = Array.from(sampleMap.values()).sort((a, b) => a.pageIndex - b.pageIndex);
                if (sampleLightPages.length >= 2) {
                    const { ClassificationMapper } = await import('./ClassificationMapper.js');
                    const sampleMapperResults = await ClassificationMapper.mapQuestionsToPages(
                        sampleLightPages,
                        usageTracker,
                        'fast',
                        debugClassification
                    );
                    PaperSplitterService.assertNoDuplicateQuestionsInMapperResults(sampleMapperResults, {
                        isPdf: standardizedPages.length > 0 && standardizedPages.every(p => /\.pdf$/i.test(p.originalFileName || '')),
                        pageCount: studentRawPageCount,
                        fileName: standardizedPages[0]?.originalFileName
                    });
                }
            }

            const buildDetectedPaperGroups = () =>
                buildDetectedPaperGroupsHelper({
                    paperBuckets,
                    studentRawPageCount,
                    maxFreePages: MAX_FREE_PAGES,
                    files,
                    interceptedSchemeMeta,
                    computeSubjectVote: computeGeoSubjectVote
                });

            // 1. Check Product Tier & Upload Limits (excluding Mark Scheme pages)
            if (isFreeUser && studentRawPageCount > MAX_FREE_PAGES) {
                const detectedPaperGroups = buildDetectedPaperGroups();
                throw new UserFacingError({
                    code: 'FREE_PAGE_LIMIT_EXCEEDED',
                    category: 'user_fixable',
                    shouldAlertAdmin: false,
                    requiresUpgrade: true,
                    detectedPaperGroups,
                    userMessage: buildFreePageLimitExceededMessage({
                        studentRawPageCount,
                        maxFreePages: MAX_FREE_PAGES,
                        detectedPaperGroups
                    }),
                    technicalMessage: `Free accounts are limited to grading ${MAX_FREE_PAGES} pages at a time (uploaded ${studentRawPageCount} student pages). Upgrade to Pro to grade full past papers.`
                });
            }
            if (!isProOrUltra && studentRawPageCount > MAX_PAGES_LIMIT) {
                throw new UserFacingError({
                    code: 'PDF_PAGE_LIMIT_EXCEEDED',
                    category: 'user_fixable',
                    shouldAlertAdmin: false,
                    userMessage:
                        `You uploaded **${studentRawPageCount} student pages**, which exceeds the maximum limit of **${MAX_PAGES_LIMIT} pages** per submission.\n\n` +
                        `**How to fix:** Please upload **1 paper at a time** (up to ${MAX_PAGES_LIMIT} student pages per submission).`,
                    technicalMessage: `Total upload exceeds the maximum limit of ${MAX_PAGES_LIMIT} pages/images. Processed ${studentRawPageCount} pages.`
                });
            }

            // 2. Check Financial Limits (only charge estimated cost for student/question pages, never Mark Scheme pages)
            if (userId && userId !== 'anonymous') {
                const exactEstimatedCost = studentRawPageCount * 0.020; // $0.02 per student page (Mathpix + Gemini tokens)
                const creditCheck = await checkCredits(userId, exactEstimatedCost, userPlan);

                if (!creditCheck.canProceed) {
                    if (creditCheck.errorCode === 'OVERDRAFT_LIMIT_EXCEEDED') {
                        const detectedPaperGroups = buildDetectedPaperGroups();
                        const creditsNeeded = creditCheck.creditsNeeded ?? Math.ceil(exactEstimatedCost * 100);
                        throw new UserFacingError({
                            code: 'OVERDRAFT_LIMIT_EXCEEDED',
                            category: 'user_fixable',
                            shouldAlertAdmin: false,
                            requiresUpgrade: true,
                            detectedPaperGroups,
                            userMessage: buildOverdraftLimitExceededMessage({
                                studentRawPageCount,
                                creditsNeeded,
                                remainingCredits: creditCheck.remaining,
                                detectedPaperGroups
                            }),
                            technicalMessage: creditCheck.warning || 'Overdraft safety limit exceeded.'
                        });
                    }
                    throw new Error(creditCheck.warning);
                }
            }

            // If Vision Orientation was deferred on a >50 raw page upload that passed after Mark Scheme exemption, run it now on the surviving student pages
            if (deferVisionUntilAfterPageGate && standardizedPages.length > 0) {
                await runVisionOrientationOnPages(standardizedPages);
                lightweightPages = await Promise.all(
                    standardizedPages.map(async page => {
                        const precomputedLight = (page as any)._lightweightImageData;
                        delete (page as any)._lightweightImageData;
                        return {
                            ...page,
                            imageData: precomputedLight || await ImageUtils.createLightweightCopy(page.imageData, 800)
                        };
                    })
                );
            }

            // 🚀 [BACKGROUND ORIGINAL FILE UPLOAD]:
            // Start uploading original files in the background right after page & credit gating passes,
            // so Firebase Storage uploads run concurrently with Classification, OCR, and Marking instead of blocking ~35s at the end!
            preUploadedOriginalFilesPromise = isAuthenticated
                ? SessionManagementService.uploadOriginalFiles(
                    files,
                    userId || 'anonymous',
                    submissionId,
                    true,
                    pdfContext
                )
                : undefined;

            // 📚 [MULTI-PAPER PARALLEL FAN-OUT & AGGREGATION]:
            // Single-paper uploads return 1 bucket and continue directly down the existing pipeline with zero regression.
            if (paperBuckets.length > 1) {
                progressCallback(
                    createProgressData(
                        2,
                        `Detected ${paperBuckets.length} papers (${paperBuckets.map(b => `${b.paperLabel}: ${b.standardizedPages.length}p`).join(', ')}). Marking in parallel...`,
                        MULTI_IMAGE_STEPS
                    )
                );

                const subResults = await Promise.all(
                    paperBuckets.map((bucket) => {
                        const childProgressCallback = (evt: any) => {
                            if (evt?.type === 'complete') return; // Suppress premature complete from child runs
                            progressCallback(evt);
                        };
                        return MarkingPipelineService.executePipeline(
                            req,
                            files,
                            submissionId,
                            {
                                ...options,
                                _preFlightPaperBucket: {
                                    ...bucket,
                                    skipPersistenceAndComplete: true
                                }
                            } as any,
                            childProgressCallback,
                            usageTracker
                        );
                    })
                );

                const aggregated = await PaperSplitterService.aggregateMultiPaperResults(subResults);

                const { unifiedSession } = await MarkingPersistenceService.persistSession(
                    files,
                    options,
                    submissionId,
                    startTime,
                    aggregated.sortedStandardizedPages,
                    aggregated.updatedQuestionResults,
                    aggregated.classificationResult,
                    aggregated.allClassificationResults,
                    aggregated.markingSchemesMap,
                    aggregated.reindexedDetectionResults,
                    options.customText || '',
                    aggregated.finalAnnotatedOutput,
                    aggregated.overallScore,
                    aggregated.totalPossibleScore,
                    aggregated.overallScoreText,
                    isPdf,
                    isMultiplePdfs || isMixedUpload,
                    pdfContext,
                    false,
                    stepTimings,
                    usageTracker.getTotalTokens(),
                    aggregated.combinedQuestionResponses,
                    usageTracker,
                    usageTracker.getMathpixPages(),
                    aggregated.allPagesOcrData,
                    preUploadedOriginalFilesPromise,
                    aggregated.precomputedPerformanceSummaryPromise
                );

                const finalOutput = {
                    success: true,
                    submissionId,
                    processingStats: {
                        apiUsed: getRealApiName(getRealModelName(actualModel)),
                        modelUsed: getRealModelName(actualModel),
                        selectedModel: actualModel,
                        totalMarks: aggregated.totalPossibleScore,
                        awardedMarks: aggregated.overallScore,
                        questionCount: aggregated.updatedQuestionResults.length,
                        usageTokens: usageTracker.getTotalTokens(),
                        mathpixCalls: usageTracker.getMathpixPages()
                    },
                    annotatedOutput: aggregated.finalAnnotatedOutput,
                    outputFormat: 'images',
                    originalInputType: isPdf ? 'pdf' : 'images',
                    unifiedSession,
                    results: aggregated.updatedQuestionResults,
                    metadata: {
                        totalQuestions: aggregated.updatedQuestionResults.length,
                        totalScore: aggregated.overallScore,
                        maxScore: aggregated.totalPossibleScore,
                        processingTime: (Date.now() - startTime) / 1000
                    },
                    sessionId: unifiedSession?.sessionId,
                    sessionStats: unifiedSession?.sessionStats || null,
                    ...(pdfContext && {
                        originalFileType: pdfContext.originalFileType,
                        originalPdfLink: pdfContext.originalPdfLink,
                        originalPdfDataUrl: pdfContext.originalPdfDataUrl,
                        originalFileName: pdfContext.originalFileName,
                        ...(pdfContext.pdfContexts && { pdfContexts: pdfContext.pdfContexts })
                    })
                };

                progressCallback({ type: 'complete', result: finalOutput });
                return finalOutput;
            }
            } // End of if (!preFlightBucket)

            // --- Preprocessing (Common for Multi-Page PDF & Multi-Image) ---
            progressCallback(createProgressData(2, `Preprocessing ${standardizedPages.length} image(s)...`, MULTI_IMAGE_STEPS));
            const logPreprocessingComplete = logStep('Preprocessing', 'image-processing');
            const preprocessedResults = await Promise.all(
                standardizedPages.map(page => ImageUtils.preProcessWithMetadata(page.imageData))
            );

            // Update image data and dimensions directly from single-pass Sharp output (avoids decoding 24 WebPs a second time)
            for (let i = 0; i < standardizedPages.length; i++) {
                const page = standardizedPages[i];
                const { imageData: displayImageData, ocrImageData, width: newW, height: newH } = preprocessedResults[i];
                page.imageData = displayImageData;
                if (ocrImageData) {
                    (page as any).ocrImageData = ocrImageData;
                }
                if (newW && newH) {
                    if (page.width !== newW || page.height !== newH) {
                        console.log(`📐 [DIMENSIONS] Refreshed Page ${page.pageIndex} dimensions after preprocessing: ${page.width}x${page.height} -> ${newW}x${newH}`);
                        page.width = newW;
                        page.height = newH;
                    }
                }
            }

            progressCallback(createProgressData(2, 'Image preprocessing complete.', MULTI_IMAGE_STEPS));
            logPreprocessingComplete();

            // ========================= START: IMPLEMENT STAGE 2 =========================
            // --- Stage 2: Parallel OCR/Classify (Common for Multi-Page PDF & Multi-Image) ---

            // --- 🧭 EARLY SUBJECT ROUTING (BEFORE CLASSIFICATION & STAGE 3 OCR) ---
            const geoSubjectVote = computeGeoSubjectVote(geometryResults);
            const geoUnsupportedSubjName = geometryResults
                .filter(g => !g?.is_marking_scheme)
                .map(g => g?.unsupported_subject_name)
                .find(Boolean);
            const customSchemeSubject = (inputMarkingScheme as any)?.examDetails?.subject || geoUnsupportedSubjName;
            const bucketGeoHints = geometryResults
                .filter(g => g?.is_cover_page && g?.paper_code_hint)
                .map(g => g?.paper_code_hint)
                .filter(Boolean);
            const geoPaperCodeHint = preFlightBucket?.paperCodeHint
                || (bucketGeoHints.length > 0 ? bucketGeoHints.join(' ') : geometryResults
                    .map(g => g?.paper_code_hint)
                    .filter((h): h is string => Boolean(h) && !/^P\d{5}A\d*$/i.test(String(h).trim()))
                    .join(' '));
            const bucketFileNames = standardizedPages
                .map(p => p?.originalFileName || '')
                .filter(Boolean);
            const uploadedFileNames = bucketFileNames.length > 0
                ? bucketFileNames
                : (Array.isArray(files) ? files.map(f => f?.originalname || '') : []);

            let subjectProfile: SubjectProfile = resolveSubjectProfile({
                detectedSubject: geoSubjectVote,
                subject: customSchemeSubject,
                paperCode: geoPaperCodeHint || (inputMarkingScheme as any)?.examDetails?.paperCode,
                customText: options.customText,
                fileNames: uploadedFileNames
            });

            progressCallback(createProgressData(3, `Running Classification on ${lightweightPages.length} pages...`, MULTI_IMAGE_STEPS));

            // --- Perform Classification on ALL Images (Question & Student Work) ---
            const logClassificationComplete = logStep('Classification', actualModel);

            // Parse explicit user marking scope from Student Input early so Stage-2 Classification
            // can skip out-of-scope pages/questions ($0 Stage-2 LLM cost) before meta-page filtering.
            const markingScope = earlyPrunedPdfMarkingScope || parseMarkingScope(options.customText);
            if (markingScope) {
                console.log(`🎯 [MARKING-SCOPE] Parsed explicit user scope: ${markingScope.label}`);
            }

            // Classify ALL images at once for better cross-page context (solves continuation page question number detection)
            // 🛑 CRITICAL: We pass the lightweightPages (Tier 2) which was already generated before Semantic Geometry
            // This prevents Gemini from doing massive inference on 2000px Mathpix images.
            let allClassificationResults = await ClassificationService.classifyMultipleImages(
                lightweightPages,
                actualModel as ModelType,  // Cast to ModelType
                debugClassification,  // debug (controlled by ENV)
                usageTracker,  // Pass tracker for auto-recording
                subjectProfile.ocrStrategy === 'VISION_VERBATIM',
                undefined,
                markingScope
            );

            logClassificationComplete();

            // Refine subjectProfile using extracted classification question text BEFORE Stage 3 OCR runs
            if (subjectProfile.key === 'MATHS') {
                const classTextSample = allClassificationResults
                    .flatMap(r => r.result?.questions || [])
                    .map((q: any) => `${q.text || ''} ${q.questionText || ''}`)
                    .join(' ')
                    .substring(0, 2000);
                if (classTextSample.trim()) {
                    subjectProfile = resolveSubjectProfile({
                        detectedSubject: geoSubjectVote,
                        paperCode: geoPaperCodeHint,
                        customText: options.customText,
                        fileNames: uploadedFileNames,
                        rawTextHint: classTextSample
                    });
                }
            }

            console.log(
                `🧭 [SUBJECT-ROUTER] Paper="${geoPaperCodeHint || uploadedFileNames[0] || 'Upload'}" -> Profile="${subjectProfile.key}" | Paradigm="${subjectProfile.paradigm}" | OCR="${subjectProfile.ocrStrategy}"`
            );

            // 🛡️ [SUBJECT GATE]: Confidence-aware subject verdict from explicit per-page votes.
            // Used to restrict DB question detection to papers of the same subject and to stop a single
            // DB match from overriding the routed subject.
            const subjectGate: SubjectGate = computeSubjectGate({
                geometryResults,
                resolvedProfileKey: subjectProfile.key,
                paperCodeHint: geoPaperCodeHint,
                hasUploadedMarkingScheme: Boolean((inputMarkingScheme as any)?.questions)
            });
            console.log(
                `🛡️ [SUBJECT-GATE] ${subjectGate.confident ? `Confident=${subjectGate.key}` : 'Not confident'} | ${subjectGate.reason}`
            );

            // --- 🛡️ BLANK CONTINUATION / OVERFLOW PAGE FILTER ---
            // 1. Collect all base question numbers (e.g. "15" from "15a") that have actual student work
            const answeredBaseQuestions = new Set<string>();
            for (const item of allClassificationResults) {
                if (item.result?.category === 'questionAnswer' && Array.isArray(item.result?.questions)) {
                    for (const q of item.result.questions) {
                        const baseNum = extractLeadingBaseQNum(q.questionNumber);
                        if (baseNum) answeredBaseQuestions.add(baseNum);
                    }
                }
            }

            // Helper to detect if extracted question text is just a "Question X continued" or English booklet "Extra space" stub
            const isContinuationStubText = (text?: string): boolean => {
                if (!text) return true;
                let cleaned = text
                    .replace(/question\s*\d+[a-z0-9().\s]*continued\.?/gi, '')
                    .replace(/turn\s+over/gi, '')
                    .replace(/leave\s+blank/gi, '')
                    .replace(/do\s+not\s+write\s+(in\s+|outside\s+)?this\s+(area|box)/gi, '')
                    .replace(/total\s+for\s+question\s+\d+\s+is\s+\d+\s+marks?/gi, '');

                for (const pattern of subjectProfile.overflowBoilerplatePatterns) {
                    cleaned = cleaned.replace(new RegExp(pattern.source, 'gi'), '');
                }
                cleaned = cleaned.trim();
                // If nothing meaningful remains after stripping continuation boilerplate, it's a blank overflow sheet
                return cleaned.length < 10;
            };

            // 2. Inspect questionOnly pages and reclassify blank overflow/continuation pages to 'metadata'
            for (const item of allClassificationResults) {
                if (item.result?.category === 'questionOnly') {
                    const questions = Array.isArray(item.result.questions) ? item.result.questions : [];

                    // Filter out individual question stubs that are just "Question X continued" or already answered on an earlier page
                    const realUnansweredQuestions = questions.filter((q: any) => {
                        const qText = q.text || q.questionText || '';
                        const subQuestions = Array.isArray(q.subQuestions) ? q.subQuestions : [];
                        const hasSubQuestionText = subQuestions.some((sq: any) => !isContinuationStubText(sq.text || sq.questionText));
                        const baseNum = extractLeadingBaseQNum(q.questionNumber);

                        // Preserve explicit blank-page unattempted stubs from Map Pass (e.g. Q22, Q23, Q24)
                        // as long as their base question was NOT already answered on an earlier page.
                        if (q.isUnattempted === true && baseNum && !answeredBaseQuestions.has(baseNum)) {
                            return true;
                        }

                        const isStub = isContinuationStubText(qText) && !hasSubQuestionText;
                        const isAlreadyAnsweredBaseQ = Boolean(baseNum && answeredBaseQuestions.has(baseNum) && isStub);

                        return !isStub && !isAlreadyAnsweredBaseQ;
                    });

                    if (realUnansweredQuestions.length === 0) {
                        console.log(
                            `🧹 [OVERFLOW-FILTER] Page ${item.pageIndex} classified as questionOnly has only continuation headers/stubs. Reclassifying to 'metadata'.`
                        );
                        item.result.category = 'metadata';
                        item.result.questions = [];
                    } else if (realUnansweredQuestions.length !== questions.length) {
                        item.result.questions = realUnansweredQuestions;
                    }
                }
            }

            // --- 🌟 SEPARATE ANSWER & HYBRID DONOR STEM HARVESTING ---
            // When a student writes answers on separate notebook pages (or partially on the booklet and
            // partially on notebook pages), `questionOnly` pages contain the printed question stems and
            // sub-question prompts for questions answered in `answeredBaseQuestions`.
            // 1. Harvest printed stems & sub-question texts from `questionOnly` pages into `donatedStemsByQNum`.
            // 2. If an entire uploaded source file has ZERO `questionAnswer` pages (a pure Reference Question Paper PDF)
            //    while other files have student work, eject all pages of that Reference Question Paper from
            //    `standardizedPages` and `allClassificationResults` so they are never OCR'd by Mathpix or rendered in output!
            // 3. In multi-page exams (> 3 pages) that have student work, reclassify any remaining `questionOnly`
            //    pages inside partially-answered booklets to `'metadata'` so `QuestionModeHandlerService` does not solve them.
            const donatedStemsByQNum = new Map<string, {
                text: string;
                subQuestionsMap: Map<string, string>;
                donorImageData?: string;
            }>();
            let ejectedPureReferenceFiles = false;

            if (answeredBaseQuestions.size > 0) {
                for (const item of allClassificationResults) {
                    if (item.result?.category === 'questionOnly' && Array.isArray(item.result?.questions)) {
                        const donorPage = standardizedPages.find(p => p.pageIndex === item.pageIndex);
                        for (const q of item.result.questions) {
                            const baseNum = extractLeadingBaseQNum(q.questionNumber);
                            if (!baseNum || !answeredBaseQuestions.has(baseNum)) continue;

                            if (!donatedStemsByQNum.has(baseNum)) {
                                donatedStemsByQNum.set(baseNum, {
                                    text: '',
                                    subQuestionsMap: new Map<string, string>(),
                                    donorImageData: donorPage?.imageData
                                });
                            }
                            const entry = donatedStemsByQNum.get(baseNum)!;
                            const qText = (q.text || (q as any).questionText || '').trim();
                            if (qText && qText !== 'null' && qText.length > entry.text.length) {
                                entry.text = qText;
                            }

                            const harvestSubQuestions = (subs: any[], prefix: string = '') => {
                                if (!Array.isArray(subs)) return;
                                for (const sq of subs) {
                                    const rawPart = String(sq.part || '').replace(/[()\s]/g, '').toLowerCase();
                                    const fullPart = prefix ? `${prefix}${rawPart}` : rawPart;
                                    const sqText = (sq.text || (sq as any).questionText || '').trim();
                                    if (fullPart && sqText && sqText !== 'null') {
                                        const existingSqText = entry.subQuestionsMap.get(fullPart) || '';
                                        if (sqText.length > existingSqText.length) {
                                            entry.subQuestionsMap.set(fullPart, sqText);
                                        }
                                    }
                                    if (Array.isArray(sq.subQuestions)) {
                                        harvestSubQuestions(sq.subQuestions, fullPart);
                                    }
                                }
                            };
                            harvestSubQuestions(q.subQuestions);
                        }
                    }
                }

                // Detect Pure Reference Question Paper files (files with >= 2 pages and 0 `questionAnswer` pages)
                const getSourceFileKey = (p: StandardizedPage) =>
                    `${(p as any)._sourceIndex ?? 'img'}_${p.originalFileName || 'default'}`;

                const fileAnswerCounts = new Map<string, { total: number; answered: number; questionOnly: number; name: string }>();
                for (const page of standardizedPages) {
                    const key = getSourceFileKey(page);
                    const stat = fileAnswerCounts.get(key) || { total: 0, answered: 0, questionOnly: 0, name: page.originalFileName || 'default' };
                    stat.total++;
                    const cls = allClassificationResults.find(r => r.pageIndex === page.pageIndex);
                    if (cls?.result?.category === 'questionAnswer') {
                        stat.answered++;
                    } else if (cls?.result?.category === 'questionOnly') {
                        stat.questionOnly++;
                    }
                    fileAnswerCounts.set(key, stat);
                }

                const hasAnsweredFile = Array.from(fileAnswerCounts.values()).some(s => s.answered > 0);
                const pureReferenceFileKeys = new Set<string>();
                if (hasAnsweredFile && fileAnswerCounts.size >= 2) {
                    fileAnswerCounts.forEach((stat, key) => {
                        // Only eject genuine reference question papers (must have questionOnly pages, and when a
                        // markingScope is active, must have actually donated stems so out-of-scope student-work
                        // images skipped by markingScope are kept unmarked in the annotated output).
                        if (
                            stat.answered === 0 &&
                            stat.total >= 2 &&
                            stat.questionOnly > 0 &&
                            (!markingScope || donatedStemsByQNum.size > 0)
                        ) {
                            pureReferenceFileKeys.add(key);
                            console.log(
                                `📑 [SEPARATE-ANSWER DEMUX] Ejecting Reference Question Paper "${stat.name}" (${stat.total} pages, 0 student work) after harvesting ${donatedStemsByQNum.size} question stem(s).`
                            );
                        }
                    });
                }

                if (pureReferenceFileKeys.size > 0) {
                    const keptPages: StandardizedPage[] = [];
                    const keptClassifications: typeof allClassificationResults = [];
                    const oldToCompactedIdx = new Map<number, number>();

                    for (const page of standardizedPages) {
                        if (!pureReferenceFileKeys.has(getSourceFileKey(page))) {
                            const newIdx = keptPages.length;
                            oldToCompactedIdx.set(page.pageIndex, newIdx);
                            keptPages.push({ ...page, pageIndex: newIdx });
                        }
                    }

                    const remapNodePageIdx = (node: any, newIdx: number) => {
                        if (!node || typeof node !== 'object') return;
                        node.pageIndex = newIdx;
                        node.sourceImageIndex = newIdx;
                        node.sourceImageIndices = [newIdx];
                        if (Array.isArray(node.studentWorkLines)) {
                            node.studentWorkLines.forEach((l: any) => {
                                if (l && typeof l === 'object') {
                                    l.pageIndex = newIdx;
                                    if (l.position) l.position.pageIndex = newIdx;
                                }
                            });
                        }
                        if (Array.isArray(node.subQuestions)) {
                            node.subQuestions.forEach((sq: any) => remapNodePageIdx(sq, newIdx));
                        }
                    };

                    for (const cls of allClassificationResults) {
                        const newIdx = oldToCompactedIdx.get(cls.pageIndex);
                        if (newIdx !== undefined) {
                            if (Array.isArray(cls.result?.questions)) {
                                cls.result.questions.forEach((q: any) => remapNodePageIdx(q, newIdx));
                            }
                            keptClassifications.push({
                                ...cls,
                                pageIndex: newIdx
                            });
                        }
                    }

                    standardizedPages = keptPages;
                    allClassificationResults = keptClassifications;
                    ejectedPureReferenceFiles = true;
                }
            }

            PaperSplitterService.assertSinglePaperClassification(allClassificationResults, {
                isPdf: standardizedPages.length > 0 && standardizedPages.every(p => /\.pdf$/i.test(p.originalFileName || '')),
                pageCount: standardizedPages.length,
                fileName: standardizedPages[0]?.originalFileName,
                isUserSelectedPageChunk
            });

            // Apply explicit user marking scope (parsed above) and blank-page preservation before meta-page filtering
            const hasAnyStudentWorkBeforeScope =
                answeredBaseQuestions.size > 0 ||
                allClassificationResults.some(r => r.result?.category === 'questionAnswer');

            const { excludedPageIndices, preservedBlankQuestionPageIndices } = applyScopeAndBlankPageHandling({
                allClassificationResults,
                markingScope,
                hasAnyStudentWork: hasAnyStudentWorkBeforeScope,
                ejectedPureReferenceFiles
            });

            if (excludedPageIndices.length > 0) {
                console.log(`✂️ [MARKING-SCOPE] Excluded out-of-scope page indices: ${excludedPageIndices.join(', ')} (${markingScope?.label})`);
                // Narrow the frontend scanning thumbnails down to only the in-scope pages (e.g. "mark Q1, Q2" -> 1-2 pages instead of all 20)
                try {
                    const excludedSet = new Set(excludedPageIndices);
                    const inScopeEntries = standardizedPages
                        .map((page, idx) => ({ page, idx }))
                        .filter(({ idx }) => !excludedSet.has(idx))
                        .slice(0, 25);
                    if (inScopeEntries.length > 0 && inScopeEntries.length < standardizedPages.length) {
                        const scopedThumbnails = await Promise.all(
                            inScopeEntries.map(async ({ page, idx }) => {
                                const cached = sseThumbnailCache.get(idx);
                                if (cached) return cached;
                                return ImageUtils.createLightweightCopy(page.imageData, 260);
                            })
                        );
                        progressCallback({
                            ...createProgressData(3, `Focusing on ${inScopeEntries.length} in-scope page(s)...`, MULTI_IMAGE_STEPS),
                            convertedThumbnails: scopedThumbnails
                        } as any);
                    }
                } catch (scopeThumbErr) {
                    console.warn('[PDF-THUMBNAILS] Failed to narrow SSE preview thumbnails to marking scope:', scopeThumbErr);
                }
            }
            if (preservedBlankQuestionPageIndices.length > 0) {
                console.log(`📋 [BLANK-QUESTION-KEEP] Preserved blank question page(s) [${preservedBlankQuestionPageIndices.join(', ')}] in Marking Mode so the total denominator reflects the full exam.`);
            }

            // ========================= CATEGORY OVERRIDE (BEFORE SPLIT) =========================
            // [REMOVED] Override 1: Drawing-only pages → questionOnly
            // User requested to preserve drawing detection even if text is minimal.
            /*
            const questionAnswerPages = allClassificationResults.filter(r => r.result?.category === 'questionAnswer');
            if (questionAnswerPages.length > 0) {
                const allWorkIsDrawingsOnly = questionAnswerPages.every(r => {
                    const questions = r.result?.questions || [];
                    return questions.every((q: any) => {
                        const hasDrawing = q.hasStudentDrawing === true;
                        // Summarize all work lines (top-level + sub-questions)
                        const workLines = [
                            ...(q.studentWorkLines || []),
                            ...(q.subQuestions?.flatMap((sq: any) => sq.studentWorkLines || []) || [])
                        ];
                        // Only override if there is a drawing but almost zero text work
                        const hasMinimalText = workLines.length < 2;
                        return hasDrawing && hasMinimalText;
                    });
                });

                if (allWorkIsDrawingsOnly) {
                    console.log('📐 [DRAWING OVERRIDE] All student work is drawings only, overriding to questionOnly');
                    questionAnswerPages.forEach(r => {
                        if (r.result) r.result.category = 'questionOnly';
                    });
                }
            }
            */

            // Override 3: 90% Student Work Rule
            // If >= 90% of the document has student work, treat the remaining questionOnly pages (that actually contain questions) as student work too
            // (Likely a neat drawing or subtle work the AI missed)
            const hasPageQuestions = (r: any) =>
                (Array.isArray(r.result?.questions) && r.result.questions.length > 0) ||
                (Array.isArray((r.result as any)?.mapperHints) && (r.result as any).mapperHints.length > 0);

            const nonMetadataPages = allClassificationResults.filter(r =>
                r.result?.category !== 'metadata' &&
                r.result?.category !== 'frontPage' &&
                (r.result?.category === 'questionAnswer' || hasPageQuestions(r))
            );
            const studentWorkPages = nonMetadataPages.filter(r => r.result?.category === 'questionAnswer');

            if (nonMetadataPages.length > 5 && (studentWorkPages.length / nonMetadataPages.length) >= 0.9) {
                console.log(`🚀 [OVERRIDE] 90% Rule Triggered: ${studentWorkPages.length}/${nonMetadataPages.length} pages have student work. Overriding questionOnly pages with questions to questionAnswer for consistency.`);
                allClassificationResults.forEach(r => {
                    if (r.result?.category === 'questionOnly') {
                        r.result.category = hasPageQuestions(r) ? 'questionAnswer' : 'metadata';
                    }
                });
            } else if (nonMetadataPages.length > 2 && (studentWorkPages.length / nonMetadataPages.length) > 0.5) {
                // NEW: 50% Safety Rule
                console.log(`🚀 [OVERRIDE] 50% Rule Triggered: ${studentWorkPages.length}/${nonMetadataPages.length} pages have student work. Overriding questionOnly pages with questions to questionAnswer for consistency.`);
                allClassificationResults.forEach(r => {
                    if (r.result?.category === 'questionOnly') {
                        r.result.category = hasPageQuestions(r) ? 'questionAnswer' : 'metadata';
                    }
                });
            }

            // Override 2: FrontPage → questionOnly ONLY when the entire upload is frontPage/metadata (0 student work AND 0 questionOnly pages with questions)
            const hasActualStudentWork = allClassificationResults.some(r => r.result?.category === 'questionAnswer');
            const hasQuestionPagesWithContent = allClassificationResults.some(r => r.result?.category === 'questionOnly' && hasPageQuestions(r));
            const hasFrontPages = allClassificationResults.some(r => r.result?.category === 'frontPage');

            if (!hasActualStudentWork && !hasQuestionPagesWithContent && hasFrontPages) {
                console.log('📄 [FRONTPAGE OVERRIDE] Pure cover/frontPage upload detected, converting frontPages to questionOnly for text-only response');
                allClassificationResults.forEach(r => {
                    if (r.result?.category === 'frontPage') {
                        r.result.category = 'questionOnly';
                    }
                });
            }

            // Save original results BEFORE split for mode detection
            const originalClassificationResults = [...allClassificationResults];

            // ========================= PERFECT SPLIT: USE MODE SPLIT SERVICE =========================
            const splitResult = ModeSplitService.splitMixedContent(standardizedPages, allClassificationResults);

            // Extract split structures for later use
            const questionOnlyPages = splitResult.questionOnlyPages;
            const questionOnlyClassificationResults = splitResult.questionOnlyClassificationResults;

            // Use final structures for pipeline
            standardizedPages = splitResult.finalPages;
            allClassificationResults = splitResult.finalClassificationResults;
            //=================================================================================================


            // Combine questions from all images
            // Merge questions with same questionNumber across pages (for multi-page questions like Q21)
            const questionsByNumber = new Map<string, Array<{ question: any; pageIndex: number }>>();
            const questionsWithoutNumber: Array<{ question: any; pageIndex: number }> = [];

            allClassificationResults.forEach(({ pageIndex, result }) => {
                if (result.questions && Array.isArray(result.questions)) {
                    result.questions.forEach((question: any) => {
                        const qNum = question.questionNumber;
                        const individualPageIndex = question.pageIndex !== undefined ? question.pageIndex : pageIndex;

                        // Only merge if questionNumber exists and is not null/undefined
                        if (qNum && qNum !== 'null' && qNum !== 'undefined') {
                            // Extract the entire base number (e.g. '12' from '12.1' or '12a')
                            const numMatch = String(qNum).match(/^(\d+)/);
                            const baseNumStr = numMatch ? numMatch[1] : String(qNum);
                            
                            if (!questionsByNumber.has(baseNumStr)) {
                                questionsByNumber.set(baseNumStr, []);
                            }
                            questionsByNumber.get(baseNumStr)!.push({
                                question,
                                pageIndex: individualPageIndex
                            });
                        } else {
                            // No question number - can't merge, keep as separate entry
                            questionsWithoutNumber.push({
                                question,
                                pageIndex: individualPageIndex
                            });
                        }
                    });
                }
            });


            // Merge questions with same questionNumber
            const allQuestions: any[] = [];

            // Helper to hydrate missing question & sub-question stems from donatedStemsByQNum
            const hydrateQuestionWithDonatedStems = (qObj: any, baseQNum: string) => {
                const donated = donatedStemsByQNum.get(baseQNum);
                if (!donated) return qObj;

                // Mark this question as residing on a separate handwritten answer sheet (no physical printed stem on page)
                qObj.isSeparateAnswerSheet = true;

                // 1. Hydrate main question stem if missing or contaminated/short (e.g. "You are advised to plan..." header on an answer page)
                const currentText = (qObj.text && qObj.text !== 'null') ? String(qObj.text).trim() : '';
                if (donated.text && (!currentText || currentText.length < 10 || donated.text.length > currentText.length * 1.5)) {
                    qObj.text = currentText && !donated.text.toLowerCase().includes(currentText.toLowerCase().slice(0, 25))
                        ? `${donated.text}\n${currentText}`
                        : donated.text;
                }

                // 2. Hydrate existing sub-questions and inject any sub-question texts from the donor PDF
                const existingSubQs = Array.isArray(qObj.subQuestions) ? qObj.subQuestions : [];
                const normalizePartKey = (p: string) =>
                    String(p || '').replace(new RegExp(`^0*${baseQNum}`, 'i'), '').replace(/[()\s]/g, '').toLowerCase();

                existingSubQs.forEach((sq: any) => {
                    sq.isSeparateAnswerSheet = true;
                    const partKey = normalizePartKey(sq.part || '');
                    const donatedSqText = donated.subQuestionsMap.get(partKey);
                    const curSqText = (sq.text && sq.text !== 'null') ? String(sq.text).trim() : '';
                    if ((!curSqText || curSqText.length < 5) && donatedSqText) {
                        sq.text = donatedSqText;
                    }
                });

                // If the notebook question has no subQuestions array yet, but donatedStems has sub-question prompts,
                // attach them to qObj.text so both Question Detection and the Marking AI see the full sub-question wording & marks
                if (donated.subQuestionsMap.size > 0) {
                    const fullStemParts: string[] = [];
                    if (qObj.text && qObj.text !== 'null') fullStemParts.push(String(qObj.text).trim());
                    donated.subQuestionsMap.forEach((sqText, partKey) => {
                        const alreadyInMain = fullStemParts.some(p => p.toLowerCase().includes(sqText.toLowerCase().slice(0, 25)));
                        if (!alreadyInMain) {
                            fullStemParts.push(`(${partKey}) ${sqText}`);
                        }
                    });
                    qObj.text = fullStemParts.join('\n');
                }

                return qObj;
            };

            const hasInstanceStudentWork = (q: any): boolean => {
                if (!q) return false;
                if (q.hasStudentDrawing === true) return true;
                if (Array.isArray(q.studentWorkLines) && q.studentWorkLines.length > 0) return true;
                if (q.studentWork && q.studentWork !== 'null' && String(q.studentWork).trim().length > 0) return true;
                if (Array.isArray(q.subQuestions)) {
                    return q.subQuestions.some((sq: any) => hasInstanceStudentWork(sq));
                }
                return false;
            };

            // Process merged questions
            questionsByNumber.forEach((questionInstances, questionNumber) => {
                if (questionInstances.length === 1) {
                    // Single page - hydrate with donated stems if needed
                    const { question, pageIndex } = questionInstances[0];
                    hydrateQuestionWithDonatedStems(question, questionNumber);
                    const page = standardizedPages.find(p => p.pageIndex === pageIndex);
                    allQuestions.push({
                        ...question,
                        sourceImage: page?.originalFileName || 'unknown',
                        sourceImageIndex: pageIndex
                    });
                } else {
                    // Multiple pages with same questionNumber - merge them
                    const isVerbatimProse = subjectProfile?.ocrStrategy === 'VISION_VERBATIM';
                    const isContaminatedStem = (q: any): boolean => {
                        if (!q || !q.text) return false;
                        const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                        const stem = norm(q.text);
                        if (stem.length < 15) return false;
                        const work = norm((q.studentWorkLines || []).map((l: any) => l?.t || '').join(' ') || q.studentWork || '');
                        return work.length > 0 && work.includes(stem.slice(0, 40));
                    };

                    const sortedInstances = [...questionInstances].sort((a, b) => {
                        const textA = a.question.text || '';
                        const textB = b.question.text || '';

                        const isBlankA = textA.toUpperCase().includes('BLANK PAGE');
                        const isBlankB = textB.toUpperCase().includes('BLANK PAGE');
                        if (isBlankA && !isBlankB) return 1;
                        if (!isBlankA && isBlankB) return -1;

                        if (isVerbatimProse) {
                            const cA = isContaminatedStem(a.question);
                            const cB = isContaminatedStem(b.question);
                            if (cA && !cB) return 1;
                            if (!cA && cB) return -1;
                        }

                        const wA = getInstanceMinWeight(a.question, questionNumber);
                        const wB = getInstanceMinWeight(b.question, questionNumber);
                        if (Math.abs(wA - wB) > 0.00001) {
                            return wA - wB;
                        }

                        return textB.length - textA.length;
                    });

                    const pageWithText = sortedInstances[0];

                    // 🛡️ ANCHOR FIX: Always anchor `sourceImageIndex` to the first page that has actual student work,
                    // NOT `pageWithText` (which may be a blank printed booklet page in hybrid mode).
                    const firstInstanceWithWork = questionInstances.find(inst => hasInstanceStudentWork(inst.question)) || pageWithText;
                    const anchorPageIndex = firstInstanceWithWork.pageIndex;

                    const combinedStudentWork = questionInstances
                        .map(({ question }) => question.studentWork)
                        .filter(sw => sw && sw !== 'null' && sw.trim().length > 0)
                        .join('\n');

                    const combinedParentLines: any[] = [];
                    questionInstances.forEach(({ question, pageIndex }) => {
                        if (question.studentWorkLines && Array.isArray(question.studentWorkLines)) {
                            question.studentWorkLines.forEach((line: any) => {
                                combinedParentLines.push({
                                    ...line,
                                    pageIndex: line.pageIndex !== undefined ? line.pageIndex : pageIndex
                                });
                            });
                        }
                    });

                    const mergedSubQuestionsMap = new Map<string, any>();
                    const subQuestionPageIndices = new Set<number>();

                    const mergeSubQuestionsRecursive = (existingMap: Map<string, any>, incomingSubQuestions: any[], pIdx: number) => {
                        incomingSubQuestions.forEach((subQ: any) => {
                            const part = subQ.part || '';
                            if (hasInstanceStudentWork(subQ)) {
                                subQuestionPageIndices.add(pIdx);
                            }

                            if (!existingMap.has(part)) {
                                existingMap.set(part, {
                                    ...subQ,
                                    pageIndex: pIdx,
                                    studentWorkLines: subQ.studentWorkLines || [],
                                    subQuestions: subQ.subQuestions ? [] : undefined
                                });
                            }

                            const existing = existingMap.get(part)!;

                            // Prefer anchoring sub-question pageIndex to the page that actually has student work
                            if (hasInstanceStudentWork(subQ) && (!existing.studentWorkLines || existing.studentWorkLines.length === 0)) {
                                existing.pageIndex = pIdx;
                            }

                            if (subQ.text && subQ.text !== 'null' && !existing.text) {
                                existing.text = subQ.text;
                            }

                            if (subQ.studentWork && subQ.studentWork !== 'null' && subQ.studentWork.trim().length > 0) {
                                if (existing.studentWork && !existing.studentWork.includes(subQ.studentWork)) {
                                    existing.studentWork += '\n' + subQ.studentWork;
                                } else if (!existing.studentWork) {
                                    existing.studentWork = subQ.studentWork;
                                }
                            }

                            if (subQ.studentWorkLines && Array.isArray(subQ.studentWorkLines)) {
                                subQ.studentWorkLines.forEach((newLine: any) => {
                                    const stampedLine = {
                                        ...newLine,
                                        pageIndex: newLine.pageIndex !== undefined ? newLine.pageIndex : pIdx
                                    };

                                    const isDuplicate = existing.studentWorkLines.some((l: any) =>
                                        l.text === stampedLine.text &&
                                        l.position?.x === stampedLine.position?.x &&
                                        l.position?.y === stampedLine.position?.y
                                    );
                                    if (!isDuplicate) existing.studentWorkLines.push(stampedLine);
                                });
                            }

                            if (subQ.hasStudentDrawing) {
                                existing.hasStudentDrawing = true;
                                if (existing.studentWork && !existing.studentWork.includes('[DRAWING]')) {
                                    existing.studentWork += '\n[DRAWING]';
                                } else if (!existing.studentWork) {
                                    existing.studentWork = '[DRAWING]';
                                }
                            }

                            if (subQ.subQuestions && Array.isArray(subQ.subQuestions)) {
                                if (!existing.subQuestionsMap) existing.subQuestionsMap = new Map<string, any>();
                                mergeSubQuestionsRecursive(existing.subQuestionsMap, subQ.subQuestions, pIdx);
                            }
                        });
                    };

                    const finalizeSubQuestions = (subQsMap: Map<string, any>): any[] => {
                        return Array.from(subQsMap.values()).map(subQ => {
                            if (subQ.subQuestionsMap) {
                                subQ.subQuestions = finalizeSubQuestions(subQ.subQuestionsMap);
                                delete subQ.subQuestionsMap;
                            }
                            return subQ;
                        });
                    };

                    questionInstances.forEach(({ question, pageIndex }) => {
                        if (question.subQuestions && Array.isArray(question.subQuestions)) {
                            mergeSubQuestionsRecursive(mergedSubQuestionsMap, question.subQuestions, pageIndex);
                        }
                    });

                    // Only include pages that actually contain student work in `sourceImageIndices` if at least one exists
                    const workPageIndices = questionInstances
                        .filter(inst => hasInstanceStudentWork(inst.question))
                        .map(inst => inst.pageIndex);
                    const basePageIndices = workPageIndices.length > 0
                        ? workPageIndices
                        : questionInstances.map(({ pageIndex }) => pageIndex);
                    const allPageIndices = [...new Set([...basePageIndices, ...Array.from(subQuestionPageIndices)])].sort((a, b) => a - b);

                    const merged = {
                        ...pageWithText.question,
                        questionNumber: questionNumber,
                        text: pageWithText.question.text && pageWithText.question.text !== 'null'
                            ? pageWithText.question.text
                            : questionInstances[0].question.text,
                        studentWork: combinedStudentWork || firstInstanceWithWork.question.studentWork || null,
                        studentWorkLines: combinedParentLines.length > 0 ? combinedParentLines : (firstInstanceWithWork.question.studentWorkLines || []),
                        sourceImage: standardizedPages.find(p => p.pageIndex === anchorPageIndex)?.originalFileName || 'unknown',
                        sourceImageIndex: anchorPageIndex,
                        sourceImageIndices: allPageIndices,
                        subQuestions: mergedSubQuestionsMap.size > 0
                            ? finalizeSubQuestions(mergedSubQuestionsMap)
                            : firstInstanceWithWork.question.subQuestions || [],
                        confidence: Math.max(...questionInstances.map(({ question }) => question.confidence || 0.9))
                    };

                    hydrateQuestionWithDonatedStems(merged, questionNumber);
                    allQuestions.push(merged);
                }
            });

            // Add questions without question number (can't be merged)
            questionsWithoutNumber.forEach(({ question, pageIndex }) => {
                const page = standardizedPages.find(p => p.pageIndex === pageIndex);
                allQuestions.push({
                    ...question,
                    sourceImage: page?.originalFileName || 'unknown',
                    sourceImageIndex: pageIndex
                });
            });

            // Sort questions by question number (natural sort for numbers like 1, 2, 3, 10, 11)
            allQuestions.sort((a, b) => {
                const numA = parseInt(a.questionNumber) || 0;
                const numB = parseInt(b.questionNumber) || 0;
                return numA - numB;
            });

            // Create combined classification result with enhanced mixed content detection
            // TRUST stage-2 results (and overrides) over stage-1 mapper
            const hasAnyStudentWork = allClassificationResults.some(r => r.result?.category === "questionAnswer");
            const hasMixedContent = allClassificationResults.some(r => r.result?.category !== allClassificationResults[0]?.result?.category);

            // Determine combined category using stage-2 results
            const allCategories = allClassificationResults.map(r => r.result?.category).filter(Boolean);
            const combinedCategory: "questionOnly" | "questionAnswer" | "metadata" =
                allCategories.every(cat => cat === "questionOnly") ? "questionOnly" :
                    allCategories.every(cat => cat === "metadata" || cat === "frontPage") ? "metadata" :
                        "questionAnswer";

            let classificationResult = {
                category: combinedCategory,
                reasoning: allClassificationResults[0]?.result?.reasoning || 'Multi-image classification',
                questions: allQuestions,
                text: (allClassificationResults[0]?.result?.questions && allClassificationResults[0]?.result?.questions[0]) ? allClassificationResults[0]?.result?.questions[0].text : (allClassificationResults[0]?.result?.extractedQuestionText || allClassificationResults[0]?.result?.text || ''),
                apiUsed: allClassificationResults[0]?.result?.apiUsed || 'Unknown',
                usageTokens: allClassificationResults.reduce((sum, { result }) => sum + (result.usageTokens || 0), 0),
                hasMixedContent: hasMixedContent,
                hasAnyStudentWork: hasAnyStudentWork,
                hasFrontPages: hasFrontPages
            };

            // Add classification tokens to total usage
            if (classificationResult.usageTokens) {
                totalLLMTokens += classificationResult.usageTokens;
                // Note: Tokens already recorded by ClassificationMapper.mapQuestionsToPages()
            }

            // For question mode, use the questions array; for marking mode, use extractedQuestionText
            const globalQuestionText = classificationResult?.questions && classificationResult.questions.length > 0
                ? classificationResult.questions[0].text
                : '';


            logClassificationComplete();

            // ========================= AUTO-ROTATION =========================
            // Check for rotation detected by AI and correct the image
            // This ensures OCR and Annotation work on the upright image
            const rotationPromises = allClassificationResults.map(async ({ pageIndex, result }, index) => {
                // Handle Rotation (90deg, -90deg, 180deg)
                const rotation = result.rotation;
                if (rotation && typeof rotation === 'number' && rotation !== 0) {
                    const page = standardizedPages.find(p => p.pageIndex === pageIndex);
                    if (!page) {
                        console.warn(`⚠️ [ROTATION] Could not find page for index ${pageIndex}, skipping rotation.`);
                        return;
                    }
                    console.log(`🔄 [ROTATION] Page ${pageIndex + 1} (${page.originalFileName}) detected rotation: ${rotation}°`);
                    try {
                        const rotatedBuffer = await ImageUtils.rotateImage(page.imageData, rotation);
                        page.imageData = `data:image/png;base64,${rotatedBuffer.toString('base64')}`;

                        // Swap dimensions if 90 or 270
                        if (rotation === 90 || rotation === 270) {
                            const temp = page.width;
                            page.width = page.height;
                            page.height = temp;
                        }
                        console.log(`✅ [ROTATION] Page ${pageIndex + 1} rotated successfully.`);
                    } catch (rotError) {
                        console.error(`❌ [ROTATION] Failed to rotate page ${pageIndex + 1}:`, rotError);
                    }
                }
            });
            await Promise.all(rotationPromises);

            // ========================= MARK METADATA PAGES =========================
            // Log metadata pages (they will skip OCR processing)
            allClassificationResults.forEach(({ pageIndex, result }, index) => {
                const isMetadataPage = result.category === "metadata";

                if (isMetadataPage) {
                    const fileName = standardizedPages.find(p => p.pageIndex === pageIndex)?.originalFileName || 'unknown';
                }
            });

            // ========================= ENHANCED MODE DETECTION =========================
            // Check ORIGINAL results (before split), not filtered marking-only results
            const hasStudentWorkPages = originalClassificationResults.some(r => r.result?.category === 'questionAnswer');
            const hasQuestionOnlyPages = originalClassificationResults.every(r =>
                r.result?.category === 'questionOnly' ||
                r.result?.category === 'frontPage' ||
                r.result?.category === 'metadata'
            );
            const isQuestionMode = hasQuestionOnlyPages && originalClassificationResults.length > 0 && !hasStudentWorkPages;
            // Simplified binary mode: either pure Question Mode (no student work) or pure Marking Mode (no mixed mode)
            const isMixedContent = false;

            const fileNamePaperHintMatch = uploadedFileNames
                .join(' ')
                .replace(/1m11/ig, '1MA1')
                .match(/(?:^|[^a-z0-9]|edexcel|aqa|ocr|wjec|eduqas|cie)(1ma1|8300|8700|8702|8461|8462|8463|8464|j560|j351|9ma0|wma1[1-4]|wma0[1-3]|wme0[1-3]|wst0[1-3]|wfm0[1-3]|wdm11|wdm01|1bi0|1ch0|1ph0|1en0)[-_\/ ]([0-9]{1,2}[a-z]?|[a-z][0-9]{1,2})\b/i);
            const fileNamePaperHint = fileNamePaperHintMatch
                ? `${fileNamePaperHintMatch[1].toUpperCase()}/${fileNamePaperHintMatch[2].toUpperCase()}`
                : undefined;
            const extractedGeoPaperCode = geoPaperCodeHint
                ? geoPaperCodeHint.match(/\b([0-9A-Z]{4,6}\/[0-9A-Z]{1,3}|8700\/[12]|8300\/[123][FH]|1MA1\/[123][FH]|J560\/0[1-6])\b/i)?.[1]
                : undefined;
            const cleanGeoPaperHint = extractedGeoPaperCode || fileNamePaperHint;
            const validatedCustomHint = isValidExamPaperHint(options.customText) ? options.customText!.trim() : undefined;
            const effectiveExamPaperHint = validatedCustomHint || cleanGeoPaperHint;

            console.log(`🔍 [MODE DETECTION] Analysis (AFTER overrides):`);
            console.log(`  - All question-only: ${isQuestionMode}`);
            console.log(`  - Has mixed content: ${isMixedContent}`);
            console.log(`  - Has any student work: ${hasStudentWorkPages}`);
            console.log(`  - Selected mode: ${isQuestionMode ? 'Question Mode' : 'Marking Mode'}`);

            if (isQuestionMode) {
                const hasQuestions = classificationResult?.questions && classificationResult.questions.length > 0;

                // 🛑 Intercept Cover Pages or Non-Maths/Metadata Pages with 0 questions before they hit the handler
                if (!hasQuestions) {
                    const isCoverPage = (classificationResult as any)?.hasFrontPages === true ||
                        (classificationResult as any)?.category === 'frontPage' ||
                        (classificationResult as any)?.pages?.some((p: any) => p.category === 'frontPage');

                    console.log(`📄 [${isCoverPage ? 'COVER PAGE ONLY' : 'NO ACADEMIC QUESTIONS'}] No questions found. Bypassing solver to return warning.`);

                    // 1. Create the proactive AI chat message
                    const uploadResult = await SessionManagementService.uploadOriginalFiles(
                        files,
                        userId || 'anonymous',
                        submissionId,
                        !!userId,
                        pdfContext
                    );
                    const { structuredImageDataArray, structuredPdfContexts } = SessionManagementService.createStructuredData(
                        files,
                        isPdf,
                        isMultiplePdfs || isMixedUpload,
                        pdfContext
                    );
                    const userMessage = SessionManagementService.createUserMessageForDatabase(
                        {
                            content: options.customText || 'Uploaded document for analysis',
                            files,
                            isPdf,
                            isMultiplePdfs: isMultiplePdfs || isMixedUpload,
                            sessionId: options.sessionId || submissionId,
                            model: actualModel,
                            pdfContext
                        },
                        structuredImageDataArray,
                        structuredPdfContexts,
                        uploadResult.originalImageLinks
                    );

                    const earlyExitText = isCoverPage
                        ? "I see you've uploaded an exam cover page. To generate a grade, please upload the pages containing the student's handwritten answers. If you want to see how to solve a problem, just upload the question page!"
                        : "No academic questions or student work were detected on the uploaded image. Please upload an exam question paper or student homework image.";

                    const aiMessage = createAIMessage({
                        content: earlyExitText,
                        messageId: req.body?.aiMessageId
                    });

                    // 2. Persist the session to Firestore so the chat panel actually loads it
                    const sessionResult = await SessionManagementService.persistMarkingSession({
                        req,
                        submissionId,
                        startTime,
                        userMessage,
                        aiMessage,
                        questionDetection: undefined,
                        globalQuestionText: options.customText || '',
                        mode: 'Question',
                        allQuestionResults: [],
                        files,
                        usageTokens: totalLLMTokens,
                        apiRequests: usageTracker.getTotalRequests(),
                        model: actualModel,
                        mathpixCallCount: usageTracker.getMathpixPages(),
                        totalCost: usageTracker.calculateCost(actualModel).total,
                        detectionResults: []
                    });

                    const finalOutput = {
                        success: true,
                        mode: 'Question',
                        sessionId: sessionResult.sessionId,
                        unifiedSession: sessionResult.unifiedSession,
                        aiMessage: sessionResult.unifiedSession?.messages?.find((m: any) => m.role === 'assistant') || aiMessage,
                        sessionTitle: sessionResult.unifiedSession?.title || (isCoverPage ? 'Cover Page' : 'Rejected Upload'),
                        annotatedOutput: [],
                        results: [],
                        warning: isCoverPage ? "COVER_PAGE_ONLY" : "NOT_MATHS_CONTENT"
                    };

                    // 3. Fire the complete event directly to the frontend UI
                    progressCallback({ type: 'complete', result: finalOutput });

                    console.log(`   - sessionId: ${finalOutput.sessionId}`);
                    console.log(`   - warning: ${finalOutput.warning} applied`);
                    
                    return finalOutput;
                }

                // ========================= ENHANCED QUESTION MODE (Normal Flow) =========================
                // If questions DO exist, proceed to the solver as normal
                questionOnlyResult = await QuestionModeHandlerService.handleQuestionMode({
                    classificationResult,
                    standardizedPages,
                    files,
                    actualModel,
                    userId: options.userId || 'anonymous',
                    submissionId,
                    req: req,
                    res: {
                        write: (data: string) => {
                            if (data.startsWith('data: ')) {
                                try {
                                    const jsonStr = data.substring(6);
                                    const parsed = JSON.parse(jsonStr);
                                    progressCallback(parsed);
                                } catch (e) {
                                    // Ignore parse errors
                                }
                            }
                        },
                        end: () => { }
                    } as any,
                    startTime,
                    logStep,
                    usageTracker,
                    examPaperHint: effectiveExamPaperHint ?? null,
                    subjectProfile
                });

                const pureQuestionResult: any = {
                    mode: 'Question',
                    sessionId: questionOnlyResult?.sessionId,
                    unifiedSession: questionOnlyResult?.unifiedSession,
                    message: questionOnlyResult?.message,
                    annotatedOutput: [],
                    results: []
                };

                return pureQuestionResult;
            }

            // ========================= ENHANCED MARKING MODE =========================
            // Marking mode: Handle mixed content with both marking and question analysis

            if (isMixedContent) {
                console.log(`🔄 [MIXED CONTENT] Processing ${standardizedPages.length} images with mixed content`);
                console.log(`  - Student work images: ${standardizedPages.filter((_, i) => allClassificationResults[i]?.result?.category === "questionAnswer").length}`);
                console.log(`  - Question-only images: ${standardizedPages.filter((_, i) => allClassificationResults[i]?.result?.category === "questionOnly").length}`);
            }

            // ========================= CLASSIFICATION-DRIVEN OCR ROUTING =========================
            // Identify which pages actually need OCR based on Gemini's classification
            let pagesToOcr: Set<number>;
            
            if (standardizedPages.length === 1) {
                // FIX: Single-image uploads MUST ALWAYS be OCR'd. Do not trust classification to drop them.
                pagesToOcr = new Set([0]);
                console.log(`🎯 [OCR ROUTING] Single image detected. Forcing OCR on the only page.`);
            } else if (allClassificationResults && allClassificationResults.length > 0) {
                // Surgical Routing: Only OCR pages that have questions or student work (skip blank unattempted question pages)
                const validIndices = allClassificationResults
                    .filter(r =>
                        (r.result?.category === 'questionAnswer' || r.result?.category === 'questionOnly') &&
                        !(r.result as any)?._isBlankQuestionPage &&
                        !(r.result as any)?._isBlankMappedPage
                    )
                    .map(r => r.pageIndex);
                pagesToOcr = new Set(validIndices);
                console.log(`🎯 [OCR ROUTING] Surgical Mathpix routing: Skipping ${standardizedPages.length - pagesToOcr.size} non-exam pages.`);
            } else {
                // Fail-safe: If AI fails, OCR everything
                console.warn(`⚠️ [OCR ROUTING] Classification failed or returned empty! Defaulting to OCRing all ${standardizedPages.length} pages.`);
                pagesToOcr = new Set(standardizedPages.map(p => p.pageIndex));
            }

            // Extract questions from Classification BEFORE OCR so we can fast-check DB before LLM scheme parsing
            const individualQuestions = extractQuestionsFromClassification(classificationResult, standardizedPages[0]?.originalFileName);

            // ⚡ [FAST DB PRE-CHECK FOR UPLOADED MARKING SCHEMES]:
            // If the user uploaded a Marking Scheme alongside an exam paper that ALREADY exists in our Firestore DB,
            // verify against our in-memory DB cache (~15ms) first. If found, skip the 30s LLM scheme extraction (and deferred PDF rasterization) completely!
            const hasGeometryUnofficialFlag = geometryResults.some(g => g?.is_unofficial_or_practice_paper === true);
            const preCheckGeoEvidence = [
                ...geometryResults.map(g => g?.paper_code_hint || ''),
                ...geometryResults.map(g => g?.evidence_text_snippet || ''),
                ...geometryResults.map(g => g?.unofficial_reason || ''),
                options.customText || ''
            ].filter(Boolean).join(' ');
            const skipFastDbPreCheckForUnofficial =
                hasGeometryUnofficialFlag || hasUnofficialPaperIndicators(preCheckGeoEvidence);

            let preResolvedOrchestrationResult: Awaited<ReturnType<typeof MarkingSchemeOrchestrationService.orchestrateMarkingSchemeLookup>> | null = null;
            if (skipFastDbPreCheckForUnofficial && pagesEjected && (interceptedSchemeImages.length > 0 || deferredSchemePdfFiles.length > 0)) {
                console.log(`🛡️ [FAST-DB-PRECHECK] Skipped official DB pre-check — uploaded document contains unofficial/practice paper indicators. Parsing uploaded mark scheme instead.`);
            } else if (pagesEjected && (interceptedSchemeImages.length > 0 || deferredSchemePdfFiles.length > 0) && !inputMarkingScheme && individualQuestions.length > 0) {
                try {
                    const { MarkingSchemeParserService } = await import('./MarkingSchemeParserService.js');
                    preResolvedOrchestrationResult = await runFastDbPreCheck({
                        individualQuestions,
                        classificationResult,
                        effectiveExamPaperHint,
                        geometryResults,
                        uploadedFileNames,
                        extractedGeoPaperCode,
                        cleanGeoPaperHint,
                        isVisionVerbatim: subjectProfile?.ocrStrategy === 'VISION_VERBATIM',
                        subjectProfile,
                        paperExistsInDatabaseFn: MarkingSchemeParserService.paperExistsInDatabase.bind(MarkingSchemeParserService),
                        orchestrateLookupFn: MarkingSchemeOrchestrationService.orchestrateMarkingSchemeLookup.bind(MarkingSchemeOrchestrationService)
                    }) as any;
                } catch (preCheckErr) {
                    // Non-fatal: fall through to custom scheme parser
                }
            }

            // 🧠 [DYNAMIC PARSER]: Only run LLM custom scheme extraction if the paper was NOT already matched in our DB.
            // Runs concurrently with Mathpix OCR below.
            const schemeParserPromise: Promise<any | null> = (async () => {
                if (preResolvedOrchestrationResult || !pagesEjected || (interceptedSchemeImages.length === 0 && deferredSchemePdfFiles.length === 0)) return null;
                const schemeParserModel = resolveExecutionPlan('fast', 'markingScheme').modelName;
                const logSchemeParserComplete = logStep('Custom Scheme Parsing', schemeParserModel);
                try {
                    if (deferredSchemePdfFiles.length > 0) {
                        console.log(`📄 [DEFERRED-MS-PDF] Paper not found in DB — rasterizing ${deferredSchemePdfFiles.length} deferred Mark Scheme PDF(s) on demand...`);
                        for (const msFile of deferredSchemePdfFiles) {
                            const msPages = await PdfProcessingService.convertPdfToImages(msFile.buffer, {
                                maxPages: MAX_RAW_COMBINED_PAGES,
                                maxPagesErrorMessage: getPageLimitErrorMessage
                            });
                            msPages.forEach(p => interceptedSchemeImages.push(p.imageData));
                        }
                    }
                    if (interceptedSchemeImages.length === 0) {
                        logSchemeParserComplete();
                        return null;
                    }
                    const { MarkingSchemeParserService } = await import('./MarkingSchemeParserService.js');
                    const parsedObj = await MarkingSchemeParserService.parseImagesToObject(
                        interceptedSchemeImages,
                        usageTracker,
                        {
                            userId: userId || 'anonymous',
                            sessionId: options.sessionId || submissionId,
                            sourceFileName: deferredSchemePdfFiles[0]?.originalname || files?.find(isExplicitMarkSchemePdfFile)?.originalname
                        }
                    );
                    logSchemeParserComplete();

                    if (parsedObj && Object.keys(parsedObj).length > 0) {
                        console.log(`✅ [SCHEME PARSER] Successfully extracted marking scheme via ${schemeParserModel}.`);
                        if (process.env.LOG_CUSTOM_SCHEME_JSON === 'true') {
                            console.log(`\n📄 [CUSTOM-SCHEME-DEBUG] Pretty JSON of Parsed Scheme:`);
                            console.log(JSON.stringify(parsedObj, null, 2));
                            console.log(`----------------------------------------------------\n`);
                        }
                        return parsedObj;
                    }
                    console.warn(`⚠️ [SCHEME PARSER] Parser returned empty object. Falling back to generic marking scheme.`);
                    return null;
                } catch (err) {
                    logSchemeParserComplete();
                    if (err instanceof UserFacingError) {
                        throw err;
                    }
                    console.error(`⚠️ [SCHEME PARSER] Exception during custom marking scheme parsing. Proceeding with generic fallback. Error:`, err instanceof Error ? err.message : String(err));
                    return null;
                }
            })();
            // Prevent Node.js unhandledRejection crash if schemeParserPromise rejects while OCR is still running;
            // the rejection is still rethrown when awaited below.
            schemeParserPromise.catch(() => {});

            progressCallback(createProgressData(3, `Running Precision OCR on ${pagesToOcr.size} pages...`, MULTI_IMAGE_STEPS));
            const logOcrComplete = logStep('OCR Processing', 'mathpix');

            const runPrecisionOcrBatched = async () => {
                const results: PageOcrResult[] = [];
                const BATCH_SIZE = 5;
                for (let i = 0; i < standardizedPages.length; i += BATCH_SIZE) {
                    const batch = standardizedPages.slice(i, i + BATCH_SIZE);
                    const batchResults = await Promise.all(batch.map(async (page) => {
                        // Skip Mathpix completely if this page was ejected by Classification
                        if (!pagesToOcr.has(page.pageIndex)) {
                            return {
                                pageIndex: page.pageIndex,
                                ocrData: { text: '', mathBlocks: [], rawResponse: null } as any, // Empty mock response
                                classificationText: '' 
                            };
                        }

                        const ocrResult = await OCRService.processImage(
                            (page as any).ocrImageData || page.imageData,
                            { pageIndex: page.pageIndex, ocrStrategy: subjectProfile.ocrStrategy },
                            false,
                            'auto',
                            {}, // Empty hint
                            usageTracker
                        );
                        return {
                            pageIndex: page.pageIndex,
                            ocrData: ocrResult,
                            classificationText: '' // We backfill this later
                        };
                    }));
                    results.push(...batchResults);
                }
                return results;
            };

            allPagesOcrData = await runPrecisionOcrBatched();
            logOcrComplete();

            // Backfill the globalQuestionText that we now have from the completed Classification pass
            allPagesOcrData.forEach(ocr => {
                 ocr.classificationText = globalQuestionText;
            });

            // [DEBUG] Verify Data Integrity immediately after OCR
            if (allPagesOcrData.length > 1) {
                const page1Data = allPagesOcrData[1]?.ocrData;
                if (page1Data?.mathBlocks?.length) {
                    // NOTE: OCR 'isHandwritten' flags are unreliable. 
                    // We pass all blocks to ensure no data loss and let AI determine context.
                    const sample = page1Data.mathBlocks.find(b => (b as any).isHandwritten || !b.isPrinted) || page1Data.mathBlocks[0];
                    /*
                    console.log(`[PIPELINE DEBUG] Page 1 OCR Data Check:`);
                    console.log(`   - Total Blocks: ${page1Data.mathBlocks.length}`);
                    console.log(`   - Sample HW Block Check:`, JSON.stringify({
                        text: (sample.mathpixLatex || sample.googleVisionText || '').substring(0, 20),
                        hasCoords: !!sample.coordinates,
                        coords: sample.coordinates
                    }));
                    */
                } else {
                    // console.log(`[PIPELINE DEBUG] Page 1 OCR Data has NO mathBlocks!`);
                }
            }

            // Aggregate Mathpix calls from OCR results
            // Mathpix calls are now automatically tracked by UsageTracker via recordMathpix()
            // No need to manually sum totalMathpixCalls

            progressCallback(createProgressData(3, 'OCR & Classification complete.', MULTI_IMAGE_STEPS));
            // ========================== END: IMPLEMENT STAGE 2 ==========================

            // ========================= START: ADD QUESTION DETECTION STAGE =========================
            progressCallback(createProgressData(4, 'Detecting questions and fetching schemes...', MULTI_IMAGE_STEPS));

            // Collect full OCR text for reliable metadata extraction (e.g. Total Marks)
            const extractedOcrText = allPagesOcrData.map((p: any) => p.ocrData.text).join('\n\n');

            // ⏳ Resolve the concurrently-running custom scheme parser (if not already satisfied by fast DB pre-check)
            const parsedCustomScheme = await schemeParserPromise;

            // Call question detection for each individual question (started after custom scheme parsing completes so timings don't overlap)
            const logQuestionDetectionComplete = logStep('Question Detection', 'question-detection');
            if (parsedCustomScheme) {
                inputMarkingScheme = parsedCustomScheme;
                const parsedSchemeSubject = (parsedCustomScheme as any)?.examDetails?.subject;
                const parsedSchemePaperCode = (parsedCustomScheme as any)?.examDetails?.paperCode;
                if (parsedSchemeSubject || parsedSchemePaperCode) {
                    const schemeResolvedProfile = resolveSubjectProfile({
                        detectedSubject: geoSubjectVote,
                        subject: parsedSchemeSubject,
                        paperCode: geoPaperCodeHint || parsedSchemePaperCode,
                        customText: options.customText,
                        fileNames: uploadedFileNames
                    });
                    if (schemeResolvedProfile.key !== subjectProfile.key || schemeResolvedProfile.displayName !== subjectProfile.displayName) {
                        console.log(
                            `🧭 [SUBJECT-ROUTER] Refined from Uploaded Scheme (subject="${parsedSchemeSubject || 'N/A'}") -> Profile="${schemeResolvedProfile.key}" | Display="${schemeResolvedProfile.displayName}"`
                        );
                        subjectProfile = schemeResolvedProfile;
                    }
                }
            }

            if (parsedCustomScheme && individualQuestions.length >= 3) {
                // Snapshot BEFORE orchestration: orchestrateMarkingSchemeLookup mutates q.text in place ("smart swap"),
                // and this save runs asynchronously, so passing the live objects races with that mutation.
                const questionsSnapshot = individualQuestions.map(q => ({
                    questionNumber: q.questionNumber,
                    text: q.text,
                    parentText: q.parentText
                }));
                const schemeForPersistence = parsedCustomScheme;

                // Paper total printed on the QUESTION PAPER cover (e.g. "The maximum mark for this paper is 100"),
                // detected by the pre-flight geometry pass. Most frequent value across non-scheme pages wins.
                const totalVotes = new Map<number, number>();
                geometryResults
                    .filter(g => g && !g.is_marking_scheme && g.paper_total_marks_hint)
                    .forEach(g => totalVotes.set(g!.paper_total_marks_hint!, (totalVotes.get(g!.paper_total_marks_hint!) || 0) + 1));
                const paperStatedTotal = Array.from(totalVotes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

                // 🛡️ COMPLETENESS GATE: Only a COMPLETE question paper + COMPLETE mark scheme is auto-persisted.
                // Individual questions / partial uploads / unofficial practice papers are ignored (see persistOfficialPastPaperIfComplete).
                const uploadEvidenceText = [
                    ...geometryResults.map(g => g?.paper_code_hint || ''),
                    ...geometryResults.map(g => g?.evidence_text_snippet || ''),
                    ...geometryResults.map(g => g?.unofficial_reason || ''),
                    extractedOcrText || '',
                    options.customText || ''
                ].filter(Boolean).join(' ');

                if (hasGeometryUnofficialFlag || hasUnofficialPaperIndicators(uploadEvidenceText)) {
                    console.log(`🛡️ [AUTO-CATALOG] Skipped persisting unofficial/practice upload (detected in document geometry or OCR content).`);
                } else {
                    import('./MarkingSchemeParserService.js')
                        .then(({ MarkingSchemeParserService }) => {
                            void MarkingSchemeParserService.persistOfficialPastPaperIfComplete({
                                parsedScheme: schemeForPersistence,
                                extractedQuestions: questionsSnapshot,
                                paperStatedTotal,
                                isUnofficialOrPracticePaper: hasGeometryUnofficialFlag,
                                documentEvidenceText: uploadEvidenceText,
                                auditContext: {
                                    userId: userId || 'anonymous',
                                    sessionId: options.sessionId || submissionId,
                                    sourceFileName: deferredSchemePdfFiles[0]?.originalname || files?.[0]?.originalname
                                }
                            });
                        })
                        .catch(() => {});
                }
            }

            // Orchestrate marking scheme lookup (reuse pre-resolved DB match if available, otherwise run lookup)
            const orchestrationResult = preResolvedOrchestrationResult || await MarkingSchemeOrchestrationService.orchestrateMarkingSchemeLookup(
                individualQuestions,
                classificationResult,
                effectiveExamPaperHint,
                inputMarkingScheme,
                subjectProfile?.ocrStrategy === 'VISION_VERBATIM',
                subjectProfile,
                subjectGate
            );

            const markingSchemesMap = orchestrationResult.markingSchemesMap;
            const detectionResults = orchestrationResult.detectionResults;
            const detectionStats = orchestrationResult.detectionStats;
            classificationResult = orchestrationResult.updatedClassificationResult;
            // ^^^ This object now holds the DB-verified Question Numbers

            // Refine subjectProfile if DB Question Detection matched an exam paper
            const firstMatch = detectionResults.find((dr: any) => dr?.detectionResult?.found && dr?.detectionResult?.match)?.detectionResult?.match;
            if (firstMatch) {
                const dbResolvedProfile = resolveSubjectProfile({
                    detectedSubject: geoSubjectVote,
                    subject: firstMatch.subject || firstMatch.qualification,
                    paperCode: firstMatch.paperCode || firstMatch.examCode,
                    paperTitle: firstMatch.paperTitle
                });
                if (dbResolvedProfile.key !== subjectProfile.key && subjectGate.confident && subjectGate.key === subjectProfile.key) {
                    // A single DB match must not override a confident page-vote subject.
                    console.log(
                        `🛡️ [SUBJECT-GATE] Ignored DB-match subject refinement "${firstMatch.paperCode || firstMatch.paperTitle}" -> ${dbResolvedProfile.key}; keeping confident ${subjectProfile.key}`
                    );
                } else if (dbResolvedProfile.key !== subjectProfile.key) {
                    subjectProfile = dbResolvedProfile;
                    console.log(
                        `🧭 [SUBJECT-ROUTER] Refined from DB Match "${firstMatch.paperCode || firstMatch.paperTitle}" -> Profile="${subjectProfile.key}" | Paradigm="${subjectProfile.paradigm}"`
                    );
                }
            }

            // Attach resolved subjectProfile onto each scheme in markingSchemesMap so MarkingInstructionService & MarkingExecutor have direct access
            if (markingSchemesMap && markingSchemesMap.size > 0) {
                for (const schemeEntry of markingSchemesMap.values()) {
                    if (schemeEntry && typeof schemeEntry === 'object') {
                        schemeEntry.subjectProfile = subjectProfile;
                        if (schemeEntry.questionMarks && typeof schemeEntry.questionMarks === 'object') {
                            schemeEntry.questionMarks.subjectProfile = subjectProfile;
                        }
                    }
                }
            }

            // 📊 [LOGGING] Print Detection Statistics BEFORE re-indexing starts
            MarkingSchemeOrchestrationService.logDetectionStatistics(detectionStats, detectionResults);
            logQuestionDetectionComplete(); // End the overall Question Detection timer

            // 🛡️ [SIGNAL-BASED PAPER TYPE DETECTION]: 
            // Detect A-Level vs GCSE using structural signals instead of guesswork (Bible Rule 8).
            const isALevelPaper = allPagesOcrData.some((p: any) => {
                const ocr = p.ocrData;
                if (!ocr) return false;
                const blocks = ocr.mathBlocks || [];
                const pageHeight = ocr.dimensions?.height || 3500;
                const textLen = blocks.reduce((sum: number, b: any) => sum + (b.googleVisionText || b.text || '').length, 0);
                
                // Signal 1: High Density (Question Text)
                if (textLen < 300) return false;

                // Signal 2: Large Empty Space (The Answer Box)
                const sortedBlocks = [...blocks].sort((a: any, b: any) => (a.coordinates?.y || 0) - (b.coordinates?.y || 0));
                let maxGap = 0;
                
                for (let i = 1; i < sortedBlocks.length; i++) {
                    const top = (sortedBlocks[i-1].coordinates?.y || 0) + (sortedBlocks[i-1].coordinates?.height || 0);
                    const bottom = sortedBlocks[i].coordinates?.y || 0;
                    const gap = bottom - top;
                    if (gap > maxGap) maxGap = gap;
                }

                // Also check the gap from the final block to the bottom of the page
                if (sortedBlocks.length > 0) {
                    const lastBlock = sortedBlocks[sortedBlocks.length - 1];
                    const lastBottom = (lastBlock.coordinates?.y || 0) + (lastBlock.coordinates?.height || 0);
                    const bottomGap = pageHeight - lastBottom;
                    if (bottomGap > maxGap) maxGap = bottomGap;
                }
                
                return maxGap > (pageHeight * 0.20); // Large vertical gap (at least 20% of page)
            });

            if (process.env.LOG_REINDEX_DEBUG === 'true') {
                console.log(`\n🔄 [RE-INDEXING] 🛡️ Aligning physical pages... (Signal-Detected: ${isALevelPaper ? 'A-Level Type' : 'GCSE/Standard Type'})`);

                // 🔍 [RE-INDEX PROBE]: Verify pointer sync integrity
                classificationResult.questions.forEach((q: any) => {
                    if (q.questionNumber === '11' || q.questionNumber === '1' || q.questionNumber?.startsWith('11')) {
                        console.log(`🕵️ [PROBE] Q${q.questionNumber} | sourceImageIndex: ${q.sourceImageIndex} | text: ${q.text?.substring(0, 30)}...`);
                    }
                });
            }

            // 1. Map pages to their Lowest VERIFIED Question Number (Sub-Question Aware)
            // 🛡️ [MULTI-ANCHOR REUSE]: We check sourceImageIndices (plural) to see if a page belongs to a question.
            // This preserves the existing logic for questions spanning multiple pages (like Q11 on P0/P23).
            const pageSortMap = standardizedPages.map((page, originalIdx) => {
                const matchedClassification = allClassificationResults.find(r => r.pageIndex === page.pageIndex) || allClassificationResults[originalIdx];
                const rawResult = matchedClassification?.result;
                const pageRawResult = rawResult || {
                    category: 'metadata',
                    questions: []
                };
                const physicalPageIndex = page.pageIndex;

                // 🛡️ [METADATA IDENTITY]: DO NOT force minSortWeight = Infinity for meta-pages.
                // ⚠️ [WARNING]: Cover pages MUST retain their question labels (identity) so the Zone Detector 
                // can find top-of-page anchors. Physical sorting is handled by the 'isMeta' flag alone.
                // Never add a page to [PIPELINE-META] if the Mapper assigned valid question number(s) to it
                // (unless explicitly excluded by user scope).
                const hasMappedQuestions = hasValidMappedQuestions(pageRawResult);
                const isExcludedByScope = Boolean((pageRawResult as any)?._excludedByScope);
                const isMeta = isExcludedByScope || ((pageRawResult?.category === 'metadata' || pageRawResult?.category === 'frontPage') && !hasMappedQuestions);

                // Detect whether this page contains a printed question prompt vs continuation text only
                const isContaminatedStemLocal = (q: any): boolean => {
                    if (!q || !q.text) return false;
                    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                    const stem = norm(q.text);
                    if (stem.length < 15) return false;
                    const work = norm((q.studentWorkLines || []).map((l: any) => l?.t || '').join(' ') || q.studentWork || '');
                    return work.length > 0 && work.includes(stem.slice(0, 40));
                };

                const hasPrintedStem = Boolean(
                    pageRawResult?.questions?.some((q: any) => {
                        const t = (q.text || '').trim();
                        return t.length > 20 && !isContinuationHeaderOnly(t) && !isContaminatedStemLocal(q);
                    })
                );

                // 🏗️ TRUTH-FIRST: Look at database-verified questions and their SUB-SEQUENCES
                const isIntroStem = hasPrintedStem || Boolean((pageRawResult as any)._isIntroStemPage);
                const { minSortWeight, pageWeights, debugQList } = resolvePageMinSortWeight({
                    questions: pageRawResult.questions,
                    mapperHints: (pageRawResult as any).mapperHints,
                    isIntroStem
                });

                if (pageWeights.length > 0 && process.env.LOG_REINDEX_DEBUG === 'true') {
                    console.log(`   ⚖️ [PAGE-WEIGHT] Page ${originalIdx}: Weights=[${pageWeights.map(pw => `${pw.q}:${pw.w}`).join(', ')}] -> Selected: ${minSortWeight}`);
                }

                // Detect true Exam Front Cover so out-of-order loose image uploads never treat it as an interior blank page
                const pageOcrBlocks = (allPagesOcrData.find(o => o.pageIndex === page.pageIndex) || allPagesOcrData[originalIdx])?.ocrData?.mathBlocks || [];
                const pageOcrText = pageOcrBlocks.map((b: any) => b.googleVisionText || b.mathpixLatex || b.text || '').join(' ');
                const pageGeo = geometryResults?.[originalIdx];
                const isGeoCover = Boolean(pageGeo?.is_cover_page);
                const geoTextSnippet = `${pageGeo?.evidence_text_snippet || ''} ${pageGeo?.visual_observations || ''} ${pageGeo?.unofficial_reason || ''}`;
                const isFrontCover = detectIsFrontCover({
                    isGeoCover,
                    originalIdx,
                    isMeta,
                    pageOcrText,
                    mapperCategory: pageRawResult?.category,
                    geoTextSnippet
                });
                const hasVerifiedCoverEvidence = hasVerifiedFrontCoverEvidence({
                    isGeoCover,
                    pageOcrText,
                    geoTextSnippet
                });

                // Detect printed booklet page number from OCR first, falling back to preFlight geometry (essential for blank/meta pages skipped by Surgical OCR)
                const baseQForBooklet = minSortWeight !== Infinity ? Math.floor(minSortWeight) : undefined;
                const ocrBookletPage = extractBookletPageNumber(pageOcrBlocks, baseQForBooklet);
                const geoBookletPage =
                    typeof pageGeo?.booklet_page_number === 'number' &&
                    pageGeo.booklet_page_number >= 1 &&
                    pageGeo.booklet_page_number <= 100
                        ? pageGeo.booklet_page_number
                        : null;
                const bookletPage = ocrBookletPage ?? geoBookletPage;
                const geoFirstQuestionNumber =
                    typeof pageGeo?.first_question_number === 'number' &&
                    pageGeo.first_question_number >= 1 &&
                    pageGeo.first_question_number <= 100
                        ? pageGeo.first_question_number
                        : null;

                return {
                    originalIdx,
                    originalPageIndex: page.originalPageIndex,
                    filename: page.originalFileName,
                    minQ: minSortWeight === Infinity ? 999999 : minSortWeight,
                    hasPrintedStem,
                    bookletPage,
                    geoFirstQuestionNumber,
                    isMeta,
                    isFrontCover,
                    hasVerifiedCoverEvidence,
                    debugQ: [...new Set(debugQList)].join(', ')
                };
            });

            // Guard against Mapper labeling multiple interior blank/continuation pages as 'frontPage':
            // if >1 page claims to be a front cover, demote unverified mapper-only candidates so they
            // can be rescued into their booklet position (or pushed to the end) instead of jumping before Q1.
            demoteSpuriousFrontCovers(pageSortMap);

            // Option A (Safe Hybrid): Anchor unresolved interior blank/continuation pages (e.g. blank "Question 13 continued"
            // spreads skipped by Surgical OCR) using printed bookletPage interpolation and preFlight first_question_number.
            anchorUnresolvedMetaPagesByBooklet(pageSortMap);

            const { majorQuestionInversions: preBackfillInversions } = computeIsScrambledPdf({
                pageSortMap,
                isPdf: false,
                isMultiplePdfs: false
            });
            const isSequentialLooseUpload = !isPdf && !isMultiplePdfs && preBackfillInversions === 0;

            const isPastPaper = Array.from(markingSchemesMap.values()).some(m => !m.isGeneric);
            // 🛡️ [ORPHAN & INTERIOR BOOKLET PAGE RESCUE]: 
            // Both GCSE and A-Level papers have unnumbered overflow/working pages, blank lined pages, or
            // "There are no questions printed on this page" filler pages in the middle/end of the booklet.
            // Rescue any page (including interior/trailing isMeta booklet pages) that follows a known question page
            // by inheriting `prev.minQ + 0.0001` so it stays in its physical booklet position instead of jumping to Page 0!
            // Leading cover pages (before any question appears, where prev.minQ === 999999) keep minQ = 999999 and stay at Page 0.
            // CRITICAL: Never backfill a true Front Cover (or an out-of-order loose image meta page from a different file, or the left-half of a Q1 spread).
            for (let i = 1; i < pageSortMap.length; i++) {
                const current = pageSortMap[i];
                const prev = pageSortMap[i - 1];
                const next = pageSortMap[i + 1];
                const isSpreadCoverBeforeQ1 = Boolean(
                    current.isMeta &&
                    next &&
                    next.filename === current.filename &&
                    next.minQ < 2
                );
                const isDifferentLooseFileMeta = Boolean(
                    current.isMeta &&
                    !isPdf &&
                    !isMultiplePdfs &&
                    !isSequentialLooseUpload &&
                    current.filename !== prev.filename
                );
                if (
                    current.minQ === 999999 &&
                    prev.minQ !== 999999 &&
                    !current.isFrontCover &&
                    !isSpreadCoverBeforeQ1 &&
                    !isDifferentLooseFileMeta
                ) {
                    current.minQ = prev.minQ + 0.0001;
                }
            }
            if (isPastPaper) {
                for (let i = pageSortMap.length - 2; i >= 0; i--) {
                    const current = pageSortMap[i];
                    const next = pageSortMap[i + 1];
                    if (!current.isMeta && current.minQ === 999999 && next.minQ !== 999999) {
                        current.minQ = Math.max(0, next.minQ - 0.0001);
                    }
                }
            }

            // 🔍 [DEBUG-PROBE] Dump the Sorting Decision Matrix
            if (process.env.LOG_REINDEX_DEBUG === 'true') {
                console.log('🔍 [RE-INDEX DEBUG] Sorting Decision Matrix:');
                console.log('-----------------------------------------------------------------------------------------');
                console.log('| OrigIdx | Filename             | IsMeta | MinQ   | Detected Qs                        |');
                console.log('-----------------------------------------------------------------------------------------');
                pageSortMap.forEach(p => {
                    const fName = p.filename.padEnd(20).slice(0, 20);
                    const qList = p.debugQ.padEnd(34).slice(0, 34);
                    console.log(`| ${String(p.originalIdx).padEnd(7)} | ${fName} | ${String(p.isMeta).padEnd(6)} | ${String(p.minQ).padEnd(6)} | ${qList} |`);
                });
                console.log('-----------------------------------------------------------------------------------------');
            }

            // 1.5 NON-DESTRUCTIVE ORPHAN FALLBACK:
            // Any page that still has no question number after neighbor backfill (e.g., a trailing blank/lined page)
            // is safely demoted to metadata so it preserves its physical sequence without crashing the pipeline.
            const unresolvedPages = pageSortMap.filter(p => !p.isMeta && p.minQ === 999999);
            if (unresolvedPages.length > 0) {
                console.warn(`⚠️ [SORT FALLBACK] Pages ${unresolvedPages.map(p => p.originalIdx).join(', ')} have no question anchors after backfill. Demoting to metadata to preserve physical sequence.`);
                unresolvedPages.forEach(p => {
                    p.isMeta = true;
                });
            }

            // 2. LOGICAL SORT (The Straightener) - [IMAGES + SCRAMBLED PDFs]
            // Loose images are always straightened. Sequential PDFs preserve their exact physical sequence,
            // while PDFs generated from out-of-order phone photos (multiple question inversions or displaced cover)
            // are automatically straightened into logical question order.
            const {
                majorQuestionInversions,
                hasDisplacedFrontCover,
                isScrambledPdf
            } = computeIsScrambledPdf({ pageSortMap, isPdf, isMultiplePdfs });

            if ((!isPdf && !isMultiplePdfs) || isScrambledPdf) {
                if (isScrambledPdf) {
                    console.log(
                        `🔄 [PDF STRAIGHTENER] Detected out-of-order pages inside PDF (inversions=${majorQuestionInversions}, displacedCover=${hasDisplacedFrontCover}). Straightening into logical question order...`
                    );
                }
                pageSortMap.sort(comparePageSortEntries);
            } else {
                console.log('🛡️ [PDF INTEGRITY] Straightener bypassed. Maintaining exact physical sequence of the PDF.');
            }

            if (process.env.LOG_REINDEX_DEBUG === 'true') {
                console.log(`\n🚀 [SORT-RESULT] Final Logical Order:`);
                console.log('-----------------------------------------------------------------------------------------');
                pageSortMap.forEach((p, i) => {
                    console.log(`| Seq ${i} | OrigIdx ${p.originalIdx} | isMeta: ${p.isMeta} | minQ: ${p.minQ} |`);
                });
                console.log('-----------------------------------------------------------------------------------------');
            }

            // 3. Create Index Lookups
            const oldToNewIndex = new Map<number, number>();
            const newToOldIndex = new Map<number, number>();
            pageSortMap.forEach((item, newIdx) => {
                oldToNewIndex.set(item.originalIdx, newIdx);
                newToOldIndex.set(newIdx, item.originalIdx);
            });

            // 4. Re-build Arrays (Use immutable shallow clones to avoid in-loop index collision)
            const reindexedStandardPages: StandardizedPage[] = [];
            const reindexedOcrData: any[] = [];
            const reindexedClassificationResults: any[] = [];

            const snapshotOcrByPageIdx = new Map<number, any>();
            allPagesOcrData.forEach(o => snapshotOcrByPageIdx.set(o.pageIndex, o));
            const snapshotClsByPageIdx = new Map<number, any>();
            allClassificationResults.forEach(c => snapshotClsByPageIdx.set(c.pageIndex, c));

            for (let newIdx = 0; newIdx < pageSortMap.length; newIdx++) {
                const oldIdx = newToOldIndex.get(newIdx)!;

                const page = standardizedPages[oldIdx];
                const prevPageIdx = page.pageIndex;
                const ocr = snapshotOcrByPageIdx.get(prevPageIdx) || allPagesOcrData[oldIdx];
                const cls = snapshotClsByPageIdx.get(prevPageIdx) || allClassificationResults[oldIdx];

                const updatedPage = { ...page, pageIndex: newIdx };
                const updatedOcr = ocr ? { ...ocr, pageIndex: newIdx } : undefined;
                const updatedCls = cls ? { ...cls, pageIndex: newIdx } : undefined;

                reindexedStandardPages.push(updatedPage);
                if (updatedOcr) reindexedOcrData.push(updatedOcr);
                if (updatedCls) reindexedClassificationResults.push(updatedCls);
            }

            // 5. UPDATE GLOBAL REFERENCES
            standardizedPages = reindexedStandardPages;
            allPagesOcrData = reindexedOcrData;
            allClassificationResults = reindexedClassificationResults;

            if (process.env.LOG_REINDEX_DEBUG === 'true') {
                console.log(`✅ [RE-INDEXING] Completed. Pages have been straightened into Logical Order.`);
            }

            // 5. CRITICAL: Update Classification Result Indices to match New Integrity (DEEP FIX)
            // We must update questions, sub-questions, AND studentWorkLines to match the new Physical Index.
            // If we don't, the Zone Detector looks at Page 5 but ignores lines tagged as "Page 1".

            // Create a lookup: PostSplitIdx (from after ModeSplit) -> NewIdx
            const originalToNewIndexMap = new Map<number, number>();
            pageSortMap.forEach((p, newIdx) => {
                // The classification questions JSON was generated on the POST-split array (0 to N-1),
                // so we MUST use originalIdx (the array index) rather than originalPageIndex (physical upload index).
                originalToNewIndexMap.set(p.originalIdx, newIdx);
            });

            const updateNodeIndices = (node: any) => {
                if (!node || typeof node !== 'object' || node._reindexed) return;
                node._reindexed = true;

                // Update Page Index if present
                if (node.pageIndex !== undefined) {
                    node.pageIndex = originalToNewIndexMap.get(node.pageIndex) ?? node.pageIndex;
                }

                // Update Source Image Index (Legacy)
                if (node.sourceImageIndex !== undefined) {
                    node.sourceImageIndex = originalToNewIndexMap.get(node.sourceImageIndex) ?? node.sourceImageIndex;
                }

                // Update Array of Indices
                if (node.sourceImageIndices && Array.isArray(node.sourceImageIndices)) {
                    node.sourceImageIndices = node.sourceImageIndices
                        .map((idx: number) => originalToNewIndexMap.get(idx) ?? idx)
                        .sort((a, b) => a - b);
                }

                // CRITICAL: Update Student Work Lines
                if (node.studentWorkLines && Array.isArray(node.studentWorkLines)) {
                    node.studentWorkLines.forEach((line: any) => {
                        if (!line || typeof line !== 'object' || line._reindexed) return;
                        line._reindexed = true;

                        if (line.pageIndex !== undefined) {
                            const newPageIdx = originalToNewIndexMap.get(line.pageIndex) ?? line.pageIndex;
                            line.pageIndex = newPageIdx;
                            if (line.position && typeof line.position === 'object') {
                                line.position.pageIndex = newPageIdx;
                            }

                            // 2. REWRITE THE ID STRING
                            // We must change "p3_q1_line_1" to "p5_q1_line_1"
                            // Otherwise, the detector parses "p3" and discards it.
                            if (line.id && typeof line.id === 'string') {
                                const oldId = line.id;
                                line.id = line.id.replace(/^p\d+_/, `p${newPageIdx}_`);

                                if (line.id !== oldId && Math.random() < 0.05) {
                                    console.log(`   🔧 [ID-REWRITE] ${oldId} -> ${line.id}`);
                                }
                            }
                            if (line.globalBlockId) {
                                line.globalBlockId = line.globalBlockId.replace(/^p\d+_/, `p${newPageIdx}_`);
                            }
                        }
                    });
                }

                // Recurse into SubQuestions
                if (node.subQuestions && Array.isArray(node.subQuestions)) {
                    node.subQuestions.forEach(updateNodeIndices);
                }
            };

            if (classificationResult && classificationResult.questions) {
                classificationResult.questions.forEach(updateNodeIndices);
            }

            // Update nested question nodes in allClassificationResults (Note: r.pageIndex itself was ALREADY set to newIdx in Step 4!)
            allClassificationResults.forEach(r => {
                if (r.result?.questions && Array.isArray(r.result.questions)) {
                    r.result.questions.forEach(updateNodeIndices);
                }
            });
            if (process.env.LOG_REINDEX_DEBUG === 'true') {
                console.log(`✅ [RE-INDEXING] Deep Pointer Update Complete. Lines now point to new physical pages.`);
            }

            // ========================= 7. REGENERATE OCR BLOCK IDs =========================
            // CRITICAL FIX: The OCR blocks still carry IDs from their original page index (e.g. "p8_ocr_1").
            // Since we moved the page to a new index (e.g. 10), we must rename the blocks to "p10_ocr_1".
            // Otherwise, the Zone Detector thinks these blocks belong to a different page and discards them.

            console.log(`\n🔄 [OCR RE-ID] Regenerating Global Block IDs to match new Page Indices...`);

            allPagesOcrData.forEach(page => {
                const newPageIndex = page.pageIndex; // This is already updated by the sort loop
                let blockCounter = 1;

                // 1. Update Math Blocks
                if (page.ocrData?.mathBlocks) {
                    page.ocrData.mathBlocks.forEach((b: any) => {
                        // Generate new ID: p{NewIndex}_ocr_{Seq}
                        const newId = `p${newPageIndex}_ocr_${blockCounter++}`;

                        // Preserve the old ID in metadata if needed for debugging, but update the main ID
                        if (!b.metadata) b.metadata = {};
                        b.metadata.originalBlockId = b.globalBlockId || b.id;

                        b.globalBlockId = newId;
                        b.id = newId; // Ensure legacy ID field is also updated
                    });
                }

                // 2. Update Standard Blocks (if they exist)
                if (page.ocrData?.blocks) {
                    page.ocrData.blocks.forEach((b: any) => {
                        const newId = `p${newPageIndex}_ocr_${blockCounter++}`;
                        b.globalBlockId = newId;
                        b.id = newId;
                    });
                }
            });
            console.log(`✅ [OCR RE-ID] Completed. Blocks are now synchronized with physical pages.`);

            // ========================= 8. REBUILD DIMENSIONS MAP =========================
            // CRITICAL FIX: The pageDimensionsMap was built BEFORE re-indexing. 
            // Now that pages have swapped indices, the old map keys point to the wrong physical page dimensions.
            // We must rebuild it to ensure coordinate calculations use the correct width/height for the new page order.

            pageDimensionsMap.clear(); // Clear old stale data
            standardizedPages.forEach((page) => {
                if (page.width && page.height && page.pageIndex != null) {
                    pageDimensionsMap.set(page.pageIndex, { width: page.width, height: page.height });
                }
            });
            console.log(`✅ [DIMENSIONS REBUILD] Map refreshed for ${pageDimensionsMap.size} re-indexed pages.`);
            // =============================================================================
            // ===============================================================================
            // =====================================================================================

            // NEW: Extract dominant paper hint for consistent detection in mixed mode
            let dominantPaperHint: string | null = null;
            const paperCounts = new Map<string, number>();
            detectionResults.forEach(res => {
                if (res.detectionResult?.found && res.detectionResult?.match?.paperTitle) {
                    const title = res.detectionResult.match.paperTitle;
                    paperCounts.set(title, (paperCounts.get(title) || 0) + 1);
                }
            });

            let maxCount = 0;
            paperCounts.forEach((count, title) => {
                if (count > maxCount) {
                    maxCount = count;
                    dominantPaperHint = title;
                }
            });

            if (dominantPaperHint) {
                // console.log(`📍 [PIPELINE] Detected consensus paper: "${dominantPaperHint}". Will use as hint for question-only pages.`);
            }

            // [LOG MOVED] Detection statistics are now logged BEFORE re-indexing for better clarity.

            // Warn if suspected missing paper in database
            const detectionRate = detectionStats.totalQuestions > 0
                ? (detectionStats.detected / detectionStats.totalQuestions) * 100
                : 0;
            if (detectionRate < 20 && detectionStats.totalQuestions > 5) {
                console.log(`\n⚠️  \x1b[33m[WARNING] Suspected Missing Exam Paper in Database\x1b[0m`);
                console.log(`   Detection rate is very low (${detectionRate.toFixed(0)}%).`);
                console.log(`   This usually indicates that the exam paper is not in the database.`);
                console.log(`   Please verify that the correct paper is uploaded to Firestore.\n`);
            }

            // 🔍 DEBUG PROBE for Merge Mismatch
            allPagesOcrData.forEach(page => {
                const matches = allClassificationResults.filter(r => r.pageIndex === page.pageIndex);
                if (matches.length === 0) {
                    console.error(`❌ [ZONE CRITICAL] Merge Mismatch! OCR Page ${page.pageIndex} has NO matching Classification Result.`);
                    console.log(`   - OCR Index: ${page.pageIndex}`);
                    console.log(`   - Available Class Indices: ${allClassificationResults.map(c => c.pageIndex).join(', ')}`);
                } else {
                    // console.log(`✅ [ZONE OK] Page ${page.pageIndex} merged with ${matches.length} classification results.`);
                }
            });

            progressCallback(createProgressData(4, `Detected ${markingSchemesMap.size} question scheme(s).`, MULTI_IMAGE_STEPS));
            // ========================== END: ADD QUESTION DETECTION STAGE ==========================


            // =========================PASS IMAGES TO DRAWING QUESTIONS (SIMPLIFIED) =========================
            // For questions with hasStudentDrawing=true, flag them to receive images for marking
            // No need for Drawing Classification AI - just pass the image directly
            allClassificationResults.forEach(({ pageIndex, result }) => {
                if (result.category === 'questionAnswer' && result.questions) {
                    result.questions.forEach((q) => {
                        // If Classification detected a drawing question (via heuristic or visual)
                        const hasDrawingsInQuestion = q.hasStudentDrawing === true ||
                            (q.subQuestions && q.subQuestions.some(sq => sq.hasStudentDrawing === true));

                        const pageForDrawing = standardizedPages.find(p => p.pageIndex === pageIndex);
                        if (hasDrawingsInQuestion && pageForDrawing) {
                            // Pass image data to Marking AI
                            (q as any).imageDataForMarking = pageForDrawing.imageData;
                        }
                    });
                }
            });

            // ========================= START: ENHANCE DRAWINGS =========================
            // Drawing Enhancement Service removed as per new design (AI Marking provides coordinates)
            // ========================== END: ENHANCE DRAWINGS ==========================

            // ========================= START: IMPLEMENT STAGE 3 =========================
            // --- Stage 3: Create Marking Tasks Directly from Classification (Bypass Segmentation) ---
            progressCallback(createProgressData(5, 'Preparing marking tasks...', MULTI_IMAGE_STEPS));


            // Create page dimensions map from standardizedPages for accurate drawing position calculation
            console.log(`🔍 [DIMENSIONS DEBUG] Pages: ${standardizedPages.length}`);
            // pageDimensionsMap is already declared and populated above after re-indexing.
            // We just log it here for confirmation.
            /* 
            standardizedPages.forEach((page) => {
                if (page.width && page.height && page.pageIndex != null) {
                    pageDimensionsMap.set(page.pageIndex, { width: page.width, height: page.height });
                } else {
                    console.error(`❌ [ZONE FATAL] Page ${page.pageIndex} (${page.originalFileName}) is MISSING from Dimensions Map! Width: ${page.width}, Height: ${page.height}`);
                }
            });
            */
            console.log(`🔍 [DIMENSIONS DEBUG] Map Size: ${pageDimensionsMap.size}`);

            // Create marking tasks directly from classification results (bypass segmentation)
            try {
                // PATCH: Ensure [DRAWING] token exists in classificationResult if hasStudentDrawing is true
                if (classificationResult && classificationResult.questions && Array.isArray(classificationResult.questions)) {
                    const computeLinesUnion = (lines: any[], targetPage: number): { x: number; y: number; width: number; height: number } | undefined => {
                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        let found = false;
                        for (const l of lines) {
                            if (!l || l.text === '[DRAWING]') continue;
                            if (l.pageIndex !== undefined && l.pageIndex !== targetPage) continue;
                            const x = l.position?.x ?? (Array.isArray(l.p) ? l.p[0] : undefined);
                            const y = l.position?.y ?? (Array.isArray(l.p) ? l.p[1] : undefined);
                            const w = l.position?.width ?? (Array.isArray(l.p) ? l.p[2] : undefined);
                            const h = l.position?.height ?? (Array.isArray(l.p) ? l.p[3] : undefined);
                            if (typeof x === 'number' && typeof y === 'number' && typeof w === 'number' && typeof h === 'number') {
                                minX = Math.min(minX, x);
                                minY = Math.min(minY, y);
                                maxX = Math.max(maxX, x + w);
                                maxY = Math.max(maxY, y + h);
                                found = true;
                            }
                        }
                        if (found && maxX > minX && maxY > minY) {
                            return {
                                x: Math.round(minX * 10) / 10,
                                y: Math.round(minY * 10) / 10,
                                width: Math.round((maxX - minX) * 10) / 10,
                                height: Math.round((maxY - minY) * 10) / 10
                            };
                        }
                        return undefined;
                    };

                    const resolveDrawingBox = (targetNode: any, parentNode?: any, lines?: any[], targetPage: number = 0) => {
                        let box = targetNode?.studentDrawingPosition || parentNode?.studentDrawingPosition;
                        if (!box && lines && lines.length > 0) {
                            box = computeLinesUnion(lines, targetPage);
                        }
                        return box;
                    };

                    classificationResult.questions.forEach((q: any) => {
                        // Check main question
                        if (q.hasStudentDrawing) {
                            if (q.studentWork) {
                                if (!q.studentWork.includes('[DRAWING]')) {
                                    q.studentWork += '\n[DRAWING]';
                                }
                            } else {
                                q.studentWork = '[DRAWING]';
                            }

                            const targetPage = q.sourceImageIndex ?? 0;
                            const drawingBox = resolveDrawingBox(q, undefined, q.studentWorkLines, targetPage);

                            // Ensure studentWorkLines has a line with [DRAWING]
                            if (!q.studentWorkLines || q.studentWorkLines.length === 0) {
                                q.studentWorkLines = [{
                                    text: '[DRAWING]',
                                    confidence: 1.0,
                                    pageIndex: targetPage,
                                    position: drawingBox ? { x: drawingBox.x, y: drawingBox.y, width: drawingBox.width, height: drawingBox.height } : undefined,
                                    p: drawingBox ? [drawingBox.x, drawingBox.y, drawingBox.width, drawingBox.height] : undefined
                                }];
                            } else {
                                // Check if any line has [DRAWING]
                                const existingDrawing = q.studentWorkLines.find((l: any) => l.text && l.text.includes('[DRAWING]'));
                                if (!existingDrawing) {
                                    q.studentWorkLines.push({
                                        text: '[DRAWING]',
                                        confidence: 1.0,
                                        pageIndex: targetPage,
                                        position: drawingBox ? { x: drawingBox.x, y: drawingBox.y, width: drawingBox.width, height: drawingBox.height } : undefined,
                                        p: drawingBox ? [drawingBox.x, drawingBox.y, drawingBox.width, drawingBox.height] : undefined
                                    });
                                } else if (!existingDrawing.position && drawingBox) {
                                    existingDrawing.position = { x: drawingBox.x, y: drawingBox.y, width: drawingBox.width, height: drawingBox.height };
                                    existingDrawing.p = [drawingBox.x, drawingBox.y, drawingBox.width, drawingBox.height];
                                }
                            }
                        }

                        // Check sub-questions
                        if (q.subQuestions && Array.isArray(q.subQuestions)) {
                            q.subQuestions.forEach((sq: any) => {
                                if (sq.hasStudentDrawing) {
                                    if (sq.studentWork) {
                                        if (!sq.studentWork.includes('[DRAWING]')) {
                                            sq.studentWork += '\n[DRAWING]';
                                        }
                                    } else {
                                        sq.studentWork = '[DRAWING]';
                                    }

                                    const targetPage = sq.pageIndex ?? sq.sourceImageIndex ?? q.sourceImageIndex ?? 0;
                                    const drawingBox = resolveDrawingBox(sq, q, sq.studentWorkLines, targetPage);

                                    // Update lines for sub-question too
                                    if (!sq.studentWorkLines || sq.studentWorkLines.length === 0) {
                                        sq.studentWorkLines = [{
                                            text: '[DRAWING]',
                                            confidence: 1.0,
                                            pageIndex: targetPage,
                                            position: drawingBox ? { x: drawingBox.x, y: drawingBox.y, width: drawingBox.width, height: drawingBox.height } : undefined,
                                            p: drawingBox ? [drawingBox.x, drawingBox.y, drawingBox.width, drawingBox.height] : undefined
                                        }];
                                    } else {
                                        const existingDrawing = sq.studentWorkLines.find((l: any) => l.text && l.text.includes('[DRAWING]'));
                                        if (!existingDrawing) {
                                            sq.studentWorkLines.push({
                                                text: '[DRAWING]',
                                                confidence: 1.0,
                                                pageIndex: targetPage,
                                                position: drawingBox ? { x: drawingBox.x, y: drawingBox.y, width: drawingBox.width, height: drawingBox.height } : undefined,
                                                p: drawingBox ? [drawingBox.x, drawingBox.y, drawingBox.width, drawingBox.height] : undefined
                                            });
                                        } else if (!existingDrawing.position && drawingBox) {
                                            existingDrawing.position = { x: drawingBox.x, y: drawingBox.y, width: drawingBox.width, height: drawingBox.height };
                                            existingDrawing.p = [drawingBox.x, drawingBox.y, drawingBox.width, drawingBox.height];
                                        }
                                    }
                                }
                            });
                        }
                    });
                }

                // ========================= OCR HANDWRITTEN RE-TAGGING =========================
                // [REMOVED] Superseded by SpatialShieldService's Semantic Tagging
                // The pipeline no longer eagerly re-tags blocks here.
                // ==============================================================================

                // ========================= CLASSIFICATION DATA MERGE =========================
                // CRITICAL: Attach classification results to page objects so logs can find them
                // This enables the "Unified Lookup" for transparency reporting
                allPagesOcrData.forEach(page => {
                    // FIND ALL MATCHES (not just one)
                    const matches = allClassificationResults.filter(r => r.pageIndex === page.pageIndex);

                    if (matches.length > 0) {
                        // Aggregate all questions from all matches
                        const allQuestions = matches.flatMap(m => m.result.questions || []);
                        const uniqueQuestions = [...allQuestions]; // Could add dedup logic if needed, but usually distinct tasks


                        // Construct a merged result
                        (page as any).classificationResult = {
                            questions: uniqueQuestions
                        };
                    }
                });
                // ==============================================================================


                // =====================================================================================

                // ========================= ASSIGN GLOBAL IDs TO OCR BLOCKS =========================
                // Pre-assign stable IDs so MarkingExecutor and Transparency Report match perfectly
                allPagesOcrData.forEach(page => {
                    if (page.ocrData && page.ocrData.mathBlocks) {
                        page.ocrData.mathBlocks.forEach((b: any, idx: number) => {
                            // Format: p{Page}_ocr_{Index}
                            // This ensures that even if MarkingExecutor filters the list, the ID remains stable (e.g. p0_ocr_5)
                            if (!b.globalBlockId) {
                                b.globalBlockId = `p${page.pageIndex}_ocr_${idx + 1}`;
                            }
                        });
                    }
                });
                // ===================================================================================

                const metaPageIndices = pageSortMap.filter(p => p.isMeta).map(p => oldToNewIndex.get(p.originalIdx)!);
                console.log(` 🕵️ [PIPELINE-META] Collected Meta Indices: ${metaPageIndices.join(', ')}`);

                markingTasks = createMarkingTasksFromClassification(
                    classificationResult,
                    allPagesOcrData,
                    markingSchemesMap,
                    pageDimensionsMap,
                    standardizedPages,
                    allClassificationResults,
                    metaPageIndices
                );
            } catch (error) {
                console.error('❌ createMarkingTasksFromClassification failed:', error);
                throw error;
            }

            // Handle case where no student work is found
            if (markingTasks.length === 0) {
                console.log('No marking tasks created, exiting early');
                const hasDetectedQuestions = allQuestions.length > 0;
                progressCallback(createProgressData(5, hasDetectedQuestions ? 'No student work found to mark.' : 'No academic content detected.', MULTI_IMAGE_STEPS));

                // 🛡️ [SESSION-STABILITY]: Ensure we have a sessionId even if no tasks were found
                let finalSessionId = questionOnlyResult?.sessionId || questionOnlyResult?.unifiedSession?.sessionId;
                let finalUnifiedSession = questionOnlyResult?.unifiedSession;
                let fallbackAiMessage: any = null;

                if (!finalSessionId) {
                    console.log(`📡 [EARLY EXIT] Generating fallback sessionId from submissionId: ${submissionId}`);
                    finalSessionId = submissionId;

                    // Persist an empty marking session so it shows in Library
                    try {
                        const uploadResult = await SessionManagementService.uploadOriginalFiles(
                            files,
                            userId || 'anonymous',
                            submissionId,
                            !!userId,
                            pdfContext
                        );
                        const { structuredImageDataArray, structuredPdfContexts } = SessionManagementService.createStructuredData(
                            files,
                            isPdf,
                            isMultiplePdfs || isMixedUpload,
                            pdfContext
                        );
                        const userMessage = SessionManagementService.createUserMessageForDatabase(
                            {
                                content: options.customText || 'Uploaded document for marking',
                                files,
                                isPdf,
                                isMultiplePdfs: isMultiplePdfs || isMixedUpload,
                                sessionId: options.sessionId || submissionId,
                                model: actualModel,
                                pdfContext
                            },
                            structuredImageDataArray,
                            structuredPdfContexts,
                            uploadResult.originalImageLinks
                        );
                        const aiMessage = createAIMessage({
                            content: hasDetectedQuestions
                                ? 'No student work was detected on the uploaded pages.'
                                : 'No academic questions or student work were detected on the uploaded image. Please upload an exam question paper or student homework image.',
                            messageId: req.body?.aiMessageId
                        });
                        fallbackAiMessage = aiMessage;

                        const markingContext: MarkingSessionContext = {
                            req,
                            submissionId,
                            startTime,
                            userMessage,
                            aiMessage,
                            questionDetection: options.markingScheme,
                            globalQuestionText: options.customText || '',
                            mode: 'Marking',
                            allQuestionResults: [],
                            files,
                            usageTokens: totalLLMTokens,
                            apiRequests: usageTracker.getTotalRequests(),
                            model: actualModel,
                            mathpixCallCount: usageTracker.getMathpixPages(),
                            totalCost: usageTracker.calculateCost(actualModel).total,
                            detectionResults: detectionResults
                        };

                        const sessionResult = await SessionManagementService.persistMarkingSession(markingContext);
                        finalSessionId = sessionResult.sessionId;
                        finalUnifiedSession = sessionResult.unifiedSession;
                        console.log(`✅ [EARLY EXIT] Persisted empty marking session: ${finalSessionId}`);
                    } catch (persistError) {
                        console.error('❌ [EARLY EXIT] Failed to persist empty session:', persistError);
                    }
                }

                const finalOutput = {
                    success: true,
                    submissionId, // Pass through submissionId
                    annotatedOutput: [],
                    results: [],
                    mode: isQuestionMode ? 'Question' : 'Marking',
                    unifiedSession: finalUnifiedSession,
                    aiMessage: finalUnifiedSession?.messages?.find((m: any) => m.role === 'assistant') || fallbackAiMessage,
                    sessionTitle: finalUnifiedSession?.title || (hasDetectedQuestions ? 'Marking Session' : 'Rejected Upload'),
                    // Add sessionId for credit deduction
                    sessionId: finalSessionId,
                    // Add sessionStats for usageRecord lookup
                    sessionStats: finalUnifiedSession?.sessionStats || null,
                    processingStats: {
                        totalLLMTokens,
                        mathpixCalls: usageTracker.getMathpixPages()
                    },
                    ...(pdfContext && { pdfContext })
                };

                progressCallback({ type: 'complete', result: finalOutput });

                console.log(`   - submissionId: ${finalOutput.submissionId}`);
                console.log(`   - sessionId: ${finalOutput.sessionId}`);
                console.log(`   - result object exists: true\n`);
                return finalOutput; // Exit early
            }
            progressCallback(createProgressData(5, `Prepared ${markingTasks.length} marking task(s).`, MULTI_IMAGE_STEPS));

            // ========================== END: IMPLEMENT STAGE 3 ==========================

            // ========================= START: VALIDATE SCHEMES =========================
            // --- Stage 3.5: Validate that schemes were attached during segmentation ---
            // Allow tasks without marking schemes - they'll use basic prompt (for non-past papers or failed detection)
            const tasksWithoutScheme: string[] = [];
            const tasksWithSchemes: MarkingTask[] = markingTasks.filter(task => {
                if (!task.markingScheme) {
                    tasksWithoutScheme.push(String(task.questionNumber || '?'));
                    console.warn(`[SEGMENTATION] ⚠️ Task for Q${task.questionNumber} has no marking scheme, will use basic prompt`);
                    // Don't skip - allow task to proceed with null markingScheme (basic prompt will be used)
                    return true;
                }
                return true;
            });

            if (tasksWithSchemes.length === 0 && markingTasks.length > 0) {
                throw new Error("Failed to assign marking schemes to any detected question work.");
            }
            // ========================== END: VALIDATE SCHEMES ==========================

            // ========================= START: IMPLEMENT STAGE 4 =========================
            // --- Stage 4: Marking (Single or Parallel) ---
            progressCallback(createProgressData(6, `Marking ${tasksWithSchemes.length} question(s)...`, MULTI_IMAGE_STEPS));
            const logMarkingComplete = logStep('Marking', 'ai-marking');

            // Call the refactored function for each task (works for 1 or many)
            let allQuestionResults: QuestionResult[] = await withPerformanceLogging(
                'AI Marking',
                actualModel,
                async () => {
                    const { PROCESSING_CONSTANTS } = await import('../../config/constants.js');
                    // Implement Worker Pool for Marking (Concurrency Limit: Global)
                    // This prevents "thundering herd" on the API and network saturation
                    const MARKING_CONCURRENCY = PROCESSING_CONSTANTS.CONCURRENCY_LIMIT;
                    const results: QuestionResult[] = [];
                    const queue = [...tasksWithSchemes];
                    let activeWorkers = 0;

                    return new Promise<QuestionResult[]>((resolve, reject) => {
                        const processNext = () => {
                            // Check if we're done
                            if (queue.length === 0 && activeWorkers === 0) {
                                resolve(results);
                                return;
                            }

                            // Start new workers if we have capacity and tasks
                            while (activeWorkers < MARKING_CONCURRENCY && queue.length > 0) {
                                const task = queue.shift();
                                if (task) {
                                    activeWorkers++;
                                    // Mock res for executeMarkingForQuestion if needed, or update it
                                    // executeMarkingForQuestion uses res for SSE updates? No, it uses it for logging?
                                    // Let's check executeMarkingForQuestion signature.
                                    // It takes (task, res, submissionId, model, ocrData, usageTracker)
                                    // We can pass a mock res that forwards to progressCallback
                                    const mockRes = {
                                        write: (data: string) => {
                                            if (data.startsWith('data: ')) {
                                                try {
                                                    const jsonStr = data.substring(6);
                                                    const parsed = JSON.parse(jsonStr);
                                                    progressCallback(parsed);
                                                } catch (e) { }
                                            }
                                        }
                                    } as any;

                                    executeMarkingForQuestion(task, mockRes, submissionId, actualModel as ModelType, allPagesOcrData, usageTracker)
                                        .then(result => {
                                            // [DIAGNOSTIC] Guillotine Trigger Check
                                            const scheme = task.markingScheme;
                                            // FIX: Use authoritative Total Marks from the result (resolved by MarkingInstructionService)
                                            const resultTotal = (result.score && result.score.totalMarks);
                                            // console.log(`[GUILLOTINE CHECK] Q${task.questionNumber}: isGeneric=${scheme?.isGeneric}, hasAnnotations=${!!result.annotations}, hasScore=${!!result.score}, SchemeTotal=${scheme?.totalMarks}, ResultTotal=${resultTotal}`);

                                            // [GUILLOTINE] Hard-Coded Post-Processing for Point-Based Questions
                                            // Ensure we strictly respect the budget, especially per sub-question.
                                            // Bypassed for Level-of-Response (LoR) questions where ScoreAuditor.reconcileLevelOfResponseScore is authoritative.
                                            const isLoRResult = isLevelOfResponseQuestion(
                                                task.markingScheme,
                                                subjectProfile,
                                                (result as any).rubricEvaluation
                                            );
                                            if (!isLoRResult && task.markingScheme && result.annotations && result.score) {
                                                const isGenericScheme = Boolean(task.markingScheme?.isGeneric);
                                                const hasIncompleteBudgets = Boolean(
                                                    isGenericScheme && (
                                                        !task.markingScheme?.totalMarks ||
                                                        task.markingScheme.totalMarks <= 0 ||
                                                        (task.markingScheme as any)?.hasIncompleteSubQuestionBudgets ||
                                                        (result.score?.totalMarks && result.score.totalMarks > (task.markingScheme.totalMarks || 0))
                                                    )
                                                );
                                                const aiReportedTotalMarks = Number((result as any)?.meta?.question_total_marks || result.score?.totalMarks || 0);
                                                const aiReportedAwardedMarks = Number(result.score?.awardedMarks || 0);
                                                const anyAnnotations = result.annotations as any[];
                                                const subQuestionBudgets = task.markingScheme.subQuestionMaxScores || {};
                                                const totalBudget = (hasIncompleteBudgets && aiReportedTotalMarks > 0)
                                                    ? aiReportedTotalMarks
                                                    : (result.score.totalMarks || task.markingScheme.totalMarks || 0);

                                                const {
                                                    finalizedAnnotations
                                                } = applyPointBasedGuillotine({
                                                    annotations: anyAnnotations,
                                                    questionNumber: String(task.questionNumber || ''),
                                                    subQuestionBudgets,
                                                    totalBudget,
                                                    isGenericScheme,
                                                    hasIncompleteBudgets
                                                });

                                                result.annotations = finalizedAnnotations;

                                                // 4. Recalculate score
                                                // Always recalculate score if we have a budget to ensure consistency
                                                const countsChanged = true;

                                                if (countsChanged) {
                                                    const newAwarded = finalizedAnnotations.reduce((sum: number, a: any) => {
                                                        return sum + getAnnotationMarkVal(a);
                                                    }, 0);

                                                    result.score.awardedMarks = newAwarded;

                                                    // 🛡️ GENERIC / UNIVERSAL MODE TOTAL MARKS RECOVERY:
                                                    // If `result.score.totalMarks` is 0 (because the paper is not in the DB and
                                                    // mark brackets like `[ 1 ]` or `[ 4 ]` were in OCR blocks rather than classification text),
                                                    // compute the true denominator from all evaluated mark annotations (e.g. B1, B2, M1, A1, B0, M0, A0).
                                                    recoverGenericTotalMarks({
                                                        task,
                                                        result,
                                                        finalizedAnnotations,
                                                        newAwarded,
                                                        aiStatedTotalMarks: aiReportedTotalMarks,
                                                        isGenericScheme,
                                                        hasIncompleteBudgets,
                                                        aiReportedTotalMarks,
                                                        aiReportedAwardedMarks
                                                    });

                                                    result.score.scoreText = `${result.score.awardedMarks}/${result.score.totalMarks}`;
                                                }

                                                if (finalizedAnnotations.length < anyAnnotations.length && result.feedback) {
                                                    result.feedback += ` (Note: ${anyAnnotations.length - finalizedAnnotations.length} excess marks removed to fit budget)`;
                                                }
                                            }

                                            // Attach scheme to result for persistence
                                            if (result.cleanedOcrText) {
                                                // Already attached by service if it returns it
                                            }

                                            // FIX: Explicitly attach student work for Context Chat
                                            // ChatContextBuilder expects result.studentWork or result.classificationBlocks with text

                                            // DEBUG TRACE: Check if data is even present in the task
                                            if (['15'].includes(String(task.questionNumber))) {
                                                // console.log(`🔍 [DEBUG PIPELINE Q${task.questionNumber}] Student Work Trace:`);
                                                // console.log(`   - task.classificationStudentWork: ${task.classificationStudentWork ? task.classificationStudentWork.length + ' chars' : 'MISSING'}`);
                                                // console.log(`   - task.formattedOcrText: ${task.formattedOcrText ? 'PRESENT' : 'MISSING'}`);
                                                // console.log(`   - task.classificationBlocks: ${task.classificationBlocks ? task.classificationBlocks.length + ' blocks' : 'MISSING'}`);
                                            }

                                            if (!result.studentWork) {
                                                result.studentWork = task.classificationStudentWork || task.formattedOcrText || '';
                                            }
                                            // Also attach classification blocks if missing, as they contain precise line data
                                            if (!result.classificationBlocks && task.classificationBlocks) {
                                                result.classificationBlocks = task.classificationBlocks;
                                            }

                                            // Attach original question text from detection if available (for Context Chat)
                                            if (task.questionText && !result.questionText) {
                                                result.questionText = task.questionText;
                                            }
                                            if (task.databaseQuestionText && !result.databaseQuestionText) {
                                                result.databaseQuestionText = task.databaseQuestionText;
                                            }

                                            results.push(result);
                                        })
                                        .catch(error => {
                                            console.error(`❌ Worker failed for Q${task.questionNumber}:`, error);
                                            if (error.message && error.message.includes('MANUAL_REVIEW_REQUIRED_TOO_DENSE')) {
                                                console.log(`[DEBUG] Catching Dense Error for Q${task.questionNumber}. task.sourcePages = ${JSON.stringify(task.sourcePages)}`);
                                                results.push({
                                                    questionNumber: task.questionNumber,
                                                    pageIndex: task.sourcePages?.[0] ?? 0,
                                                    sourceImageIndices: task.sourcePages || [],
                                                    annotations: [],
                                                    score: { totalMarks: task.markingScheme?.marks || 0, awardedMarks: 0 },
                                                    isError: true,
                                                    errorMessage: 'Too Dense'
                                                } as any);
                                            }
                                        })
                                        .finally(() => {
                                            activeWorkers--;
                                            processNext();
                                        });
                                }
                            }
                        };

                        // Kick off the first batch
                        processNext();
                    });
                }
            );

            // FIX: Sort results by question number to ensure consistent order (e.g., Q12 before Q13)
            // The worker pool completes tasks in random order, so we must sort explicitly.
            allQuestionResults.sort((a, b) => {
                const qA = String(a.questionNumber);
                const qB = String(b.questionNumber);

                // Extract numeric parts for comparison
                const numA = parseFloat(qA.replace(/[^\d.]/g, ''));
                const numB = parseFloat(qB.replace(/[^\d.]/g, ''));

                if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
                    return numA - numB;
                }

                // Fallback to alphanumeric
                return qA.localeCompare(qB, undefined, { numeric: true, sensitivity: 'base' });
            });

            // Aggregate usage stats from marking results
            if (allQuestionResults) {

                allQuestionResults.forEach(qr => {
                    if (qr.usageTokens) {
                        totalLLMTokens += qr.usageTokens;
                        // Note: Tokens will be auto-recorded when services accept tracker
                        // For now, tracking via legacy usageTokens field
                    }
                    // if (qr.mathpixCalls) totalMathpixCalls += qr.mathpixCalls; // FIX: Prevent double counting (already counted in OCR phase)
                });
            }

            progressCallback(createProgressData(6, 'All questions marked.', MULTI_IMAGE_STEPS));
            logMarkingComplete();
            // ========================== END: IMPLEMENT STAGE 4 ==========================

            // ========================= PROCESS QUESTION-ONLY PAGES (FILTERED EARLIER) =========================
            // Process the questionOnly pages we filtered out earlier for text responses
            questionOnlyResult = null; // Reset or reuse
            if (questionOnlyPages.length > 0) {
                console.log(`\n📝 [QUESTION-ONLY] Processing ${questionOnlyPages.length} filtered questionOnly page(s)...`);

                // Build PROPER standalone classificationResult (not just filtered array)
                // Extract and sort all questions from questionOnly results
                const allQuestionOnlyQuestions = questionOnlyClassificationResults
                    .flatMap(r => r.result?.questions || [])
                    .sort((a: any, b: any) => {
                        const numA = parseInt(a.questionNumber?.toString().replace(/\D/g, '') || '0');
                        const numB = parseInt(b.questionNumber?.toString().replace(/\D/g, '') || '0');
                        return numA - numB;
                    });

                // Build complete standalone classificationResult (as if pure questionOnly mode)
                const questionOnlyClassificationResult = {
                    category: 'questionOnly',
                    questions: allQuestionOnlyQuestions,
                    hasAnyStudentWork: false,
                    hasMixedContent: false
                };

                console.log(`   Built standalone classificationResult:`);
                console.log(`     - Questions: ${questionOnlyClassificationResult.questions.length} (${questionOnlyClassificationResult.questions.map((q: any) => q.questionNumber).join(', ')})`);
                console.log(`     - Category: ${questionOnlyClassificationResult.category}`);

                // Call QuestionModeHandler for questionOnly pages and CAPTURE result
                questionOnlyResult = await QuestionModeHandlerService.handleQuestionMode({
                    classificationResult: questionOnlyClassificationResult,
                    standardizedPages: questionOnlyPages,
                    files,
                    actualModel,
                    userId: options.userId || 'anonymous',
                    submissionId,
                    req: req,
                    res: {
                        write: (data: string) => {
                            if (data.startsWith('data: ')) {
                                try {
                                    const jsonStr = data.substring(6);
                                    const parsed = JSON.parse(jsonStr);
                                    progressCallback(parsed);
                                } catch (e) {
                                    // Ignore
                                }
                            }
                        },
                        end: () => { }
                    } as any,
                    startTime,
                    logStep,
                    usageTracker,
                    suppressSseCompletion: true,  // CRITICAL: Suppress completion in mixed mode!
                    examPaperHint: dominantPaperHint, // ✅ Pass paper hint from marking pass
                    subjectProfile
                });

                console.log(`✅ [QUESTION-ONLY] Processed ${questionOnlyPages.length} page(s)`);
                console.log(`   Result captured:`, questionOnlyResult ? 'YES' : 'NO');
                if (questionOnlyResult) {
                    console.log(`   - Mode: ${questionOnlyResult.mode}`);
                    console.log(`   - message type: ${typeof questionOnlyResult.message}`);
                    console.log(`   - message keys:`, questionOnlyResult.message ? Object.keys(questionOnlyResult.message) : 'null');
                    console.log(`   - Has unifiedSession: ${!!questionOnlyResult.unifiedSession}`);

                    // Check what's actually in the result
                    if (questionOnlyResult.unifiedSession?.questionResponses) {
                        console.log(`   - Found questionResponses in unifiedSession: ${questionOnlyResult.unifiedSession.questionResponses.length}`);
                    }
                }
            }

            // ========================= VERIFY DOWNSTREAM TRIGGERING =========================
            console.log('\n🔍 [RESULT VERIFICATION] Checking what will be combined:');
            console.log(`   📊 Marking Results: ${allQuestionResults?.length || 0} questions`);
            console.log(`   📝 Question Results: ${questionOnlyResult ? 'YES (captured)' : 'NO'}`);
            console.log(`   ✅ Both modes triggered: ${(allQuestionResults?.length > 0) && questionOnlyResult ? 'YES' : 'NO'}`);
            //=================================================================================================

            // ========================= START: IMPLEMENT STAGE 5 =========================
            // --- Stage 5: Aggregation & Output ---
            progressCallback(createProgressData(7, 'Aggregating results and generating annotated images...', MULTI_IMAGE_STEPS));
            const logOutputGenerationComplete = logStep('Output Generation', 'output-generation');

            // 🚀 [PARALLEL PERFORMANCE SUMMARY]:
            // Kick off the 4s Performance Summary AI call concurrently with Output Generation (SVG burning + Firebase Storage image uploads)!
            const precomputedPerformanceSummaryPromise = (async () => {
                const summaryStart = Date.now();
                try {
                    const { overallScore: preOverall, totalPossibleScore: preTotal, overallScoreText: preScoreText } =
                        calculateOverallScore(allQuestionResults, markingScope?.label);
                    const isModifiedPaper = detectionResults?.some((r: any) => r.detectionResult?.isModifiedQuestion === true) || false;
                    let detectedQuestionForGrade: any = undefined;
                    if (!isModifiedPaper && markingSchemesMap && markingSchemesMap.size > 0) {
                        const allSchemes = Array.from(markingSchemesMap.values());
                        const firstSchemeEntry =
                            allSchemes.find((s: any) => !s?.isGeneric && s?.questionDetection?.found && s?.questionDetection?.match) ||
                            allSchemes[0];
                        detectedQuestionForGrade = firstSchemeEntry?.questionDetection || undefined;
                    }
                    const gradeResult = isModifiedPaper
                        ? { grade: undefined, predictedGrade: undefined, boundaries: undefined }
                        : await GradeBoundaryService.calculateGradeWithOrchestration(
                            preOverall,
                            preTotal,
                            detectedQuestionForGrade,
                            markingSchemesMap
                        );
                    const validDetectionEntry = detectionResults?.find((r: any) => {
                        const m = r?.detectionResult?.match;
                        return r?.detectionResult?.found === true && m?.board && m.board !== 'Unknown' && m.board !== 'N/A' && m?.paperCode !== 'Generic Question';
                    });
                    const firstDetection = validDetectionEntry?.detectionResult?.match || detectionResults?.[0]?.detectionResult?.match || {};
                    const isAnyQuestionFound = detectionResults?.some((r: any) => r.detectionResult?.found === true) || false;
                    const isRealPastPaper = Boolean(firstDetection.board && firstDetection.board !== 'Unknown' && isAnyQuestionFound);
                    const examInfo = isRealPastPaper ? {
                        examBoard: firstDetection.board || '',
                        examSeries: firstDetection.examSeries || firstDetection.year || '',
                        subject: firstDetection.subject || firstDetection.qualification || '',
                        examCode: firstDetection.paperCode || '',
                        tier: firstDetection.tier || '',
                        ...(isModifiedPaper ? { isModified: true } : {})
                    } : undefined;

                    const summary = await SessionManagementService.generateMasterPerformanceSummary(
                        allQuestionResults,
                        actualModel,
                        usageTracker,
                        isRealPastPaper && !isModifiedPaper ? gradeResult.grade : undefined,
                        isRealPastPaper && !isModifiedPaper ? gradeResult.predictedGrade : undefined,
                        isRealPastPaper && !isModifiedPaper ? gradeResult.boundaries : undefined,
                        { totalMarks: preTotal, awardedMarks: preOverall, scoreText: preScoreText },
                        examInfo
                    );
                    return { summary, durationMs: Date.now() - summaryStart, startTime: summaryStart };
                } catch (err) {
                    console.warn('⚠️ [PARALLEL SUMMARY] Failed to precompute performance summary:', err);
                    return { summary: undefined, durationMs: Date.now() - summaryStart, startTime: summaryStart };
                }
            })();

            const {
                finalAnnotatedOutput,
                overallScore,
                totalPossibleScore,
                overallScoreText,
                updatedQuestionResults,
                sortedStandardizedPages
            } = await MarkingOutputService.generateOutput(
                standardizedPages,  // Already filtered upstream - only marking pages
                allQuestionResults,
                classificationResult,
                allClassificationResults,
                allPagesOcrData,
                files,
                submissionId,
                { ...options, scopeLabel: markingScope?.label },
                markingSchemesMap,
                progressCallback,
                MULTI_IMAGE_STEPS
            );

            // ========================= REALIGN DETECTION RESULTS (FOR EXAM TAB) =========================
            // After re-indexing, we must also update sourceImageIndex in detectionResults 
            // so that the Exam Tab (sidebar) points to the correct physical pages.

            // Actually, MarkingOutputService already built the map internally.
            // Let's create a map from originalPageIndex to new physical index.
            const originalToPhysicalMap = new Map<number, number>();
            sortedStandardizedPages.forEach((p, physicalIdx) => {
                if (p.originalPageIndex !== undefined) {
                    originalToPhysicalMap.set(p.originalPageIndex, physicalIdx);
                }
            });
            


            
            // ===========================================================================================


            const reindexedDetectionResults = detectionResults.map(dr => {
                const newDr = { ...dr };
                if (dr.question?.sourceImageIndex !== undefined && dr.question.sourceImageIndex >= 0) {
                    newDr.question = {
                        ...dr.question,
                        sourceImageIndex: originalToPhysicalMap.get(dr.question.sourceImageIndex) ?? dr.question.sourceImageIndex
                    };
                }
                return newDr;
            });
            // ===========================================================================================


            logOutputGenerationComplete();

            // ========================= COMBINE QUESTION-ONLY RESULTS (BEFORE PERSISTENCE) =========================
            // Extract questionOnly text responses so they can be added to AI message content
            let combinedQuestionResponses: any[] = [];


            if (questionOnlyResult && questionOnlyResult.unifiedSession?.questionResponses) {
                console.log('\n📝 [RESULT COMBINATION] Extracting questionOnly responses...');
                const questionOnlyResponses = questionOnlyResult.unifiedSession.questionResponses;
                console.log(`   - QuestionOnly responses: ${questionOnlyResponses.length}`);

                // Sort questionOnly responses by question number
                questionOnlyResponses.sort((a: any, b: any) => {
                    const numA = parseInt(a.questionNumber?.toString().replace(/\D/g, '')) || 0;
                    const numB = parseInt(b.questionNumber?.toString().replace(/\D/g, '')) || 0;
                    return numA - numB;
                });

                combinedQuestionResponses = questionOnlyResponses;
                console.log(`   - Sorted questionOnly: ${combinedQuestionResponses.map((r: any) => r.questionNumber).join(', ')}`);
            } else {
                console.log('⚠️  [COMBINATION] No questionResponses found');
            }
            //=================================================================================

            if (preFlightBucket?.skipPersistenceAndComplete) {
                return {
                    paperIndex: preFlightBucket.paperIndex ?? 0,
                    paperLabel: preFlightBucket.paperLabel || `Paper ${(preFlightBucket.paperIndex ?? 0) + 1}`,
                    sortedStandardizedPages,
                    updatedQuestionResults,
                    classificationResult,
                    allClassificationResults,
                    markingSchemesMap,
                    reindexedDetectionResults,
                    finalAnnotatedOutput,
                    overallScore,
                    totalPossibleScore,
                    overallScoreText,
                    allPagesOcrData,
                    combinedQuestionResponses,
                    precomputedPerformanceSummaryPromise,
                    subjectProfile
                };
            }

            // ========================= START: DATABASE PERSISTENCE =========================
            const { unifiedSession } = await MarkingPersistenceService.persistSession(
                files,
                options,
                submissionId,
                startTime,
                sortedStandardizedPages, // RE-INDEXED
                updatedQuestionResults, // RE-INDEXED
                classificationResult,
                allClassificationResults,
                markingSchemesMap,
                reindexedDetectionResults,  // RE-INDEXED for Exam Tab building
                globalQuestionText,
                finalAnnotatedOutput,
                overallScore,
                totalPossibleScore,
                overallScoreText,
                isPdf,
                isMultiplePdfs || isMixedUpload, // ✅ Ensures PDF contexts are persisted in mixed uploads
                pdfContext,
                isMixedContent,
                stepTimings,
                totalLLMTokens,
                combinedQuestionResponses,  // Pass questionOnly responses for persistence
                usageTracker,  // Pass UsageTracker for accurate token/cost tracking
                usageTracker.getMathpixPages(),  // Pass actual Mathpix call count from tracker
                allPagesOcrData,  // Pass OCR data for pipeline cache persistence
                preUploadedOriginalFilesPromise,
                precomputedPerformanceSummaryPromise
            );

            // Construct unified finalOutput that works for both authenticated and unauthenticated users
            const finalOutput = {
                success: true, // Add success flag for frontend compatibility
                submissionId: submissionId,
                // Calculate message-specific processing stats (not session-level totals)
                processingStats: {
                    apiUsed: getRealApiName(getRealModelName(actualModel)),
                    modelUsed: getRealModelName(actualModel),
                    selectedModel: actualModel,
                    totalMarks: totalPossibleScore, // Use the grouped total marks calculation
                    awardedMarks: allQuestionResults.reduce((sum, q) => sum + (q.score?.awardedMarks || 0), 0),
                    questionCount: allQuestionResults.length,
                    usageTokens: usageTracker.getTotalTokens(),
                    mathpixCalls: usageTracker.getMathpixPages()
                },
                annotatedOutput: finalAnnotatedOutput,
                outputFormat: 'images',
                originalInputType: isPdf ? 'pdf' : 'images',
                // Always include unifiedSession for consistent frontend handling
                unifiedSession: unifiedSession,
                results: updatedQuestionResults,
                metadata: {
                    totalQuestions: allQuestionResults.length,
                    totalScore: overallScore, // Use calculated overall score
                    maxScore: totalPossibleScore, // Use grouped total marks calculation to avoid double-counting
                    processingTime: (Date.now() - startTime) / 1000
                },
                // Add sessionId for credit deduction (prefer questionOnly result for pure Question Mode)
                sessionId: questionOnlyResult?.sessionId || unifiedSession?.sessionId,
                // Add sessionStats for usageRecord lookup
                sessionStats: unifiedSession?.sessionStats || null,
                // Add PDF context for frontend display
                ...(pdfContext && {
                    originalFileType: pdfContext.originalFileType,
                    originalPdfLink: pdfContext.originalPdfLink,
                    originalPdfDataUrl: pdfContext.originalPdfDataUrl,
                    originalFileName: pdfContext.originalFileName,
                    // Include pdfContexts for multiple PDFs
                    ...(pdfContext.pdfContexts && {
                        pdfContexts: pdfContext.pdfContexts
                    })
                })
            };

            // --- Send FINAL Complete Event ---
            if (process.env.CHAOS_MODE === 'true') {
                console.log('🌪️ [CHAOS MODE] Simulating 85s latency before complete payload...');
                await new Promise(resolve => setTimeout(resolve, 85000));
            }
            progressCallback({ type: 'complete', result: finalOutput }); // 'true' marks as final

            // --- Performance Summary ---
            const totalProcessingTime = Date.now() - startTime;

            // Gather all blocks (OCR + Classification) for the transparency report
            const allOcrBlocks = allPagesOcrData.flatMap(page => {
                let ocrIdx = 0;
                const blocks: any[] = [];

                // 1. Mathpix/Vision Blocks
                if (page.ocrData?.mathBlocks) {
                    page.ocrData.mathBlocks.forEach((b: any) => {
                        // GLOBAL RESCUE ID: p{PageIndex}_ocr_{Index}
                        const globalRescueId = `p${page.pageIndex}_ocr_${ocrIdx++}`;

                        // Use globalBlockId if it exists (highly preferred), otherwise use our new global format.
                        // We do NOT use the old "block_..." format anymore to avoid collision ambiguity.
                        blocks.push({ ...b, id: b.globalBlockId || globalRescueId });
                    });
                }
                if (page.ocrData?.blocks) {
                    page.ocrData.blocks.forEach((b: any) => {
                        const globalRescueId = `p${page.pageIndex}_ocr_${ocrIdx++}`;
                        blocks.push({ ...b, id: b.globalBlockId || globalRescueId });
                    });
                }

                // 2. Classification Blocks (CRITICAL: These are the citations AI usually makes)
                if (page.classificationResult?.questions) {

                    // Reset or continue an index? Ideally continue if we want global uniqueness, but per-page reset with standard IDs is safer if AI resets.
                    // However, AI cites "line_1", "line_13" globally?
                    // Let's assume global sequential for the page context.
                    let logLineIdx = 1;

                    // Recursive helper to gather lines from any depth
                    const gatherLines = (node: any, parentBaseQNum: string) => {
                        // 1. Gather lines from current node
                        if (node.studentWorkLines) {
                            node.studentWorkLines.forEach((l: any) => {
                                // AUTO-SYNTHESIZE ID if missing
                                const isSynthesized = !l.id && !l.lineId;

                                // GLOBAL ID: p{Page}_q{Question}_line_{Index}
                                // We now have parentBaseQNum passed down!
                                const pIdx = l.pageIndex ?? node.pageIndex ?? page.pageIndex;
                                const synthesizedId = `p${pIdx}_q${parentBaseQNum}_line_${logLineIdx++}`;

                                // If l.id exists, it MIGHT be the new global ID we just set in MarkingExecutor, 
                                // OR it might be a weak "line_1" from an old pass.
                                // We check if it matches the global pattern.
                                let validId = l.id || l.lineId;

                                // If ID is missing or "weak" (just line_X), synthesize a robust one
                                if (!validId || validId.startsWith('line_')) {
                                    validId = synthesizedId;
                                }
                                blocks.push({ text: l.text, id: validId, metadata: { isSynthesized } });
                            });
                        }
                        // 2. Recurse into subQuestions
                        if (node.subQuestions && Array.isArray(node.subQuestions)) {
                            node.subQuestions.forEach((child: any) => gatherLines(child, parentBaseQNum));
                        }
                    };

                    // Start traversal for each top-level question
                    page.classificationResult.questions.forEach((q: any) => {
                        const baseQNum = q.questionNumber ? q.questionNumber.toString().replace(/\D/g, '') : '0';
                        gatherLines(q, baseQNum);
                    });
                } else {
                    console.warn(`⚠️ [LOG-DEBUG] No classificationResult for page ${page.pageIndex} in allPagesOcrData`);
                }
                return blocks;
            });


            logAnnotationSummary(allQuestionResults, markingTasks);
            logPerformanceSummary(stepTimings, totalProcessingTime, actualModel, 'unified');
            console.log(usageTracker.getSummary(actualModel));

            console.log(`\n🏁 ========== UNIFIED PIPELINE END ==========`);
            console.log(`🏁 ==========================================\n`);
            // ========================== END: IMPLEMENT STAGE 5 ==========================

            return finalOutput;

        } catch (error: any) {
            console.error('❌ Pipeline Error:', error);
            throw error;
        }
    }

    /**
     * Executes the zero-reupload re-marking pipeline.
     * Reuses cached OCR data & student page images to re-grade against an official past paper mark scheme
     * and updates the session in-place. Deducts 0 credits!
     */
    static async executeRemarkPipeline(
        req: Request,
        options: {
            sessionId: string;
            paperTitle?: string;
            questionNumber?: string | null;
            uploadedSchemeFiles?: Array<{ originalName: string; mimeType: string; base64Data: string }>;
            model?: string;
            userId?: string;
            aiMessageId?: string;
        },
        progressCallback: (data: any) => void,
        usageTracker: UsageTracker
    ): Promise<any> {
        const startTime = Date.now();
        console.log(`🚀 [REMARK-PIPELINE] Starting re-marking for session ${options.sessionId} | paper="${options.paperTitle || 'N/A'}" | question="${options.questionNumber || 'ALL'}" | schemeFiles=${options.uploadedSchemeFiles?.length || 0}`);

        // 1. Load Cache (loading_cache)
        progressCallback(createProgressData(0, 'Loading cached student work...', REMARK_STEPS));
        const db = getFirestore();
        if (!db) {
            throw new Error('Firestore is not available');
        }

        let resolvedSessionId = options.sessionId;
        let cacheDoc = await db.collection('unifiedSessions').doc(resolvedSessionId).collection('pipelineCache').doc('latest').get();

        if (!cacheDoc.exists) {
            const alternateId = resolvedSessionId.startsWith('sub-')
                ? resolvedSessionId.replace(/^sub-/, 'session-')
                : resolvedSessionId.startsWith('session-')
                ? resolvedSessionId.replace(/^session-/, 'sub-')
                : null;
            if (alternateId) {
                const altDoc = await db.collection('unifiedSessions').doc(alternateId).collection('pipelineCache').doc('latest').get();
                if (altDoc.exists) {
                    resolvedSessionId = alternateId;
                    cacheDoc = altDoc;
                }
            }
        }

        if (!cacheDoc.exists) {
            const sessionSnap = await db.collection('unifiedSessions').doc(options.sessionId).get();
            if (sessionSnap.exists) {
                const sData = sessionSnap.data() as any;
                if (sData?.pipelineCache) {
                    cacheDoc = { exists: true, data: () => sData.pipelineCache } as any;
                } else if (sData?.sessionId && sData.sessionId !== options.sessionId) {
                    const linkedDoc = await db.collection('unifiedSessions').doc(sData.sessionId).collection('pipelineCache').doc('latest').get();
                    if (linkedDoc.exists) {
                        resolvedSessionId = sData.sessionId;
                        cacheDoc = linkedDoc;
                    }
                }
            }
        }

        if (!cacheDoc.exists) {
            throw new Error(`Pipeline cache not found for session ${options.sessionId}. Please re-upload your document.`);
        }

        let cacheData = cacheDoc.data() as any;
        if (cacheData.cacheStorageUrl) {
            const resp = await axios.get(cacheData.cacheStorageUrl);
            cacheData = resp.data;
        }

        const pagesMeta = cacheData.pagesMeta || [];
        if (pagesMeta.length === 0) {
            throw new Error('No cached student pages found in pipeline cache.');
        }

        const standardizedPages: StandardizedPage[] = [];
        for (let i = 0; i < pagesMeta.length; i++) {
            const pm = pagesMeta[i];
            let imgData = '';
            if (pm.imageUrl) {
                if (pm.imageUrl.startsWith('data:')) {
                    imgData = pm.imageUrl;
                } else {
                    try {
                        const imgResp = await axios.get(pm.imageUrl, { responseType: 'arraybuffer' });
                        const contentType = imgResp.headers['content-type'] || 'image/jpeg';
                        const base64 = Buffer.from(imgResp.data).toString('base64');
                        imgData = `data:${contentType};base64,${base64}`;
                    } catch (fetchErr) {
                        console.error(`❌ [REMARK] Failed to fetch image from ${pm.imageUrl}:`, fetchErr);
                    }
                }
            }
            standardizedPages.push({
                pageIndex: pm.pageIndex ?? i,
                originalPageIndex: pm.originalPageIndex ?? i,
                originalFileName: pm.originalFileName || `page-${i + 1}.jpg`,
                width: pm.width,
                height: pm.height,
                imageData: imgData
            });
        }

        let classificationResult = JSON.parse(JSON.stringify(cacheData.classificationResult || { questions: [] }));
        let allClassificationResults = JSON.parse(JSON.stringify(cacheData.allClassificationResults || []));
        const allPagesOcrData: PageOcrResult[] = cacheData.allPagesOcrData || [];

        // 2. Resolve Target Rubric: Either Custom Uploaded Mark Scheme OR Official Past Paper
        progressCallback(createProgressData(1, 'Fetching & validating mark scheme...', REMARK_STEPS));

        let parsedCustomScheme: any = undefined;

        // --- PATH A: USER UPLOADED CUSTOM MARK SCHEME FILES ---
        if (Array.isArray(options.uploadedSchemeFiles) && options.uploadedSchemeFiles.length > 0) {
            const schemePageImages: string[] = [];

            for (const f of options.uploadedSchemeFiles) {
                const rawB64 = f.base64Data.includes(',') ? f.base64Data.split(',')[1] : f.base64Data;
                const buf = Buffer.from(rawB64, 'base64');
                if (f.mimeType === 'application/pdf' || f.originalName?.toLowerCase().endsWith('.pdf')) {
                    const pdfPages = await PdfProcessingService.convertPdfToImages(buf, { maxPages: 30 });
                    pdfPages.forEach(p => schemePageImages.push(p.imageData));
                } else {
                    const normImg = await ImageUtils.normalizeOrientation(
                        f.base64Data.startsWith('data:') ? f.base64Data : `data:${f.mimeType || 'image/jpeg'};base64,${rawB64}`
                    );
                    schemePageImages.push(normImg);
                }
            }

            if (schemePageImages.length === 0) {
                throw new Error('INVALID_MARKING_SCHEME: Could not read any pages from the uploaded file.');
            }

            // 🛡️ STRICT VALIDATION GATE 1: Verify with ImageGeometryService that the uploaded files are actually a Marking Scheme
            // (Rejects dummy images, selfies, or duplicate student essay pages like "HARRY D Q5 P1_page_1.jpg"!)
            const lightSchemeImages = await Promise.all(
                schemePageImages.map(img => ImageUtils.createLightweightCopy(img, 800))
            );
            const geoChecks = await Promise.all(
                lightSchemeImages.map(img => ImageGeometryService.analyze(img, 800, 1000, 'fast', usageTracker))
            );

            const validSchemeImages = schemePageImages.filter((_, idx) => geoChecks[idx]?.is_acceptable_quality && geoChecks[idx]?.is_marking_scheme === true);

            if (validSchemeImages.length === 0) {
                console.warn(`🛑 [REMARK-REJECTED] Uploaded file(s) failed Marking Scheme validation gate. None of the ${schemePageImages.length} page(s) were recognized as a marking scheme.`);
                throw new Error('INVALID_MARKING_SCHEME: The uploaded file is not a valid marking scheme (it looks like a student answer page or non-scheme image). Your existing marks have been kept.');
            }

            // 🛡️ STRICT VALIDATION GATE 2: Parse the scheme and ensure it contains valid question criteria
            const { MarkingSchemeParserService } = await import('./MarkingSchemeParserService.js');
            parsedCustomScheme = await MarkingSchemeParserService.parseImagesToObject(validSchemeImages, usageTracker);

            if (!parsedCustomScheme || !parsedCustomScheme.questions || Object.keys(parsedCustomScheme.questions).length === 0) {
                throw new Error('INVALID_MARKING_SCHEME: Could not extract any valid marking scheme criteria from the uploaded file. Your existing marks have been kept.');
            }
            console.log(`✅ [REMARK-SCHEME] Validated & parsed custom marking scheme with ${Object.keys(parsedCustomScheme.questions).length} question(s).`);
        }

        // --- PATH B: USER SELECTED OFFICIAL PAST PAPER ---
        const targetQNum = options.questionNumber && options.questionNumber !== 'ALL'
            ? String(options.questionNumber).replace(/^Q/i, '').trim()
            : null;

        const findOfficialPaperDoc = async (paperTitleStr?: string): Promise<any | null> => {
            if (!paperTitleStr) return null;
            const exactSnap = await db.collection('fullExamPapers').where('paperTitle', '==', paperTitleStr).limit(1).get();
            if (!exactSnap.empty) return exactSnap.docs[0].data();

            const codeMatch = paperTitleStr.match(/\b([0-9A-Z]{4,6}\/[0-9A-Z]{1,3}|8700\/[12]|8300\/[123][FH]|1MA1\/[123][FH]|J560\/0[1-6]|J351\/0[12]|1EN0\/0[12])\b/i);
            if (codeMatch) {
                const targetCode = codeMatch[1].toUpperCase();
                let byCodeSnap = await db.collection('fullExamPapers').where('paperCode', '==', targetCode).get();
                if (byCodeSnap.empty) {
                    byCodeSnap = await db.collection('fullExamPapers').where('metadata.exam_code', '==', targetCode).get();
                }
                if (!byCodeSnap.empty) {
                    const norm = (s: string) => (s || '').toLowerCase().replace(/\b(june|may|summer)\b/g, 'summer').replace(/[^a-z0-9]/g, '');
                    const targetNorm = norm(paperTitleStr);
                    const matched = byCodeSnap.docs.find(d => {
                        const data = d.data();
                        const series = data.examSeries || data.metadata?.exam_series || '';
                        return series && targetNorm.includes(norm(series));
                    }) || byCodeSnap.docs[0];
                    return matched.data();
                }
            }
            return null;
        };

        const officialPaperDoc = await findOfficialPaperDoc(options.paperTitle);

        const getOfficialQuestionFromDoc = (paperDoc: any, qNum: string): any | null => {
            if (!paperDoc) return null;
            const qList = paperDoc.questions || paperDoc.marking_scheme?.questions || paperDoc.markingScheme?.allQuestions;
            const baseTarget = getBaseQuestionNumber(qNum) || qNum;
            if (Array.isArray(qList)) {
                return qList.find((q: any) => {
                    const qn = String(q.questionNumber ?? q.question_number ?? q.number ?? '').replace(/^0+/, '');
                    return qn === qNum || getBaseQuestionNumber(qn) === baseTarget;
                }) || null;
            } else if (qList && typeof qList === 'object') {
                return qList[qNum] || qList[`0${qNum}`] || qList[baseTarget] || null;
            }
            return null;
        };

        if (targetQNum) {
            const dbQObj = getOfficialQuestionFromDoc(officialPaperDoc, targetQNum);
            const officialStemText = dbQObj?.questionText || dbQObj?.question_text || dbQObj?.text || '';

            if (classificationResult?.questions?.length > 0) {
                classificationResult.questions.forEach((q: any) => {
                    q.questionNumber = targetQNum;
                    if (officialStemText) {
                        q.text = officialStemText;
                    }
                });
            }
            if (Array.isArray(allClassificationResults)) {
                allClassificationResults.forEach((cr: any) => {
                    const qArr = cr?.result?.questions || cr?.questions || [];
                    if (Array.isArray(qArr)) {
                        qArr.forEach((q: any) => {
                            q.questionNumber = targetQNum;
                            if (officialStemText) {
                                q.text = officialStemText;
                            }
                        });
                    }
                });
            }
        }

        let subjectProfile: SubjectProfile = resolveSubjectProfile({
            detectedSubject: cacheData.subjectProfileKey,
            subject: parsedCustomScheme?.examDetails?.subject || officialPaperDoc?.metadata?.subject || officialPaperDoc?.subject,
            paperCode: parsedCustomScheme?.examDetails?.paperCode || officialPaperDoc?.metadata?.exam_code || officialPaperDoc?.paperCode || options.paperTitle,
            paperTitle: options.paperTitle,
            customText: options.paperTitle
        });

        const individualQuestions = extractQuestionsFromClassification(classificationResult, standardizedPages[0]?.originalFileName);
        if (targetQNum && individualQuestions.length > 0) {
            const dbQObj = getOfficialQuestionFromDoc(officialPaperDoc, targetQNum);
            const officialStemText = dbQObj?.questionText || dbQObj?.question_text || dbQObj?.text || '';
            individualQuestions.forEach(iq => {
                iq.questionNumber = targetQNum;
                if (officialStemText) iq.text = officialStemText;
            });
        }

        const orchestrationResult = await MarkingSchemeOrchestrationService.orchestrateMarkingSchemeLookup(
            individualQuestions,
            classificationResult,
            options.paperTitle || null,
            parsedCustomScheme,
            subjectProfile?.ocrStrategy === 'VISION_VERBATIM',
            subjectProfile
        );

        const markingSchemesMap = orchestrationResult.markingSchemesMap;
        const detectionResults = orchestrationResult.detectionResults;
        classificationResult = orchestrationResult.updatedClassificationResult;

        const firstMatch = detectionResults.find((dr: any) => dr?.detectionResult?.found && dr?.detectionResult?.match)?.detectionResult?.match;
        if (firstMatch) {
            const dbResolvedProfile = resolveSubjectProfile({
                detectedSubject: cacheData.subjectProfileKey,
                subject: firstMatch.subject || firstMatch.qualification,
                paperCode: firstMatch.paperCode || firstMatch.examCode || options.paperTitle,
                paperTitle: firstMatch.paperTitle || options.paperTitle
            });
            if (dbResolvedProfile.key !== subjectProfile.key) {
                subjectProfile = dbResolvedProfile;
            }
        }

        // CRITICAL: Attach subjectProfile to every entry in markingSchemesMap so LoR vs M1/A1/B1 prompts work properly!
        if (markingSchemesMap && markingSchemesMap.size > 0) {
            for (const schemeEntry of markingSchemesMap.values()) {
                if (schemeEntry && typeof schemeEntry === 'object') {
                    schemeEntry.subjectProfile = subjectProfile;
                    if (schemeEntry.questionMarks && typeof schemeEntry.questionMarks === 'object') {
                        schemeEntry.questionMarks.subjectProfile = subjectProfile;
                    }
                }
            }
        }

        // 3. Run Fast Marking & Output Generation (marking -> generating_output)
        progressCallback(createProgressData(2, 'Re-marking with official rubric...', REMARK_STEPS));

        const pageDimensionsMap = new Map<number, { width: number; height: number }>();
        standardizedPages.forEach(p => {
            if (p.width && p.height) pageDimensionsMap.set(p.pageIndex, { width: p.width, height: p.height });
        });

        // Attach classificationResult to allPagesOcrData pages so createMarkingTasksFromClassification links lines properly
        allPagesOcrData.forEach(page => {
            const matches = allClassificationResults.filter((r: any) => r.pageIndex === page.pageIndex);
            if (matches.length > 0) {
                (page as any).classificationResult = {
                    questions: matches.flatMap((m: any) => m.result?.questions || m.questions || [])
                };
            }
        });

        const markingTasks = createMarkingTasksFromClassification(
            classificationResult,
            allPagesOcrData,
            markingSchemesMap,
            pageDimensionsMap,
            standardizedPages,
            allClassificationResults,
            []
        );

        const selectedTier = (options.model && options.model !== 'auto') ? options.model : getDefaultModel();
        const actualModel = selectedTier;

        const allQuestionResults: any[] = [];
        for (const task of markingTasks) {
            const mockRes = {
                write: (data: string) => {
                    if (data.startsWith('data: ')) {
                        try {
                            const parsed = JSON.parse(data.substring(6));
                            progressCallback(parsed);
                        } catch (e) {}
                    }
                }
            } as any;
            const result = await executeMarkingForQuestion(
                task,
                mockRes,
                resolvedSessionId,
                actualModel as ModelType,
                allPagesOcrData,
                usageTracker
            );
            if (!result.studentWork) {
                result.studentWork = task.classificationStudentWork || task.formattedOcrText || '';
            }
            if (!result.classificationBlocks && task.classificationBlocks) {
                result.classificationBlocks = task.classificationBlocks;
            }
            if (task.questionText && !result.questionText) {
                result.questionText = task.questionText;
            }
            if (task.databaseQuestionText && !result.databaseQuestionText) {
                result.databaseQuestionText = task.databaseQuestionText;
            }
            allQuestionResults.push(result);
        }

        progressCallback(createProgressData(3, 'Updating grade boundaries & annotations...', REMARK_STEPS));

        const dummyFiles: any[] = standardizedPages.map((p, idx) => ({
            originalname: p.originalFileName || `page-${idx + 1}.jpg`,
            buffer: Buffer.from(p.imageData.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64'),
            size: p.imageData.length
        }));

        const {
            finalAnnotatedOutput,
            overallScore,
            totalPossibleScore,
            overallScoreText,
            updatedQuestionResults,
            sortedStandardizedPages
        } = await MarkingOutputService.generateOutput(
            standardizedPages,
            allQuestionResults,
            classificationResult,
            allClassificationResults,
            allPagesOcrData,
            dummyFiles,
            resolvedSessionId,
            { userId: options.userId },
            markingSchemesMap,
            progressCallback,
            REMARK_STEPS
        );

        let detectedQuestionForGrade: any = undefined;
        if (markingSchemesMap && markingSchemesMap.size > 0) {
            const allSchemes = Array.from(markingSchemesMap.values());
            const firstSchemeEntry = allSchemes.find((s: any) => !s?.isGeneric && s?.questionDetection?.found && s?.questionDetection?.match) || allSchemes[0];
            detectedQuestionForGrade = firstSchemeEntry?.questionDetection || undefined;
        }

        const gradeResult = await GradeBoundaryService.calculateGradeWithOrchestration(
            overallScore,
            totalPossibleScore,
            detectedQuestionForGrade,
            markingSchemesMap
        );

        const richMarkingContext = await ChatContextBuilder.buildMarkingContext({
            allQuestionResults: updatedQuestionResults,
            questionDetection: detectionResults?.[0] || null,
            markingSchemesMap,
            detectionResults,
            overallScore: {
                awardedMarks: overallScore,
                totalMarks: totalPossibleScore,
                percentage: totalPossibleScore > 0 ? Math.round((overallScore / totalPossibleScore) * 100) : 0,
                scoreText: overallScoreText
            },
            gradeBoundaryResult: gradeResult,
            standardizedPages: sortedStandardizedPages
        });

        // 4. Update Session In-Place using SessionManagementService.createAIMessageForDatabase
        const sessionRef = db.collection('unifiedSessions').doc(resolvedSessionId);
        const sessionSnap = await sessionRef.get();
        if (!sessionSnap.exists) {
            throw new Error(`Unified session ${resolvedSessionId} not found`);
        }
        const sessionDoc = sessionSnap.data() as any;
        const existingMessages: any[] = Array.isArray(sessionDoc.messages)
            ? [...sessionDoc.messages]
            : Array.isArray(sessionDoc.unifiedMessages)
                ? [...sessionDoc.unifiedMessages]
                : [];

        let assistantIndex = -1;
        for (let i = existingMessages.length - 1; i >= 0; i--) {
            if (existingMessages[i].role === 'assistant') {
                assistantIndex = i;
                break;
            }
        }

        const preservedAiMessageId = assistantIndex >= 0
            ? existingMessages[assistantIndex].id
            : (options.aiMessageId || `ai-${Date.now()}`);

        const stepTimings: any = {};
        const dbAiMessage = await SessionManagementService.createAIMessageForDatabase({
            allQuestionResults: updatedQuestionResults,
            finalAnnotatedOutput,
            files: dummyFiles as any,
            actualModel,
            startTime,
            markingSchemesMap,
            detectionResults,
            globalQuestionText: classificationResult?.questions?.[0]?.text || '',
            resolvedAIMessageId: preservedAiMessageId,
            studentScore: {
                totalMarks: totalPossibleScore,
                awardedMarks: overallScore,
                scoreText: overallScoreText
            },
            grade: gradeResult.grade,
            predictedGrade: gradeResult.predictedGrade,
            gradeBoundaryType: gradeResult.boundaryType,
            gradeBoundaries: gradeResult.boundaries,
            markingContext: richMarkingContext,
            usageTracker,
            stepTimings,
            standardizedPages: sortedStandardizedPages
        });

        (dbAiMessage as any).suggestedFollowUps = await getSuggestedFollowUps();
        (dbAiMessage as any).requiresMarkingScheme = false;
        (dbAiMessage as any).timestamp = new Date().toISOString();

        (dbAiMessage as any).questionResponses = updatedQuestionResults.map(qr => ({
            questionNumber: String(qr.questionNumber || ''),
            questionText: qr.questionText || '',
            markingScheme: qr.markingScheme || '',
            score: qr.score,
            annotations: Array.isArray(qr.annotations)
                ? [...qr.annotations].sort((a, b) => getQuestionSortValue(a.subQuestion) - getQuestionSortValue(b.subQuestion))
                : qr.annotations,
            studentWork: qr.studentWork,
            pageIndex: qr.pageIndex,
            overallPerformanceSummary: qr.overallPerformanceSummary || qr.feedback
        })).sort((a, b) => getQuestionSortValue(a.questionNumber) - getQuestionSortValue(b.questionNumber));

        if (assistantIndex >= 0) {
            existingMessages[assistantIndex] = dbAiMessage;
        } else {
            existingMessages.push(dbAiMessage);
        }

        const { generateSessionTitleFromDetectionResults } = await import('./questionDetectionService.js');
        const finalSessionTitle = detectionResults && detectionResults.length > 0
            ? generateSessionTitleFromDetectionResults(detectionResults, 'Marking')
            : `${options.paperTitle || 'Custom Mark Scheme'}${targetQNum ? ` Q${targetQNum}` : ''}`;

        const updatedSessionFields: any = {
            title: finalSessionTitle,
            sessionTitle: finalSessionTitle,
            messageType: 'Marking',
            usageMode: 'marking',
            isPastPaper: Boolean(options.paperTitle),
            studentScore: dbAiMessage.studentScore,
            detectedQuestion: dbAiMessage.detectedQuestion,
            messages: existingMessages,
            unifiedMessages: existingMessages,
            updatedAt: new Date().toISOString(),
            lastMessagePreview: {
                content: dbAiMessage.content,
                role: 'assistant',
                timestamp: dbAiMessage.timestamp
            }
        };

        await sessionRef.set(updatedSessionFields, { merge: true });

        const unifiedSessionPayload = {
            ...sessionDoc,
            ...updatedSessionFields,
            id: resolvedSessionId,
            sessionId: resolvedSessionId,
            messages: existingMessages
        };

        import('../subjectMarkingResultService.js').then(({ persistMarkingResultToSubject }) => {
            persistMarkingResultToSubject(unifiedSessionPayload, dbAiMessage).catch(() => {});
        }).catch(() => {});

        const finalOutput = {
            success: true,
            submissionId: resolvedSessionId,
            sessionId: resolvedSessionId,
            sessionTitle: finalSessionTitle,
            unifiedSession: unifiedSessionPayload,
            aiMessage: dbAiMessage,
            annotatedOutput: finalAnnotatedOutput,
            outputFormat: 'images',
            results: updatedQuestionResults,
            metadata: {
                totalQuestions: updatedQuestionResults.length,
                totalScore: overallScore,
                maxScore: totalPossibleScore,
                processingTime: (Date.now() - startTime) / 1000
            },
            processingStats: {
                modelUsed: actualModel,
                totalMarks: totalPossibleScore,
                awardedMarks: overallScore,
                questionCount: updatedQuestionResults.length
            }
        };

        progressCallback({ type: 'complete', result: finalOutput });
        return finalOutput;
    }
}
