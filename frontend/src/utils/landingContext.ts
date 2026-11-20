export interface LandingExamContext {
  board: string;          // e.g. 'Pearson Edexcel', 'AQA', 'OCR'
  subject: string;        // e.g. 'Mathematics', 'English Language'
  qualification?: string; // e.g. 'GCSE', 'A-Level'
  sourcePath: string;
  timestamp: number;
}

const STORAGE_KEY = 'aimarking_last_landing_context';
const MAX_CONTEXT_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

export const normalizeBoardLabel = (rawBoard: string): string => {
  const lower = rawBoard.trim().toLowerCase();
  if (lower.includes('edexcel') || lower.includes('pearson')) return 'Pearson Edexcel';
  if (lower.includes('aqa')) return 'AQA';
  if (lower.includes('ocr')) return 'OCR';
  if (lower.includes('wjec') || lower.includes('eduqas')) return 'WJEC';
  return rawBoard.trim().toUpperCase();
};

/**
 * Extract exam board, subject, and qualification from an SEO landing page URL path + search query.
 * Returns null if the path is not an exam board/subject landing page.
 */
export const parseLandingExamContextFromUrl = (
  pathname: string,
  search: string = ''
): LandingExamContext | null => {
  const lowerPath = (pathname || '').toLowerCase();
  const params = new URLSearchParams(search || '');
  const querySubject = (params.get('subject') || params.get('tab') || '').toLowerCase();

  let board: string | null = null;
  if (lowerPath.includes('edexcel')) {
    board = 'Pearson Edexcel';
  } else if (lowerPath.includes('aqa')) {
    board = 'AQA';
  } else if (lowerPath.includes('ocr')) {
    board = 'OCR';
  } else {
    // Match programmatic routes like /mark-:examBoard-gcse-maths-past-papers or /gcse-maths-marking/:examBoard
    const progMatch =
      lowerPath.match(/^\/mark-([a-z0-9-]+)-gcse-maths-past-papers/) ||
      lowerPath.match(/^\/gcse-maths-marking\/([a-z0-9-]+)/);
    if (progMatch && progMatch[1]) {
      board = normalizeBoardLabel(progMatch[1]);
    }
  }

  if (!board) return null;

  const isEnglish =
    lowerPath.includes('english') ||
    querySubject.includes('english');

  const isALevel =
    lowerPath.includes('a-level') ||
    lowerPath.includes('alevel') ||
    querySubject.includes('alevel');

  return {
    board,
    subject: isEnglish ? 'English Language' : 'Mathematics',
    qualification: isALevel ? 'A-Level' : 'GCSE',
    sourcePath: pathname + search,
    timestamp: Date.now(),
  };
};

export const saveLandingExamContext = (context: Omit<LandingExamContext, 'timestamp'> & { timestamp?: number }): void => {
  try {
    const payload: LandingExamContext = {
      ...context,
      timestamp: context.timestamp ?? Date.now(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors in private browsing
  }
};

export const getLandingExamContext = (): LandingExamContext | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LandingExamContext;
    if (!parsed || !parsed.board || !parsed.subject) return null;
    if (parsed.timestamp && Date.now() - parsed.timestamp > MAX_CONTEXT_AGE_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const clearLandingExamContext = (): void => {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
};
