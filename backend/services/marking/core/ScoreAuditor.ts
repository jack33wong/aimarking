
export class ScoreAuditor {

    /**
     * Faithfully migrates the original "parseScore" logic.
     */
    static parseScore(scoreInput: any): { awardedMarks: number; totalMarks: number; scoreText?: string } {
        if (!scoreInput) return { awardedMarks: 0, totalMarks: 0 };

        if (typeof scoreInput === 'object') {
            const awarded = parseFloat(scoreInput.awardedMarks);
            const total = parseFloat(scoreInput.totalMarks);
            if (!isNaN(awarded) && !isNaN(total) && total > 0) {
                return { awardedMarks: awarded, totalMarks: total };
            }
        }

        const scoreStr = String(typeof scoreInput === 'object' ? (scoreInput.scoreText || scoreInput.awardedMarks || '0') : scoreInput);
        if (scoreStr.includes('/')) {
            const parts = scoreStr.split('/');
            return {
                awardedMarks: parseFloat(parts[0]) || 0,
                totalMarks: parseFloat(parts[1]) || 0
            };
        }

        const numericValue = parseFloat(scoreStr);
        return {
            awardedMarks: isNaN(numericValue) ? 0 : numericValue,
            totalMarks: 0
        };
    }

    /**
     * Faithfully migrates "The Guillotine" (Strict Budget Enforcement)
     * with safe fallback for Generic Mode when sub-question marks are not printed on the image.
     */
    static enforceStrictBudget(
        annotations: any[],
        scheme: any,
        subQuestionRubrics?: Record<string, any> | null
    ): { annotations: any[], awardedMarks: number, inferredTotalMarks?: number } {
        const normSubKey = (k: string) => String(k || '').trim().toLowerCase().replace(/^q/i, '').replace(/[()\s]/g, '').replace(/^0+(?=\d)/, '');

        const rubricMap = new Map<string, any>();
        if (subQuestionRubrics && typeof subQuestionRubrics === 'object') {
            for (const [rk, rv] of Object.entries(subQuestionRubrics)) {
                if (rv && typeof rv === 'object') {
                    rubricMap.set(normSubKey(rk), rv);
                }
            }
        }

        const sanitizeValue = (text: string, action?: string) => {
            const act = String(action || '').toLowerCase();
            if (act === 'cross' || act === 'circle' || act === 'not_attempted') return 0;
            const raw = String(text || '').trim();
            if (!raw) return 0;
            // Strip Assessment Objective and Level tags (e.g. AO1, AO2, L3) so AO2 is never misread as 2 marks
            const stripped = raw.replace(/\b(?:AO|L)\d+\b/gi, ' ').trim();
            const codeMatch = stripped.match(/\b[BMAPC](\d+)\b/i);
            if (codeMatch) return parseInt(codeMatch[1], 10);
            const plusMatch = stripped.match(/\+(\d+)/);
            if (plusMatch) return parseInt(plusMatch[1], 10);
            const fracMatch = stripped.match(/(\d+)\s*\/\s*\d+/);
            if (fracMatch) return parseInt(fracMatch[1], 10);
            const num = parseInt(stripped.replace(/\D/g, ''), 10);
            if (!isNaN(num)) return num;
            // Pure AO/label tick (e.g. "[AO1]" or "✓") on a point-based sub-question counts as 1 mark
            return act === 'tick' ? 1 : 0;
        };

        const countAttemptedWeight = (text: string, action?: string) => {
            const act = String(action || '').toLowerCase();
            if (act === 'circle') return 0;
            const clean = (text || '').trim();
            const zeroMatch = clean.match(/^[BMAPC]0$|^0$/i);
            if (zeroMatch) return 1;
            return sanitizeValue(clean, action);
        };

        const buckets: Record<string, any[]> = {};
        annotations.forEach(a => {
            const key = a.subQuestion || 'main';
            if (!buckets[key]) buckets[key] = [];
            buckets[key].push(a);
        });

        let grandTotal = 0;
        let inferredTotalMarks = 0;
        const survivorList: any[] = [];
        const isGeneric = Boolean(scheme?.isGeneric);
        const hasIncompleteBudgets = Boolean(scheme?.hasIncompleteSubQuestionBudgets);
        const schemeTotalMarks = Number(scheme?.totalMarks || scheme?.parentQuestionMarks || 0);
        const rawTotalAwardedMarks = annotations.reduce((sum, a) => {
            if (!a || a.action === 'cross' || a.action === 'circle' || a.action === 'not_attempted' || a.isUnattempted) return sum;
            return sum + sanitizeValue(a.text || '0', a.action);
        }, 0);
        const bypassSubGuillotineForGeneric = Boolean(
            isGeneric && (
                hasIncompleteBudgets ||
                schemeTotalMarks <= 0 ||
                rawTotalAwardedMarks <= schemeTotalMarks
            )
        );

        Object.keys(buckets).forEach(subQ => {
            const anns = buckets[subQ];
            let budget = 99;
            let hasExplicitSubBudget = false;

            if (scheme) {
                const cleanSubQ = String(subQ).trim().replace(/^0+(?=\d)/, '');
                const suffix = cleanSubQ.replace(/^\d+/, '');
                const dotStripped = suffix.replace(/^\./, '');

                const subMaxMap = scheme.subQuestionMaxScores || {};
                const explicitSubMax =
                    subMaxMap[subQ] ??
                    subMaxMap[cleanSubQ] ??
                    subMaxMap[suffix] ??
                    subMaxMap[dotStripped];

                if (typeof explicitSubMax === 'number' && explicitSubMax > 0) {
                    budget = explicitSubMax;
                    hasExplicitSubBudget = true;
                } else if (scheme.markBreakdown && scheme.markBreakdown[subQ]?.maxScore > 0) {
                    budget = scheme.markBreakdown[subQ].maxScore;
                    hasExplicitSubBudget = true;
                } else if (Array.isArray(scheme.subQuestions)) {
                    const match = (scheme.subQuestions as any[]).find((sq: any) => sq.label === subQ || sq.questionNumber === subQ);
                    if (match && Number(match.maxScore) > 0) {
                        budget = Number(match.maxScore);
                        hasExplicitSubBudget = true;
                    }
                } else if (Object.keys(buckets).length === 1 && Number(scheme.totalMarks) > 0) {
                    budget = Number(scheme.totalMarks);
                    hasExplicitSubBudget = true;
                }
            }

            // Never enforce a 0 budget! If budget is 0 or undefined, treat as unbounded (99)
            if (!budget || budget <= 0) {
                budget = 99;
            }

            const effectiveSubBudget = bypassSubGuillotineForGeneric ? 99 : budget;
            const normalizedBucketKey = normSubKey(subQ);
            const matchedRubric = rubricMap.get(normalizedBucketKey);

            if (matchedRubric) {
                // LoR sub-question governed by subQuestionRubrics: preserve all qualitative/flaw/SPaG
                // paragraph annotations and take score authoritatively from the rubric object.
                anns.forEach(a => survivorList.push(a));
                const contentAwarded = Math.max(0, Number(matchedRubric.awardedMarks || 0));
                const spagAwarded = matchedRubric.spag ? Math.max(0, Number(matchedRubric.spag.awardedMarks || 0)) : 0;
                const rubricMax = Math.max(0, Number(matchedRubric.maxMarks || 0)) + (matchedRubric.spag ? Math.max(0, Number(matchedRubric.spag.maxMarks || 0)) : 0);
                const cap = hasExplicitSubBudget ? budget : (rubricMax > 0 ? rubricMax : effectiveSubBudget);
                const subAwarded = cap < 99 ? Math.min(contentAwarded + spagAwarded, cap) : (contentAwarded + spagAwarded);
                grandTotal += subAwarded;
                rubricMap.delete(normalizedBucketKey);

                if (hasExplicitSubBudget && !bypassSubGuillotineForGeneric) {
                    inferredTotalMarks += budget;
                } else if (rubricMax > 0) {
                    inferredTotalMarks += rubricMax;
                }
                return;
            }

            let currentVal = 0;
            let subInferredMax = 0;
            const survivors: any[] = [];
            for (const ann of anns) {
                if (ann.action === 'not_attempted' || ann.isUnattempted || ann.action === 'circle') {
                    survivors.push(ann);
                    continue;
                }
                const val = sanitizeValue(ann.text || "0", ann.action);
                subInferredMax += countAttemptedWeight(ann.text || "0", ann.action);
                if (currentVal + val <= effectiveSubBudget) {
                    survivors.push(ann);
                    currentVal += val;
                }
            }
            survivors.forEach(s => survivorList.push(s));
            grandTotal += currentVal;

            if (hasExplicitSubBudget && !bypassSubGuillotineForGeneric) {
                inferredTotalMarks += budget;
            } else if (isGeneric) {
                inferredTotalMarks += Math.max(currentVal, subInferredMax, 1);
            }
        });

        // Include any subQuestionRubrics entry that had no annotations emitted on the page
        for (const [, rubric] of rubricMap.entries()) {
            const contentAwarded = Math.max(0, Number(rubric.awardedMarks || 0));
            const spagAwarded = rubric.spag ? Math.max(0, Number(rubric.spag.awardedMarks || 0)) : 0;
            const rubricMax = Math.max(0, Number(rubric.maxMarks || 0)) + (rubric.spag ? Math.max(0, Number(rubric.spag.maxMarks || 0)) : 0);
            grandTotal += rubricMax > 0 ? Math.min(contentAwarded + spagAwarded, rubricMax) : (contentAwarded + spagAwarded);
            if (rubricMax > 0) inferredTotalMarks += rubricMax;
        }

        // If scheme had subQuestionMaxScores for unattempted sub-questions not in buckets, include them in inferredTotalMarks
        if (scheme?.subQuestionMaxScores && typeof scheme.subQuestionMaxScores === 'object') {
            const baseQ = String(scheme.questionNumber || '').trim();
            const allCanonicalSubKeys = Object.keys(scheme.subQuestionMaxScores).filter(
                k => baseQ && k !== baseQ && k.startsWith(baseQ) && Number(scheme.subQuestionMaxScores[k]) > 0
            );
            if (allCanonicalSubKeys.length > 0) {
                const fullSubSum = allCanonicalSubKeys.reduce((acc, k) => acc + Number(scheme.subQuestionMaxScores[k]), 0);
                if (fullSubSum > inferredTotalMarks) {
                    inferredTotalMarks = fullSubSum;
                }
            }
        }

        return {
            annotations: survivorList,
            awardedMarks: grandTotal,
            inferredTotalMarks: inferredTotalMarks > 0 ? inferredTotalMarks : undefined
        };
    }

    /**
     * Reconciles point-based question scores after strict budget enforcement.
     * In Generic Rubric Mode (or when no official scheme totalMarks exists),
     * preserves the AI's printed/stated total (`meta.question_total_marks`, falling back
     * to `studentScore.totalMarks`) whenever it is a valid positive integer,
     * never replacing a valid denominator with the annotation count.
     */
    static reconcilePointBasedScore(params: {
        enrichedAnnotations: any[];
        scheme: any;
        studentScore: any;
        meta?: any;
        subQuestionRubrics?: Record<string, any> | null;
    }): {
        annotations: any[];
        awardedMarks: number;
        totalMarks: number;
        scoreText: string;
        _authoritativeGenericScore?: boolean;
    } {
        const { enrichedAnnotations, scheme, studentScore, meta, subQuestionRubrics } = params;
        const parsedScore = this.parseScore(studentScore);
        const strictResult = this.enforceStrictBudget(enrichedAnnotations, scheme, subQuestionRubrics);

        const isGeneric = Boolean(scheme?.isGeneric);
        const schemeTotal = Number(scheme?.totalMarks || 0);
        const metaTotalRaw = Number(meta?.question_total_marks || 0);
        const scoreTotalRaw = Number(parsedScore.totalMarks || 0);

        const aiAuthoritativeTotal =
            (Number.isFinite(metaTotalRaw) && metaTotalRaw > 0)
                ? Math.round(metaTotalRaw)
                : ((Number.isFinite(scoreTotalRaw) && scoreTotalRaw > 0) ? Math.round(scoreTotalRaw) : 0);

        let totalMarks = 0;
        let isAuthoritativeGeneric = false;

        if (isGeneric || schemeTotal <= 0) {
            if (aiAuthoritativeTotal > 0) {
                totalMarks = aiAuthoritativeTotal;
                isAuthoritativeGeneric = isGeneric;
            } else if (schemeTotal > 0) {
                totalMarks = (isGeneric && strictResult.inferredTotalMarks && strictResult.inferredTotalMarks > schemeTotal)
                    ? strictResult.inferredTotalMarks
                    : schemeTotal;
            } else {
                totalMarks = Math.max(
                    strictResult.awardedMarks,
                    strictResult.inferredTotalMarks || 0,
                    enrichedAnnotations.length
                );
            }
        } else {
            totalMarks = schemeTotal;
        }

        const awardedMarks = totalMarks > 0
            ? Math.min(strictResult.awardedMarks, totalMarks)
            : strictResult.awardedMarks;

        const result: {
            annotations: any[];
            awardedMarks: number;
            totalMarks: number;
            scoreText: string;
            _authoritativeGenericScore?: boolean;
        } = {
            annotations: strictResult.annotations,
            awardedMarks,
            totalMarks,
            scoreText: `${awardedMarks}/${totalMarks}`
        };

        if (isAuthoritativeGeneric) {
            result._authoritativeGenericScore = true;
        }

        return result;
    }

    /**
     * Level-of-Response (LoR) Score Integrity Guard (GCSE English Language & Literature).
     * Never sums integers from margin annotations (which are qualitative evidence badges like [AO2 L4]).
     * Instead, validates and reconciles the single-AO or dual-AO rubricEvaluation and emits
     * the 📊 [RUBRIC-AUDIT] structured log.
     */
    static reconcileLevelOfResponseScore(
        rubricEvaluation: any,
        studentScore: any,
        scheme: any,
        annotations: any[],
        questionId: string | number = '?'
    ): {
        awardedMarks: number;
        totalMarks: number;
        scoreText: string;
        rubricEvaluation: any;
    } {
        const parsedFallback = this.parseScore(studentScore);
        const schemeMax = Number(scheme?.totalMarks || scheme?.marks || 0);
        const evalMax = Number(rubricEvaluation?.maxMarks || 0);
        let totalMarks = schemeMax > 0 ? schemeMax : (evalMax > 0 ? evalMax : parsedFallback.totalMarks);

        const aoBreakdown: any[] = Array.isArray(rubricEvaluation?.aoBreakdown)
            ? rubricEvaluation.aoBreakdown
            : [];

        let awardedMarks = Number(rubricEvaluation?.awardedMarks ?? parsedFallback.awardedMarks ?? 0);
        const scoringType = rubricEvaluation?.scoringType || (aoBreakdown.length > 1 ? 'DUAL_AO_LOR' : 'SINGLE_AO_LOR');

        if (aoBreakdown.length > 0) {
            let sumAwarded = 0;
            let sumMax = 0;
            aoBreakdown.forEach(item => {
                const itemMax = Math.max(0, Number(item.maxMarks || 0));
                const itemAwarded = Math.max(0, Math.min(Number(item.awardedMarks || 0), itemMax > 0 ? itemMax : 99));
                item.awardedMarks = itemAwarded;
                item.maxMarks = itemMax;
                sumAwarded += itemAwarded;
                sumMax += itemMax;
            });
            if (sumMax > 0 && totalMarks === 0) {
                totalMarks = sumMax;
            }
            if (aoBreakdown.length > 1 || sumAwarded > 0) {
                awardedMarks = sumAwarded;
            }
        }

        if (totalMarks > 0) {
            awardedMarks = Math.max(0, Math.min(awardedMarks, totalMarks));
        } else {
            awardedMarks = Math.max(0, awardedMarks);
        }

        const updatedEval: any = {
            ...(rubricEvaluation || {}),
            scoringType,
            awardedMarks,
            maxMarks: totalMarks,
            aoBreakdown
        };

        // Ensure a clean, deterministic rubricStamp exists
        if (!updatedEval.rubricStamp || typeof updatedEval.rubricStamp !== 'string') {
            if (aoBreakdown.length > 1) {
                const parts = aoBreakdown.map(b => {
                    const lvl = b.level ? ` (L${b.level})` : '';
                    return `${b.ao || 'AO'}: ${b.awardedMarks}/${b.maxMarks}${lvl}`;
                });
                updatedEval.rubricStamp = `[${parts.join(' + ')} = ${awardedMarks}/${totalMarks}]`;
            } else {
                const lvlLabel = updatedEval.levelLabel || (updatedEval.awardedLevel ? `Level ${updatedEval.awardedLevel}` : 'Rubric');
                updatedEval.rubricStamp = `[${lvlLabel} | ${awardedMarks}/${totalMarks} marks]`;
            }
        }

        const breakdownLog = aoBreakdown.length > 0
            ? aoBreakdown.map(b => `${b.ao || 'AO'}=${b.awardedMarks}/${b.maxMarks}${b.level ? ` (L${b.level})` : ''}`).join(' + ')
            : `${updatedEval.levelLabel || 'LoR'}=${awardedMarks}/${totalMarks}`;

        console.log(
            `📊 [RUBRIC-AUDIT] Q${questionId} (${scoringType}): ${breakdownLog} => Total=${awardedMarks}/${totalMarks} | Annotations=${annotations?.length || 0} (non-additive)`
        );

        return {
            awardedMarks,
            totalMarks,
            scoreText: `${awardedMarks}/${totalMarks}`,
            rubricEvaluation: updatedEval
        };
    }
}
