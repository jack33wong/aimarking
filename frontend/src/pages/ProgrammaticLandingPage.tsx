import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Loader2, Upload } from 'lucide-react';
import LandingPageHeader from '../components/layout/LandingPageHeader';
import HeroAnimation from '../components/layout/HeroAnimation';
import LandingFooter from '../components/layout/LandingFooter';
import SeoHeader from '../components/common/SeoHeader';
import { trackPaperInteraction } from '../utils/analytics';
import { saveLandingExamContext } from '../utils/landingContext';
import './AqaLandingPage.css';
import './PastPaperTable.css';

interface CatalogPaper {
    id: string;
    qualification: string;
    board: string;
    subject: string;
    code: string;
    name: string;
    series: string;
    tier: string;
    tierCode: string;
    type: string;
}

interface ExamPreset {
    highlightText: string;
    heroSuffix: string;
    board: string;
    qualification: string;
    defaultSubject: string;
    subtitle: string;
    trustMicrocopy: string;
    badgeOverlay: string;
    feature1Image?: string;
    feature1Alt?: string;
    feature1Title: string;
    feature1Body: string;
    feature2Image?: string;
    feature2Alt?: string;
    feature2Title: string;
    feature2Body: string;
    tutorQuestion: string;
    tutorAnswer: string;
    tutorTitle: string;
    tutorBody: string;
    accentColor: string;
    filterFn: (p: CatalogPaper) => boolean;
}

const EXAM_PRESETS: Record<string, ExamPreset> = {
    'cambridge-igcse': {
        highlightText: 'Cambridge IGCSE',
        heroSuffix: '& O Level Papers',
        board: 'CIE',
        qualification: 'IGCSE',
        defaultSubject: 'Mathematics',
        subtitle:
            'Stop staring at confusing Cambridge mark schemes. Scan your handwritten IGCSE (0580, 0610, 0620, 0625) or Edexcel International GCSE (4MA1) papers and let our AI grade every step like a real examiner.',
        trustMicrocopy:
            'Supports Cambridge (CIE) & Edexcel IGCSE (Extended/Core & 9–1 / A*–G). Mark scheme pages never count toward your limit.',
        badgeOverlay: 'CIE 0610 IGCSE Biology Marking',
        feature1Image: '/images/igcse_biology_marking.jpg',
        feature1Alt: 'Cambridge IGCSE Biology 0610/41 diagram marking with B0 and B1 annotations',
        feature1Title: 'Marks Diagrams, Equations & Structured Answers',
        feature1Body:
            'Cambridge IGCSE papers test everything from Biology diagrams (B1) to Maths method steps (M1/A1) and structured Science explanations. Our AI reads your handwritten answers line-by-line across Extended and Core papers so you see every mark earned or missed.',
        feature2Image: '/images/igcse_mobile_explanation.jpg',
        feature2Alt: 'Cambridge IGCSE Biology Q1 AI Explanation and step-by-step feedback on mobile',
        feature2Title: 'Stuck on a Hard Question?',
        feature2Body:
            'See exactly where marks were dropped and how to build a full-mark response — with clear AI explanations and examiner-ready model answers tailored to Cambridge 0580, 0610, 0620, 0625 and Edexcel 4MA1 past papers.',
        tutorQuestion: 'Why did I only get 2/4 on CIE 0580/42 Question 7?',
        tutorAnswer:
            'You earned M1 for setting up the quadratic equation and M1 for factorising, but lost A1 for omitting the second root and A1 for rounding before the final step.',
        tutorTitle: 'Your 24/7 Personal IGCSE Tutor',
        tutorBody:
            "Don't just look at a red 'X'. Chat directly with our AI to understand why you dropped a mark, get a simpler explanation of the Cambridge mark scheme, and confidently tackle the next paper.",
        accentColor: '#004B98',
        filterFn: (p) => p.qualification === 'IGCSE' || p.qualification === 'O Level'
    },
    'cambridge-o-level': {
        highlightText: 'Cambridge O Level',
        heroSuffix: 'Past Papers',
        board: 'CIE',
        qualification: 'O Level',
        defaultSubject: 'Mathematics',
        subtitle:
            'Scan your handwritten Cambridge O Level past papers (4024, 5054, 5070, 5090, 1123) together with official mark schemes for instant examiner-level marking and feedback.',
        trustMicrocopy:
            'Supports Cambridge O Level (A*–E scale & paper variants). Mark scheme pages never count toward your limit.',
        badgeOverlay: 'Cambridge O Level Logic Check',
        feature1Title: 'Line-by-Line Handwritten Marking',
        feature1Body:
            'Our AI reads handwritten algebra, geometry proofs, diagrams, and structured science responses against official Cambridge O Level mark schemes to award exact method and accuracy marks.',
        feature2Title: 'Examiner-Quality Model Solutions',
        feature2Body:
            'Turn any difficult O Level question into a clean, step-by-step model solution showing the exact working steps examiners expect.',
        tutorQuestion: 'How can I secure full marks on this 4024 Paper 2 question?',
        tutorAnswer:
            'Show the intermediate substitution step explicitly for the M1 method mark, and give your final answer to 3 significant figures as required by the rubric.',
        tutorTitle: 'Your 24/7 Personal O Level Tutor',
        tutorBody:
            'Ask follow-up questions on any step you missed, get clearer explanations of tricky syllabus topics, and track your progress across series.',
        accentColor: '#004B98',
        filterFn: (p) => p.qualification === 'O Level'
    },
    'international-a-level': {
        highlightText: 'International A-Level',
        heroSuffix: '(IAL & IAS) Papers',
        board: 'Pearson Edexcel',
        qualification: 'IAL',
        defaultSubject: 'Mathematics',
        subtitle:
            'Scan your handwritten Pearson Edexcel IAL (WMA, WME, WST, WPH, WCH, WBI) and Cambridge International AS & A Level (9709, 9702, 9701, 9700) papers for instant examiner-grade marking.',
        trustMicrocopy:
            'Supports Edexcel IAL & Cambridge International AS/A-Level written units (A*–E & UMS). No credit card required.',
        badgeOverlay: 'IAL & IAS Method-Mark Check',
        feature1Title: 'Built for Multi-Step A-Level Proofs & Working',
        feature1Body:
            'International A-Level papers reward rigorous calculus, mechanics diagrams, and multi-stage derivations. Our spatial AI tracks every M1, A1, and B1 mark across multi-page handwritten solutions.',
        feature2Title: 'Stuck on a Pure or Mechanics Question?',
        feature2Body:
            'Generate structured, step-by-step model answers matching Edexcel IAL and Cambridge 9709 examiner layouts so you learn the exact phrasing and working that earns full marks.',
        tutorQuestion: 'Why did I lose the final A1 on WMA12 integration?',
        tutorAnswer:
            'Your integration method earned M1 A1, but you dropped the final A1 by omitting the constant of integration (+ c) before substituting the boundary condition.',
        tutorTitle: 'Your 24/7 Personal IAL Tutor',
        tutorBody:
            'Chat directly with our AI on any marked step to unpack official IAL mark schemes, compare alternative methods, and push toward an A*.',
        accentColor: '#003057',
        filterFn: (p) => p.qualification === 'IAL' || p.qualification === 'International AS'
    },
    'sqa-national-5': {
        highlightText: 'SQA National 5',
        heroSuffix: 'Past Papers',
        board: 'SQA',
        qualification: 'National 5',
        defaultSubject: 'Mathematics',
        subtitle:
            'Scan your handwritten SQA National 5 past papers across Mathematics, Physics, Chemistry, Biology, and English for instant marking aligned to official SQA marking instructions.',
        trustMicrocopy:
            'Supports SQA National 5 written papers (A–D grade bands). Mark scheme pages never count toward your limit.',
        badgeOverlay: 'SQA National 5 Marking Check',
        feature1Title: 'Aligned to Official SQA Marking Instructions',
        feature1Body:
            'SQA marking instructions specify exact strategy, process, and communication marks. Our AI evaluates your handwritten steps line-by-line so you see exactly where every mark was gained or lost.',
        feature2Title: 'Clear Step-by-Step Model Answers',
        feature2Body:
            'Generate worked National 5 exemplars showing the exact layout, units, and concluding statements SQA markers look for.',
        tutorQuestion: 'Why did I lose 1 mark on this National 5 Maths question?',
        tutorAnswer:
            'Your calculation was correct, but SQA requires a concluding comparison statement referencing both calculated values to earn the final communication mark.',
        tutorTitle: 'Your 24/7 Personal National 5 Tutor',
        tutorBody:
            'Ask follow-up questions on any marked step to master SQA marking rules and build confidence before your May exams.',
        accentColor: '#004B98',
        filterFn: (p) => p.qualification === 'National 5' || p.board === 'SQA'
    },
    'ib-diploma': {
        highlightText: 'IB Diploma',
        heroSuffix: '(HL & SL) Papers',
        board: 'IB',
        qualification: 'IB',
        defaultSubject: 'Mathematics',
        subtitle:
            'Upload your handwritten IB Diploma Paper 1, Paper 2, or Paper 3 responses alongside the official markscheme for instant HL & SL examiner feedback across Maths AA/AI, Sciences, and Economics.',
        trustMicrocopy:
            'Supports IB Diploma HL & SL (1–7 scale). Private BYO markscheme upload — markscheme pages never count toward your limit.',
        badgeOverlay: 'IB Diploma HL / SL Check',
        feature1Title: 'Precision Marking for IB Method & Follow-Through',
        feature1Body:
            'IB markschemes distinguish carefully between M1 (method), A1 (accuracy), R1 (reasoning), and FT (follow-through). Our AI checks your handwritten working step-by-step against the official criteria.',
        feature2Title: 'Master Band-7 Structure & Reasoning',
        feature2Body:
            'Generate clean, Band-7 model solutions for complex HL/SL problems and structured responses so you see exactly what separates a 6 from a 7.',
        tutorQuestion: 'Why did I miss the R1 mark on this IB Maths AA HL proof?',
        tutorAnswer:
            'Your algebraic steps earned M1 A1, but IB requires an explicit concluding reasoning statement linking the inductive step back to the base case for R1.',
        tutorTitle: 'Your 24/7 Personal IB Tutor',
        tutorBody:
            'Discuss any marked step directly with our AI to decode IB markscheme notation (AG, FT, OE) and close gaps before mock and final exams.',
        accentColor: '#003057',
        filterFn: (p) => p.qualification === 'IB' || p.board === 'IB'
    },
    'ap-stem-frq': {
        highlightText: 'AP® Hybrid STEM',
        heroSuffix: 'FRQ Papers',
        board: 'College Board',
        qualification: 'AP',
        defaultSubject: 'Calculus AB',
        subtitle:
            'Purpose-built for the 12 College Board Hybrid AP® exams where Free-Response Questions (FRQs) are handwritten in physical paper booklets — Calculus AB/BC, Precalculus, Statistics, Physics 1/2/C, Chemistry, Biology & Economics.',
        trustMicrocopy:
            'Supports all 12 handwritten AP® Hybrid FRQ exams with official College Board Scoring Guidelines (1–5 scale).',
        badgeOverlay: 'AP® FRQ Scoring Guideline Check',
        feature1Title: 'Graded Against Official College Board Scoring Guidelines',
        feature1Body:
            'AP® FRQ rubrics award discrete points for setup, justification, units, and graphs. Scan your handwritten FRQ booklet with the official scoring guideline PDF to see every point earned or missed.',
        feature2Title: 'Score-5 Model FRQ Responses',
        feature2Body:
            'Generate concise, full-credit AP® FRQ exemplars that hit every College Board justification requirement without wasting exam time.',
        tutorQuestion: 'Why did I lose 1 point on AP Calculus AB FRQ #3(b)?',
        tutorAnswer:
            'You computed the right Riemann sum correctly, but College Board requires stating that f is increasing to justify why the right sum is an overestimate.',
        tutorTitle: 'Your 24/7 Personal AP® FRQ Tutor',
        tutorBody:
            'Chat directly with our AI on any FRQ part to understand College Board scoring notes, fix recurring justification errors, and push toward a 5.',
        accentColor: '#004B98',
        filterFn: (p) => p.qualification === 'AP' || p.board === 'College Board'
    }
};

const formatSlugLabel = (raw?: string, fallback = ''): string => {
    if (!raw) return fallback;
    const lower = raw.toLowerCase();
    const specialMap: Record<string, string> = {
        'aqa': 'AQA',
        'ocr': 'OCR',
        'edexcel': 'Pearson Edexcel',
        'pearson-edexcel': 'Pearson Edexcel',
        'cie': 'CIE',
        'cambridge': 'CIE',
        'sqa': 'SQA',
        'ib': 'IB',
        'college-board': 'College Board',
        'gcse': 'GCSE',
        'igcse': 'IGCSE',
        'a-level': 'A-Level',
        'as-level': 'AS-Level',
        'ial': 'IAL',
        'international-as': 'International AS',
        'o-level': 'O Level',
        'national-5': 'National 5',
        'level-3': 'Level 3',
        'ap': 'AP'
    };
    if (specialMap[lower]) return specialMap[lower];
    return raw
        .split('-')
        .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ''))
        .join(' ');
};

const parseSeriesDate = (s: string) => {
    const parts = (s || '').split(' ');
    if (parts.length < 2) return 0;
    const months: Record<string, number> = {
        'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
        'summer': 5, 'may/june': 5, 'july': 6, 'august': 7, 'september': 8,
        'october': 9, 'october/november': 10, 'november': 10, 'december': 11
    };
    const m = months[parts[0].toLowerCase()] ?? 5;
    const y = parseInt(parts[parts.length - 1], 10) || 0;
    return new Date(y, m).getTime();
};

const ProgrammaticLandingPage: React.FC = () => {
    const { examSlug, examBoard, qualification, subject } = useParams<{
        examSlug?: string;
        examBoard?: string;
        qualification?: string;
        subject?: string;
        year?: string;
    }>();
    const navigate = useNavigate();
    const location = useLocation();

    const preset = examSlug ? EXAM_PRESETS[examSlug.toLowerCase()] : undefined;

    const resolvedBoard = preset?.board || formatSlugLabel(examBoard, 'Official');
    const resolvedQual = preset?.qualification || formatSlugLabel(qualification, 'GCSE');
    const resolvedSubject = preset?.defaultSubject || formatSlugLabel(subject, 'Mathematics');
    const isEnglish = /english/i.test(resolvedSubject);

    const highlightText = preset?.highlightText || `${resolvedBoard} ${resolvedQual}`;
    const heroSuffix = preset?.heroSuffix || `${resolvedSubject} Papers`;
    const heroSubtitle =
        preset?.subtitle ||
        `Stop staring at confusing ${resolvedBoard} mark schemes. Scan your handwritten ${resolvedQual} ${resolvedSubject} past papers (and attach the official mark scheme PDF if not yet in our library) for instant examiner-grade marking.`;
    const trustMicrocopy =
        preset?.trustMicrocopy ||
        `Supports ${resolvedBoard} ${resolvedQual} ${resolvedSubject} handwritten papers. Mark scheme pages never count toward your limit.`;

    const [startAnimations, setStartAnimations] = useState(false);
    const [catalog, setCatalog] = useState<CatalogPaper[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        saveLandingExamContext({
            board: resolvedBoard,
            subject: preset ? '' : resolvedSubject,
            qualification: resolvedQual,
            sourcePath: location.pathname + location.search,
        });
    }, [preset, resolvedBoard, resolvedSubject, resolvedQual, location.pathname, location.search]);

    useEffect(() => {
        const timer = setTimeout(() => setStartAnimations(true), 100);
        const fetchData = async () => {
            try {
                const response = await fetch('/api/exams/public-list');
                const json = await response.json();
                if (json.success && Array.isArray(json.catalog)) {
                    setCatalog(json.catalog);
                }
            } catch (error) {
                console.error('Error fetching exam catalog:', error);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
        return () => clearTimeout(timer);
    }, []);

    // Filter live DB papers matching this exam page
    const seriesList = useMemo(() => {
        const matching = catalog.filter((p) => {
            if (preset) return preset.filterFn(p);
            const qualMatch = !qualification || p.qualification.toLowerCase() === resolvedQual.toLowerCase();
            const boardMatch = !examBoard || p.board.toLowerCase().includes(resolvedBoard.toLowerCase());
            const subjMatch = !subject || p.subject.toLowerCase().includes(resolvedSubject.toLowerCase());
            return qualMatch && boardMatch && subjMatch;
        });

        const bySeries = new Map<string, CatalogPaper[]>();
        matching.forEach((p) => {
            const key = p.series || 'Other';
            if (!bySeries.has(key)) bySeries.set(key, []);
            bySeries.get(key)!.push(p);
        });

        return Array.from(bySeries.entries())
            .map(([series, papers]) => ({
                series,
                papers: papers.sort((a, b) =>
                    (a.code || '').localeCompare(b.code || '', undefined, { numeric: true, sensitivity: 'base' })
                )
            }))
            .sort((a, b) => parseSeriesDate(b.series) - parseSeriesDate(a.series));
    }, [catalog, preset, qualification, examBoard, subject, resolvedQual, resolvedBoard, resolvedSubject]);

    const seoTitle = `${highlightText} ${heroSuffix} Model Answers & AI Marking`;

    return (
        <div className="light-mode-forced aqa-landing-page">
            <SeoHeader
                title={seoTitle}
                description={heroSubtitle}
                canonicalUrl={`https://aimarking.ai${location.pathname}`}
                ogTitle={seoTitle}
                ogDescription={heroSubtitle}
                ogUrl={`https://aimarking.ai${location.pathname}`}
            />

            <LandingPageHeader />

            <section className="landing-section aqa-hero-section">
                <div className={`aqa-hero-content ${startAnimations ? 'trigger-anim' : ''}`}>
                    <h1 className="aqa-hero-title">
                        Instantly Mark Your{' '}
                        <span
                            className="aqa-highlight-blue"
                            style={preset?.accentColor ? { color: preset.accentColor } : undefined}
                        >
                            {highlightText}
                        </span>{' '}
                        {heroSuffix}
                    </h1>
                    <p className="aqa-hero-subtitle">{heroSubtitle}</p>

                    <div className="hero-cta-group">
                        <div className="anim-item">
                            <button className="hero-primary-cta" onClick={() => navigate('/app?action=scan')}>
                                <span>Scan Your {resolvedQual} Paper</span>
                                <svg className="w-6 h-6 cta-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" width="24" height="24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path>
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"></path>
                                </svg>
                            </button>

                            <button className="hero-secondary-cta" onClick={() => navigate('/app?action=select')}>
                                <span>Upload PDF / Mark Scheme</span>
                                <svg className="w-6 h-6 cta-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" width="24" height="24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                                </svg>
                            </button>

                            <p className="hero-trust-microcopy">{trustMicrocopy}</p>
                        </div>
                    </div>
                </div>
            </section>

            <HeroAnimation subject={isEnglish ? 'english' : 'maths'} />

            <section className="landing-section aqa-feature-row">
                <div className="aqa-feature-container">
                    <div className="aqa-feature-visual">
                        <div className="aqa-mockup-frame">
                            <img
                                src={preset?.feature1Image || (isEnglish ? '/images/english_spatial_marking_q2.jpg' : '/images/spatial_mapping_v3.png')}
                                alt={preset?.feature1Alt || `${highlightText} Spatial Marking Analysis`}
                                style={{ width: '100%', borderRadius: '8px' }}
                            />
                            <div className="aqa-badge-overlay">
                                {preset?.badgeOverlay || `${highlightText} Logic Check`}
                            </div>
                        </div>
                    </div>
                    <div className="aqa-feature-text">
                        <h2 className="aqa-section-title">
                            {preset?.feature1Title || 'Get Every Method & Accuracy Mark'}
                        </h2>
                        <p className="aqa-section-body">
                            {preset?.feature1Body ||
                                `Our AI reads your handwritten ${resolvedQual} ${resolvedSubject} working step-by-step against official ${resolvedBoard} mark schemes to find every method, accuracy, and rubric mark you deserve.`}
                        </p>
                    </div>
                </div>
            </section>

            <section className="landing-section aqa-feature-row">
                <div className="aqa-feature-container">
                    <div className="aqa-feature-text">
                        <h2 className="aqa-section-title">
                            {preset?.feature2Title || 'Stuck on a Hard Question?'}
                        </h2>
                        <p className="aqa-section-body">
                            {preset?.feature2Body ||
                                `Generate clear, step-by-step model answers formatted to match ${resolvedBoard} ${resolvedQual} examiner expectations so you know exactly how to structure full-mark responses.`}
                        </p>
                    </div>
                    <div className="aqa-feature-visual">
                        <div className="exemplar-preview-container">
                            <div className="aqa-mobile-frame">
                                <div className="aqa-mobile-screen">
                                    <img
                                        src={preset?.feature2Image || (isEnglish ? '/images/english_model_answer_exemplar.jpg?v=3' : '/images/aqa_question_mode_v2.png')}
                                        alt={preset?.feature2Alt || `${highlightText} Step-by-Step Model Answer`}
                                        style={{
                                            width: '100%',
                                            height: '100%',
                                            objectFit: isEnglish ? 'contain' : 'cover',
                                            objectPosition: 'top center',
                                            padding: isEnglish ? '10px 8px 0 8px' : '0',
                                            boxSizing: 'border-box',
                                            backgroundColor: '#ffffff'
                                        }}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section id="papers" className="landing-section aqa-resources-section">
                <div className="aqa-resources-content">
                    <h2 className="aqa-section-title">
                        {highlightText} Past Papers &amp; Model Answers
                    </h2>

                    {loading ? (
                        <div className="papers-loading">
                            <Loader2 className="spinner" size={40} />
                            <p>Loading {highlightText} papers...</p>
                        </div>
                    ) : seriesList.length > 0 ? (
                        <div className="year-card-grid">
                            {seriesList.map((series, index) => (
                                <div key={series.series} className="year-card-static">
                                    <div className="year-card-header">
                                        <span className="year-title">{series.series} Series</span>
                                        {index === 0 && <span className="new-tag">Latest</span>}
                                    </div>
                                    <div className="tier-groups-stack">
                                        <div className="internal-tier-group">
                                            <div className="paper-list-container">
                                                {series.papers.map((paper) => {
                                                    const paperCode = (paper.code || '').replace('/', '-');
                                                    const seriesParts = (series.series || '').split(' ');
                                                    const seriesYear = seriesParts.length >= 2
                                                        ? seriesParts[0].substring(0, 3).toUpperCase() + seriesParts[seriesParts.length - 1]
                                                        : '';
                                                    const finalCode = seriesYear ? `${paperCode}-${seriesYear}` : paperCode;

                                                    return (
                                                        <div key={paper.id || paper.code} className="paper-item-row">
                                                            <div className="paper-meta">
                                                                <span className="paper-name">{paper.subject}:</span>
                                                                <span className="paper-code-tag">{paper.code}</span>
                                                                {(paper.tier || paper.type) && (
                                                                    <span className="paper-type-label">
                                                                        {paper.tier || paper.type}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="paper-actions">
                                                                <button
                                                                    className="action-link model"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        trackPaperInteraction(finalCode, 'MODEL');
                                                                        navigate(`/app?code=${encodeURIComponent(finalCode)}&mode=model`);
                                                                    }}
                                                                >
                                                                    Model
                                                                </button>
                                                                <button
                                                                    className="action-link mark"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        trackPaperInteraction(finalCode, 'MARK');
                                                                        navigate(`/app?code=${encodeURIComponent(finalCode)}&mode=markingscheme`);
                                                                    }}
                                                                >
                                                                    Mark
                                                                </button>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="year-card-static" style={{ maxWidth: '720px', margin: '0 auto', textAlign: 'center', padding: '36px 28px' }}>
                            <h3 style={{ margin: '0 0 10px', fontSize: '1.25rem', color: '#0f172a' }}>
                                Upload Any {highlightText} Paper + Official Mark Scheme
                            </h3>
                            <p style={{ margin: '0 0 22px', color: '#475569', lineHeight: 1.6 }}>
                                No {highlightText} papers are cached in the public library yet — upload your handwritten answers together with the official mark scheme PDF. Your work is marked immediately and verified official schemes are automatically added to the library.
                            </p>
                            <button
                                className="hero-primary-cta"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
                                onClick={() => navigate('/app?action=select')}
                            >
                                <Upload size={18} />
                                <span>Upload {resolvedQual} Paper + Mark Scheme</span>
                            </button>
                        </div>
                    )}
                </div>
            </section>

            <section className="tutor-feature-section">
                <h2 className="section-title center">Stop Guessing Why You Lost Marks</h2>
                <div className="tutor-feature-card">
                    <div className="tutor-card-visual">
                        <div className="board-chat-mockup">
                            <div className="chat-bubble user">
                                {preset?.tutorQuestion || `Why did I only get 2 marks on this ${resolvedQual} ${resolvedSubject} question?`}
                            </div>
                            <div className="chat-bubble ai">
                                {preset?.tutorAnswer ||
                                    `You earned the method marks for your setup, but missed the final accuracy mark required by the ${resolvedBoard} mark scheme.`}
                            </div>
                        </div>
                    </div>
                    <div className="tutor-card-text">
                        <h2 className="board-section-title">
                            {preset?.tutorTitle || `Your 24/7 Personal ${resolvedBoard} Tutor`}
                        </h2>
                        <p className="board-section-body">
                            {preset?.tutorBody ||
                                `Don't just look at a red 'X'. Chat directly with our AI to understand why you dropped a mark, get a simpler explanation of the ${resolvedBoard} mark scheme, and confidently tackle the next paper.`}
                        </p>
                        <div className="feature-tag">Pro &amp; Ultra Feature</div>
                    </div>
                </div>
            </section>

            <LandingFooter />
        </div>
    );
};

export default ProgrammaticLandingPage;
