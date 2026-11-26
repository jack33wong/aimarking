import React, { useMemo, useState, useEffect } from 'react';
import {
  CheckCircle2,
  Target,
  Sparkles,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  FileCheck2,
  ArrowRight,
  ChevronRight,
  BookOpen,
  Pencil,
  X
} from 'lucide-react';
import { useMarkingPage } from '../../contexts/MarkingPageContext';
import { engagementTracker } from '../../utils/engagementTracker';
import './css/PerformanceSummaryPanel.css';

interface RadarPoint {
  axis: string;
  score: number; // 0 - 100
  awarded: number;
  total: number;
  assessed: boolean;
}

interface QuestionCoachingItem {
  q: string;
  rubricStamp: string;
  awardedLevel: number;
  levelLabel: string;
  awardedMarks: number;
  maxMarks: number;
  aoBreakdown?: Array<{
    ao: string;
    skill?: string;
    level: number;
    levelLabel: string;
    awardedMarks: number;
    maxMarks: number;
  }>;
  coaching: {
    rationale: string;
    nextLevelGap: string;
    upgradeRewrite?: {
      originalQuote: string;
      upgradedVersion: string;
      explanation?: string;
    } | null;
  };
}

interface HandwritingIssue {
  q: string;
  subQ?: string;
  pageIndex?: number;
  ocrText: string;
  intendedText?: string;
  note: string;
  confidenceRate?: number;
}

interface HandwritingSummary {
  rating: 'clear' | 'fair' | 'needs_care';
  label: 'Clear' | 'Fair' | 'Needs Care';
  confidenceRate?: number;
  tip: string;
  issues: HandwritingIssue[];
  isTyped?: boolean;
}

interface SummaryV2Payload {
  _type: 'AI_SUMMARY_V2';
  level: 'GCSE' | 'ALEVEL' | string;
  subjectKey?: string;
  headline?: string;
  tooDenseWarning?: boolean;
  examInfo?: {
    examBoard?: string;
    examSeries?: string;
    qualification?: string;
    subject?: string;
    examCode?: string;
    tier?: string;
    isModified?: boolean;
  } | null;
  markingSource?: {
    type: 'official' | 'user_uploaded' | 'modified' | 'general';
    label?: string;
    fileName?: string;
  } | null;
  questionBreakdown?: Array<{
    q: string;
    awarded: number;
    total: number;
    lost: number;
    feedback?: string;
  }>;
  score: {
    awardedMarks: number;
    totalMarks: number;
    percentage: number;
    questionsTotal: number;
    questionsFullMarks: number;
    questionsAttempted: number;
  };
  grading?: {
    grade?: string | null;
    predictedGrade?: string | null;
    boundaries?: Record<string, number>;
    boundariesSource?: 'official' | 'estimated';
  } | null;
  radar: RadarPoint[];
  mastered: Array<{ q?: string; text: string }>;
  focusNext: Array<{ q?: string; text: string; marksLost?: number }>;
  questionCoaching?: QuestionCoachingItem[];
  handwriting?: HandwritingSummary | null;
  hasCombinedOverview?: boolean;
  paperSummaries?: Array<{
    label: string;
    summary: SummaryV2Payload;
  }>;
}

interface PerformanceSummaryPanelProps {
  rawSummary: string;
  MarkdownMathRenderer: React.ElementType;
  detectedQuestion?: any;
  markingContext?: any;
  onQuestionClick?: (qNum: string, pageIndex?: number) => void;
  activeQuestionId?: string | null;
}

const sanitizePaperCodeForDisplay = (code?: string | null): string => {
  if (!code || typeof code !== 'string') return '';
  let cleaned = code
    .replace(/\|.*$/, '')
    .replace(/\.(pdf|png|jpe?g|webp)$/i, '')
    .trim();
  cleaned = cleaned
    .replace(/(?:[_\-\s]+(?:MS|QP|ER|INS|RMS|QUE))+$/i, '')
    .replace(/[_\-\s]+\d{4}$/, '')
    .replace(/(?:[_\-\s]+(?:MS|QP|ER|INS|RMS|QUE))+$/i, '')
    .trim();
  if (/^[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(cleaned)) {
    cleaned = cleaned.replace('_', '/');
  } else {
    cleaned = cleaned.replace(/_+/g, ' ');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
};

const shortenSubjectForDisplay = (subject?: string | null): string => {
  const s = (subject || '').trim();
  if (!s || /^(unknown|n\/a|general|generic question)$/i.test(s)) return '';
  if (/^mathematics$/i.test(s)) return 'Maths';
  if (/^further mathematics$/i.test(s)) return 'Further Maths';
  return s;
};

type ParsedSchemeBlock =
  | { kind: 'subpart'; label: string; marks?: string }
  | { kind: 'section'; label: string }
  | { kind: 'point'; code: string; body: string }
  | { kind: 'text'; body: string };

const parseMarkSchemeBlocks = (scheme: string): ParsedSchemeBlock[] => {
  const lines = scheme.split(/\r?\n/);
  const blocks: ParsedSchemeBlock[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Clean internal headers like "[2a] [MAX SCORE: 3] [PARADIGM: CALCULATION_STEP]"
    // or "[1.5] [MAX SCORE: 15 (Content: 12 + SPaG: 3)] [PARADIGM: LEVEL_OF_RESPONSE]"
    const subpartMatch = line.match(/^\[([^\]]+)\]\s*(?:\[MAX SCORE:\s*([^\]]+)\])?(?:\s*\[PARADIGM:[^\]]+\])?$/i);
    if (subpartMatch) {
      const partId = subpartMatch[1].trim();
      const rawMaxScore = subpartMatch[2]?.trim();
      // Ignore structural section headers like [LEVEL DESCRIPTORS], [INDICATIVE CONTENT], [SPaG RUBRIC (...)]
      if (/^(?:LEVEL DESCRIPTORS|INDICATIVE CONTENT|SPaG RUBRIC|Additional Examiner Guidance)/i.test(partId)) {
        blocks.push({ kind: 'section', label: partId });
        continue;
      }
      let formattedMarks: string | undefined;
      if (rawMaxScore) {
        const splitMatch = rawMaxScore.match(/^(\d+)\s*(\(.+\))$/);
        if (splitMatch) {
          const totalNum = splitMatch[1];
          formattedMarks = `${totalNum} ${totalNum === '1' ? 'mark' : 'marks'} ${splitMatch[2]}`;
        } else if (/mark/i.test(rawMaxScore)) {
          formattedMarks = rawMaxScore;
        } else {
          formattedMarks = `${rawMaxScore} ${rawMaxScore === '1' ? 'mark' : 'marks'}`;
        }
      }
      blocks.push({
        kind: 'subpart',
        label: `Part ${partId}`,
        ...(formattedMarks ? { marks: formattedMarks } : {})
      });
      continue;
    }

    // Section headers with trailing colon like "[Additional Examiner Guidance]:"
    const sectionHeaderMatch = line.match(/^\[([^\]]+)\]:?$/);
    if (sectionHeaderMatch && /^(?:LEVEL DESCRIPTORS|INDICATIVE CONTENT|SPaG RUBRIC|Additional Examiner Guidance)/i.test(sectionHeaderMatch[1])) {
      blocks.push({ kind: 'section', label: sectionHeaderMatch[1].trim() });
      continue;
    }

    // Level descriptor bullets like "* Level 4 (10-12 marks): Well-argued response..."
    const levelMatch = line.match(/^(?:[-*•]\s*)?(Level\s*\d+(?:\s*\([^)]+\))?|Band\s*\d+(?:\s*\([^)]+\))?)\s*:\s*(.+)$/i);
    if (levelMatch) {
      blocks.push({
        kind: 'point',
        code: levelMatch[1].trim(),
        body: levelMatch[2].trim()
      });
      continue;
    }

    // SPaG band bullets like "* High performance (2-3 marks): ..." or "* 0 marks: ..."
    const spagBandMatch = line.match(/^(?:[-*•]\s*)?((?:High|Intermediate|Threshold)\s+performance\s*\([^)]+\)|0\s+marks)\s*:\s*(.+)$/i);
    if (spagBandMatch) {
      blocks.push({
        kind: 'point',
        code: spagBandMatch[1].trim(),
        body: spagBandMatch[2].trim()
      });
      continue;
    }

    // Parse mark-point bullets supporting ALL exam-board native codes:
    // Maths/Science: M1, A1, B1, B2, P1, C1, SC1, FT1
    // Humanities/English AOs: AO1, AO1:1, AO1:2, AO2, AO3, AO4, AO1:1 (2 marks)
    // Plain mark counts: +1, +2, 1 mark, 2 marks, 1m, 2m, Level of Response, SPaG (3 marks)
    const pointMatch = line.match(
      /^(?:[-*•]\s*)?\*{0,2}((?:AO\d+(?::\d+)?(?:\s*\(\d+\s*(?:marks?|m)\))?|[A-Z]{1,4}\d+[a-z]?|\+\d+|\d+\s*(?:marks?|m)|SPaG(?:\s*\(\d+\s*(?:marks?|m)\))?|Level\s+of\s+Response))\*{0,2}\s*[:\-–]\s*(.+)$/i
    );
    if (pointMatch) {
      blocks.push({
        kind: 'point',
        code: pointMatch[1].trim(),
        body: pointMatch[2].trim()
      });
      continue;
    }

    // Merge consecutive plain text lines into a single markdown block
    const prev = blocks[blocks.length - 1];
    if (prev && prev.kind === 'text') {
      prev.body += `\n${rawLine}`;
    } else {
      blocks.push({ kind: 'text', body: rawLine });
    }
  }

  return blocks;
};

// Helpers for Scannable Micro-Coaching and Single-Expand Strategy
const renderBoldText = (str: string, highlight?: boolean): React.ReactNode[] => {
  if (!str) return [];
  const parts = str.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      const inner = part.slice(2, -2);
      return (
        <strong
          key={i}
          className={highlight ? 'coaching-highlight-phrase' : undefined}
        >
          {inner}
        </strong>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
};

const parseCoachingBullets = (text: string): string[] => {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1. Pipe-separated bullets: "bullet 1 | bullet 2"
  if (trimmed.includes('|')) {
    return trimmed
      .split(/\s*\|\s*/)
      .map(b => b.trim())
      .filter(Boolean);
  }

  // 2. Numbered markers: "1) ... 2) ..."
  if (/\b\d+\)\s*/.test(trimmed)) {
    return trimmed
      .split(/(?=\b\d+\)\s*)/)
      .map(b => b.replace(/^\d+\)\s*/, '').trim())
      .filter(Boolean);
  }

  // 3. Fallback: multiple sentences if length > 140 chars
  if (trimmed.length > 140) {
    const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
    if (sentences && sentences.length > 1) {
      return sentences.map(s => s.trim()).filter(Boolean).slice(0, 3);
    }
  }

  return [trimmed];
};

const getDefaultExpandedKey = (qcList: QuestionCoachingItem[]): string | null => {
  if (!qcList || qcList.length === 0) return null;
  const parseQNum = (qStr: string | number) => {
    const num = parseInt(String(qStr).replace(/\D/g, ''), 10);
    return isNaN(num) ? 999 : num;
  };
  const sorted = [...qcList].sort((a, b) => parseQNum(a.q) - parseQNum(b.q));

  // 1. Find the first extended question (> 4 maxMarks) that lost marks
  const firstExtendedLost = sorted.find(
    qc => (qc.maxMarks ?? 0) > 4 && (qc.awardedMarks ?? 0) < (qc.maxMarks ?? 0)
  );
  if (firstExtendedLost) return String(firstExtendedLost.q);

  // 2. Fallback: first question of any mark value where marks were lost
  const firstLost = sorted.find(
    qc => (qc.maxMarks ?? 0) > 0 && (qc.awardedMarks ?? 0) < (qc.maxMarks ?? 0)
  );
  if (firstLost) return String(firstLost.q);

  // 3. Fallback: first question in qcList
  if (sorted.length > 0) return String(sorted[0].q);
  return null;
};

const getCardPreviewText = (
  qc: QuestionCoachingItem,
  focusNextList: Array<{ q?: string; text: string }> = []
): string => {
  const normQ = String(qc.q).replace(/^Q/i, '').trim().toLowerCase();
  const matchFocus = focusNextList.find(f => f.q && String(f.q).replace(/^Q/i, '').trim().toLowerCase() === normQ);
  if (matchFocus && matchFocus.text) {
    return matchFocus.text;
  }
  const rawGap = qc.coaching?.nextLevelGap || qc.coaching?.rationale || '';
  const clean = rawGap.replace(/\*\*/g, '').replace(/\|/g, '•').trim();
  return clean.length > 60 ? clean.slice(0, 60) + '...' : clean;
};

// Formats the rubric stamp into a clean, compact pill text (desktop vs. mobile)
const formatRubricBadge = (
  stamp: string | undefined,
  awarded: number | undefined,
  max: number | undefined,
  isMobile: boolean
): string => {
  const aw = awarded ?? 0;
  const mx = max ?? 0;
  const markPart = mx > 0 ? `${aw}/${mx}` : '';

  if (!stamp) return markPart ? (isMobile ? markPart : `${markPart} marks`) : '';

  // Clean outer brackets and extra whitespaces
  let clean = stamp.replace(/^\[\s*|\s*\]$/g, '').trim();

  // Strip parentheses content like "(Clear, relevant)"
  clean = clean.replace(/\s*\([^)]*\)/g, '').trim();

  // Check if contains pipe separator: "Point-Based | 3/4 marks" or "Level 3 | 9/12 marks"
  if (clean.includes('|')) {
    const [tier, marks] = clean.split(/\s*\|\s*/).map(s => s.trim());
    const cleanMarks = marks ? marks.replace(/\s+marks?/i, '').trim() : markPart;
    if (isMobile) {
      let shortTier = tier;
      if (/^point-based/i.test(tier)) shortTier = 'Pt';
      else if (/^level\s*(\d+)/i.test(tier)) {
        const m = tier.match(/^level\s*(\d+)/i);
        shortTier = m ? `L${m[1]}` : tier;
      }
      return cleanMarks ? `${shortTier} • ${cleanMarks}` : shortTier;
    }
    return cleanMarks ? `${tier} • ${cleanMarks}` : tier;
  }

  // Dual AO pattern: "AO5: 16/24 (L3) + AO6: 12/16 (L3) = 28/40"
  if (/AO5.*AO6/i.test(clean)) {
    if (isMobile) {
      return markPart ? `AO5+6 • ${markPart}` : 'AO5+6';
    }
    return markPart ? `AO5+AO6 • ${markPart}` : 'AO5+AO6';
  }

  // Remove trailing "marks" and replace | with •
  clean = clean.replace(/\s+marks?/i, '').replace(/\s*\|\s*/g, ' • ');

  if (isMobile) {
    clean = clean.replace(/^point-based/i, 'Pt').replace(/^level\s*(\d+)/i, 'L$1');
  }

  return clean;
};

// Aligns badge color with top question ribbon (full mark = green, mid = yellow, low = red)
const getStampScoreColor = (
  awarded: number | undefined,
  max: number | undefined
): 'green' | 'yellow' | 'red' | 'neutral' => {
  if (max === undefined || max === null || max <= 0 || awarded === undefined || awarded === null) {
    return 'neutral';
  }
  if (awarded >= max) return 'green';
  if (awarded === 0) return 'red';
  return 'yellow';
};

// Soft pastel sector colors (adapts via opacity to both light & dark mode)
const SECTOR_COLORS = [
  '#f59e0b', // Amber
  '#3b82f6', // Blue
  '#ec4899', // Pink
  '#10b981', // Emerald
  '#f97316', // Orange
  '#8b5cf6', // Violet
  '#06b6d4', // Cyan
  '#eab308'  // Yellow
];

const TopicRadarChart: React.FC<{ data: RadarPoint[] }> = ({ data }) => {
  const width = 360;
  const height = 310;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 94;
  const levels = [0.25, 0.5, 0.75, 1.0];
  const n = data.length || 6;

  const getPoint = (index: number, ratio: number) => {
    // Start at top (-90 deg)
    const angle = (Math.PI * 2 * index) / n - Math.PI / 2;
    return {
      x: cx + radius * ratio * Math.cos(angle),
      y: cy + radius * ratio * Math.sin(angle),
      angle
    };
  };

  // Sector background wedges (like TMUA radar chart)
  const sectorPaths = useMemo(() => {
    return data.map((_, i) => {
      const nextI = (i + 1) % n;
      const p1 = getPoint(i, 1);
      const p2 = getPoint(nextI, 1);
      return {
        d: `M ${cx} ${cy} L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} Z`,
        color: SECTOR_COLORS[i % SECTOR_COLORS.length]
      };
    });
  }, [data, n]);

  // Data polygon points
  const dataPoints = useMemo(() => {
    return data.map((d, i) => {
      const ratio = Math.max(0.08, Math.min(1, (d.score || 0) / 100));
      const pt = getPoint(i, ratio);
      const labelPt = getPoint(i, 1.20);
      return { ...pt, labelX: labelPt.x, labelY: labelPt.y, item: d };
    });
  }, [data, n]);

  const polygonPointsStr = dataPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const hasProvisional = data.some(d => !d.assessed);

  return (
    <div className="tmua-radar-wrapper">
      <div className="tmua-section-label">MASTERY BY TOPIC</div>
      <svg viewBox={`0 0 ${width} ${height}`} className="tmua-radar-svg">
        {/* Subtle colored sector wedges */}
        {sectorPaths.map((s, idx) => (
          <path key={idx} d={s.d} fill={s.color} className="tmua-radar-sector" />
        ))}

        {/* Concentric web polygons */}
        {levels.map((lvl, lIdx) => {
          const pts = data.map((_, i) => {
            const p = getPoint(i, lvl);
            return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
          }).join(' ');
          return (
            <polygon
              key={lIdx}
              points={pts}
              fill="none"
              className="tmua-radar-grid-ring"
            />
          );
        })}

        {/* Axis spokes */}
        {data.map((_, i) => {
          const end = getPoint(i, 1);
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={end.x.toFixed(1)}
              y2={end.y.toFixed(1)}
              className="tmua-radar-spoke"
            />
          );
        })}

        {/* Filled Mastery Polygon */}
        <polygon
          points={polygonPointsStr}
          className={`tmua-radar-area ${hasProvisional ? 'has-provisional' : ''}`}
        />

        {/* Vertex Dots (Solid for assessed, Hollow for provisional) */}
        {dataPoints.map((p, i) => (
          <g key={i}>
            <circle
              cx={p.x}
              cy={p.y}
              r={p.item.assessed ? 4 : 3.5}
              className={p.item.assessed ? 'tmua-dot-solid' : 'tmua-dot-hollow'}
            >
              <title>
                {p.item.axis}: {p.item.assessed ? `${p.item.awarded}/${p.item.total} (${p.item.score}%)` : 'Not assessed in this upload (provisional)'}
              </title>
            </circle>
          </g>
        ))}

        {/* Axis Labels */}
        {dataPoints.map((p, i) => {
          const cos = Math.cos(p.angle);
          const textAnchor = cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle';
          // Split long labels onto 2 lines if needed
          const words = p.item.axis.split(' ');
          const line1 = words.length > 2 ? words.slice(0, 2).join(' ') : p.item.axis;
          const line2 = words.length > 2 ? words.slice(2).join(' ') : '';

          return (
            <text
              key={i}
              x={p.labelX}
              y={p.labelY}
              textAnchor={textAnchor}
              dominantBaseline="middle"
              className={`tmua-radar-label ${p.item.assessed ? 'assessed' : 'provisional'}`}
            >
              <tspan x={p.labelX} dy={line2 ? '-0.4em' : '0'}>{line1}</tspan>
              {line2 && <tspan x={p.labelX} dy="1.1em">{line2}</tspan>}
            </text>
          );
        })}
      </svg>

      <div className="tmua-radar-legend">
        <span className="legend-item">
          <span className="legend-dot solid" /> Assessed
        </span>
        {hasProvisional && (
          <span className="legend-item">
            <span className="legend-dot hollow" /> Provisional
          </span>
        )}
      </div>
    </div>
  );
};

export const PerformanceSummaryPanel: React.FC<PerformanceSummaryPanelProps> = ({
  rawSummary,
  MarkdownMathRenderer,
  detectedQuestion,
  markingContext,
  onQuestionClick,
  activeQuestionId: propActiveQuestionId
}) => {
  const [showSchemeModal, setShowSchemeModal] = useState(false);
  const [isHandwritingExpanded, setIsHandwritingExpanded] = useState(false);
  let contextActiveQuestionId: string | null = null;
  try {
    const markingPage = useMarkingPage();
    contextActiveQuestionId = markingPage?.activeQuestionId || null;
  } catch (_) {
    // Safe fallback if rendered outside MarkingPageProvider
  }
  const effectiveActiveQuestionId = propActiveQuestionId ?? contextActiveQuestionId;

  const parsedV2 = useMemo<SummaryV2Payload | null>(() => {
    if (!rawSummary || typeof rawSummary !== 'string') return null;
    const trimmed = rawSummary.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && obj._type === 'AI_SUMMARY_V2') {
        return obj as SummaryV2Payload;
      }
    } catch (_) {}
    return null;
  }, [rawSummary]);

  const [selectedPaperTab, setSelectedPaperTab] = useState<number>(0);

  const summaryTabs = useMemo(() => {
    if (!parsedV2?.paperSummaries || parsedV2.paperSummaries.length <= 1) return [];
    if (parsedV2.hasCombinedOverview === false) {
      return parsedV2.paperSummaries.map(p => ({
        label: p.label,
        payload: p.summary
      }));
    }
    const overallGradeTag = parsedV2.grading?.grade && parsedV2.grading.grade !== 'N/A'
      ? ` (${parsedV2.grading.grade})`
      : '';
    return [
      {
        label: `Overall: ${parsedV2.score.awardedMarks}/${parsedV2.score.totalMarks}${overallGradeTag}`,
        payload: parsedV2
      },
      ...parsedV2.paperSummaries.map(p => ({
        label: p.label,
        payload: p.summary
      }))
    ];
  }, [parsedV2]);

  const activeV2 = useMemo<SummaryV2Payload | null>(() => {
    if (!parsedV2) return null;
    if (summaryTabs.length > 0) {
      const safeIdx = Math.min(selectedPaperTab, summaryTabs.length - 1);
      return summaryTabs[safeIdx]?.payload || parsedV2;
    }
    return parsedV2;
  }, [parsedV2, summaryTabs, selectedPaperTab]);

  // Collect mark scheme entries:
  // 1) Official / user-uploaded per-question markingScheme text when available (never leaking internal prompts)
  // 2) Fallback for non-official / General Mark Scheme multi-question papers (2+ Qs)
  const isInternalPromptText = (text: string): boolean =>
    /\[GENERIC_[A-Z_]+\]|\[INSTRUCTION\]|CHIEF EXAMINER|RAW OCR BLOCKS|\[SUB-QUESTION BUDGETS\]/i.test(text);

  const { items: schemeQuestions, hasCriteria: hasSchemeCriteria } = useMemo<{
    items: Array<{ q: string; marks?: number; awarded?: number; scheme: string; paperTitle?: string }>;
    hasCriteria: boolean;
  }>(() => {
    const papers = detectedQuestion?.examPapers;
    const withSchemeText: Array<{ q: string; marks?: number; awarded?: number; scheme: string; paperTitle?: string }> = [];
    if (Array.isArray(papers)) {
      papers.forEach((p: any) => {
        (p.questions || []).forEach((q: any, idx: number) => {
          const schemeText = typeof q?.markingScheme === 'string' ? q.markingScheme.trim() : '';
          if (schemeText && !isInternalPromptText(schemeText)) {
            const rawNum = q.questionNumber ?? q.number ?? q.q ?? String(idx + 1);
            withSchemeText.push({
              q: String(rawNum).replace(/^Q/i, '').trim() || String(idx + 1),
              marks: Number(q.marks) || 0,
              scheme: schemeText,
              paperTitle: p.paperTitle || [p.examBoard, p.examCode, p.examSeries].filter(Boolean).join(' ')
            });
          }
        });
      });
    }
    if (withSchemeText.length > 0) {
      return { items: withSchemeText, hasCriteria: true };
    }

    // Fallback for non-official / General Mark Scheme multi-question papers (e.g. 51 / 112)
    const breakdown = activeV2?.questionBreakdown;
    if (Array.isArray(breakdown) && breakdown.length >= 2) {
      return {
        items: breakdown.map((qb, idx) => ({
          q: String(qb.q || idx + 1).replace(/^Q/i, '').trim() || String(idx + 1),
          marks: Number(qb.total) || 0,
          awarded: Number(qb.awarded) || 0,
          scheme: ''
        })),
        hasCriteria: false
      };
    }

    const ctxResults = markingContext?.questionResults;
    if (Array.isArray(ctxResults) && ctxResults.length >= 2) {
      let anyRealScheme = false;
      const mapped = ctxResults.map((qr: any, idx: number) => {
        const rawNum = qr.number ?? qr.questionNumber ?? qr.q ?? String(idx + 1);
        const cleanNum = String(rawNum).replace(/^Q/i, '').trim() || String(idx + 1);
        const rawScheme = typeof qr.scheme === 'string' ? qr.scheme.trim() : '';
        const safeScheme = rawScheme && qr.hasScheme !== false && !isInternalPromptText(rawScheme) ? rawScheme : '';
        if (safeScheme) anyRealScheme = true;
        return {
          q: cleanNum,
          marks: Number(qr.totalMarks ?? qr.score?.totalMarks ?? 0),
          awarded: Number(qr.earnedMarks ?? qr.score?.awardedMarks ?? qr.marks ?? 0),
          scheme: safeScheme
        };
      });
      return { items: mapped, hasCriteria: anyRealScheme };
    }

    if (Array.isArray(papers)) {
      const fallbackQs: Array<{ q: string; marks?: number; scheme: string }> = [];
      papers.forEach((p: any) => {
        (p.questions || []).forEach((q: any, idx: number) => {
          const rawNum = q.questionNumber ?? q.number ?? q.q ?? String(idx + 1);
          fallbackQs.push({
            q: String(rawNum).replace(/^Q/i, '').trim() || String(idx + 1),
            marks: Number(q.marks) || 0,
            scheme: ''
          });
        });
      });
      if (fallbackQs.length >= 2) {
        return { items: fallbackQs, hasCriteria: false };
      }
    }

    return { items: [], hasCriteria: false };
  }, [detectedQuestion, activeV2, markingContext]);

  // Sort grade boundaries descending (highest grade 9 / A* on the left, matching original database table)
  const sortedBoundariesDesc = useMemo(() => {
    if (!activeV2?.grading?.boundaries) return [];
    return Object.entries(activeV2.grading.boundaries)
      .map(([g, mark]) => ({ grade: g, mark: Number(mark) }))
      .filter(b => !isNaN(b.mark))
      .sort((a, b) => b.mark - a.mark);
  }, [activeV2]);

  // Strategy 1 Initial Default (Single-Expand Accordion)
  const [expandedQuestionKey, setExpandedQuestionKey] = useState<string | null>(() =>
    getDefaultExpandedKey(activeV2?.questionCoaching || [])
  );

  useEffect(() => {
    if (activeV2?.questionCoaching && activeV2.questionCoaching.length > 0) {
      setExpandedQuestionKey(prev => prev ?? getDefaultExpandedKey(activeV2.questionCoaching!));
    }
  }, [activeV2]);

  // Sync When User Clicks Top QUESTION BREAKDOWN Ribbon or Focus Next Chips
  useEffect(() => {
    if (!effectiveActiveQuestionId || !activeV2?.questionCoaching) return;
    const normActive = String(effectiveActiveQuestionId).replace(/^Q/i, '').trim().toLowerCase();
    const match = activeV2.questionCoaching.find(
      qc => String(qc.q).replace(/^Q/i, '').trim().toLowerCase() === normActive
    );
    if (match) {
      setExpandedQuestionKey(String(match.q));
    }
  }, [effectiveActiveQuestionId, activeV2]);

  // Fallback for legacy markdown sessions
  if (!activeV2) {
    return (
      <div className="ai-performance-summary">
        <div className="ai-performance-summary-content">
          <MarkdownMathRenderer
            content={rawSummary}
            className="chat-message-renderer"
            options={{ throwOnError: false, errorColor: '#cc0000' }}
          />
        </div>
        <hr className="summary-separator" />
      </div>
    );
  }

  const {
    examInfo,
    markingSource,
    questionBreakdown,
    score,
    grading,
    radar,
    mastered,
    focusNext,
    headline,
    tooDenseWarning,
    questionCoaching,
    handwriting
  } = activeV2;

  const showHandwritingCard = Boolean(handwriting && !handwriting.isTyped);
  const handwritingIssues = Array.isArray(handwriting?.issues) ? handwriting!.issues : [];
  const hasHandwritingDetails = Boolean(
    showHandwritingCard &&
    handwriting &&
    handwriting.rating !== 'clear' &&
    (handwritingIssues.length > 0 || handwriting.tip)
  );

  const toggleHandwritingPanel = () => {
    if (!hasHandwritingDetails) return;
    setIsHandwritingExpanded(prev => {
      const next = !prev;
      if (next) {
        engagementTracker.recordHandwritingPanelOpen();
      }
      return next;
    });
  };

  const isPastPaperWithBoundaries = sortedBoundariesDesc.length > 0;
  const maxBoundaryMark = sortedBoundariesDesc[0]?.mark || 0;
  const isPartialPaper = isPastPaperWithBoundaries && score.totalMarks > 0 && score.totalMarks < maxBoundaryMark * 0.65;
  const isFullMarksOverall = score.totalMarks > 0 && score.awardedMarks >= score.totalMarks;

  // 3-tier adaptive layout: Compact (1 Q) | Standard (2-5 Qs or partial) | Full (6+ Qs or full paper)
  const summaryTier: 'compact' | 'standard' | 'full' =
    score.questionsTotal <= 1 && (!isPastPaperWithBoundaries || isPartialPaper)
      ? 'compact'
      : (score.questionsTotal <= 5 && (!isPastPaperWithBoundaries || isPartialPaper))
        ? 'standard'
        : 'full';

  // Only show Radar Chart when >= 3 distinct axes are actually assessed (prevents fake 5-provisional hexagons)
  const assessedRadarCount = Array.isArray(radar) ? radar.filter(r => r.assessed).length : 0;
  const showRadarChart = summaryTier !== 'compact' && Array.isArray(radar) && radar.length >= 3 && assessedRadarCount >= 3;

  // Resolve marking source provenance badge:
  // - `label`: full exam meta for modal & tooltip (e.g. "CIE Biology 0610/41 (May/June 2026)")
  // - `shortLabel`: compact identifier for the single-line header pill (e.g. "CIE 0610/41")
  const resolvedSource = (() => {
    const cleanCode = sanitizePaperCodeForDisplay(examInfo?.examCode);
    const shortSubj = shortenSubjectForDisplay(examInfo?.subject);
    const seriesStr = examInfo?.examSeries && !/^(n\/a|unknown|general)$/i.test(examInfo.examSeries)
      ? ` (${examInfo.examSeries})`
      : '';
    const formattedExamMeta = [examInfo?.examBoard, shortSubj, cleanCode]
      .filter(v => v && !/^(unknown|n\/a|generic question)$/i.test(String(v)))
      .join(' ');
    const compactExamMeta = [examInfo?.examBoard, cleanCode]
      .filter(v => v && !/^(unknown|n\/a|generic question)$/i.test(String(v)))
      .join(' ');

    if (markingSource?.type) {
      if (markingSource.type === 'official' && formattedExamMeta) {
        return {
          ...markingSource,
          label: `${formattedExamMeta}${seriesStr}`.trim(),
          shortLabel: compactExamMeta || formattedExamMeta
        };
      }
      if (markingSource.type === 'modified' && formattedExamMeta) {
        return {
          ...markingSource,
          label: formattedExamMeta,
          shortLabel: compactExamMeta || formattedExamMeta
        };
      }
      return {
        ...markingSource,
        shortLabel: markingSource.fileName || markingSource.label || ''
      };
    }
    if (examInfo?.isModified) {
      return {
        type: 'modified' as const,
        label: formattedExamMeta || 'Official Scheme',
        shortLabel: compactExamMeta || 'Official Scheme'
      };
    }
    if (
      examInfo?.examBoard &&
      !/^(unknown|n\/a)$/i.test(examInfo.examBoard) &&
      cleanCode &&
      !/^(generic question|unknown|n\/a)$/i.test(cleanCode)
    ) {
      return {
        type: 'official' as const,
        label: `${formattedExamMeta}${seriesStr}`.trim(),
        shortLabel: compactExamMeta || formattedExamMeta
      };
    }
    return {
      type: 'general' as const,
      label: 'General Mark Scheme',
      shortLabel: 'General Scheme'
    };
  })();

  // Compute Next Grade Gap for full papers (replaces duplicate Grade Achieved / Predicted Grade boxes)
  const nextGradeTarget = (() => {
    if (!isPastPaperWithBoundaries || isPartialPaper) return null;
    const higherBoundaries = sortedBoundariesDesc.filter(b => b.mark > score.awardedMarks);
    if (higherBoundaries.length === 0) {
      return { isTopGrade: true, marksNeeded: 0, nextGrade: sortedBoundariesDesc[0]?.grade || '' };
    }
    const closestHigher = higherBoundaries[higherBoundaries.length - 1];
    return {
      isTopGrade: false,
      marksNeeded: closestHigher.mark - score.awardedMarks,
      nextGrade: closestHigher.grade
    };
  })();

  // Filter out filler Focus Next on 100% scores
  const visibleFocusNext = isFullMarksOverall ? [] : (focusNext || []);

  let proratedGradeStr: string | null = null;
  if (isPartialPaper) {
    const fullPaperMax = maxBoundaryMark > 45 ? 80 : 100;
    const proratedMark = Math.round((score.percentage / 100) * fullPaperMax);
    const matchedBoundary = sortedBoundariesDesc.find(b => proratedMark >= b.mark);
    if (matchedBoundary) {
      proratedGradeStr = `Grade ${matchedBoundary.grade}`;
    }
  }

  const rawGradeAchieved = grading?.grade || 'N/A';
  const rawPredictedGrade = grading?.predictedGrade || 'N/A';

  const gradeAchieved = isPartialPaper
    ? 'Partial Paper'
    : (rawGradeAchieved || 'N/A');

  const predictedGrade = isPartialPaper
    ? (proratedGradeStr ? `~${proratedGradeStr}` : (rawPredictedGrade && rawPredictedGrade !== 'N/A' && rawPredictedGrade.startsWith('~') ? rawPredictedGrade : 'N/A'))
    : (rawPredictedGrade || 'N/A');

  const hasAchievedGrade = gradeAchieved !== 'N/A' && gradeAchieved !== 'Partial Paper';

  const formatSummaryQuestionChip = (qStr: string): string => {
    const clean = String(qStr).replace(/^Q/i, '').trim();
    const multiMatch = clean.match(/^(P\d+)[·.\-]Q?(.+)$/i);
    if (multiMatch) {
      return `${multiMatch[1].toUpperCase()}.Q${multiMatch[2]}`;
    }
    return `Q${clean}`;
  };

  const scrollToCoachingCard = (qNum: string) => {
    const clean = String(qNum).replace(/^Q/i, '');
    const el = document.getElementById(`coaching-card-q${clean}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const boundaryProvenanceText = (() => {
    if (!isPastPaperWithBoundaries) return '';
    if (grading?.boundariesSource === 'estimated') {
      const seriesLabel = examInfo?.examSeries ? `${examInfo.examSeries} ` : '';
      return `Estimated boundaries (official ${seriesLabel}boundaries not yet published)`;
    }
    const sourceMeta = [examInfo?.examBoard, examInfo?.examSeries].filter(Boolean).join(' ');
    return sourceMeta ? `Source: Official ${sourceMeta} Grade Boundaries` : 'Source: Official Grade Boundaries';
  })();

  const sourceLabelText =
    resolvedSource.type === 'official'
      ? 'Marked with Official Mark Scheme'
      : resolvedSource.type === 'user_uploaded'
        ? 'Marked with Your Mark Scheme'
        : resolvedSource.type === 'modified'
          ? 'Marked with Official Scheme (Modified)'
          : 'Marked with General Mark Scheme';

  const schemeChipCode =
    resolvedSource.type === 'user_uploaded'
      ? (resolvedSource.fileName || resolvedSource.shortLabel || '')
      : resolvedSource.type === 'general'
        ? ''
        : (resolvedSource.shortLabel || '');

  const showSchemeChip = Boolean(schemeChipCode) || schemeQuestions.length > 0;

  const headerBadgeTooltip =
    resolvedSource.type === 'official'
      ? `Marked against Official Mark Scheme: ${resolvedSource.label}${schemeQuestions.length > 0 ? ' — Click to view scheme' : ''}`
      : resolvedSource.type === 'user_uploaded'
        ? `Marked using your uploaded mark scheme: ${resolvedSource.fileName || resolvedSource.label}${schemeQuestions.length > 0 ? ' — Click to view scheme' : ''}`
        : resolvedSource.type === 'modified'
          ? `Marked against official scheme adapted for modified questions (${resolvedSource.label})`
          : 'Marked with AI General Mark Scheme';

  return (
    <div className={`tmua-summary-card tier-${summaryTier}`}>
      {/* Single-Line Split Header (desktop/split) / Clean 2-Line Stack (mobile ≤480px) */}
      <div className="tmua-summary-header">
        <div className="tmua-summary-title">
          <Sparkles size={15} className="tmua-sparkle-icon" />
          <span className="summary-title-desktop">AI PERFORMANCE SUMMARY</span>
          <span className="summary-title-compact">SUMMARY</span>
        </div>

        <div className="tmua-header-provenance">
          <span
            className={`tmua-source-label source-${resolvedSource.type}`}
            title={headerBadgeTooltip}
          >
            {resolvedSource.type === 'user_uploaded'
              ? <FileCheck2 size={13} className="tmua-source-icon" />
              : resolvedSource.type !== 'general'
                ? <ShieldCheck size={13} className="tmua-source-icon" />
                : null}
            <span className="tmua-source-label-text">{sourceLabelText}</span>
          </span>

          {showSchemeChip && (
            schemeQuestions.length > 0 ? (
              <button
                type="button"
                className="tmua-scheme-chip clickable"
                onClick={() => {
                  engagementTracker.recordMarkSchemeModalOpen();
                  setShowSchemeModal(true);
                }}
                title={headerBadgeTooltip}
                aria-label={`View mark scheme${schemeChipCode ? ` for ${schemeChipCode}` : ''}`}
              >
                <span className="tmua-scheme-chip-code">{schemeChipCode || 'Breakdown'}</span>
                <ChevronRight size={12} className="tmua-scheme-chip-chevron" />
              </button>
            ) : (
              <span className="tmua-scheme-chip" title={headerBadgeTooltip}>
                <span className="tmua-scheme-chip-code">{schemeChipCode}</span>
              </span>
            )
          )}
        </div>
      </div>

      {/* Multi-Paper / Multi-Subject Switcher Pill Bar */}
      {summaryTabs.length > 1 && (
        <div
          className="tmua-paper-switcher"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            marginBottom: '12px'
          }}
        >
          {summaryTabs.map((tab, idx) => {
            const isTabActive = idx === selectedPaperTab;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => setSelectedPaperTab(idx)}
                className={`tmua-pill ${isTabActive ? 'strong' : ''}`}
                style={{
                  cursor: 'pointer',
                  border: isTabActive ? '1px solid var(--primary-color, #3b82f6)' : '1px solid rgba(148, 163, 184, 0.3)',
                  fontWeight: isTabActive ? 600 : 500,
                  padding: '5px 12px'
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      {tooDenseWarning && (
        <div className="tmua-warning-banner">
          <AlertTriangle size={15} />
          <span>Some dense pages required manual review and were skipped.</span>
        </div>
      )}

      {/* Main Body: 2-Column only when Radar has >=3 real assessed axes; otherwise full-width clean layout */}
      <div className={`tmua-summary-grid ${showRadarChart ? '' : 'single-column'}`}>
        <div className="tmua-left-col">
          {/* Hero Metric, Progress Bar & Official Past Paper Grade Boundary Table */}
          <div className="tmua-hero-box">
            <div className="tmua-hero-top">
              <div className="tmua-hero-score-group">
                <span
                  className="tmua-hero-Raw tmua-score-fraction"
                  aria-label={`${score.awardedMarks} out of ${score.totalMarks} marks`}
                >
                  <span className="tmua-fraction-num">{score.awardedMarks}</span>
                  <span className="tmua-fraction-bar" aria-hidden="true" />
                  <span className="tmua-fraction-den">{score.totalMarks}</span>
                </span>
                <span className="tmua-hero-pct">{score.percentage}%</span>
              </div>
              <div className="tmua-hero-badges">
                {isFullMarksOverall && !isPastPaperWithBoundaries && (
                  <span className="tmua-full-marks-pill">
                    <CheckCircle2 size={13} />
                    <span>Full Marks</span>
                  </span>
                )}
                {isPastPaperWithBoundaries && (
                  <div className={`tmua-grade-badge ${!hasAchievedGrade ? 'na' : ''}`}>
                    {gradeAchieved === 'Partial Paper' ? (
                      <span className="tmua-grade-fallback">
                        <span className="pill-text-desktop">Partial Paper</span>
                        <span className="pill-text-mobile">Partial</span>
                      </span>
                    ) : (
                      <>
                        <span className="tmua-grade-label">Grade</span>
                        <span className="tmua-grade-value">{gradeAchieved}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {headline && <p className="tmua-headline-text">{headline}</p>}

            {/* Linear Progress Bar */}
            <div className="tmua-track-container">
              <div className="tmua-track-bar">
                <div
                  className="tmua-track-fill"
                  style={{ width: `${Math.min(100, Math.max(0, score.percentage))}%` }}
                />
                <div
                  className="tmua-track-thumb"
                  style={{ left: `${Math.min(100, Math.max(0, score.percentage))}%` }}
                  title={`${score.awardedMarks}/${score.totalMarks} (${score.percentage}%)`}
                />
              </div>
              {summaryTier !== 'compact' && (
                <div className="tmua-Scale-labels">
                  <span>0%</span>
                  <span>25%</span>
                  <span>50%</span>
                  <span>75%</span>
                  <span>100%</span>
                </div>
              )}
            </div>

            {/* Official Past Paper Grade Boundary Table (shown on Full tier / full papers with boundaries) */}
            {isPastPaperWithBoundaries && summaryTier === 'full' && (
              <div className="tmua-grade-table-wrapper">
                <table className="tmua-grade-table">
                  <tbody>
                    <tr>
                      <th>Grade</th>
                      {sortedBoundariesDesc.map((b) => {
                        const isMatch = hasAchievedGrade && String(gradeAchieved) === String(b.grade);
                        return (
                          <td key={b.grade} className={isMatch ? 'highlighted-grade' : ''}>
                            {b.grade}
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <th>Mark Required</th>
                      {sortedBoundariesDesc.map((b) => {
                        const isMatch = hasAchievedGrade && String(gradeAchieved) === String(b.grade);
                        return (
                          <td key={b.grade} className={isMatch ? 'highlighted-grade' : ''}>
                            {b.mark}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
                {boundaryProvenanceText && (
                  <div className={`tmua-boundary-caption ${grading?.boundariesSource === 'estimated' ? 'estimated' : 'official'}`}>
                    {boundaryProvenanceText}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Standard Tier (2-5 Qs): Compact clickable Question Score Pills */}
          {summaryTier === 'standard' && Array.isArray(questionBreakdown) && questionBreakdown.length > 1 && (
            <div className="tmua-question-pills-row">
              {questionBreakdown.map((qb, idx) => {
                const isFull = qb.total > 0 && qb.awarded >= qb.total;
                const isZero = qb.total > 0 && qb.awarded === 0;
                return (
                  <button
                    key={idx}
                    type="button"
                    className={`tmua-q-pill ${isFull ? 'full' : isZero ? 'zero' : 'partial'}`}
                    onClick={() => {
                      const cleanQ = String(qb.q).replace(/^Q/i, '');
                      setExpandedQuestionKey(String(qb.q));
                      onQuestionClick?.(cleanQ);
                      scrollToCoachingCard(cleanQ);
                    }}
                    title={`Jump to Q${qb.q}`}
                  >
                    <span className="q-pill-num">{formatSummaryQuestionChip(qb.q)}</span>
                    <span className="q-pill-score">{qb.awarded}/{qb.total}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Full Tier KPI Row: 3 distinct, non-duplicate stats (no more 4x repeated Grade!) */}
          {summaryTier === 'full' && (
            <div className="tmua-stat-pills-row">
              <div className="tmua-stat-card">
                <div className="tmua-stat-value">
                  <span
                    className="tmua-stat-fraction"
                    aria-label={`${score.questionsFullMarks} out of ${score.questionsTotal}`}
                  >
                    <span className="tmua-stat-fraction-num">{score.questionsFullMarks}</span>
                    <span className="tmua-stat-fraction-bar" aria-hidden="true" />
                    <span className="tmua-stat-fraction-den">{score.questionsTotal}</span>
                  </span>
                </div>
                <div className="tmua-stat-label">Full marks questions</div>
              </div>

              {nextGradeTarget ? (
                <div className="tmua-stat-card">
                  <div className="tmua-stat-value">
                    {nextGradeTarget.isTopGrade ? 'Top' : `+${nextGradeTarget.marksNeeded}`}
                  </div>
                  <div className="tmua-stat-label">
                    {nextGradeTarget.isTopGrade
                      ? 'Highest grade band'
                      : `Marks to Grade ${nextGradeTarget.nextGrade}`}
                  </div>
                </div>
              ) : isPartialPaper && predictedGrade !== 'N/A' ? (
                <div className="tmua-stat-card">
                  <div className="tmua-stat-value">{predictedGrade}</div>
                  <div className="tmua-stat-label">Predicted Grade</div>
                </div>
              ) : (
                <div className="tmua-stat-card">
                  <div className="tmua-stat-value">
                    <span
                      className="tmua-stat-fraction"
                      aria-label={`${score.questionsAttempted} out of ${score.questionsTotal}`}
                    >
                      <span className="tmua-stat-fraction-num">{score.questionsAttempted}</span>
                      <span className="tmua-stat-fraction-bar" aria-hidden="true" />
                      <span className="tmua-stat-fraction-den">{score.questionsTotal}</span>
                    </span>
                  </div>
                  <div className="tmua-stat-label">Questions attempted</div>
                </div>
              )}

              {showHandwritingCard && handwriting ? (
                hasHandwritingDetails ? (
                  <button
                    type="button"
                    className={`tmua-stat-card tmua-stat-card-clickable rating-${handwriting.rating} ${isHandwritingExpanded ? 'expanded' : ''}`}
                    onClick={toggleHandwritingPanel}
                    aria-expanded={isHandwritingExpanded}
                    title={handwriting.tip || 'Click to view handwriting clarity details'}
                  >
                    <div className={`tmua-stat-value rating-${handwriting.rating}`}>
                      {handwriting.label}
                    </div>
                    <div className="tmua-stat-label">Handwriting clarity</div>
                    <div className="tmua-stat-action-cue">
                      <span>
                        {handwritingIssues.length > 0
                          ? `${handwritingIssues.length} ${handwritingIssues.length === 1 ? 'note' : 'notes'}`
                          : 'View tip'}
                      </span>
                      {isHandwritingExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </div>
                  </button>
                ) : (
                  <div
                    className={`tmua-stat-card rating-${handwriting.rating}`}
                    title={handwriting.tip || 'Clean, legible handwriting'}
                  >
                    <div className={`tmua-stat-value rating-${handwriting.rating}`}>
                      {handwriting.label}
                    </div>
                    <div className="tmua-stat-label">Handwriting clarity</div>
                  </div>
                )
              ) : (
                <div className="tmua-stat-card">
                  <div className="tmua-stat-value">
                    {score.questionsAttempted < score.questionsTotal
                      ? `${score.questionsTotal - score.questionsAttempted}`
                      : `${score.percentage}%`}
                  </div>
                  <div className="tmua-stat-label">
                    {score.questionsAttempted < score.questionsTotal ? 'Unattempted' : 'Overall accuracy'}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Compact / Standard Tier Handwriting Strip (shown only when rating is not Clear) */}
          {summaryTier !== 'full' && hasHandwritingDetails && handwriting && (
            <button
              type="button"
              className={`tmua-handwriting-strip rating-${handwriting.rating} ${isHandwritingExpanded ? 'expanded' : ''}`}
              onClick={toggleHandwritingPanel}
              aria-expanded={isHandwritingExpanded}
            >
              <span className="tmua-hw-strip-left">
                <Pencil size={13} />
                <span className="tmua-hw-strip-title">Handwriting: {handwriting.label}</span>
                {handwriting.tip && <span className="tmua-hw-strip-tip">— {handwriting.tip}</span>}
              </span>
              <span className="tmua-hw-strip-toggle">
                {isHandwritingExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </span>
            </button>
          )}

          {/* Expandable Handwriting Details Drawer (Option A) */}
          {isHandwritingExpanded && hasHandwritingDetails && handwriting && (
            <div className={`tmua-handwriting-drawer rating-${handwriting.rating}`}>
              <div className="tmua-hw-drawer-header">
                <div className="tmua-hw-drawer-title">
                  <Pencil size={13} />
                  <span>Handwriting Review</span>
                  <span className={`tmua-hw-rating-pill rating-${handwriting.rating}`}>
                    {handwriting.label}
                  </span>
                </div>
                {handwriting.tip && (
                  <p className="tmua-hw-drawer-tip">{handwriting.tip}</p>
                )}
              </div>

              {handwritingIssues.length > 0 && (
                <div className="tmua-hw-issue-list">
                  {handwritingIssues.map((issue, idx) => {
                    const cleanMainQ = String(issue.q).replace(/^Q/i, '').trim();
                    const displayQ = String(issue.subQ || issue.q).replace(/^Q/i, '').trim();
                    const hasMismatch = Boolean(
                      issue.intendedText &&
                      issue.ocrText &&
                      issue.intendedText.trim().toLowerCase() !== issue.ocrText.trim().toLowerCase()
                    );
                    return (
                      <div key={idx} className="tmua-hw-issue-item">
                        <div className="tmua-hw-issue-top">
                          <span className="tmua-hw-issue-q">{formatSummaryQuestionChip(displayQ)}</span>
                          <button
                            type="button"
                            className="tmua-hw-jump-btn"
                            onClick={() => {
                              engagementTracker.recordHandwritingQuestionJump();
                              setExpandedQuestionKey(cleanMainQ);
                              onQuestionClick?.(cleanMainQ, issue.pageIndex);
                              scrollToCoachingCard(cleanMainQ);
                            }}
                          >
                            <span>View on paper</span>
                            <ArrowRight size={11} />
                          </button>
                        </div>

                        {hasMismatch ? (
                          <div className="tmua-hw-mismatch-row">
                            <span className="tmua-hw-ocr-label">Looked like</span>
                            <code className="tmua-hw-code ocr">{issue.ocrText}</code>
                            <span className="tmua-hw-arrow">→</span>
                            <span className="tmua-hw-ocr-label">Intended</span>
                            <code className="tmua-hw-code intended">{issue.intendedText}</code>
                          </div>
                        ) : issue.ocrText ? (
                          <div className="tmua-hw-mismatch-row">
                            <span className="tmua-hw-ocr-label">Hard to read</span>
                            <code className="tmua-hw-code ocr">{issue.ocrText}</code>
                          </div>
                        ) : null}

                        {issue.note && (
                          <div className="tmua-hw-issue-note">{issue.note}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Actionable "Marks to Recover" (hidden on Compact 1-Q tier & 100% scores) + lightweight Strengths on Full tier */}
          {summaryTier !== 'compact' && (visibleFocusNext.length > 0 || (summaryTier === 'full' && mastered.length > 0)) && (
            <div className="tmua-insights-box">
              {visibleFocusNext.length > 0 && (
                <div className="tmua-insight-row">
                  <div className="tmua-insight-heading focus">
                    <Target size={14} />
                    <span>Marks to Recover</span>
                  </div>
                  <div className="tmua-insight-chips">
                    {visibleFocusNext.map((f, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="tmua-insight-chip focus"
                        onClick={() => {
                          if (f.q) {
                            const cleanQ = String(f.q).replace(/^Q/i, '');
                            setExpandedQuestionKey(String(f.q));
                            onQuestionClick?.(cleanQ);
                            scrollToCoachingCard(cleanQ);
                          }
                        }}
                        title={f.q ? `Jump to ${formatSummaryQuestionChip(String(f.q))}` : undefined}
                      >
                        {f.q && <span className="chip-q">{formatSummaryQuestionChip(String(f.q))}</span>}
                        {typeof f.marksLost === 'number' && f.marksLost > 0 && (
                          <span className="chip-lost">-{f.marksLost}</span>
                        )}
                        <span>{f.text}</span>
                        {f.q && <ArrowRight size={12} className="chip-arrow" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {summaryTier === 'full' && mastered.length > 0 && (
                <div className="tmua-insight-row compact-strengths">
                  <div className="tmua-insight-heading mastered">
                    <CheckCircle2 size={14} />
                    <span>Strengths</span>
                  </div>
                  <div className="tmua-insight-chips">
                    {mastered.map((m, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="tmua-insight-chip mastered"
                        onClick={() => {
                          if (m.q) {
                            const cleanQ = String(m.q).replace(/^Q/i, '');
                            setExpandedQuestionKey(String(m.q));
                            onQuestionClick?.(cleanQ);
                            scrollToCoachingCard(cleanQ);
                          }
                        }}
                      >
                        {m.q && <span className="chip-q">{formatSummaryQuestionChip(String(m.q))}</span>}
                        <span>{m.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT COLUMN (~35%): Radar Chart (only rendered when >=3 axes are truly assessed) */}
        {showRadarChart && (
          <div className="tmua-right-col">
            <TopicRadarChart data={radar} />
          </div>
        )}
      </div>

      {/* 1-Click View Mark Scheme Modal (Instant, Zero-LLM-Cost Proof) */}
      {showSchemeModal && (
        <div
          className="tmua-scheme-modal-backdrop"
          onClick={() => setShowSchemeModal(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Mark Scheme Used"
        >
          <div className="tmua-scheme-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tmua-scheme-modal-header">
              <div className="tmua-scheme-modal-title">
                <BookOpen size={16} />
                <span>Mark Scheme Used</span>
                <span className={`tmua-source-badge source-${resolvedSource.type}`}>
                  {resolvedSource.label || 'Official Mark Scheme'}
                </span>
              </div>
              <button
                type="button"
                className="tmua-scheme-modal-close"
                onClick={() => setShowSchemeModal(false)}
                aria-label="Close mark scheme modal"
              >
                <X size={16} />
              </button>
            </div>
            {schemeQuestions.length >= 2 && (() => {
              const breakdownMap = new Map<string, { awarded: number; total: number }>();
              (questionBreakdown || []).forEach(qb => {
                const key = String(qb.q || '').replace(/^Q/i, '').trim().toLowerCase();
                if (key) breakdownMap.set(key, { awarded: Number(qb.awarded) || 0, total: Number(qb.total) || 0 });
              });
              (markingContext?.questionResults || []).forEach((qr: any, idx: number) => {
                const key = String(qr.number ?? qr.questionNumber ?? idx + 1).replace(/^Q/i, '').trim().toLowerCase();
                if (key && !breakdownMap.has(key)) {
                  breakdownMap.set(key, {
                    awarded: Number(qr.earnedMarks ?? qr.score?.awardedMarks ?? qr.marks ?? 0),
                    total: Number(qr.totalMarks ?? qr.score?.totalMarks ?? 0)
                  });
                }
              });

              const resolvedRows = schemeQuestions.map(sq => {
                const key = String(sq.q || '').replace(/^Q/i, '').trim().toLowerCase();
                const fallback = breakdownMap.get(key);
                const max = (typeof sq.marks === 'number' && sq.marks > 0) ? sq.marks : (fallback?.total ?? 0);
                const awarded = typeof sq.awarded === 'number' ? sq.awarded : fallback?.awarded;
                return { max, awarded };
              });
              const hasScoredRow = resolvedRows.some(r => typeof r.awarded === 'number');
              const sumMax = resolvedRows.reduce((acc, r) => acc + r.max, 0);
              const maxTotalMarks = sumMax > 0 ? sumMax : (score.totalMarks || 0);
              const sumAwarded = resolvedRows.reduce((acc, r) => acc + (typeof r.awarded === 'number' ? r.awarded : 0), 0);
              const totalAwardedMarks = hasScoredRow ? (sumAwarded || score.awardedMarks || 0) : 0;

              return (
                <div className="tmua-scheme-overview-bar">
                  <div className="tmua-scheme-overview-wrapper">
                    <table className="tmua-scheme-overview-table">
                      <tbody>
                        <tr>
                          <th>Question</th>
                          {schemeQuestions.map((sq, idx) => (
                            <td key={idx}>
                              {hasSchemeCriteria ? (
                                <button
                                  type="button"
                                  className="tmua-scheme-jump-btn"
                                  onClick={() => {
                                    const el = document.getElementById(`scheme-modal-q-${idx}`);
                                    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                  }}
                                  title={`Jump to ${formatSummaryQuestionChip(sq.q)}`}
                                >
                                  {formatSummaryQuestionChip(sq.q)}
                                </button>
                              ) : (
                                <span className="tmua-scheme-q-cell">{formatSummaryQuestionChip(sq.q)}</span>
                              )}
                            </td>
                          ))}
                          <td className="tmua-scheme-total-col">Total</td>
                        </tr>
                        {hasScoredRow && (
                          <tr>
                            <th>Scored</th>
                            {resolvedRows.map((r, idx) => {
                              const hasVal = typeof r.awarded === 'number';
                              const scoreClass = !hasVal || r.max <= 0
                                ? ''
                                : r.awarded! >= r.max
                                  ? 'tmua-scheme-score-full'
                                  : r.awarded! === 0
                                    ? 'tmua-scheme-score-zero'
                                    : 'tmua-scheme-score-partial';
                              return (
                                <td key={idx} className={scoreClass}>
                                  {hasVal ? r.awarded : '–'}
                                </td>
                              );
                            })}
                            <td className="tmua-scheme-total-col">{totalAwardedMarks}</td>
                          </tr>
                        )}
                        <tr>
                          <th>{hasScoredRow ? 'Max' : 'Marks'}</th>
                          {resolvedRows.map((r, idx) => (
                            <td key={idx} className={hasScoredRow ? 'tmua-scheme-max-cell' : undefined}>
                              {r.max > 0 ? r.max : '–'}
                            </td>
                          ))}
                          <td className="tmua-scheme-total-col">{maxTotalMarks > 0 ? maxTotalMarks : '–'}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
            <div className="tmua-scheme-modal-body">
              {!hasSchemeCriteria ? (
                <div className="tmua-scheme-general-note">
                  Marked using the AI General Mark Scheme — no official or custom mark scheme was attached for this paper. Attach an official past paper or upload a mark scheme to inspect exact mark points and level descriptors.
                </div>
              ) : schemeQuestions.map((sq, idx) => (
                <div key={idx} id={`scheme-modal-q-${idx}`} className="tmua-scheme-item">
                  <div className="tmua-scheme-item-header">
                    <span className="tmua-scheme-q-label">
                      {formatSummaryQuestionChip(sq.q)}
                    </span>
                    {typeof sq.marks === 'number' && sq.marks > 0 && (
                      <span className="tmua-scheme-q-marks">
                        {sq.marks} {sq.marks === 1 ? 'mark' : 'marks'}
                      </span>
                    )}
                  </div>
                  <div className="tmua-scheme-item-content">
                    {(() => {
                      const blocks = parseMarkSchemeBlocks(sq.scheme);
                      const hasStructuredPoints = blocks.some(b => b.kind === 'point' || b.kind === 'subpart' || b.kind === 'section');
                      if (!hasStructuredPoints) {
                        return (
                          <MarkdownMathRenderer
                            content={sq.scheme}
                            className="chat-message-renderer"
                            options={{ throwOnError: false, errorColor: '#cc0000' }}
                          />
                        );
                      }
                      return (
                        <div className="tmua-scheme-points-list">
                          {blocks.map((block, bIdx) => {
                            if (block.kind === 'subpart') {
                              return (
                                <div key={bIdx} className="tmua-scheme-subpart-header">
                                  <span>{block.label}</span>
                                  {block.marks && <span className="tmua-scheme-subpart-marks">{block.marks}</span>}
                                </div>
                              );
                            }
                            if (block.kind === 'section') {
                              return (
                                <div key={bIdx} className="tmua-scheme-subpart-header" style={{ fontSize: '0.72rem', opacity: 0.85, marginTop: '6px' }}>
                                  <span>{block.label}</span>
                                </div>
                              );
                            }
                            if (block.kind === 'point') {
                              return (
                                <div key={bIdx} className="tmua-scheme-point-row">
                                  <div className="tmua-scheme-point-body">
                                    <MarkdownMathRenderer
                                      content={block.body}
                                      className="chat-message-renderer"
                                      options={{ throwOnError: false, errorColor: '#cc0000' }}
                                    />
                                  </div>
                                  <span className="tmua-scheme-point-code">{block.code}</span>
                                </div>
                              );
                            }
                            return (
                              <div key={bIdx} className="tmua-scheme-text-block">
                                <MarkdownMathRenderer
                                  content={block.body}
                                  className="chat-message-renderer"
                                  options={{ throwOnError: false, errorColor: '#cc0000' }}
                                />
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 3-Part Examiner Coaching Block for Level-of-Response Questions */}
      {questionCoaching && questionCoaching.length > 0 && (
        <div className="tmua-coaching-section">
          <div className="tmua-section-label">
            EXAMINER LEVEL &amp; GRADE-BOOSTING COACHING
          </div>
          {questionCoaching.map((qc, idx) => {
            const cardKey = String(qc.q || idx);
            const isCardExpanded = expandedQuestionKey === cardKey;
            const cleanQ = String(qc.q).replace(/^Q/i, '');
            const cardId = `coaching-card-q${cleanQ}`;
            const scoreColor = getStampScoreColor(qc.awardedMarks, qc.maxMarks);

            const handleCardHeaderClick = () => {
              if (isCardExpanded) {
                setExpandedQuestionKey(null);
              } else {
                setExpandedQuestionKey(cardKey);
                onQuestionClick?.(cleanQ);
                scrollToCoachingCard(cleanQ);
              }
            };

            const previewText = getCardPreviewText(qc, focusNext);

            return (
              <div
                key={idx}
                id={cardId}
                className={`coaching-card ${isCardExpanded ? 'expanded' : ''}`}
              >
                <div
                  className="coaching-card-header"
                  onClick={handleCardHeaderClick}
                >
                  <div className="coaching-card-header-left">
                    {isCardExpanded ? (
                      <ChevronUp size={16} className="coaching-card-chevron" />
                    ) : (
                      <ChevronDown size={16} className="coaching-card-chevron" />
                    )}
                    <span className="coaching-card-q-title">
                      {/^P\d+[·.\-]/i.test(String(qc.q || ''))
                        ? formatSummaryQuestionChip(String(qc.q))
                        : `Question ${qc.q}`}
                    </span>
                    {!isCardExpanded && (
                      <span className="coaching-card-preview" title={previewText}>
                        — {previewText}
                      </span>
                    )}
                  </div>
                  <span className={`coaching-stamp-badge score-${scoreColor}`}>
                    <span className="badge-text-desktop">
                      {formatRubricBadge(qc.rubricStamp, qc.awardedMarks, qc.maxMarks, false)}
                    </span>
                    <span className="badge-text-mobile">
                      {formatRubricBadge(qc.rubricStamp, qc.awardedMarks, qc.maxMarks, true)}
                    </span>
                  </span>
                </div>

                {isCardExpanded && (
                  <div className="coaching-card-body">
                    {/* 2-Column Grid */}
                    <div className="coaching-grid">
                      {/* Left Box (✅ What Worked) */}
                      <div className="coaching-box coaching-what-worked">
                        <div className="coaching-box-header what-worked">
                          <span>✅</span>
                          <span>What Worked</span>
                        </div>
                        {qc.coaching?.rationale ? (
                          <ul className="coaching-bullet-list">
                            {parseCoachingBullets(qc.coaching.rationale).map((bullet, bIdx) => (
                              <li key={bIdx}>
                                {renderBoldText(bullet)}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="coaching-empty-note">No rationale provided.</span>
                        )}
                      </div>

                      {/* Right Box (🎯 How to Reach Next Level) */}
                      <div className="coaching-box coaching-next-level">
                        <div className="coaching-box-header next-level">
                          <span>🎯</span>
                          <span>How to Reach Next Level</span>
                        </div>
                        {qc.coaching?.nextLevelGap ? (
                          <ul className="coaching-bullet-list">
                            {parseCoachingBullets(qc.coaching.nextLevelGap).map((bullet, bIdx) => (
                              <li key={bIdx}>
                                {renderBoldText(bullet)}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="coaching-empty-note">Full marks achieved.</span>
                        )}
                      </div>
                    </div>

                    {/* Compact Grade 9 Upgrade Rewrite Box */}
                    {qc.coaching?.upgradeRewrite?.originalQuote &&
                      qc.coaching?.upgradeRewrite?.upgradedVersion &&
                      (qc.maxMarks ? qc.maxMarks > 4 : true) && (
                        <div className="coaching-rewrite-box">
                          <div className="coaching-rewrite-title">
                            Grade 9 Analytical Upgrade Rewrite
                          </div>
                          <div>
                            <span className="coaching-rewrite-label user-line">Your Line: </span>
                            <em className="coaching-rewrite-quote">&ldquo;{qc.coaching.upgradeRewrite.originalQuote}&rdquo;</em>
                          </div>
                          <div>
                            <span className="coaching-rewrite-label upgrade">Grade 9 Upgrade: </span>
                            <span>
                              &ldquo;{renderBoldText(qc.coaching.upgradeRewrite.upgradedVersion, true)}&rdquo;
                            </span>
                          </div>
                          {qc.coaching.upgradeRewrite.explanation && (
                            <div className="coaching-rewrite-explanation">
                              💡 <strong>Why this scores higher: </strong>
                              <span>{qc.coaching.upgradeRewrite.explanation}</span>
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PerformanceSummaryPanel;
