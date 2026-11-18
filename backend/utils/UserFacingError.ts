export type ErrorCategory = 'user_fixable' | 'system';

export type UserErrorCode =
  | 'PDF_UNREADABLE'
  | 'PDF_PAGE_LIMIT_EXCEEDED'
  | 'FREE_PAGE_LIMIT_EXCEEDED'
  | 'OVERDRAFT_LIMIT_EXCEEDED'
  | 'MULTI_PAPER_LOOSE_IMAGES_NOT_SUPPORTED'
  | 'COMBINED_MULTI_PAPER_PDF_NOT_SUPPORTED'
  | 'MIXED_MULTI_PAPER_UPLOAD_NOT_SUPPORTED'
  | 'AMBIGUOUS_MARK_SCHEME_PAIRING'
  | 'PDF_OVERSIZED_PAGE'
  | 'PDF_CONTINUOUS_PAGE'
  | 'PDF_TOO_BLURRY'
  | 'SYSTEM_ERROR';

export interface DetectedPaperGroup {
  paperIndex: number;
  label: string;
  subject?: string;
  pageCount: number;
  fileIndices: number[];
  rawPageIndices: number[];
  canGradeOnFree: boolean;
  hasMarkScheme?: boolean;
  markSchemeCount?: number;
  storageUrls?: string[];
  isPageChunk?: boolean;
}

export interface UserFacingErrorOptions {
  code: UserErrorCode;
  category: ErrorCategory;
  userMessage: string;
  technicalMessage?: string;
  shouldAlertAdmin?: boolean;
  requiresUpgrade?: boolean;
  detectedPaperGroups?: DetectedPaperGroup[];
}

/**
 * Standardized error for surfacing plain-language, actionable messages in the UI
 * without leaking internal stack traces or file paths.
 */
export class UserFacingError extends Error {
  public readonly code: UserErrorCode;
  public readonly category: ErrorCategory;
  public readonly userMessage: string;
  public readonly shouldAlertAdmin: boolean;
  public readonly requiresUpgrade: boolean;
  public readonly detectedPaperGroups?: DetectedPaperGroup[];

  constructor(options: UserFacingErrorOptions) {
    super(options.technicalMessage || options.userMessage);
    this.name = 'UserFacingError';
    this.code = options.code;
    this.category = options.category;
    this.userMessage = options.userMessage;
    this.shouldAlertAdmin = options.shouldAlertAdmin ?? options.category === 'system';
    this.requiresUpgrade = Boolean(options.requiresUpgrade);
    this.detectedPaperGroups = options.detectedPaperGroups;
    Object.setPrototypeOf(this, UserFacingError.prototype);
  }
}
