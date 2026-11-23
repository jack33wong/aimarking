import { Request, Response, NextFunction } from 'express';
import { MarkingPipelineService } from '../services/marking/MarkingPipelineService.js';
import { PreInspectService } from '../services/marking/PreInspectService.js';
import { sendSseUpdate } from '../utils/sseUtils.js';
import { PERMISSIONS, hasPermission } from '../config/permissions.js';
import UsageTracker from '../utils/UsageTracker.js';
import { checkCredits, deductCredits } from '../services/creditService.js';
import { GuestUsageService } from '../services/guestUsageService.js';
import axios from 'axios';
import https from 'https';
import { AdminAlertService } from '../services/AdminAlertService.js';
import { runWithLogCapture } from '../utils/RequestLogCapture.js';
import { UserFacingError } from '../utils/UserFacingError.js';
import { FirestoreService } from '../services/firestoreService.js';
import { SessionManagementService } from '../services/sessionManagementService.js';

// Global HTTPS Agent with Keep-Alive enabled
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30000
});

const MARKING_PIPELINE_STEPS = [
    'Input Validation',
    'Standardization',
    'Preprocessing',
    'OCR & Classification',
    'Question Detection',
    'Segmentation',
    'Marking',
    'Output Generation'
];

const REMARK_PIPELINE_STEPS = [
    'Loading Cached Work',
    'Fetching Mark Scheme',
    'Re-marking',
    'Updating Results'
];

function extractProgressData(data: any): any | undefined {
    if (!data) return undefined;
    if (data.progressData) return data.progressData;
    if (Array.isArray(data.allSteps)) {
        return {
            currentStepDescription: data.currentStepDescription,
            allSteps: data.allSteps,
            currentStepIndex: data.currentStepIndex,
            isComplete: Boolean(data.isComplete)
        };
    }
    return undefined;
}

export class MarkingController {
    /**
     * Handles re-marking an existing session using an official past paper mark scheme
     * with zero re-upload. Sets up SSE stream and delegates to MarkingPipelineService.executeRemarkPipeline.
     * Deducts 0 credits (Free Quota)!
     */
    public static async remarkSession(req: Request, res: Response, next: NextFunction): Promise<void> {
        const usageTracker = new UsageTracker();

        const { sessionId, paperTitle, questionNumber, model, aiMessageId, uploadedSchemeFiles } = req.body || {};
        if (!sessionId || (!paperTitle && (!Array.isArray(uploadedSchemeFiles) || uploadedSchemeFiles.length === 0))) {
            res.status(400).json({ error: 'Missing required parameters: sessionId and either paperTitle or uploadedSchemeFiles are required.' });
            return;
        }

        // Setup SSE Headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        sendSseUpdate(res, { type: 'connected', message: 'Connection established', sessionId });

        const heartbeat = setInterval(() => {
            res.write(':\n\n');
        }, 15000);

        let capturedRemarkLogs: { logsText: string; lineCount: number; durationMs: number; truncated: boolean } | null = null;
        let remarkModel = model;

        const resolvedRemarkAiMessageId = aiMessageId || `ai-${Date.now()}`;
        const remarkJobUserId = (req as any).user?.uid || null;
        const resolvedRemarkUid = remarkJobUserId || `guest:${req.ip || '0.0.0.0'}`;
        const schemeMulterFiles: Express.Multer.File[] = Array.isArray(uploadedSchemeFiles)
            ? uploadedSchemeFiles
                  .map((f: any, idx: number) => {
                      if (!f || typeof f.base64Data !== 'string') return null;
                      const rawB64 = f.base64Data.includes(',') ? f.base64Data.split(',')[1] : f.base64Data;
                      const buffer = Buffer.from(rawB64 || '', 'base64');
                      return {
                          originalname: f.originalName || `marking-scheme-${idx + 1}`,
                          mimetype: f.mimeType || 'application/octet-stream',
                          buffer,
                          size: buffer.length,
                      } as Express.Multer.File;
                  })
                  .filter((f): f is Express.Multer.File => Boolean(f && f.buffer.length > 0))
            : [];
        const schemeFileNames = schemeMulterFiles.map((f) => f.originalname).join(', ');
        let isRemarkJobFinished = false;
        let lastRemarkJobUpsertPromise: Promise<void> = Promise.resolve();
        const queueRemarkJobUpsert = (jobId: string, data: Record<string, any>): Promise<void> => {
            lastRemarkJobUpsertPromise = lastRemarkJobUpsertPromise
                .catch(() => {})
                .then(() => FirestoreService.upsertMarkingJob(jobId, data))
                .catch((err) => {
                    console.warn(`⚠️ [MARKING-JOB] Failed to upsert remark job ${jobId}:`, err?.message || err);
                });
            return lastRemarkJobUpsertPromise;
        };

        try {
            void queueRemarkJobUpsert(sessionId, {
                sessionId,
                submissionId: `remark-${sessionId}`,
                userId: remarkJobUserId,
                status: 'processing',
                isRemark: true,
                aiMessageId: resolvedRemarkAiMessageId,
                startedAt: Date.now(),
                progressData: {
                    currentStepDescription: 'Loading cached student work...',
                    allSteps: REMARK_PIPELINE_STEPS,
                    currentStepIndex: 0,
                    isComplete: false
                }
            });

            let requestedModel = model;
            if (!requestedModel || requestedModel.toUpperCase() === 'AUTO') {
                requestedModel = 'FAST';
            }
            remarkModel = requestedModel;

            const options = {
                sessionId,
                paperTitle,
                questionNumber: questionNumber || null,
                uploadedSchemeFiles: Array.isArray(uploadedSchemeFiles) ? uploadedSchemeFiles : undefined,
                model: requestedModel,
                userId: (req as any).user?.uid,
                aiMessageId: resolvedRemarkAiMessageId
            };

            let completeEventSent = false;
            const progressCallback = (data: any) => {
                if (data?.type === 'complete') {
                    completeEventSent = true;
                } else if (!isRemarkJobFinished && data?.type !== 'error') {
                    const progressData = extractProgressData(data);
                    if (progressData) {
                        void queueRemarkJobUpsert(sessionId, {
                            status: 'processing',
                            isRemark: true,
                            progressData
                        });
                    }
                }
                sendSseUpdate(res, data);
            };

            let remarkResult: any;
            let remarkError: any;

            const result = await runWithLogCapture(
                `remark-${sessionId}`,
                () => MarkingPipelineService.executeRemarkPipeline(
                    req,
                    options,
                    progressCallback,
                    usageTracker
                ),
                (captured) => {
                    capturedRemarkLogs = captured;
                }
            ).catch((err) => {
                remarkError = err;
                throw err;
            });
            remarkResult = result;
            isRemarkJobFinished = true;
            await queueRemarkJobUpsert(sessionId, {
                status: 'completed',
                sessionId,
                isRemark: true,
                completedAt: Date.now()
            });

            if (result && !completeEventSent) {
                sendSseUpdate(res, { type: 'complete', result });
                completeEventSent = true;
            }

            if (capturedRemarkLogs) {
                const rawRemarkAiContent =
                    (remarkResult as any)?.aiMessage?.content ||
                    (remarkResult as any)?.message?.content ||
                    undefined;

                let remarkUploadedFiles = AdminAlertService.extractUploadedFileLinksFromResult(remarkResult);
                if (schemeMulterFiles.length > 0) {
                    const schemeLogLinks = await Promise.race([
                        AdminAlertService.uploadFilesForLog(schemeMulterFiles, resolvedRemarkUid),
                        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 4000)),
                    ]);
                    remarkUploadedFiles = [...remarkUploadedFiles, ...schemeLogLinks];
                }

                await AdminAlertService.notifyMarkingLog({
                    submissionId: `remark-${sessionId}`,
                    sessionId,
                    userId: resolvedRemarkUid,
                    userEmail: (req as any).user?.email,
                    userAgent: req.get('user-agent') || undefined,
                    model: requestedModel,
                    isRemark: true,
                    turnType: 'REMARK',
                    result: remarkResult,
                    error: remarkError,
                    userInput: schemeFileNames ? `Uploaded marking scheme: ${schemeFileNames}` : (paperTitle ? `Official paper: ${paperTitle}` : undefined),
                    aiResponse: typeof rawRemarkAiContent === 'string' ? rawRemarkAiContent : undefined,
                    uploadedFiles: remarkUploadedFiles,
                    ...capturedRemarkLogs,
                });
            }

            res.end();
        } catch (error: any) {
            console.error('❌ [CONTROLLER] Remark request failed:', error);
            isRemarkJobFinished = true;
            const cleanErrorMessage =
                error.message?.replace(/^(?:INVALID_MARKING_SCHEME|UNSUPPORTED_SCHEME_FORMAT):\s*/i, '') ||
                'Failed to re-mark session.';
            const isCreditExhausted = error.message?.includes('exhausted your credits');
            const isInvalidScheme = error.message?.includes('INVALID_MARKING_SCHEME');
            const isUnsupportedFormat = error.message?.includes('UNSUPPORTED_SCHEME_FORMAT');

            await queueRemarkJobUpsert(sessionId, {
                status: 'failed',
                sessionId,
                isRemark: true,
                error: cleanErrorMessage,
                completedAt: Date.now()
            });

            // Option 1: Persist the failed marking-scheme upload attempt + system response in chat history
            // while keeping the student's existing graded message untouched.
            let persistedSchemeLinks: string[] = [];
            if (remarkJobUserId && remarkJobUserId !== 'anonymous' && sessionId && schemeMulterFiles.length > 0) {
                try {
                    const uploadResult = await SessionManagementService.uploadOriginalFiles(
                        schemeMulterFiles,
                        remarkJobUserId,
                        sessionId,
                        true
                    );
                    persistedSchemeLinks = uploadResult.originalImageLinks || [];

                    const pdfFiles = schemeMulterFiles
                        .map((file, idx) => ({ file, idx }))
                        .filter((entry) => entry.file.mimetype === 'application/pdf' || entry.file.originalname.toLowerCase().endsWith('.pdf'));
                    const isSinglePdf = schemeMulterFiles.length === 1 && pdfFiles.length === 1;
                    const isMultiplePdfs = pdfFiles.length > 1 || (pdfFiles.length >= 1 && schemeMulterFiles.length > 1);

                    let pdfContext: any = undefined;
                    if (isSinglePdf) {
                        pdfContext = {
                            isMultiplePdfs: false,
                            originalPdfLink: persistedSchemeLinks[0] || null,
                            originalFileName: schemeMulterFiles[0].originalname || 'marking-scheme.pdf',
                            fileSize: schemeMulterFiles[0].size || 0
                        };
                    } else if (isMultiplePdfs) {
                        pdfContext = {
                            isMultiplePdfs: true,
                            pdfContexts: pdfFiles.map(({ file, idx }) => ({
                                originalPdfLink: persistedSchemeLinks[idx] || null,
                                originalFileName: file.originalname || `marking-scheme-${idx + 1}.pdf`,
                                fileSize: file.size || 0
                            }))
                        };
                    }

                    const { structuredImageDataArray, structuredPdfContexts } = SessionManagementService.createStructuredData(
                        schemeMulterFiles,
                        isSinglePdf,
                        isMultiplePdfs,
                        pdfContext
                    );

                    const userTimestamp = new Date().toISOString();
                    const aiTimestamp = new Date(Date.now() + 50).toISOString();
                    const userUploadMessage = SessionManagementService.createUserMessageForDatabase(
                        {
                            content: `Uploaded marking scheme: ${schemeFileNames}`,
                            files: schemeMulterFiles,
                            isPdf: isSinglePdf,
                            isMultiplePdfs,
                            customText: `Uploaded marking scheme: ${schemeFileNames}`,
                            sessionId,
                            model: remarkModel || 'FAST',
                            pdfContext
                        },
                        structuredImageDataArray,
                        structuredPdfContexts,
                        persistedSchemeLinks
                    );
                    userUploadMessage.timestamp = userTimestamp;

                    const aiErrorMessage: any = {
                        id: `ai-remark-err-${Date.now()}`,
                        role: 'assistant',
                        content: cleanErrorMessage,
                        timestamp: aiTimestamp,
                        type: 'text',
                        isProcessing: false,
                        errorCode: isUnsupportedFormat
                            ? 'UNSUPPORTED_SCHEME_FORMAT'
                            : isInvalidScheme
                              ? 'INVALID_MARKING_SCHEME'
                              : 'REMARK_ERROR',
                        processingStats: {
                            apiUsed: 'System Validation',
                            modelUsed: 'Mark Scheme Check'
                        }
                    };

                    const existingSession = await FirestoreService.getUnifiedSession(sessionId);
                    if (existingSession) {
                        await FirestoreService.addMessageToUnifiedSession(sessionId, userUploadMessage, 'Marking');
                        await FirestoreService.addMessageToUnifiedSession(sessionId, aiErrorMessage, 'Marking');
                    }
                } catch (persistErr) {
                    console.error('⚠️ [CONTROLLER] Failed to persist remark error state to Firestore:', persistErr);
                }
            }

            if (capturedRemarkLogs) {
                let remarkUploadedFiles: any[] = persistedSchemeLinks
                    .map((url, idx) => ({
                        filename: schemeMulterFiles[idx]?.originalname || `marking-scheme-${idx + 1}`,
                        url,
                        sizeBytes: schemeMulterFiles[idx]?.size
                    }))
                    .filter((item) => Boolean(item.url));

                if (remarkUploadedFiles.length === 0 && schemeMulterFiles.length > 0) {
                    remarkUploadedFiles = await Promise.race([
                        AdminAlertService.uploadFilesForLog(schemeMulterFiles, resolvedRemarkUid),
                        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 6000)),
                    ]);
                }

                await AdminAlertService.notifyMarkingLog({
                    submissionId: `remark-${sessionId}`,
                    sessionId,
                    userId: resolvedRemarkUid,
                    userEmail: (req as any).user?.email,
                    userAgent: req.get('user-agent') || undefined,
                    model: remarkModel || 'FAST',
                    isRemark: true,
                    turnType: 'REMARK',
                    error,
                    userInput: schemeFileNames ? `Uploaded marking scheme: ${schemeFileNames}` : (paperTitle ? `Official paper: ${paperTitle}` : undefined),
                    aiResponse: cleanErrorMessage,
                    uploadedFiles: remarkUploadedFiles,
                    ...(capturedRemarkLogs as { logsText: string; lineCount: number; durationMs: number; truncated: boolean }),
                });
            }
            if (!isCreditExhausted && !isInvalidScheme && !isUnsupportedFormat) {
                void AdminAlertService.notifyCrash('MARKING', req, error);
            }
            sendSseUpdate(res, {
                type: 'error',
                error: cleanErrorMessage
            });
            res.end();
        } finally {
            clearInterval(heartbeat);
        }
    }

    /**
     * Proxies image download to bypass CORS and force attachment
     */
    public static async downloadImage(req: Request, res: Response): Promise<void> {
        const imageUrl = req.query.url as string;
        let filename = req.query.filename as string || 'download-image.jpg';

        // Never proxy an image with a .pdf extension
        if (filename.toLowerCase().endsWith('.pdf')) {
            filename = filename.replace(/\.pdf$/i, '.jpg');
        }

        if (!imageUrl) {
            res.status(400).send('Missing image URL');
            return;
        }

        try {
            console.log(`📡 [MARKING] Proxying download for: ${filename}`);
            const response = await axios({
                method: 'get',
                url: imageUrl,
                responseType: 'stream',
                httpsAgent: keepAliveAgent
            });

            // Forward relevant headers
            res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            // Pipe the stream
            response.data.pipe(res);
        } catch (error: any) {
            console.error('❌ [MARKING] Download proxy failed:', error.message);
            res.status(500).send('Failed to proxy image download');
        }
    }
    /**
     * Handles the marking request.
     * Sets up SSE, extracts parameters, and delegates to MarkingPipelineService.
     */
    public static async processMarkingRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
        const startTime = Date.now();
        const usageTracker = new UsageTracker();

        // Track critical IDs and completion state for credit deduction
        let finalUserId: string | null = null;
        let finalSessionId: string | null = null;
        let finalModel: string = 'gemini-3.7-flash';
        let shouldDeductCredits = false;
        let creditsDeducted = false;

        // 1. Validate Request
        console.log(`🚀 [MARKING] Controller started - Files: ${Array.isArray(req.files) ? req.files.length : 0}, Body Keys: ${Object.keys(req.body || {}).join(', ')}`);

        if (!req.files || (Array.isArray(req.files) && req.files.length === 0)) {
            console.warn('⚠️ [MARKING] 400 Bad Request: No files found in request.');
            console.log('[MARKING-DEBUG] Full Body:', JSON.stringify(req.body));
            res.status(400).json({
                error: 'No files uploaded.',
                debug: {
                    hasFiles: !!req.files,
                    filesCount: Array.isArray(req.files) ? req.files.length : 0,
                    bodyKeys: Object.keys(req.body || {}),
                    contentType: req.headers['content-type'],
                    hasRawBody: !!(req as any).rawBody,
                    rawBodySize: (req as any).rawBody?.length || 0
                }
            });
            return;
        }

        const files = req.files as Express.Multer.File[];

        let sessionId = req.body.sessionId;
        // Sanitization: Reject temp- IDs from frontend
        if (sessionId && sessionId.startsWith('temp-')) {
            console.log(`⚠️ [MARKING] Rejecting temp session ID: ${sessionId}`);
            sessionId = undefined;
        }

        const submissionId = req.body.submissionId || sessionId || `sub-${Date.now()}`;
        if (!sessionId) {
            sessionId = submissionId;
        }

        // 2. Setup SSE Headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Send initial connection confirmation with the guaranteed submissionId
        sendSseUpdate(res, { type: 'connected', message: 'Connection established', sessionId: submissionId });

        // 👇 KEEP-ALIVE HEARTBEAT 👇
        const heartbeat = setInterval(() => {
            // Sending a colon and newlines is an SSE comment. 
            // The frontend fetch reader will completely ignore it, but GCP stays awake.
            res.write(':\n\n'); 
        }, 15000); // Ping every 15 seconds

        let capturedMarkingLogs: { logsText: string; lineCount: number; durationMs: number; truncated: boolean } | null = null;
        const aiMessageId = req.body?.aiMessageId || `ai-${Date.now()}`;
        const jobUserId = (req as any).user?.uid || null;
        let isJobFinished = false;
        let lastJobUpsertPromise: Promise<void> = Promise.resolve();
        const queueJobUpsert = (jobId: string, data: Record<string, any>): Promise<void> => {
            lastJobUpsertPromise = lastJobUpsertPromise
                .catch(() => {})
                .then(() => FirestoreService.upsertMarkingJob(jobId, data))
                .catch((err) => {
                    console.warn(`⚠️ [MARKING-JOB] Failed to upsert job ${jobId}:`, err?.message || err);
                });
            return lastJobUpsertPromise;
        };

        try {
            void queueJobUpsert(submissionId, {
                sessionId: submissionId,
                submissionId,
                userId: jobUserId,
                status: 'processing',
                isRemark: false,
                aiMessageId,
                startedAt: Date.now(),
                progressData: {
                    currentStepDescription: 'Processing started...',
                    allSteps: MARKING_PIPELINE_STEPS,
                    currentStepIndex: 0,
                    isComplete: false
                }
            });
            // 3. Prepare Options
            let requestedModel = req.body.model;
            if (!requestedModel || requestedModel.toUpperCase() === 'AUTO') {
                requestedModel = 'FAST';
            }

            // Enforce Plan Limits: Only allowed plans can select custom models
            const userPlan = (req as any).userPlan || 'free';
            const isDefaultFast = (requestedModel || '').toUpperCase() === 'FAST';
            if (!hasPermission(userPlan, PERMISSIONS.MODEL_SELECTION_PLANS) && !isDefaultFast) {
                const uid = (req as any).user?.uid;
                const userIdentifier = (uid && uid !== 'anonymous') ? `User ${uid}` : 'Guest User';
                console.log(`🔒 [PLAN LIMIT] ${userIdentifier} (${userPlan}) tried to use model '${requestedModel}'. Forcing 'FAST'.`);
                requestedModel = 'FAST';
            }

            // Write back so downstream services see the final string
            req.body.model = requestedModel;

            let selectedRawPageIndices: number[] | undefined = undefined;
            if (req.body.selectedRawPageIndices !== undefined && req.body.selectedRawPageIndices !== null && req.body.selectedRawPageIndices !== '') {
                try {
                    const parsed = typeof req.body.selectedRawPageIndices === 'string'
                        ? JSON.parse(req.body.selectedRawPageIndices)
                        : req.body.selectedRawPageIndices;
                    if (Array.isArray(parsed)) {
                        const nums = parsed.map(Number).filter(n => Number.isFinite(n));
                        if (nums.length > 0) {
                            selectedRawPageIndices = nums;
                        }
                    }
                } catch {
                    console.warn('⚠️ [MARKING] Ignoring invalid selectedRawPageIndices payload');
                }
            }

            const options = {
                userId: (req as any).user?.uid,
                sessionId: sessionId,
                customText: req.body.customText,
                model: requestedModel,
                allowGenericSubjectMarking: req.body.allowGenericSubjectMarking === true || req.body.allowGenericSubjectMarking === 'true',
                bypassDuplicateQuestionGuard: req.body.bypassDuplicateQuestionGuard === true || req.body.bypassDuplicateQuestionGuard === 'true',
                bypassPreCheckPause: req.body.bypassPreCheckPause === true || req.body.bypassPreCheckPause === 'true',
                ...(selectedRawPageIndices ? { selectedRawPageIndices } : {})
            };

            const userId = options.userId;
            if (userId) {
                AdminAlertService.markUserActive(userId);
            }
            
            // Populate tracking variables for finally block
            finalUserId = userId || null;
            finalSessionId = sessionId || null;
            finalModel = requestedModel;

            const isAuthenticated = !!userId && userId !== 'anonymous';
            const userIP = req.ip || '0.0.0.0';

            // --- NEW: Guest Usage Limit Check ---
            if (!isAuthenticated) {
                const limitInfo = await GuestUsageService.checkLimit(userIP);
                if (!limitInfo.allowed) {
                    isJobFinished = true;
                    await queueJobUpsert(submissionId, {
                        status: 'failed',
                        sessionId: submissionId,
                        isRemark: false,
                        error: 'Guest limit reached. Please sign up to continue.',
                        completedAt: Date.now()
                    });
                    sendSseUpdate(res, {
                        type: 'error',
                        error: 'Guest limit reached. Please sign up to continue.',
                        details: 'guest_limit_reached',
                        usageCount: limitInfo.count,
                        usageLimit: limitInfo.limit,
                        resetAt: limitInfo.resetAt
                    });
                    res.end();
                    return;
                }
            }

            console.log(`🔍 [CREDIT DEBUG] userId: ${userId}, isAuthenticated: ${isAuthenticated}`);

            // Note: Credit check is now securely handled inside MarkingPipelineService.ts 
            // AFTER files have been standardized into explicit images for 100% accurate page counts.

            // 4. Execute Pipeline
            let completeEventSent = false;
            let pendingCompleteEvent: any = null;
            const progressCallback = (data: any) => {
                if (data?.type === 'complete') {
                    // Defer sending 'complete' until credits are deducted & job status is persisted
                    // so the frontend's immediate /api/credits refresh always reads post-deduction balance.
                    pendingCompleteEvent = data;
                    return;
                } else if (!isJobFinished && data?.type !== 'error') {
                    const progressData = extractProgressData(data);
                    if (progressData) {
                        void queueJobUpsert(submissionId, {
                            status: 'processing',
                            isRemark: false,
                            progressData
                        });
                    }
                }
                if (process.env.CHAOS_MODE === 'true') {
                    // Randomly drop non-essential packets (progress updates, not 'complete' or 'error' or first packet)
                    if (data.type !== 'complete' && data.type !== 'error' && data.progress !== 0) {
                        if (Math.random() < 0.3) {
                            console.log(`🌪️ [CHAOS MODE] Dropped packet: ${data.message || data.type}`);
                            return; // Simulate packet loss
                        }
                    }
                }
                sendSseUpdate(res, data);
            };

            const result = await runWithLogCapture(
                submissionId,
                () => MarkingPipelineService.executePipeline(
                    req,
                    files,
                    submissionId,
                    options,
                    progressCallback,
                    usageTracker
                ),
                (captured) => {
                    capturedMarkingLogs = captured;
                }
            );
            
            if (result?.sessionId) {
                finalSessionId = result.sessionId;
            }

            const warningCode = (result as any)?.warning || (result as any)?.submissionResult?.warning;
            const isRejectedOrEmpty = warningCode === 'CONTENT_REJECTED' ||
                warningCode === 'NOT_MATHS_CONTENT' ||
                warningCode === 'COVER_PAGE_ONLY' ||
                warningCode === 'NO_STUDENT_WORK';

            if (result && result.sessionId && !isRejectedOrEmpty) {
                shouldDeductCredits = true;
            }

            // 💳 Commit credit deduction BEFORE emitting 'complete' / marking job completed,
            // so the frontend's immediate /api/credits fetch always sees the updated balance (including negative).
            if (shouldDeductCredits && !creditsDeducted && finalUserId && finalUserId !== 'anonymous') {
                try {
                    const finalCost = usageTracker.calculateCost(finalModel).total;
                    if (finalCost > 0) {
                        console.log(`💳 [CREDIT DEDUCT] Calculating final cost: $${finalCost} for user ${finalUserId}`);
                        await deductCredits(finalUserId, finalCost, finalSessionId || 'unknown');
                        creditsDeducted = true;
                        console.log(`💳 ✅ Successfully deducted $${finalCost} from user ${finalUserId}`);
                    }
                } catch (deductionError) {
                    console.error('❌ CRITICAL: Failed to deduct credits before completion:', deductionError);
                }
            }

            console.log(`✅ [CONTROLLER] Pipeline completed, result exists: ${!!result}, sessionId: ${result?.sessionId}`);

            isJobFinished = true;
            const resolvedCompletedSessionId = result?.sessionId || finalSessionId || submissionId;
            const persistedToUnifiedSessions = Boolean(finalUserId && finalUserId !== 'anonymous' && resolvedCompletedSessionId);
            const completedJobPayload: Record<string, any> = {
                status: 'completed',
                sessionId: resolvedCompletedSessionId,
                isRemark: false,
                completedAt: Date.now(),
                ...(persistedToUnifiedSessions ? {} : { fallbackResult: result })
            };
            await queueJobUpsert(submissionId, completedJobPayload);
            if (resolvedCompletedSessionId && resolvedCompletedSessionId !== submissionId) {
                await queueJobUpsert(resolvedCompletedSessionId, completedJobPayload);
            }

            // 6. Handle Completion (guarantee 'complete' event was sent AFTER credits are deducted)
            if (!completeEventSent && (pendingCompleteEvent || result)) {
                sendSseUpdate(res, pendingCompleteEvent || { type: 'complete', result });
                completeEventSent = true;
            }

            // --- NEW: Increment Guest Usage ---
            if (!isAuthenticated && shouldDeductCredits) {
                await GuestUsageService.incrementUsage(userIP);
            }

            if (capturedMarkingLogs) {
                const resolvedUid = userId || (isAuthenticated ? 'auth-user' : `guest:${userIP}`);
                let uploadedFiles = AdminAlertService.extractUploadedFileLinksFromResult(result);
                if (uploadedFiles.length === 0 && files?.length > 0) {
                    uploadedFiles = await Promise.race([
                        AdminAlertService.uploadFilesForLog(files, resolvedUid),
                        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 2500)),
                    ]);
                }

                const rawAiContent =
                    (result as any)?.message?.content ||
                    (result as any)?.aiMessage?.content ||
                    (result as any)?.submissionResult?.aiMessage?.content ||
                    undefined;

                await AdminAlertService.notifyMarkingLog({
                    submissionId,
                    sessionId: result?.sessionId || finalSessionId,
                    userId: resolvedUid,
                    userEmail: (req as any).user?.email,
                    userAgent: req.get('user-agent') || undefined,
                    model: options.model || 'auto',
                    isRemark: false,
                    turnType: (result as any)?.mode === 'Question' ? 'QUESTION_MODE' : 'MARKING',
                    result,
                    userInput: options.customText || undefined,
                    aiResponse: typeof rawAiContent === 'string' ? rawAiContent : undefined,
                    uploadedFiles,
                    ...capturedMarkingLogs,
                });
            }

            res.end();

        } catch (error: any) {
            console.error(`❌ [CONTROLLER] Marking request failed: ${error.message}`);
            isJobFinished = true;

            const isCreditExhausted = error.message?.includes('exhausted your credits');
            const isOverdraftLimit =
                (error instanceof UserFacingError && error.code === 'OVERDRAFT_LIMIT_EXCEEDED') ||
                error.message?.includes('safety limit for overdrafts');
            const isLegacyUserFixable =
                isOverdraftLimit ||
                error.message?.includes('PDF_UNREADABLE') ||
                error.message?.includes('Postscript delegate failed') ||
                error.message?.includes('exceeds the maximum limit') ||
                error.message?.includes('limited to grading');

            const shouldAlertAdmin = !isCreditExhausted && (
                error instanceof UserFacingError
                    ? error.shouldAlertAdmin
                    : !isLegacyUserFixable
            );

            if (shouldAlertAdmin) {
                void AdminAlertService.notifyCrash('MARKING', req, error);
            }

            if (isCreditExhausted) {
                const creditFailPayload: Record<string, any> = {
                    status: 'failed',
                    sessionId: finalSessionId || submissionId,
                    isRemark: false,
                    error: error.message,
                    credits_exhausted: true,
                    completedAt: Date.now()
                };
                await queueJobUpsert(submissionId, creditFailPayload);
                if (finalSessionId && finalSessionId !== submissionId) {
                    await queueJobUpsert(finalSessionId, creditFailPayload);
                }
                if (capturedMarkingLogs) {
                    const resolvedUid = finalUserId || (req as any).user?.uid || `guest:${req.ip || '0.0.0.0'}`;
                    await AdminAlertService.notifyMarkingLog({
                        submissionId,
                        sessionId: finalSessionId || sessionId,
                        userId: resolvedUid,
                        userEmail: (req as any).user?.email,
                        userAgent: req.get('user-agent') || undefined,
                        model: finalModel || 'auto',
                        isRemark: false,
                        turnType: 'MARKING',
                        error,
                        userInput: req.body?.customText || undefined,
                        uploadedFiles: [],
                        ...(capturedMarkingLogs as { logsText: string; lineCount: number; durationMs: number; truncated: boolean }),
                    });
                }
                if (!res.headersSent) {
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.status(200);
                }
                const errorPayload = JSON.stringify({
                    type: 'error',
                    error: error.message,
                    credits_exhausted: true
                });
                res.write(`data: ${errorPayload}\n\n`);
                res.end();
                return;
            }
            
            // Safely extract IDs to tie the response back to the user's UI
            const resolvedSessionId = finalSessionId || sessionId;

            // 2-Bucket non-technical error message for the UI
            let displayMessage = `We hit a temporary error while processing your work — **no credits were deducted**. Please click **Retry** below to try again.`;

            const isDuplicateQuestionError =
                error instanceof UserFacingError &&
                (error.code === 'COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED' ||
                    error.code === 'MULTI_PAPER_LOOSE_IMAGES_NOT_SUPPORTED');

            const isUnexpectedSystemError =
                !(error instanceof UserFacingError && error.category === 'user_fixable') &&
                !error.message?.includes('PDF_UNREADABLE') &&
                !error.message?.includes('Postscript delegate failed') &&
                !isLegacyUserFixable;

            if (error instanceof UserFacingError) {
                displayMessage = error.userMessage;
            } else if (error.message?.includes('PDF_UNREADABLE') || error.message?.includes('Postscript delegate failed')) {
                displayMessage = `We couldn't read this PDF because it appears corrupted, password-protected, or in an unsupported format.\n\n**How to fix:** Open the file, choose **Print → Save as PDF**, and upload the new file.`;
            } else if (isLegacyUserFixable) {
                displayMessage = error.message.replace(/^PDF_PAGE_LIMIT_EXCEEDED:\s*/i, '');
            }

            const requiresUpgrade =
                (error instanceof UserFacingError && error.requiresUpgrade) ||
                error.message?.includes('Upgrade to Pro') ||
                isOverdraftLimit;

            const detectedPaperGroups =
                error instanceof UserFacingError && Array.isArray(error.detectedPaperGroups) && error.detectedPaperGroups.length > 0
                    ? error.detectedPaperGroups
                    : undefined;

            const userTimestamp = new Date().toISOString();
            const aiTimestamp = new Date(Date.now() + 50).toISOString();
            const aiErrorMessage: any = {
                id: aiMessageId,
                role: 'assistant',
                content: displayMessage,
                timestamp: aiTimestamp,
                type: 'text',
                isProcessing: false,
                ...(error instanceof UserFacingError ? { errorCode: error.code } : { errorCode: 'SYSTEM_ERROR' }),
                ...(isDuplicateQuestionError ? { canMarkAnyway: true } : {}),
                ...(isUnexpectedSystemError ? { canRetryUpload: true } : {}),
                ...(requiresUpgrade ? { requiresUpgrade: true } : {}),
                ...(detectedPaperGroups ? { detectedPaperGroups } : {}),
                processingStats: {
                    apiUsed: 'System Validation',
                    modelUsed: 'Pre-flight Check'
                }
            };

            let persistedOriginalLinks: string[] = [];

            // Persist the failed upload attempt (with PDF/image attachment metadata) + friendly error to Firestore
            if (finalUserId && finalUserId !== 'anonymous' && resolvedSessionId) {
                try {
                    const uploadResult = await SessionManagementService.uploadOriginalFiles(
                        files,
                        finalUserId,
                        resolvedSessionId,
                        true
                    );
                    persistedOriginalLinks = uploadResult.originalImageLinks || [];
                    if (detectedPaperGroups && persistedOriginalLinks.length > 0) {
                        aiErrorMessage.detectedPaperGroups = detectedPaperGroups.map(group => ({
                            ...group,
                            storageUrls: (group.fileIndices || [])
                                .map(idx => persistedOriginalLinks[idx])
                                .filter((u): u is string => Boolean(u))
                        }));
                    }

                    const pdfFiles = files
                        .map((file, idx) => ({ file, idx }))
                        .filter(entry => entry.file.mimetype === 'application/pdf');
                    const isSinglePdf = files.length === 1 && pdfFiles.length === 1;
                    const isMultiplePdfs = pdfFiles.length > 1 || (pdfFiles.length >= 1 && files.length > 1);

                    let pdfContext: any = undefined;
                    if (isSinglePdf) {
                        pdfContext = {
                            isMultiplePdfs: false,
                            originalPdfLink: uploadResult.originalImageLinks[0] || null,
                            originalFileName: files[0].originalname || 'document.pdf',
                            fileSize: files[0].size || 0
                        };
                    } else if (isMultiplePdfs) {
                        pdfContext = {
                            isMultiplePdfs: true,
                            pdfContexts: pdfFiles.map(({ file, idx }) => ({
                                originalPdfLink: uploadResult.originalImageLinks[idx] || null,
                                originalFileName: file.originalname || `document-${idx + 1}.pdf`,
                                fileSize: file.size || 0
                            }))
                        };
                    }

                    const { structuredImageDataArray, structuredPdfContexts } = SessionManagementService.createStructuredData(
                        files,
                        isSinglePdf,
                        isMultiplePdfs,
                        pdfContext
                    );

                    const userUploadMessage = SessionManagementService.createUserMessageForDatabase(
                        {
                            content: req.body?.customText || '',
                            files,
                            isPdf: isSinglePdf,
                            isMultiplePdfs,
                            customText: req.body?.customText,
                            sessionId: resolvedSessionId,
                            model: finalModel,
                            pdfContext
                        },
                        structuredImageDataArray,
                        structuredPdfContexts,
                        uploadResult.originalImageLinks
                    );
                    userUploadMessage.timestamp = userTimestamp;

                    const existingSession = await FirestoreService.getUnifiedSession(resolvedSessionId);
                    if (existingSession) {
                        await FirestoreService.addMessageToUnifiedSession(resolvedSessionId, userUploadMessage, 'Marking');
                        await FirestoreService.addMessageToUnifiedSession(resolvedSessionId, aiErrorMessage, 'Marking');
                    } else {
                        await FirestoreService.createUnifiedSessionWithMessages({
                            sessionId: resolvedSessionId,
                            title: 'Upload Issue',
                            userId: finalUserId,
                            messageType: 'Marking',
                            messages: [userUploadMessage, aiErrorMessage],
                            usageMode: 'Marking'
                        });
                    }
                } catch (persistErr) {
                    console.error('⚠️ [CONTROLLER] Failed to persist error state to Firestore:', persistErr);
                }
            }

            if (capturedMarkingLogs) {
                const resolvedUid = finalUserId || (req as any).user?.uid || `guest:${req.ip || '0.0.0.0'}`;
                let uploadedFiles: any[] = persistedOriginalLinks
                    .map((url, idx) => ({
                        filename: files?.[idx]?.originalname || `file-${idx + 1}`,
                        url,
                        sizeBytes: files?.[idx]?.size
                    }))
                    .filter(item => Boolean(item.url));

                if (uploadedFiles.length === 0 && files?.length > 0) {
                    uploadedFiles = await Promise.race([
                        AdminAlertService.uploadFilesForLog(files, resolvedUid),
                        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 10000)),
                    ]);
                }
                await AdminAlertService.notifyMarkingLog({
                    submissionId,
                    sessionId: resolvedSessionId,
                    userId: resolvedUid,
                    userEmail: (req as any).user?.email,
                    userAgent: req.get('user-agent') || undefined,
                    model: finalModel || 'auto',
                    isRemark: false,
                    turnType: 'MARKING',
                    error,
                    userInput: req.body?.customText || undefined,
                    uploadedFiles,
                    ...(capturedMarkingLogs as { logsText: string; lineCount: number; durationMs: number; truncated: boolean }),
                });
            }

            // 🛑 THE FIX: Wrap the error as a successful AI chat message so it renders gracefully in the UI
            const gracefulPayload = JSON.stringify({
                type: 'complete',
                result: {
                    success: true, // Force true so the frontend renders it instead of throwing a JS exception
                    sessionId: resolvedSessionId,
                    sessionTitle: "Upload Issue",
                    aiMessage: aiErrorMessage
                }
            });

            const persistedErrorToUnifiedSessions = Boolean(finalUserId && finalUserId !== 'anonymous' && resolvedSessionId);
            const failJobPayload: Record<string, any> = {
                status: 'failed',
                sessionId: resolvedSessionId,
                isRemark: false,
                error: displayMessage,
                completedAt: Date.now(),
                ...(persistedErrorToUnifiedSessions ? {} : {
                    fallbackResult: {
                        success: true,
                        sessionId: resolvedSessionId,
                        sessionTitle: "Upload Issue",
                        aiMessage: aiErrorMessage
                    }
                })
            };
            await queueJobUpsert(submissionId, failJobPayload);
            if (resolvedSessionId && resolvedSessionId !== submissionId) {
                await queueJobUpsert(resolvedSessionId, failJobPayload);
            }

            // Ensure headers are set if the stream hasn't started yet
            if (!res.headersSent) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.status(200);
            }
            
            res.write(`data: ${gracefulPayload}\n\n`);
            res.end(); // Gracefully close the connection
        } finally {
            // 👇 CLEAR HEARTBEAT 👇
            clearInterval(heartbeat);
            
            // 🛑 TRANSACTION-SAFE CREDIT DEDUCTION: Only deduct credits when the pipeline succeeded without crashing or rejecting content
            try {
                const finalCost = usageTracker.calculateCost(finalModel).total;
                
                if (shouldDeductCredits && !creditsDeducted && finalCost > 0 && finalUserId && finalUserId !== 'anonymous') {
                    console.log(`💳 [CREDIT DEDUCT] Calculating final cost: $${finalCost} for user ${finalUserId}`);
                    await deductCredits(finalUserId, finalCost, finalSessionId || 'unknown');
                    creditsDeducted = true;
                    console.log(`💳 ✅ Successfully deducted $${finalCost} from user ${finalUserId}`);
                } else if (!creditsDeducted && finalCost > 0) {
                    console.log(`⏭️  [CREDIT DEDUCT] Skipped deduction for user ${finalUserId || 'anonymous'} (shouldDeductCredits=${shouldDeductCredits}, Cost: $${finalCost})`);
                }
            } catch (deductionError) {
                console.error('❌ CRITICAL: Failed to deduct credits during cleanup:', deductionError);
            }
        }
    }

    /**
     * POST /api/marking/pre-inspect
     * Fast on-attach pre-inspection (1-3 strategic pages). Tracks usage in UsageTracker,
     * logs usage & decision to terminal, and records a PRE_INSPECT turn in AdminAlertService digest.
     */
    static async preInspectFiles(req: Request, res: Response): Promise<void> {
        const files = (req.files as Express.Multer.File[]) || [];
        if (!files || files.length === 0) {
            res.status(400).json({ error: 'No files provided for pre-inspection.' });
            return;
        }

        const isAuthenticated = Boolean((req as any).user?.uid);
        const userIP = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
        const userId = (req as any).user?.uid || `guest:${userIP}`;
        const userPlan = (req as any).userPlan || 'free';
        const userEmail = (req as any).user?.email;
        const userAgent = req.get('user-agent') || undefined;

        let rawSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
        if (rawSessionId.startsWith('temp-')) rawSessionId = '';
        const digestSessionId = rawSessionId || `pre-inspect-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        let originalHashes: string[] = [];
        if (req.body?.originalHashes) {
            try {
                const parsed = typeof req.body.originalHashes === 'string'
                    ? JSON.parse(req.body.originalHashes)
                    : req.body.originalHashes;
                if (Array.isArray(parsed)) {
                    originalHashes = parsed.map((h: any) => String(h || ''));
                }
            } catch {
                // Ignore malformed optional hashes
            }
        }

        const usageTracker = new UsageTracker();
        let capturedLogs: { logsText: string; lineCount: number; durationMs: number; truncated: boolean } | null = null;

        try {
            const result = await runWithLogCapture(
                digestSessionId,
                async () => {
                    const inspectRes = await PreInspectService.inspectFiles({
                        files,
                        userId,
                        userPlan,
                        digestSessionId,
                        originalHashes,
                        usageTracker,
                    });
                    if (usageTracker.getTotalRequests() > 0) {
                        console.log(`\n📊 [PRE-INSPECT USAGE]\n${usageTracker.getSummary('fast')}`);
                    }
                    return inspectRes;
                },
                (captured) => {
                    capturedLogs = captured;
                }
            );

            const shouldRecordDigest =
                result.usage.requestCount > 0 ||
                result.docType === 'pdf_structural_error' ||
                result.docType === 'unsupported_layout' ||
                result.docType === 'page_limit_exceeded';

            if (capturedLogs && shouldRecordDigest) {
                const logs = capturedLogs as { logsText: string; lineCount: number; durationMs: number; truncated: boolean };
                AdminAlertService.recordSessionTurn({
                    sessionId: digestSessionId,
                    submissionId: result.preInspectToken,
                    turnType: 'PRE_INSPECT',
                    userId: isAuthenticated ? userId : `guest:${userIP}`,
                    userEmail,
                    userAgent,
                    sessionTitle: result.bannerTitle || 'Pre-Inspect',
                    model: 'lite',
                    userInput: files.map((f) => f.originalname).join(', '),
                    aiResponse: `[${result.overallStatus.toUpperCase()} | ${result.docType}] ${result.bannerTitle} — ${result.bannerMessage}`,
                    ...logs,
                });
            }

            res.status(200).json({ ...result, preInspectSessionId: digestSessionId });
        } catch (error: any) {
            console.error('❌ [PRE-INSPECT] Failed:', error?.message || error);
            if (capturedLogs) {
                const logs = capturedLogs as { logsText: string; lineCount: number; durationMs: number; truncated: boolean };
                AdminAlertService.recordSessionTurn({
                    sessionId: digestSessionId,
                    turnType: 'PRE_INSPECT',
                    userId: isAuthenticated ? userId : `guest:${userIP}`,
                    userEmail,
                    userAgent,
                    sessionTitle: 'Pre-Inspect Error',
                    model: 'lite',
                    error,
                    userInput: files.map((f) => f.originalname).join(', '),
                    ...logs,
                });
            }
            res.status(500).json({ error: 'Pre-inspection failed' });
        }
    }
}
