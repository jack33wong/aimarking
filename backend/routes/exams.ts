import * as express from 'express';
import type { Request, Response } from 'express';
import { getFirestore } from '../config/firebase.js';
import { ExamReferenceService } from '../services/ExamReferenceService.js';
import { NormalizationService } from '../services/marking/NormalizationService.js';

const router = express.Router();
const db = getFirestore();

/**
 * GET /api/exams/public-list
 * Public endpoint to fetch and group exam data for landing pages.
 */
router.get('/public-list', async (req: Request, res: Response) => {
    try {
        const snapshot = await db.collection('fullExamPapers').get();
        const papers = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        const groupedData: any = {};
        const dynamicCatalog: Array<{
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
            publicDownloadable: boolean;
        }> = [];

        const normalizeSubjectLabel = (raw: string, code: string): string => {
            const trimmed = String(raw || '').trim().replace(/\s+/g, ' ');
            if (!trimmed) {
                return /\b(8700|8702|1EN0|1ET0|J351|J352|C700|C720)\b|english/i.test(code) ? 'English Language' : 'Mathematics';
            }
            if (/^maths?$/i.test(trimmed)) return 'Mathematics';
            return trimmed
                .toLowerCase()
                .replace(/(^|[\s:\-\/(])([a-z])/g, (_, sep, ch) => `${sep}${ch.toUpperCase()}`);
        };

        papers.forEach((paper: any) => {
            const meta = paper.metadata || paper.exam || {};
            let rawBoard = (meta.board || meta.exam_board || 'Unknown').trim();
            const board = NormalizationService.normalizeExamBoard(rawBoard);
            let { series, qualification, isAlevel, tier: formattedTier, tierCode } = ExamReferenceService.formatMetadataDisplay({
                ...meta,
                exam_board: board
            });
            series = NormalizationService.normalizeExamSeries(series, board);
            
            if (!groupedData[board]) {
                groupedData[board] = { gcse: {}, alevel: { pure: {}, stats_mech: {} } };
            }

            const code = (meta.exam_code || meta.code || '').toLowerCase();
            const rawCode = meta.code || meta.exam_code || '';
            const name = meta.paper || meta.name || '';
            const subjectLabel = normalizeSubjectLabel(meta.subject || '', rawCode);

            // Extract Calculator info if present
            const paperName = meta.paper || meta.paper_title || meta.name || '';
            const typeMatch = paperName.match(/(Non-Calculator|Calculator|Non-Calc|Calc)/i);
            let paperType = typeMatch ? typeMatch[0] : '';
            if (paperType.toLowerCase().includes('non')) paperType = 'Non-Calc';
            else if (paperType.toLowerCase().includes('calc')) paperType = 'Calculator';

            if (board && board !== 'Unknown' && !/^(custom|unknown|n\/a|none)$/i.test(board)) {
                dynamicCatalog.push({
                    id: paper.id,
                    qualification: qualification || 'GCSE',
                    board,
                    subject: subjectLabel,
                    code: rawCode,
                    name: meta.paper || 'Paper',
                    series,
                    tier: formattedTier,
                    tierCode,
                    type: paperType,
                    // IB papers are kept for BYO marking/search matching only (copyright)
                    publicDownloadable: qualification !== 'IB'
                });
            }

            if (isAlevel) {
                // Group A-Level by Pure vs Stats/Mech
                const isStatsMech = code.includes('31') || code.includes('32') || 
                                   name.toLowerCase().includes('stats') || 
                                   name.toLowerCase().includes('mechanics') ||
                                   code.endsWith('3') || // Common for paper 3
                                   code.includes('/3');

                const category = isStatsMech ? 'stats_mech' : 'pure';
                
                if (!groupedData[board].alevel[category][series]) {
                    groupedData[board].alevel[category][series] = [];
                }

                groupedData[board].alevel[category][series].push({
                    id: paper.id,
                    code: rawCode,
                    name: meta.paper || 'Paper',
                    series: series,
                    tier: formattedTier,
                    tierCode: tierCode,
                    category: category === 'pure' ? 'Pure' : 'Applied',
                    type: paperType,
                    qualification,
                    subject: subjectLabel
                });
            } else {
                // GCSE / IGCSE / O Level / Nat 5 / etc. legacy bucket
                if (!groupedData[board].gcse[series]) {
                    groupedData[board].gcse[series] = [];
                }
                
                groupedData[board].gcse[series].push({
                    id: paper.id,
                    code: rawCode,
                    name: meta.paper || 'Paper',
                    series: series,
                    tier: formattedTier,
                    tierCode: tierCode,
                    type: paperType,
                    subject: subjectLabel,
                    qualification
                });
            }
        });

        // Sort dynamic catalog: newest series first, then code ascending
        dynamicCatalog.sort((a, b) => {
            const seriesDiff = sortSeries(b.series, a.series);
            if (seriesDiff !== 0) return seriesDiff;
            return (a.code || '').localeCompare(b.code || '', undefined, { numeric: true, sensitivity: 'base' });
        });

        const QUAL_ORDER = [
            'GCSE', 'IGCSE', 'A-Level', 'IAL', 'AS-Level', 'International AS',
            'O Level', 'National 5', 'Level 3', 'IB', 'AP'
        ];
        const qualifications = Array.from(new Set(dynamicCatalog.map(p => p.qualification))).sort((a, b) => {
            const ia = QUAL_ORDER.indexOf(a);
            const ib = QUAL_ORDER.indexOf(b);
            if (ia !== -1 && ib !== -1) return ia - ib;
            if (ia !== -1) return -1;
            if (ib !== -1) return 1;
            return a.localeCompare(b);
        });
        const boards = Array.from(new Set(dynamicCatalog.map(p => p.board))).sort();
        const subjects = Array.from(new Set(dynamicCatalog.map(p => p.subject))).sort();

        // Convert grouped objects to sorted arrays
        const result: any = {};
        for (const board in groupedData) {
            result[board] = {
                gcse: Object.entries(groupedData[board].gcse)
                    .map(([series, papers]: [string, any]) => ({ 
                        series, 
                        papers: papers.sort((a: any, b: any) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true, sensitivity: 'base' }))
                    }))
                    .sort((a, b) => sortSeries(b.series, a.series)),
                alevel: {
                    pure: Object.entries(groupedData[board].alevel.pure)
                        .map(([series, papers]: [string, any]) => ({ 
                            series, 
                            papers: papers.sort((a: any, b: any) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true, sensitivity: 'base' }))
                        }))
                        .sort((a, b) => sortSeries(b.series, a.series)),
                    stats_mech: Object.entries(groupedData[board].alevel.stats_mech)
                        .map(([series, papers]: [string, any]) => ({ 
                            series, 
                            papers: papers.sort((a: any, b: any) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true, sensitivity: 'base' }))
                        }))
                        .sort((a, b) => sortSeries(b.series, a.series))
                }
            };
        }

        res.json({
            success: true,
            data: result,
            catalog: dynamicCatalog,
            filters: { qualifications, boards, subjects }
        });
    } catch (error: any) {
        console.error('Error fetching public exam list:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

function sortSeries(a: string, b: string): number {
    const parseDate = (s: string) => {
        const parts = s.split(' ');
        if (parts.length < 2) return new Date(0);
        const months: any = { 'January': 0, 'Summer': 5, 'June': 5, 'November': 10 };
        return new Date(parseInt(parts[1]), months[parts[0]] || 0);
    };
    return parseDate(a).getTime() - parseDate(b).getTime();
}

export default router;
