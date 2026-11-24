import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, ChevronLeft, ChevronRight, Loader2, Upload } from 'lucide-react';
import { trackPaperInteraction } from '../../utils/analytics';
import '../../pages/PastPaperShared.css';
import './SupportedPapers.css';

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
    publicDownloadable?: boolean;
}

const isEnglishPaper = (codeOrTitle: string = '') =>
    /\b(8700|8702|1EN0|1ET0|J351|J352|C700|C720)\b|english/i.test(codeOrTitle);

const getPaperTypeLabel = (paper: CatalogPaper) => {
    const isEnglish = isEnglishPaper(`${paper.code} ${paper.subject}`);
    if (!isEnglish) {
        return paper.tier || paper.type || '';
    }
    const code = (paper.code || paper.name || '').toUpperCase();
    if (code.includes('8700/1') || code.includes('8700-1')) return 'PAPER 1 • CREATIVE';
    if (code.includes('8700/2') || code.includes('8700-2')) return 'PAPER 2 • VIEWPOINTS';
    if (code.includes('1EN0/01') || code.includes('1EN0-01') || code.includes('1EN0/1') || code.includes('1EN0-1')) return 'PAPER 1 • FICTION';
    if (code.includes('1EN0/02') || code.includes('1EN0-02') || code.includes('1EN0/2') || code.includes('1EN0-2')) return 'PAPER 2 • NON-FICTION';
    if (code.includes('J351/01') || code.includes('J351-01') || code.includes('J351/1') || code.includes('J351-1')) return 'PAPER 1 • NON-FICTION';
    if (code.includes('J351/02') || code.includes('J351-02') || code.includes('J351/2') || code.includes('J351-2')) return 'PAPER 2 • LITERARY';
    return paper.tier || paper.type || '';
};

const getBoardToolUrl = (board: string, qualification: string, subject: string): string => {
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const bLower = board.toLowerCase();
    const qLower = qualification.toLowerCase();
    const sLower = subject.toLowerCase();

    if (qLower === 'gcse' && sLower.includes('math')) {
        if (bLower.includes('edexcel')) return '/mark-edexcel-gcse-maths-past-papers';
        if (bLower === 'aqa') return '/mark-aqa-gcse-maths-past-papers';
        if (bLower === 'ocr') return '/mark-ocr-gcse-maths-past-papers';
    }
    if (qLower === 'gcse' && sLower.includes('english')) {
        if (bLower.includes('edexcel')) return '/mark-edexcel-gcse-english-language-past-papers';
        if (bLower === 'aqa') return '/mark-aqa-gcse-english-language-past-papers';
        if (bLower === 'ocr') return '/mark-ocr-gcse-english-language-past-papers';
    }
    const boardSlug = bLower.includes('edexcel') ? 'edexcel' : slugify(board);
    return `/exams/${slugify(qualification)}/${boardSlug}/${slugify(subject)}`;
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

export const SupportedPapers: React.FC = () => {
    const navigate = useNavigate();
    const scrollRefs = useRef<(HTMLDivElement | null)[]>([]);

    const [catalog, setCatalog] = useState<CatalogPaper[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedQualification, setSelectedQualification] = useState<string>('ALL');
    const [selectedBoard, setSelectedBoard] = useState<string>('ALL');
    const [selectedSubject, setSelectedSubject] = useState<string>('ALL');

    const handleScroll = (index: number, direction: 'left' | 'right') => {
        const container = scrollRefs.current[index];
        if (container) {
            const scrollAmount = container.clientWidth;
            container.scrollBy({
                left: direction === 'left' ? -scrollAmount : scrollAmount,
                behavior: 'smooth'
            });
        }
    };

    useEffect(() => {
        const fetchData = async () => {
            try {
                const response = await fetch('/api/exams/public-list');
                const json = await response.json();
                if (json.success && Array.isArray(json.catalog)) {
                    setCatalog(json.catalog);
                    // Default to GCSE + Mathematics first for a clean initial landing view
                    const quals: string[] = json.filters?.qualifications || [];
                    const defaultQual = quals.includes('GCSE') ? 'GCSE' : (quals[0] || 'ALL');
                    setSelectedQualification(defaultQual);
                    const hasMathsInDefaultQual = json.catalog.some(
                        (p: CatalogPaper) =>
                            (defaultQual === 'ALL' || p.qualification === defaultQual) &&
                            p.subject === 'Mathematics'
                    );
                    if (hasMathsInDefaultQual) {
                        setSelectedSubject('Mathematics');
                    }
                }
            } catch (error) {
                console.error('Error fetching exam data:', error);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, []);

    // Dynamic cascading filter options derived strictly from DB records
    const availableQualifications = useMemo(() => {
        const QUAL_ORDER = [
            'GCSE', 'IGCSE', 'A-Level', 'IAL', 'AS-Level', 'International AS',
            'O Level', 'National 5', 'Level 3', 'IB', 'AP'
        ];
        const set = new Set(catalog.map((p) => p.qualification).filter(Boolean));
        return Array.from(set).sort((a, b) => {
            const ia = QUAL_ORDER.indexOf(a);
            const ib = QUAL_ORDER.indexOf(b);
            if (ia !== -1 && ib !== -1) return ia - ib;
            if (ia !== -1) return -1;
            if (ib !== -1) return 1;
            return a.localeCompare(b);
        });
    }, [catalog]);

    const availableBoards = useMemo(() => {
        const filtered = selectedQualification === 'ALL'
            ? catalog
            : catalog.filter((p) => p.qualification === selectedQualification);
        return Array.from(new Set(filtered.map((p) => p.board).filter(Boolean))).sort();
    }, [catalog, selectedQualification]);

    const availableSubjects = useMemo(() => {
        const filtered = catalog.filter((p) =>
            (selectedQualification === 'ALL' || p.qualification === selectedQualification) &&
            (selectedBoard === 'ALL' || p.board === selectedBoard)
        );
        return Array.from(new Set(filtered.map((p) => p.subject).filter(Boolean))).sort();
    }, [catalog, selectedQualification, selectedBoard]);

    const handleSelectQualification = (qual: string) => {
        setSelectedQualification(qual);
        setSelectedBoard('ALL');
        setSelectedSubject('ALL');
    };

    const handleSelectBoard = (board: string) => {
        setSelectedBoard(board);
        setSelectedSubject('ALL');
    };

    // Group matching papers into sections by (board, qualification, subject) -> series[]
    const groupedSections = useMemo(() => {
        const matching = catalog.filter((p) =>
            (selectedQualification === 'ALL' || p.qualification === selectedQualification) &&
            (selectedBoard === 'ALL' || p.board === selectedBoard) &&
            (selectedSubject === 'ALL' || p.subject === selectedSubject)
        );

        const sectionMap = new Map<string, {
            board: string;
            qualification: string;
            subject: string;
            seriesMap: Map<string, CatalogPaper[]>;
        }>();

        matching.forEach((paper) => {
            const key = `${paper.board}__${paper.qualification}__${paper.subject}`;
            if (!sectionMap.has(key)) {
                sectionMap.set(key, {
                    board: paper.board,
                    qualification: paper.qualification,
                    subject: paper.subject,
                    seriesMap: new Map()
                });
            }
            const sec = sectionMap.get(key)!;
            const seriesKey = paper.series || 'Other';
            if (!sec.seriesMap.has(seriesKey)) {
                sec.seriesMap.set(seriesKey, []);
            }
            sec.seriesMap.get(seriesKey)!.push(paper);
        });

        return Array.from(sectionMap.values())
            .map((sec) => {
                const seriesList = Array.from(sec.seriesMap.entries())
                    .map(([series, papers]) => ({
                        series,
                        papers: papers.sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true, sensitivity: 'base' }))
                    }))
                    .sort((a, b) => parseSeriesDate(b.series) - parseSeriesDate(a.series));
                return {
                    board: sec.board,
                    qualification: sec.qualification,
                    subject: sec.subject,
                    toolUrl: getBoardToolUrl(sec.board, sec.qualification, sec.subject),
                    seriesList
                };
            })
            .sort((a, b) => a.board.localeCompare(b.board) || a.subject.localeCompare(b.subject));
    }, [catalog, selectedQualification, selectedBoard, selectedSubject]);

    return (
        <section id="supported-papers" className="supported-papers">
            <div className="papers-container">
                <div className="badge-container center">
                    <span className="performance-badge">Live Syllabus Coverage</span>
                </div>
                <h2>Auto-Growing Official Past Paper Library</h2>
                <div className="status-freshness">
                    <span className="live-dot"></span>
                    <span className="status-text">Updated dynamically from verified official mark schemes in our database</span>
                </div>

                {/* Row 1: Dynamic Qualification / Level Pills */}
                {availableQualifications.length > 0 && (
                    <div className="supported-papers-tabs" role="tablist" aria-label="Exam levels">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={selectedQualification === 'ALL'}
                            className={`supported-papers-tab-btn ${selectedQualification === 'ALL' ? 'active' : ''}`}
                            onClick={() => handleSelectQualification('ALL')}
                        >
                            <span className="tab-text">All Levels</span>
                        </button>
                        {availableQualifications.map((qual) => (
                            <button
                                key={qual}
                                type="button"
                                role="tab"
                                aria-selected={selectedQualification === qual}
                                className={`supported-papers-tab-btn ${selectedQualification === qual ? 'active' : ''}`}
                                onClick={() => handleSelectQualification(qual)}
                            >
                                <span className="tab-text">{qual}</span>
                            </button>
                        ))}
                    </div>
                )}

                {/* Row 2 & 3: Dynamic Cascading Board & Subject Subfilters */}
                {!loading && (availableBoards.length > 1 || availableSubjects.length > 1) && (
                    <div className="supported-papers-subfilters-wrap">
                        {availableBoards.length > 1 && (
                            <div className="supported-papers-subfilter-row" role="tablist" aria-label="Exam boards">
                                <button
                                    type="button"
                                    className={`supported-subfilter-pill ${selectedBoard === 'ALL' ? 'active' : ''}`}
                                    onClick={() => handleSelectBoard('ALL')}
                                >
                                    All Boards
                                </button>
                                {availableBoards.map((board) => (
                                    <button
                                        key={board}
                                        type="button"
                                        className={`supported-subfilter-pill ${selectedBoard === board ? 'active' : ''}`}
                                        onClick={() => handleSelectBoard(board)}
                                    >
                                        {board}
                                    </button>
                                ))}
                            </div>
                        )}
                        {availableSubjects.length > 1 && (
                            <div className="supported-papers-subfilter-row" role="tablist" aria-label="Subjects">
                                <button
                                    type="button"
                                    className={`supported-subfilter-pill ${selectedSubject === 'ALL' ? 'active' : ''}`}
                                    onClick={() => setSelectedSubject('ALL')}
                                >
                                    All Subjects
                                </button>
                                {availableSubjects.map((subject) => (
                                    <button
                                        key={subject}
                                        type="button"
                                        className={`supported-subfilter-pill ${selectedSubject === subject ? 'active' : ''}`}
                                        onClick={() => setSelectedSubject(subject)}
                                    >
                                        {subject}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                <div className="papers-display">
                    {loading ? (
                        <div className="papers-loading">
                            <Loader2 className="spinner" size={40} />
                            <p>Fetching the latest past papers...</p>
                        </div>
                    ) : groupedSections.length > 0 ? (
                        groupedSections.map((section, i) => (
                            <div key={`${section.board}-${section.qualification}-${section.subject}`} className="board-section">
                                <div className="board-main-header">
                                    <div className="header-top">
                                        <span className="board-logo-pill">
                                            {section.board} · {section.qualification} {section.subject}
                                        </span>
                                    </div>
                                    <div className="header-bottom">
                                        <a href={section.toolUrl} className="board-tool-link">
                                            Try {section.board} {section.qualification} {section.subject} AI Marking →
                                        </a>
                                    </div>
                                </div>

                                <div className="board-scroll-wrapper">
                                    <button
                                        className="mobile-pagination-btn left"
                                        onClick={() => handleScroll(i, 'left')}
                                        aria-label="Previous year"
                                    >
                                        <ChevronLeft size={20} />
                                    </button>

                                    <div
                                        className="board-content-scroll"
                                        ref={(el) => { scrollRefs.current[i] = el; }}
                                    >
                                        {section.seriesList.map((s, si) => (
                                            <div key={si} className="series-group">
                                                <div className="series-header">
                                                    <h4>
                                                        {section.qualification} {section.subject} · {s.series}
                                                    </h4>
                                                </div>
                                                <div className="series-papers-list">
                                                    {s.papers.map((paper, pi) => {
                                                        const typeLabel = getPaperTypeLabel(paper);
                                                        return (
                                                            <div key={paper.id || pi} className="paper-row">
                                                                <div className="paper-info">
                                                                    <span className="paper-count">{paper.name}:</span>
                                                                    <span className="paper-code-tag">{paper.code}</span>
                                                                    {typeLabel && (
                                                                        <span className="paper-type-label">
                                                                            {typeLabel}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div className="paper-actions">
                                                                    <button
                                                                        onClick={() => {
                                                                            const paperCode = (paper.code || '').replace('/', '-');
                                                                            const parts = (s.series || '').split(' ');
                                                                            const seriesYear = parts.length >= 2
                                                                                ? parts[0].substring(0, 3).toUpperCase() + parts[parts.length - 1]
                                                                                : '';
                                                                            const finalCode = seriesYear ? `${paperCode}-${seriesYear}` : paperCode;
                                                                            trackPaperInteraction(finalCode, 'MODEL');
                                                                            navigate(`/app?code=${encodeURIComponent(finalCode)}&mode=model`);
                                                                        }}
                                                                        className="action-link model"
                                                                    >
                                                                        Model
                                                                    </button>
                                                                    <button
                                                                        onClick={() => {
                                                                            const paperCode = (paper.code || '').replace('/', '-');
                                                                            const parts = (s.series || '').split(' ');
                                                                            const seriesYear = parts.length >= 2
                                                                                ? parts[0].substring(0, 3).toUpperCase() + parts[parts.length - 1]
                                                                                : '';
                                                                            const finalCode = seriesYear ? `${paperCode}-${seriesYear}` : paperCode;
                                                                            trackPaperInteraction(finalCode, 'MARK');
                                                                            navigate(`/app?code=${encodeURIComponent(finalCode)}&mode=markingscheme`);
                                                                        }}
                                                                        className="action-link mark"
                                                                    >
                                                                        Mark
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        ))}
                                    </div>

                                    <button
                                        className="mobile-pagination-btn right"
                                        onClick={() => handleScroll(i, 'right')}
                                        aria-label="Next year"
                                    >
                                        <ChevronRight size={20} />
                                    </button>
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="no-papers-found">
                            <p>No papers match this filter yet.</p>
                        </div>
                    )}
                </div>

                {/* BYO Upload CTA for any handwritten paper not yet in DB */}
                <div className="supported-papers-byo-cta">
                    <div className="byo-cta-copy">
                        <strong>Don&apos;t see your paper yet (e.g. IGCSE, IAL, O Level, National 5, IB, or AP® STEM FRQ)?</strong>
                        <span>
                            Upload your handwritten paper together with its official mark scheme PDF — it&apos;s marked immediately and automatically added to the library.
                        </span>
                    </div>
                    <button
                        type="button"
                        className="byo-cta-btn"
                        onClick={() => navigate('/app?action=select')}
                    >
                        <Upload size={16} />
                        <span>Upload Paper + Mark Scheme</span>
                    </button>
                </div>

                <p className="papers-note">
                    <ShieldCheck size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                    Mark scheme pages are always free and never count toward your page limit.
                </p>
            </div>
        </section>
    );
};

export default SupportedPapers;
