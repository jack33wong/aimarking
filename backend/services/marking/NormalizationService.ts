/**
 * Normalization Service
 * Centralizes normalization logic for exam boards and series
 */

export class NormalizationService {
    /**
     * Normalize exam board name for comparison
     */
    static normalizeExamBoard(board: string): string {
        if (!board) return '';
        const normalized = board.toLowerCase().trim();
        // Map common variations
        if (normalized.includes('edexcel') || normalized === 'pearson') return 'Pearson Edexcel';
        if (normalized.includes('aqa')) return 'AQA';
        if (normalized.includes('ocr')) return 'OCR';
        if (normalized.includes('wjec')) return 'WJEC';
        if (normalized.includes('eduqas')) return 'Eduqas';
        if (normalized === 'cie' || normalized.includes('cambridge')) return 'CIE';
        if (normalized === 'ccea') return 'CCEA';
        if (normalized === 'sqa' || normalized.includes('scottish qualifications')) return 'SQA';
        if (normalized === 'ib' || normalized === 'ibo' || normalized.includes('international baccalaureate')) return 'IB';
        if (normalized.includes('college board') || normalized === 'ap' || normalized.includes('advanced placement')) return 'College Board';
        return board.trim(); // Return original if no match
    }

    /**
     * Normalize exam series mapping (e.g., "May 2024" to "June 2024" for Edexcel)
     */
    static normalizeExamSeries(series: string, board: string): string {
        if (!series) return '';
        const normalizedSeries = series.trim();
        const normalizedBoard = board ? this.normalizeExamBoard(board) : '';

        // Pearson Edexcel: map "May [Year]", "June [Year]" to "Summer [Year]"
        if (normalizedBoard === 'Pearson Edexcel' || !normalizedBoard) {
            if (/^(May|June|Summer)\s+\d{4}$/i.test(normalizedSeries)) {
                return normalizedSeries.replace(/^(May|June|Summer)/i, 'Summer');
            }
        }

        // OCR: map "May [Year]" and "June [Year]" to "Summer [Year]" to group summer papers
        if (normalizedBoard === 'OCR') {
            if (/^(May|June)\s+\d{4}$/i.test(normalizedSeries)) {
                return normalizedSeries.replace(/^(May|June)/i, 'Summer');
            }
        }

        return normalizedSeries;
    }

    /**
     * Get all possible variations of an exam series for database querying
     */
    static getExamSeriesVariations(series: string, board: string): string[] {
        if (!series) return [];
        const normalizedSeries = series.trim();
        const normalizedBoard = board ? this.normalizeExamBoard(board) : '';
        const variations = [normalizedSeries];

        const match = normalizedSeries.match(/^(May|June|Summer)\s+(\d{4})$/i);
        if (match && (normalizedBoard === 'Pearson Edexcel' || normalizedBoard === 'OCR' || !normalizedBoard)) {
            const year = match[2];
            variations.push(`Summer ${year}`);
            variations.push(`June ${year}`);
            variations.push(`May ${year}`);
        }

        return Array.from(new Set(variations));
    }
}
