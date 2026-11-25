/**
 * Subject Profile Registry & Declarative Strategy Pattern
 * Routes pipeline behavior between Point-Based subjects (Mathematics)
 * and Level-of-Response subjects (GCSE English Language & English Literature)
 * with zero regressions on existing Maths workflows.
 */

export type SubjectKey = 'MATHS' | 'ENGLISH_LANGUAGE' | 'ENGLISH_LITERATURE' | 'UNIVERSAL_BYOMS';

export type GradingParadigm = 'POINT_BASED' | 'LEVEL_OF_RESPONSE';

export type SubjectFamily = 'QUANTITATIVE' | 'SCIENCE_DATA' | 'HUMANITIES_ESSAY' | 'ENGLISH_WRITING' | 'GENERAL';

export type OcrStrategy = 'MATHPIX_LATEX' | 'VISION_VERBATIM';

export type QuestionScoringType = 'POINT_BASED' | 'SINGLE_AO_LOR' | 'DUAL_AO_LOR';

export interface AOBreakdownItem {
  ao: string;                 // e.g. 'AO1', 'AO2', 'AO4', 'AO5', 'AO6'
  radarAxis?: string;         // e.g. 'AO5 Content & Org', 'AO6 Technical SPaG'
  level?: number;             // e.g. 1, 2, 3, 4
  levelLabel?: string;        // e.g. 'Level 3 (Clear, relevant)'
  awardedMarks: number;
  maxMarks: number;
}

export interface RubricCoachingBlock {
  rationale: string;          // Why this Level was awarded (quoting the student)
  nextLevelGap: string;       // Concrete advice on how to move from Level N -> Level N+1
  upgradeRewrite?: {
    originalQuote: string;    // Verbatim sentence/paragraph from student's work
    upgradedVersion: string;  // Rewritten to Level 4 (Perceptive, detailed) standard
    explanation?: string;     // Brief note on what changed (e.g. zoom-in on connotations)
  };
}

export interface RubricEvaluation {
  scoringType: QuestionScoringType;
  awardedLevel?: number;
  levelLabel?: string;
  awardedMarks: number;
  maxMarks: number;
  rubricStamp: string;        // e.g. "[Level 3 (Clear, relevant) | 6/8 marks]" or "[AO5: 16/24 (L3) + AO6: 12/16 (L3) = 28/40]"
  aoBreakdown: AOBreakdownItem[];
  coaching?: RubricCoachingBlock;
}

export interface SubjectProfile {
  key: SubjectKey;
  displayName: string;
  paradigm: GradingParadigm;
  ocrStrategy: OcrStrategy;
  assessmentObjectives: string[];
  radarAxes: string[];
  overflowBoilerplatePatterns: RegExp[];
}

const COMMON_ENGLISH_OVERFLOW_PATTERNS: RegExp[] = [
  /continues?\s+on\s+(the\s+)?next\s+page/i,
  /answer\s+space\s+continues/i,
  /turn\s+over\s+for\s+(the\s+)?next\s+question/i,
  /extra\s+space\s+(for\s+question|if\s+required)/i,
  /additional\s+page,?\s+if\s+required/i,
  /there\s+are\s+no\s+questions\s+printed\s+on\s+this\s+page/i,
  /if\s+you\s+need\s+extra\s+space\s+for\s+your\s+answer/i,
  /write\s+the\s+question\s+number\s+in\s+the\s+(left-hand\s+)?margin/i,
  /do\s+not\s+write\s+outside\s+the\s+box/i
];

export const ENGLISH_LANGUAGE_P1_RADAR_AXES = [
  'AO1 Retrieval',
  'AO2 Language',
  'AO2 Structure',
  'AO4 Evaluation',
  'AO5 Content & Org',
  'AO6 Technical SPaG'
];

export const ENGLISH_LANGUAGE_P2_RADAR_AXES = [
  'AO1 Retrieval',
  'AO1 Synthesis',
  'AO2 Language',
  'AO3 Comparison',
  'AO5 Content & Org',
  'AO6 Technical SPaG'
];

export function isPaper2EnglishLanguage(hints?: any): boolean {
  if (!hints) return false;
  const str = typeof hints === 'string'
    ? hints
    : [hints.examCode, hints.paperCode, hints.paperTitle, hints.subject, hints.qualification, hints.customText].filter(Boolean).join(' ');
  if (/8700\/?2|1EN0\/?0?2|J351\/?0?2|Paper\s*2|writers['’]?\s+viewpoints|transactional\s+writing|exploring\s+effects/i.test(str)) {
    return true;
  }
  if (typeof hints === 'object') {
    if (hints.isPaper2) return true;
    if (Array.isArray(hints.radarAxes) && hints.radarAxes.some((a: string) => /AO3|Synthesis/i.test(a))) {
      return true;
    }
    if (Array.isArray(hints.questions)) {
      const hasAo3 = hints.questions.some((q: any) => {
        const aos = q.assessmentObjectives || q.assessment_objectives || q.rubricEvaluation?.aoBreakdown?.map((a: any) => a.ao) || [];
        return Array.isArray(aos) && aos.some((a: string) => /AO3/i.test(String(a)));
      });
      if (hasAo3) return true;
    }
  }
  return false;
}

export function getEnglishLanguageRadarAxes(hints?: any): string[] {
  return isPaper2EnglishLanguage(hints) ? ENGLISH_LANGUAGE_P2_RADAR_AXES : ENGLISH_LANGUAGE_P1_RADAR_AXES;
}

export const SUBJECT_PROFILES: Record<SubjectKey, SubjectProfile> = {
  MATHS: {
    key: 'MATHS',
    displayName: 'Mathematics',
    paradigm: 'POINT_BASED',
    ocrStrategy: 'MATHPIX_LATEX',
    assessmentObjectives: ['AO1', 'AO2', 'AO3'],
    radarAxes: [
      'Number',
      'Algebra',
      'Ratio & Proportion',
      'Geometry',
      'Probability',
      'Statistics'
    ],
    overflowBoilerplatePatterns: [
      /continues?\s+on\s+(the\s+)?next\s+page/i,
      /answer\s+space\s+continues/i,
      /turn\s+over\s+for\s+(the\s+)?next\s+question/i
    ]
  },

  ENGLISH_LANGUAGE: {
    key: 'ENGLISH_LANGUAGE',
    displayName: 'GCSE English Language',
    paradigm: 'LEVEL_OF_RESPONSE',
    ocrStrategy: 'VISION_VERBATIM',
    assessmentObjectives: ['AO1', 'AO2', 'AO3', 'AO4', 'AO5', 'AO6'],
    radarAxes: ENGLISH_LANGUAGE_P1_RADAR_AXES,
    overflowBoilerplatePatterns: COMMON_ENGLISH_OVERFLOW_PATTERNS
  },

  ENGLISH_LITERATURE: {
    key: 'ENGLISH_LITERATURE',
    displayName: 'GCSE English Literature',
    paradigm: 'LEVEL_OF_RESPONSE',
    ocrStrategy: 'VISION_VERBATIM',
    assessmentObjectives: ['AO1', 'AO2', 'AO3', 'AO4'],
    radarAxes: [
      'AO1 Critical Response',
      'AO1 Quotations',
      'AO2 Language & Form',
      'AO2 Structure',
      'AO3 Context',
      'AO4 SPaG'
    ],
    overflowBoilerplatePatterns: COMMON_ENGLISH_OVERFLOW_PATTERNS
  },

  UNIVERSAL_BYOMS: {
    key: 'UNIVERSAL_BYOMS',
    displayName: 'Universal Subject (Custom Mark Scheme)',
    paradigm: 'POINT_BASED',
    ocrStrategy: 'VISION_VERBATIM',
    assessmentObjectives: ['AO1', 'AO2', 'AO3'],
    radarAxes: [
      'AO1 Knowledge & Recall',
      'AO2 Application & Calculation',
      'AO3 Analysis & Evaluation',
      'Scientific / Subject Terminology',
      'Data, Tables & Diagrams',
      'Extended Response'
    ],
    overflowBoilerplatePatterns: COMMON_ENGLISH_OVERFLOW_PATTERNS
  }
};

export interface SubjectResolutionHints {
  detectedSubject?: string;
  subject?: string;
  qualification?: string;
  paperCode?: string;
  paperTitle?: string;
  customText?: string;
  fileNames?: string[];
  rawTextHint?: string;
}

/**
 * Deterministically resolves the SubjectProfile as early as possible in the pipeline
 * (before Stage 3 OCR runs, and refined after Question Detection).
 * Always defaults safely to SUBJECT_PROFILES.MATHS if no English or Universal BYOMS signal is present.
 */
export function resolveSubjectProfile(hints: SubjectResolutionHints = {}): SubjectProfile {
  const MATHS_CODE_REGEX = /(?:^|[^a-z0-9])(1MA1|8300|9MA0|8MA0|J560|H240|H230|7357|7356|9709|0580|0606|4MA1|4MB1|WMA1[1-4]|WMA0[1-3]|WME0[1-3]|WST0[1-3]|WFM0[1-3]|WDM11|WDM01)(?:[^a-z0-9]|$)/i;
  const EXPLICIT_NON_MATHS_CODE_REGEX = /(?:^|[^a-z0-9])(8700|8702|1EN0|1ET0|J351|J352|C700|C720|8461|8462|8463|8464|1BI0|1CH0|1PH0|1SC0)(?:[^a-z0-9]|$)/i;

  // 1. Content-verified paper code / title takes highest precedence over filenames
  const contentCodeSource = [hints.paperCode || '', hints.paperTitle || ''].filter(Boolean).join(' ');
  if (contentCodeSource && MATHS_CODE_REGEX.test(contentCodeSource)) {
    return SUBJECT_PROFILES.MATHS;
  }

  // Only allow filename Maths paper-code override when visual content has NOT identified a non-Maths paper code
  const hasExplicitNonMathsContentCode = Boolean(contentCodeSource && EXPLICIT_NON_MATHS_CODE_REGEX.test(contentCodeSource));
  if (!hasExplicitNonMathsContentCode) {
    const fileNameCodeSource = (hints.fileNames || []).filter(Boolean).join(' ');
    if (fileNameCodeSource && MATHS_CODE_REGEX.test(fileNameCodeSource)) {
      return SUBJECT_PROFILES.MATHS;
    }
  }

  const explicitKey = (hints.detectedSubject || '').trim().toUpperCase();
  if (explicitKey === 'ENGLISH_LANGUAGE') return SUBJECT_PROFILES.ENGLISH_LANGUAGE;
  if (explicitKey === 'ENGLISH_LITERATURE') return SUBJECT_PROFILES.ENGLISH_LITERATURE;
  if (explicitKey === 'MATHS' || explicitKey === 'MATHEMATICS') return SUBJECT_PROFILES.MATHS;
  if (explicitKey === 'UNIVERSAL_BYOMS' || explicitKey === 'UNSUPPORTED_SUBJECT') {
    const customLabel = (hints.subject || '').trim();
    const isValidCustomLabel =
      customLabel &&
      !/^(mathematics|maths|general|unknown|custom)$/i.test(customLabel);
    return isValidCustomLabel
      ? { ...SUBJECT_PROFILES.UNIVERSAL_BYOMS, displayName: customLabel }
      : SUBJECT_PROFILES.UNIVERSAL_BYOMS;
  }

  const combined = [
    hints.paperCode || '',
    hints.subject || '',
    hints.qualification || '',
    hints.paperTitle || '',
    hints.customText || '',
    ...(hints.fileNames || []),
    hints.rawTextHint || ''
  ]
    .join(' | ')
    .toLowerCase();

  if (!combined.trim()) {
    return SUBJECT_PROFILES.MATHS;
  }

  // 1. Check explicit UK GCSE English Literature paper codes & titles (AQA 8702, Edexcel 1ET0, OCR J352, Eduqas C720)
  if (
    /\b(8702|1et0|j352|c720)\b/i.test(combined) ||
    /english\s+literature/i.test(combined) ||
    /\b(macbeth|romeo\s+and\s+juliet|the\s+tempest|merchant\s+of\s+venice|much\s+ado|julius\s+caesar|christmas\s+carol|jekyll\s+and\s+hyde|sign\s+of\s+four|great\s+expectations|jane\s+eyre|frankenstein|pride\s+and\s+prejudice|inspector\s+calls|blood\s+brothers|lord\s+of\s+the\s+flies|animal\s+farm|power\s+and\s+conflict|love\s+and\s+relationships|unseen\s+poetry)\b/i.test(combined)
  ) {
    return SUBJECT_PROFILES.ENGLISH_LITERATURE;
  }

  // 2. Check explicit & generic UK GCSE English Language paper codes, titles, and task prompts
  if (
    /\b(8700|1en0|j351|c700)\b/i.test(combined) ||
    /english\s+language/i.test(combined) ||
    /communicating\s+information\s+and\s+ideas/i.test(combined) ||
    /exploring\s+effects\s+and\s+impact/i.test(combined) ||
    /explorations\s+in\s+creative\s+reading\s+and\s+writing/i.test(combined) ||
    /writers['’]?\s+viewpoints\s+and\s+perspectives/i.test(combined) ||
    /how\s+(does|has)\s+the\s+writer\s+(use|used|structured)\s+(language|structure)/i.test(combined) ||
    /(to\s+what\s+extent|how\s+far)\s+do\s+you\s+agree[\s\S]{0,120}(writer|methods|reader|statement)/i.test(combined) ||
    /evaluate\s+how\s+the\s+writer/i.test(combined) ||
    /write\s+an?\s+(description|story|narrative|speech|letter|article|leaflet|essay|report|review)(?:[\s.,:;!?]+(?:of|about|arguing|explaining|persuading|describing|to|for|with|set|based|in\s+which|your|as\s+suggested\s+by)|\s*$)/i.test(combined) ||
    /\b(list\s+four\s+things|source\s+a\s+and\s+source\s+b|compare\s+how\s+the\s+writers)\b/i.test(combined) ||
    /\b(ao1|ao2|ao3|ao4|ao5|ao6)\b[\s\S]{0,80}\b(level\s+[1-4]|perceptive|spag|technical\s+accuracy)\b/i.test(combined)
  ) {
    return SUBJECT_PROFILES.ENGLISH_LANGUAGE;
  }

  // 3. Check explicit non-Maths, non-English-Language subjects (Sciences, Humanities, Computer Science, Social Sciences, Business)
  const subjectText = `${hints.subject || ''} ${hints.paperTitle || ''} ${hints.paperCode || ''}`.toLowerCase();
  if (
    !/\b(math|mathematics|further\s+maths|statistics)\b/i.test(subjectText) &&
    /\b(biology|chemistry|physics|combined\s+science|trilogy|synergy|geography|history|computer\s+science|business|economics|religious\s+studies|psychology|sociology|citizenship|media\s+studies|physical\s+education|design\s+and\s+technology|food\s+preparation|engineering|accounting)\b/i.test(combined)
  ) {
    const customLabel = (hints.subject || '').trim();
    const isValidCustomLabel =
      customLabel &&
      !/^(mathematics|maths|general|unknown|custom)$/i.test(customLabel);
    return isValidCustomLabel
      ? { ...SUBJECT_PROFILES.UNIVERSAL_BYOMS, displayName: customLabel }
      : SUBJECT_PROFILES.UNIVERSAL_BYOMS;
  }

  return SUBJECT_PROFILES.MATHS;
}

// ─── SUBJECT GATE (DB question detection pool filter) ───────────────────────────────────────

/** Subject keys that the DB-detection subject gate is allowed to enforce. */
export type GateableSubjectKey = 'MATHS' | 'ENGLISH_LANGUAGE' | 'ENGLISH_LITERATURE';

/** Coarse subject family of a DB exam paper ('OTHER' = a known non-Maths/non-English subject). */
export type PaperSubjectKey = GateableSubjectKey | 'OTHER';

export interface SubjectGate {
  /** Subject the upload is confidently identified as (only set when `confident` is true). */
  key: GateableSubjectKey | null;
  confident: boolean;
  /** Pages that EXPLICITLY reported a subject (pages with no detected_subject are NOT counted as Maths). */
  explicitVotes: number;
  /** Explicit votes for the winning subject. */
  topVotes: number;
  reason: string;
}

const PAPER_MATHS_CODE_REGEX = /(?:^|[^a-z0-9])(1MA1|8300|9MA0|8MA0|9FM0|8FM0|J560|H240|H230|H245|H640|Y5\d{2}|7357|7356|7367|7366|9709|9231|0580|0606|4MA1|4MB1|4PM1|WMA1[1-4]|WMA0[1-3]|WME0[1-3]|WST0[1-3]|WFM0[1-3]|WDM11|WDM01)(?:[^a-z0-9]|$)/i;
const PAPER_ENGLISH_LIT_CODE_REGEX = /(?:^|[^a-z0-9])(8702|1ET0|J352|C720)(?:[^a-z0-9]|$)/i;
const PAPER_ENGLISH_LANG_CODE_REGEX = /(?:^|[^a-z0-9])(8700|1EN0|J351|C700)(?:[^a-z0-9]|$)/i;
const PAPER_OTHER_CODE_REGEX = /(?:^|[^a-z0-9])(8461|8462|8463|8464|8465|7402|7405|7407|7408|1BI0|1CH0|1PH0|1SC0|J247|J248|J249|J250|H556|H557|H156|0625|9702|WPH1\d|WBI1\d|WCH1\d)(?:[^a-z0-9]|$)/i;
const PAPER_OTHER_SUBJECT_REGEX = /\b(combined\s+science|trilogy|synergy|biology|chemistry|physics|science|history|geography|computer\s+science|economics|business|psychology|sociology|religious\s+studies|accounting|engineering)\b/i;

/**
 * Maps DB exam paper metadata (subject / qualification / exam_code / paper_title) to a coarse subject family.
 * Returns null when the paper's subject cannot be determined (such papers are never filtered out).
 */
export function resolvePaperSubjectKey(meta: {
  subject?: string | null;
  qualification?: string | null;
  exam_code?: string | null;
  code?: string | null;
  paperCode?: string | null;
  paper_title?: string | null;
  paperTitle?: string | null;
} | null | undefined): PaperSubjectKey | null {
  if (!meta) return null;
  const subjectText = `${meta.subject || ''} ${meta.qualification || ''}`.toLowerCase();
  const titleText = `${meta.paper_title || ''} ${meta.paperTitle || ''}`.toLowerCase();
  const code = String(meta.exam_code || meta.code || meta.paperCode || '');

  if (/english\s*lit/.test(subjectText) || PAPER_ENGLISH_LIT_CODE_REGEX.test(code)) return 'ENGLISH_LITERATURE';
  if (/english/.test(subjectText) || PAPER_ENGLISH_LANG_CODE_REGEX.test(code)) return 'ENGLISH_LANGUAGE';
  if (/\b(math|maths|mathematics|statistics|mechanics|further\s+pure)\b/.test(subjectText) || PAPER_MATHS_CODE_REGEX.test(code)) return 'MATHS';
  if (PAPER_OTHER_CODE_REGEX.test(code)) return 'OTHER';

  const cleanSubject = String(meta.subject || '').trim();
  if (cleanSubject && !/^(general|unknown|n\/a|custom|generic question)$/i.test(cleanSubject)) return 'OTHER';

  // Fallback to paper_title when metadata.subject and exam_code are missing/generic
  if (/english\s*lit/.test(titleText)) return 'ENGLISH_LITERATURE';
  if (/english\s*lang/.test(titleText)) return 'ENGLISH_LANGUAGE';
  if (/\b(math|maths|mathematics|further\s+pure)\b/.test(titleText)) return 'MATHS';
  if (PAPER_OTHER_SUBJECT_REGEX.test(titleText)) return 'OTHER';

  return null;
}

/** True when a DB paper is allowed through the gate (unknown-subject papers always pass). */
export function isPaperAllowedBySubjectGate(paperMeta: any, gateKey: GateableSubjectKey | null | undefined): boolean {
  if (!gateKey) return true;
  const paperKey = resolvePaperSubjectKey(paperMeta);
  return paperKey === null || paperKey === gateKey;
}

/**
 * Builds a subject gate from per-page geometry votes.
 * Confident ONLY when:
 *  - at least one non-scheme page explicitly reported a gateable subject (no implicit MATHS default), and
 *  - the winning subject has >= 80% of explicit academic votes, and
 *  - the resolved routing profile agrees, and
 *  - no printed paper code points to a different subject.
 */
export function computeSubjectGate(params: {
  geometryResults: Array<{ is_marking_scheme?: boolean; detected_subject?: string } | null | undefined>;
  resolvedProfileKey?: SubjectKey;
  paperCodeHint?: string | null;
  hasUploadedMarkingScheme?: boolean;
}): SubjectGate {
  const notConfident = (reason: string, explicitVotes = 0, topVotes = 0): SubjectGate =>
    ({ key: null, confident: false, explicitVotes, topVotes, reason });

  if (params.hasUploadedMarkingScheme) return notConfident('uploaded marking scheme supplied');

  const counts = new Map<string, number>();
  let explicitVotes = 0;
  for (const g of params.geometryResults || []) {
    if (!g || g.is_marking_scheme) continue;
    const s = String(g.detected_subject || '').trim().toUpperCase();
    if (!s || s === 'NON_ACADEMIC') continue;
    explicitVotes++;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  if (explicitVotes === 0) return notConfident('no explicit page subject votes');

  let topSubject = '';
  let topVotes = 0;
  counts.forEach((cnt, subj) => {
    if (cnt > topVotes) { topVotes = cnt; topSubject = subj; }
  });

  const gateable: GateableSubjectKey[] = ['MATHS', 'ENGLISH_LANGUAGE', 'ENGLISH_LITERATURE'];
  if (!gateable.includes(topSubject as GateableSubjectKey)) {
    return notConfident(`top subject ${topSubject} is not gateable`, explicitVotes, topVotes);
  }
  if (topVotes / explicitVotes < 0.8) {
    return notConfident(`split vote ${topSubject} ${topVotes}/${explicitVotes}`, explicitVotes, topVotes);
  }
  if (params.resolvedProfileKey && params.resolvedProfileKey !== topSubject) {
    return notConfident(`router profile ${params.resolvedProfileKey} disagrees with page vote ${topSubject}`, explicitVotes, topVotes);
  }
  const codeKey = params.paperCodeHint ? resolvePaperSubjectKey({ exam_code: params.paperCodeHint }) : null;
  if (codeKey && codeKey !== topSubject) {
    return notConfident(`printed paper code "${params.paperCodeHint}" suggests ${codeKey}`, explicitVotes, topVotes);
  }

  return {
    key: topSubject as GateableSubjectKey,
    confident: true,
    explicitVotes,
    topVotes,
    reason: `${topVotes}/${explicitVotes} explicit page votes`
  };
}

/**
 * Determines whether a specific question result / scheme uses Level-of-Response (LoR) grading
 * rather than additive point-summing.
 * Note: Inside an English Language paper, Question 1 (4 marks AO1 retrieval) is point-based,
 * whereas Questions 2-5 and Literature essays are Level-of-Response.
 */
export function isLevelOfResponseQuestion(
  schemeOrTask?: any,
  profile?: SubjectProfile,
  rubricEvaluation?: RubricEvaluation | null
): boolean {
  if (rubricEvaluation) {
    return rubricEvaluation.scoringType === 'SINGLE_AO_LOR' || rubricEvaluation.scoringType === 'DUAL_AO_LOR';
  }

  const scoringType = schemeOrTask?.scoringType || schemeOrTask?.markingScheme?.scoringType;
  if (scoringType === 'SINGLE_AO_LOR' || scoringType === 'DUAL_AO_LOR') {
    return true;
  }
  if (scoringType === 'POINT_BASED') {
    return false;
  }

  if (
    schemeOrTask?.levels ||
    schemeOrTask?.markingScheme?.levels ||
    schemeOrTask?.levelDescriptors ||
    schemeOrTask?.markingScheme?.levelDescriptors
  ) {
    return true;
  }

  if (profile?.paradigm === 'LEVEL_OF_RESPONSE') {
    // Check if this is Q1 short retrieval (<= 4 marks) without LoR descriptors
    const qNum = String(schemeOrTask?.questionNumber || '').replace(/[^0-9]/g, '');
    const totalMarks = Number(schemeOrTask?.totalMarks || schemeOrTask?.markingScheme?.totalMarks || 0);
    if (profile.key === 'ENGLISH_LANGUAGE' && qNum === '1' && totalMarks > 0 && totalMarks <= 4) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Classifies any academic subject (across GCSE, IGCSE, A-Level, IAL, O Level, National 5, IB, AP)
 * into a coarse marking family so UNIVERSAL_BYOMS only injects relevant domain tie-breaker rules
 * and native mark-code conventions.
 */
export function resolveSubjectFamily(subjectName?: string, paperCode?: string): SubjectFamily {
  const haystack = `${subjectName || ''} ${paperCode || ''}`.toLowerCase();

  if (/\b(english\s*lang|english\s*lit|literature\s+in\s+english|english\s+language|english\s+literature|ap\s+english|8700|8702|1en0|1et0)\b/i.test(haystack)) {
    return 'ENGLISH_WRITING';
  }
  if (/\b(math|maths|mathematics|math\s*aa|math\s*ai|further\s*maths|additional\s*math\w*|applied\s*math\w*|numeracy|statistics|mechanics|calculus|precalculus|accounting|core\s*maths|econometrics|1ma1|8300|9ma0|0580|0606|4ma1|wma)\b/i.test(haystack)) {
    return 'QUANTITATIVE';
  }
  if (/\b(biology|biochemistry|chemistry|physics|astrophysics|combined\s*science|trilogy|synergy|science|computer\s*science|environmental|astronomy|geology|engineering|design\s*(?:and|&)\s*technology|food\s*prep\w*|physical\s*education|sports?\s*science|8461|8462|8463|8464|8465|0610|0620|0625)\b/i.test(haystack)) {
    return 'SCIENCE_DATA';
  }
  if (/\b(religious|religion|theology|philosophy|ethics|history|geography|sociology|psychology|politics|government|civics|economics|macroeconomics|microeconomics|business|law|citizenship|classics|classical|anthropology|archaeology|global\s*perspectives|drama|media|film|art\s*history|8062|8063|8145|8035|8192|8182|8132|8136)\b/i.test(haystack)) {
    return 'HUMANITIES_ESSAY';
  }

  return 'GENERAL';
}

/**
 * Returns true if a normalized scheme (standalone or composite) contains at least one
 * LEVEL_OF_RESPONSE sub-question (or standalone level descriptors) worth >= minMarks.
 */
export function hasLevelOfResponseSubQuestion(normalizedScheme: any, minMarks: number = 6): boolean {
  if (!normalizedScheme || typeof normalizedScheme !== 'object') return false;

  if (Array.isArray(normalizedScheme.levels) && normalizedScheme.levels.length > 0) {
    const total = Number(normalizedScheme.totalMarks || normalizedScheme.parentQuestionMarks || 0);
    if (total === 0 || total >= minMarks) return true;
  }

  const subMetaMap = normalizedScheme.subQuestionMetadata || {};
  const subMaxScores = normalizedScheme.subQuestionMaxScores || {};
  for (const [key, meta] of Object.entries(subMetaMap)) {
    const m: any = meta;
    if (!m || typeof m !== 'object') continue;
    const isLoR =
      String(m.paradigm || '').toUpperCase() === 'LEVEL_OF_RESPONSE' ||
      (Array.isArray(m.levels) && m.levels.length > 0);
    if (isLoR) {
      const subMax = Number(subMaxScores[key] ?? m.maxScore ?? m.totalMarks ?? 0);
      if (subMax === 0 || subMax >= minMarks) return true;
    }
  }

  return false;
}

/**
 * Maps an AO code (and optional question number / context) to its canonical Radar Axis name
 * for a given SubjectProfile.
 */
export function mapAoToRadarAxis(
  aoCode: string,
  profile: SubjectProfile,
  questionNumber?: string,
  questionText?: string,
  hints?: any
): string {
  const cleanAo = (aoCode || '').toUpperCase().trim();
  const qNum = String(questionNumber || '').replace(/[^0-9]/g, '');
  const qTextLower = (questionText || '').toLowerCase();
  const isP2 = isPaper2EnglishLanguage(hints) ||
    /synthesis|synthesise|comparison|compare/i.test(aoCode) ||
    /synthesis|synthesise|comparison|compare/i.test(qTextLower) ||
    (hints?.radarAxes && Array.isArray(hints.radarAxes) && hints.radarAxes.includes('AO3 Comparison'));

  if (profile.key === 'ENGLISH_LANGUAGE') {
    if (cleanAo.includes('AO5')) return 'AO5 Content & Org';
    if (cleanAo.includes('AO6')) return 'AO6 Technical SPaG';

    // Deterministic Paper 2 (8700/2, 1EN0/02) Question-to-AO mapping
    if (isP2) {
      if (qNum === '1') return 'AO1 Retrieval';
      if (qNum === '2') return 'AO1 Synthesis';
      if (qNum === '3') return 'AO2 Language';
      if (qNum === '4' || cleanAo.includes('AO3') || cleanAo.includes('AO4')) return 'AO3 Comparison';
      if (cleanAo.includes('AO1')) {
        return /synthesis|synthesise|similarit|differen|summary/i.test(qTextLower + ' ' + aoCode)
          ? 'AO1 Synthesis'
          : 'AO1 Retrieval';
      }
      if (cleanAo.includes('AO2')) return 'AO2 Language';
      return 'AO5 Content & Org';
    }

    // Paper 1 (8700/1) mapping
    if (cleanAo.includes('AO1')) return 'AO1 Retrieval';
    if (cleanAo.includes('AO2')) {
      if (qNum === '3' || /structure|structural|whole\s+of\s+the\s+source/i.test(qTextLower + ' ' + aoCode)) {
        return 'AO2 Structure';
      }
      return 'AO2 Language';
    }
    if (cleanAo.includes('AO3') || cleanAo.includes('AO4')) return 'AO4 Evaluation';

    // Fallback by question number for Paper 1
    if (qNum === '1') return 'AO1 Retrieval';
    if (qNum === '2') return 'AO2 Language';
    if (qNum === '3') return 'AO2 Structure';
    if (qNum === '4') return 'AO4 Evaluation';
    if (qNum === '5' || qNum === '6') return 'AO5 Content & Org';
    return ENGLISH_LANGUAGE_P1_RADAR_AXES[0];
  }

  if (profile.key === 'ENGLISH_LITERATURE') {
    if (cleanAo.includes('AO1')) {
      if (/quot|reference|evidence/i.test(aoCode)) return 'AO1 Quotations';
      return 'AO1 Critical Response';
    }
    if (cleanAo.includes('AO2')) {
      if (/structure/i.test(aoCode)) return 'AO2 Structure';
      return 'AO2 Language & Form';
    }
    if (cleanAo.includes('AO3')) return 'AO3 Context';
    if (cleanAo.includes('AO4')) return 'AO4 SPaG';
    return profile.radarAxes[0];
  }

  return profile.radarAxes[0];
}

export function buildUniversalEnglishRubricFallback(params: {
  subjectKey?: SubjectKey;
  questionNumber?: string;
  questionText?: string;
  totalMarks?: number;
}): string {
  const {
    subjectKey = 'ENGLISH_LANGUAGE',
    questionNumber = '1',
    questionText = '',
    totalMarks = 0
  } = params;
  const qNum = String(questionNumber).replace(/[^0-9]/g, '');
  const qLower = questionText.toLowerCase();

  if (subjectKey === 'ENGLISH_LITERATURE') {
    const maxM = totalMarks > 0 ? totalMarks : 30;
    return `[UNIVERSAL GCSE ENGLISH LITERATURE LEVEL-OF-RESPONSE RUBRIC (Max ${maxM} marks)]
- Assess AO1 (Critical, exploratory response to text & task with precise references/quotations), AO2 (Analysis of writer's methods—language, form, and structure—using subject terminology), and AO3 (Understanding of relationship between ideas and historical/social/literary context). If totalMarks > 30 (e.g. 34 marks), award up to 4 marks for AO4 (Vocabulary, sentence structure, spelling, and punctuation).
- Level 4 (Top Band, ~76-100% of marks): Conceptualised, convincing, critical response; judicious references; perceptive analysis of writer's methods and context.
- Level 3 (Upper-Mid Band, ~51-75% of marks): Clear, explained response; apt references; clear explanation of writer's methods and relevant context.
- Level 2 (Lower-Mid Band, ~26-50% of marks): Some supported response; some appropriate references; some identification of writer's methods/context.
- Level 1 (Bottom Band, ~1-25% of marks): Simple, limited narrative comment; simple references.`;
  }

function computeLorBands(max: number) {
  const safeMax = Math.max(4, max);
  const l1Max = Math.max(1, Math.round(safeMax * 0.25));
  const l2Max = Math.max(l1Max + 1, Math.round(safeMax * 0.5));
  const l3Max = Math.min(safeMax - 1, Math.max(l2Max + 1, Math.round(safeMax * 0.75)));
  return {
    l1: `1-${l1Max}`,
    l2: `${l1Max + 1}-${l2Max}`,
    l3: `${l2Max + 1}-${l3Max}`,
    l4: `${l3Max + 1}-${safeMax}`
  };
}

  // 1. Detect Creative / Transactional Writing (Section B / Q5 / 24-40 marks)
  const isWritingTask =
    totalMarks >= 24 ||
    qNum === '5' ||
    qNum === '6' ||
    /write\s+a\s+(description|story|narrative|speech|letter|article|leaflet|report|review)/i.test(qLower) ||
    /content\s+and\s+organisation[\s\S]*technical\s+accuracy/i.test(qLower);

  if (isWritingTask) {
    const effectiveTotal = totalMarks >= 24 ? totalMarks : 40;
    const ao5Max = effectiveTotal === 40 ? 24 : Math.round(effectiveTotal * 0.6);
    const ao6Max = effectiveTotal - ao5Max;
    const ao5Bands = computeLorBands(ao5Max);
    const ao6Bands = computeLorBands(ao6Max);
    return `[UNIVERSAL GCSE ENGLISH LANGUAGE WRITING RUBRIC — DUAL-AO (${effectiveTotal} Marks = AO5: ${ao5Max} marks + AO6: ${ao6Max} marks)]
1. AO5 Content & Organisation (${ao5Max} marks) — Radar Axis: "AO5 Content & Org":
   - Level 4 (Compelling, Convincing | ${ao5Bands.l4} marks): Communication is convincing and compelling; tone, style, and register assuredly matched to purpose and audience; extensive vocabulary with sustained crafting of linguistic devices; varied and inventive structural features (e.g. cyclical structure, shifts in focus/pace) with fluently linked paragraphs.
   - Level 3 (Consistent, Clear | ${ao5Bands.l3} marks): Communication is consistently clear and effective; tone/register matched to audience; increasingly sophisticated vocabulary and successful linguistic devices; coherent paragraphs with integrated discourse markers.
   - Level 2 (Some Success | ${ao5Bands.l2} marks): Communicates with some sustained success; attempts to match tone/register and vary vocabulary; some linked ideas and paragraphing.
   - Level 1 (Simple, Limited | ${ao5Bands.l1} marks): Simple communication and vocabulary; limited structural features or random paragraphing.
2. AO6 Technical Accuracy / SPaG (${ao6Max} marks) — Radar Axis: "AO6 Technical SPaG":
   - Level 4 (${ao6Bands.l4} marks): Sentence demarcation consistently secure; wide range of ambitious punctuation (colons, semicolons, dashes) and sentence forms used for effect; high accuracy in spelling including ambitious vocabulary.
   - Level 3 (${ao6Bands.l3} marks): Sentence demarcation mostly secure; range of punctuation and sentence forms used mostly with success; generally accurate spelling of complex words.
   - Level 2 (${ao6Bands.l2} marks): Some control of punctuation and sentence variety; accurate basic spelling.
   - Level 1 (${ao6Bands.l1} marks): Occasional sentence demarcation; simple range of sentence forms.`;
  }

  // 2. Detect 4-Mark Point-Based Retrieval (Q1)
  if ((totalMarks > 0 && totalMarks <= 4) || (qNum === '1' && /list\s+four\s+things|choose\s+four\s+statements/i.test(qLower))) {
    const maxM = totalMarks > 0 ? totalMarks : 4;
    return `[UNIVERSAL GCSE ENGLISH LANGUAGE AO1 RETRIEVAL RUBRIC (${maxM} Marks — POINT_BASED)]
- Award 1 mark for each valid, accurate piece of explicit/implicit information or correct statement identified from the specified lines (up to ${maxM} marks). Set scoringType to "POINT_BASED" and upgradeRewrite to null.`;
  }

  // 3. Detect Single-AO Reading Analysis / Synthesis / Comparison / Evaluation (Q2, Q3, Q4)
  const isComparison = /compare\s+how\s+the\s+writers|both\s+texts|source\s+a\s+and\s+source\s+b/i.test(qLower);
  const isSynthesis = /summary\s+of\s+what\s+you\s+understand|similarities|differences\s+between/i.test(qLower) && totalMarks <= 10;
  const isEvaluation = /to\s+what\s+extent\s+do\s+you\s+agree|evaluate\s+how/i.test(qLower) || totalMarks >= 18;
  const isStructure = /structured\s+the\s+text|structural\s+features/i.test(qLower);

  const targetAo = isComparison ? 'AO3' : isEvaluation ? 'AO4' : isSynthesis ? 'AO1' : 'AO2';
  const targetAxis = isComparison
    ? 'AO3 Comparison'
    : isEvaluation
      ? 'AO4 Evaluation'
      : isSynthesis
        ? 'AO1 Synthesis'
        : isStructure
          ? 'AO2 Structure'
          : 'AO2 Language';
  const effectiveMarks = totalMarks > 0 ? totalMarks : (isEvaluation ? 20 : isComparison ? 16 : 8);
  const readingBands = computeLorBands(effectiveMarks);

  return `[UNIVERSAL GCSE ENGLISH LANGUAGE ${targetAo} LEVEL-OF-RESPONSE RUBRIC (${effectiveMarks} Marks — Radar Axis: "${targetAxis}")]
- Level 4 (Perceptive, Detailed | ${readingBands.l4} marks): Shows perceptive, detailed understanding; analyses subtle effects of the writer's choices/methods; selects judicious textual quotations; makes sophisticated and accurate use of subject terminology.
- Level 3 (Clear, Relevant | ${readingBands.l3} marks): Shows clear, explained understanding; explains clearly the effects of the writer's choices/methods; selects relevant textual quotations; makes clear and accurate use of subject terminology.
- Level 2 (Some, Attempts | ${readingBands.l2} marks): Shows some understanding; attempts to comment on the effect of methods; selects some appropriate textual references; some use of subject terminology.
- Level 1 (Simple, Limited | ${readingBands.l1} marks): Shows simple awareness; offers simple descriptive/narrative comment; selects simple references.`;
}
