/**
 * PdfProcessingService
 * Converts uploaded PDF buffers into high-clarity page images (base64 data URLs)
 * using 3-page chunked sub-PDF isolation to keep Cloud Run /tmp (tmpfs) and libvips RAM flat (< 500 MB).
 */

import { fromPath } from "pdf2pic";
import sharp from 'sharp';
import { PDFDocument, PDFPage } from 'pdf-lib';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { UserFacingError } from '../../utils/UserFacingError.js';

const execFileAsync = promisify(execFile);

export interface PdfHeaderPeekResult {
  headerText: string;
  hasTextLayer: boolean;
  isDigitalMarkScheme: boolean;
  isStudentPaper: boolean;
}

// Disable libvips internal operation cache in Cloud Run so native C++ memory is freed immediately after each page
sharp.cache(false);
sharp.concurrency(4);

interface StandardizedPage {
  pageIndex: number; // 0-based index
  imageData: string; // base64 data URL ("data:image/jpeg;base64,...")
  originalFileName?: string;
  width?: number;
  height?: number;
}

interface ConversionResult {
  page: number;
  name: string;
  path: string;
  size?: string;
  height?: number;
  width?: number;
}

const MAX_PIXEL_DIMENSION = 10000; // Well below GraphicsMagick's 65500px JPEG limit

export class PdfProcessingService {
  /**
   * Returns visual page dimensions in PDF points after applying /Rotate (90/270 swaps width & height).
   */
  private static getVisualPageSize(page: PDFPage): { width: number; height: number } {
    const { width, height } = page.getSize();
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    if (angle === 90 || angle === 270) {
      return { width: height, height: width };
    }
    return { width, height };
  }

  /**
   * Rejects ultra-tall continuous-scroll PDF pages (e.g. Apple Notes / GoodNotes infinite-canvas exports)
   * where fixed-height slicing cuts questions across boundaries and embedded handwriting is often too faint.
   */
  private static validateNoContinuousScrollPages(srcPdfDoc: PDFDocument): void {
    const pages = srcPdfDoc.getPages();
    if (pages.length === 0 || pages.length > 3) return;

    const hasContinuousPage = pages.some((p) => {
      const { width, height } = this.getVisualPageSize(p);
      return width > 0 && height / width > 2.5;
    });

    if (hasContinuousPage) {
      throw new UserFacingError({
        code: 'PDF_CONTINUOUS_PAGE',
        category: 'user_fixable',
        userMessage:
          'We couldn\'t mark this file accurately because it is saved as a single continuous scrolling page, which makes questions and handwriting too faint or cut off.\n\n**How to fix:** Export it as separate pages (e.g. **Print → Save as PDF**), or upload clear screenshots of each page.',
        technicalMessage: 'Continuous-scroll PDF page detected (aspect ratio > 2.5).'
      });
    }
  }

  /**
   * Shared sharp optimization pipeline with mild contrast boost & sharpening for faint pencil/stylus strokes.
   */
  private static async optimizeRasterizedPage(filePath: string) {
    return sharp(filePath)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .grayscale()
      .linear(1.12, -15)
      .sharpen({ sigma: 0.8 })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
  }

  /**
   * Fast pre-rasterization page count check using pdf-lib (~5-15ms).
   * Returns null if pdf-lib cannot parse the buffer (caller should fall back to normal conversion).
   */
  static async getPdfPageCount(pdfBuffer: Buffer): Promise<number | null> {
    try {
      let cleanPdfBytes: Uint8Array | Buffer = pdfBuffer;
      const headerOffset = pdfBuffer.indexOf('%PDF-');
      if (headerOffset > 0 && headerOffset < 4096) {
        cleanPdfBytes = pdfBuffer.subarray(headerOffset);
      }
      const doc = await PDFDocument.load(cleanPdfBytes, { ignoreEncryption: true });
      return doc.getPageCount();
    } catch {
      return null;
    }
  }

  /**
   * Classifies extracted PDF page 1-2 text as a digital mark scheme vs student question paper.
   * Zero API cost; purely deterministic content-based classification.
   */
  static detectMarkSchemeFromHeaderText(headerText: string): PdfHeaderPeekResult {
    const normalized = (headerText || '').replace(/\0/g, ' ').replace(/\s+/g, ' ').trim();
    const hasTextLayer = normalized.length >= 30;
    if (!hasTextLayer) {
      return {
        headerText: normalized,
        hasTextLayer: false,
        isDigitalMarkScheme: false,
        isStudentPaper: false
      };
    }

    const strongMarkSchemeHeaderRegex =
      /\b(mark\s+scheme|marking\s+scheme|general\s+marking\s+guidance|general\s+marking\s+principles|guidance\s+on\s+applying\s+the\s+mark\s+scheme)\b/i;
    const secondaryMarkSchemeRegex =
      /\b(marking\s+guidance|marking\s+instructions|examiners?\s+should\s+apply|principal\s+examiner|allow\s+follow\s+through|method\s+marks?\s*\(\s*m\s*\)|accuracy\s+marks?\s*\(\s*a\s*\))\b/i;
    const studentPaperVetoRegex =
      /\b(candidate\s+surname|other\s+names|centre\s+number|candidate\s+number|write\s+your\s+answers\s+in\s+the\s+spaces\s+provided|do\s+not\s+write\s+outside\s+the\s+box|answer\s+all\s+questions|turn\s+over\s+for\s+the\s+next\s+question|you\s+must\s+have\s*:\s*ruler|time\s+allowed\s*:)\b/i;

    const hasStrongMs = strongMarkSchemeHeaderRegex.test(normalized);
    const hasSecondaryMs = secondaryMarkSchemeRegex.test(normalized);
    const hasStudentVeto = studentPaperVetoRegex.test(normalized);

    const isStudentPaper = hasStudentVeto && !hasStrongMs;
    const isDigitalMarkScheme = (hasStrongMs || hasSecondaryMs) && !isStudentPaper;

    return {
      headerText: normalized,
      hasTextLayer: true,
      isDigitalMarkScheme,
      isStudentPaper
    };
  }

  /**
   * Fast, zero-API-cost text extraction of the first 1-2 pages of a PDF using Ghostscript (`txtwrite`).
   * Decompresses FlateDecode/compressed PDF streams in ~15-40ms. Returns '' on scanned PDFs or errors.
   */
  static async peekPdfHeaderText(pdfBuffer: Buffer, maxPages: number = 2): Promise<string> {
    if (!pdfBuffer || pdfBuffer.length < 8) return '';
    const headerOffset = pdfBuffer.indexOf('%PDF-');
    if (headerOffset < 0 || headerOffset >= 4096) return '';

    const cleanPdfBytes = headerOffset > 0 ? pdfBuffer.subarray(headerOffset) : pdfBuffer;
    const tempPdfPath = path.join(os.tmpdir(), `pdf-peek-${uuidv4()}.pdf`);
    try {
      await fs.writeFile(tempPdfPath, cleanPdfBytes);
      const { stdout } = await execFileAsync(
        'gs',
        [
          '-q',
          '-dNOPAUSE',
          '-dBATCH',
          '-dSAFER',
          '-sDEVICE=txtwrite',
          '-dFirstPage=1',
          `-dLastPage=${Math.max(1, maxPages)}`,
          '-sOutputFile=-',
          tempPdfPath
        ],
        { timeout: 3000, maxBuffer: 512 * 1024 }
      );
      return (stdout || '').replace(/\0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
    } catch {
      return '';
    } finally {
      await fs.unlink(tempPdfPath).catch(() => {});
    }
  }

  /**
   * Combined fast PDF page 1-2 text peek + content-based mark scheme classification.
   */
  static async peekPdfMarkSchemeMetadata(pdfBuffer: Buffer): Promise<PdfHeaderPeekResult> {
    const headerText = await this.peekPdfHeaderText(pdfBuffer, 2);
    return this.detectMarkSchemeFromHeaderText(headerText);
  }

  /**
   * Converts a PDF buffer into an array of standardized JPEG base64 data URLs.
   * Uses 3-page sub-PDF chunking so Ghostscript never parses a massive PDF 15 times
   * and /tmp (Cloud Run RAM disk) never holds more than 3 uncompressed pages at once.
   */
  static async convertPdfToImages(
    pdfBuffer: Buffer,
    options: any = {}
  ): Promise<StandardizedPage[]> {
    const startTime = Date.now();
    const { maxPages, maxPagesErrorMessage, selectedPageIndices, ...pdf2picCustomOptions } = options;

    let tempDirPath: string | undefined;
    try {
      tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2pic-'));
    } catch (dirError) {
      console.error('❌ [PDF Processing] Failed to create temporary directory:', dirError);
      throw new Error('Failed to create temporary directory for PDF conversion.');
    }

    // 1. Strip leading junk/whitespace/BOM before %PDF- header if present
    let cleanPdfBytes: Uint8Array | Buffer = pdfBuffer;
    const headerOffset = pdfBuffer.indexOf('%PDF-');
    if (headerOffset > 0 && headerOffset < 4096) {
      console.log(`🧼 [PDF-REPAIR] Stripped ${headerOffset} leading bytes before %PDF- header.`);
      cleanPdfBytes = pdfBuffer.subarray(headerOffset);
    }

    let srcPdfDoc: PDFDocument | null = null;
    let pageCount = 1;
    let knownPageCount = 0;
    let pdfPtW = 595.28; // Standard A4 width in PDF points
    let pdfPtH = 841.89; // Standard A4 height in PDF points

    try {
      console.log("🧼 [PDF-REPAIR] Loading document into pdf-lib to check page count & clean structural metadata...");
      srcPdfDoc = await PDFDocument.load(cleanPdfBytes, { ignoreEncryption: true });
      pageCount = srcPdfDoc.getPageCount();
      knownPageCount = pageCount;

      // ⚡ INSTANT PAGE GATING (0.05s instead of rasterizing)
      if (maxPages && pageCount > maxPages) {
        const customMsg = typeof maxPagesErrorMessage === 'function'
          ? maxPagesErrorMessage(pageCount)
          : maxPagesErrorMessage;
        const msg = customMsg || `PDF_PAGE_LIMIT_EXCEEDED: Upload exceeds the maximum limit of ${maxPages} pages (found ${pageCount} pages).`;
        const finalMsg = msg.startsWith('PDF_PAGE_LIMIT_EXCEEDED:') ? msg : `PDF_PAGE_LIMIT_EXCEEDED: ${msg}`;
        throw new Error(finalMsg);
      }

      if (pageCount > 0) {
        const firstPage = srcPdfDoc.getPages()[0];
        const size = this.getVisualPageSize(firstPage);
        if (size.width > 0 && size.height > 0) {
          pdfPtW = size.width;
          pdfPtH = size.height;
        }
      }

      if (srcPdfDoc.isEncrypted) {
        console.warn(`🔒 [PDF-REPAIR] Encrypted/owner-protected PDF detected (${pageCount} pages). Bypassing pdf-lib sub-PDF rewrite so Ghostscript can decrypt streams natively.`);
        srcPdfDoc = null;
      } else {
        this.validateNoContinuousScrollPages(srcPdfDoc);
        console.log(`✨ [PDF-REPAIR] Validated ${pageCount} pages. Ready for chunked rasterization.`);
      }
    } catch (repairError: any) {
      if (repairError instanceof UserFacingError) {
        try {
          if (tempDirPath) await fs.rm(tempDirPath, { recursive: true, force: true });
        } catch (_) {}
        throw repairError;
      }
      if (repairError?.message?.includes('PDF_PAGE_LIMIT_EXCEEDED')) {
        try {
          if (tempDirPath) await fs.rm(tempDirPath, { recursive: true, force: true });
        } catch (_) {}
        throw new UserFacingError({
          code: 'PDF_PAGE_LIMIT_EXCEEDED',
          category: 'user_fixable',
          userMessage: repairError.message.replace('PDF_PAGE_LIMIT_EXCEEDED: ', '')
        });
      }
      console.warn("⚠️ [PDF-REPAIR] pdf-lib load failed. Falling back to direct whole-file chunking.", repairError);
      srcPdfDoc = null;
    }

    // 2. HIGH-CLARITY ADAPTIVE DPI (Preserves crisp superscripts/fractions while staying well under 4 GiB RAM):
    // - 1 to 6 pages: 260 DPI (~2158 x 3052 px)
    // - 7+ pages:     220 DPI (~1826 x 2582 px — ideal for Google Vision & Gemini OCR)
    const TARGET_DENSITY = pageCount <= 6 ? 260 : 220;
    const rawTargetWidth = Math.round((pdfPtW / 72) * TARGET_DENSITY);
    const rawTargetHeight = Math.round((pdfPtH / 72) * TARGET_DENSITY);
    const dimScale = Math.min(1, MAX_PIXEL_DIMENSION / Math.max(rawTargetWidth, rawTargetHeight, 1));
    const targetWidth = Math.max(1, Math.round(rawTargetWidth * dimScale));
    const targetHeight = Math.max(1, Math.round(rawTargetHeight * dimScale));

    const CHUNK_SIZE = 6; // Process 6 pages per sub-PDF chunk (halves Ghostscript + pdf-lib overhead while keeping RAM bounded)
    const standardizedPages: StandardizedPage[] = [];

    const normalizedSelectedIndices: number[] | null =
      knownPageCount > 0 && Array.isArray(selectedPageIndices) && selectedPageIndices.length > 0
        ? Array.from(
            new Set(
              selectedPageIndices
                .map(Number)
                .filter((n) => Number.isInteger(n) && n >= 0 && n < knownPageCount)
            )
          ).sort((a, b) => a - b)
        : null;

    if (
      knownPageCount > 0 &&
      Array.isArray(selectedPageIndices) &&
      selectedPageIndices.length > 0 &&
      normalizedSelectedIndices &&
      normalizedSelectedIndices.length === 0
    ) {
      try {
        if (tempDirPath) await fs.rm(tempDirPath, { recursive: true, force: true });
      } catch (_) {}
      return [];
    }

    try {
      if (srcPdfDoc && pageCount > 0) {
        // 3A. CHUNKED SUB-PDF RASTERIZATION (Fastest & lowest memory footprint on Cloud Run)
        const pagesToRasterize = normalizedSelectedIndices ?? Array.from({ length: pageCount }, (_, i) => i);
        if (normalizedSelectedIndices) {
          console.log(`✂️ [PDF Processing] Pre-rasterization filter: rasterizing ${pagesToRasterize.length}/${pageCount} selected page(s).`);
        }
        for (let chunkStart = 0; chunkStart < pagesToRasterize.length; chunkStart += CHUNK_SIZE) {
          const pageIndices = pagesToRasterize.slice(chunkStart, chunkStart + CHUNK_SIZE);

          const chunkPdfPath = path.join(tempDirPath, `chunk_${chunkStart}_${uuidv4()}.pdf`);
          try {
            // Create a lightweight 3-page PDF in memory and write to /tmp
            const chunkDoc = await PDFDocument.create();
            const copiedPages = await chunkDoc.copyPages(srcPdfDoc, pageIndices);
            copiedPages.forEach((cp) => chunkDoc.addPage(cp));
            const chunkBytes = await chunkDoc.save();
            await fs.writeFile(chunkPdfPath, Buffer.from(chunkBytes));

            const chunkOptions: any = {
              density: TARGET_DENSITY,
              format: "jpeg", // Write JPEG directly from GM/GS instead of uncompressed 35MB PNGs!
              quality: 92,
              savePath: tempDirPath,
              saveFilename: `page_${chunkStart}_${uuidv4()}`,
              width: targetWidth,
              height: targetHeight,
              preserveAspectRatio: true,
              compression: "jpeg",
              "-background": "white",
              "-alpha": "remove",
              "-flatten": true,
              ...pdf2picCustomOptions
            };

            const convertChunk = fromPath(chunkPdfPath, chunkOptions);
            const chunkResults = (await convertChunk.bulk(-1)) as unknown as ConversionResult[];

            if (Array.isArray(chunkResults)) {
              chunkResults.sort((a, b) => (a.page || 0) - (b.page || 0));

              const chunkPages = await Promise.all(
                chunkResults.map(async (res, j): Promise<{ page: StandardizedPage; isBlankWhite: boolean } | null> => {
                  const globalPageIndex = pageIndices[j] ?? (chunkStart + j);
                  if (!res || !res.path) return null;

                  try {
                    // Single-pass sharp optimization + dimension extraction in parallel across chunk pages
                    const { data: optimizedBuffer, info } = await this.optimizeRasterizedPage(res.path);

                    // Immediately delete the rasterized page file from /tmp RAM disk
                    await fs.unlink(res.path).catch(() => {});

                    // On Chunk 0, check if pdf-lib copyPages produced a 100% solid white blank page (<1ms via sharp.stats)
                    let isBlankWhite = false;
                    if (chunkStart === 0) {
                      try {
                        const stats = await sharp(optimizedBuffer).stats();
                        isBlankWhite = stats.channels.length > 0 && stats.channels.every(c => c.stdev < 0.8 && c.mean > 250);
                      } catch (_) {}
                    }

                    if (info.width && info.height) {
                      return {
                        page: {
                          pageIndex: globalPageIndex,
                          imageData: `data:image/jpeg;base64,${optimizedBuffer.toString('base64')}`,
                          width: info.width,
                          height: info.height
                        },
                        isBlankWhite
                      };
                    }
                    return null;
                  } catch (pageErr) {
                    console.error(`❌ [PDF Processing] Failed to optimize page ${globalPageIndex + 1}:`, pageErr);
                    await fs.unlink(res.path).catch(() => {});
                    return null;
                  }
                })
              );

              const validChunkEntries = chunkPages.filter((entry): entry is { page: StandardizedPage; isBlankWhite: boolean } => entry !== null);
              if (chunkStart === 0 && validChunkEntries.length > 0 && validChunkEntries.every(e => e.isBlankWhite)) {
                console.warn(`⚠️ [PDF-REPAIR] Chunk 0 (${validChunkEntries.length} page(s)) rendered 100% blank white via pdf-lib sub-document. Falling back to direct Ghostscript rasterization!`);
                standardizedPages.length = 0;
                break;
              }

              validChunkEntries.forEach((entry) => {
                standardizedPages.push(entry.page);
              });
            }
          } finally {
            // Immediately delete the sub-PDF from /tmp RAM disk before starting the next chunk
            await fs.unlink(chunkPdfPath).catch(() => {});
          }
        }

        // Release srcPdfDoc reference
        srcPdfDoc = null;
      }

      if (standardizedPages.length === 0) {
        // 3B. DIRECT GHOSTSCRIPT RASTERIZATION (For encrypted/owner-protected PDFs or non-standard stream PDFs):
        const fallbackPdfPath = path.join(tempDirPath, `fallback_${Date.now()}.pdf`);
        await fs.writeFile(fallbackPdfPath, Buffer.from(cleanPdfBytes));

        try {
          const fallbackOptions: any = {
            density: TARGET_DENSITY,
            format: "jpeg",
            quality: 90,
            savePath: tempDirPath,
            saveFilename: `fb_page_${uuidv4()}`,
            width: targetWidth,
            height: targetHeight,
            preserveAspectRatio: true,
            compression: "jpeg",
            "-background": "white",
            "-alpha": "remove",
            "-flatten": true,
            ...pdf2picCustomOptions
          };

          const convertFallback = fromPath(fallbackPdfPath, fallbackOptions);

          if (knownPageCount > 0) {
            const fallbackIndices = normalizedSelectedIndices ?? Array.from({ length: knownPageCount }, (_, i) => i);
            for (let chunkStart = 0; chunkStart < fallbackIndices.length; chunkStart += CHUNK_SIZE) {
              const chunkZeroBased = fallbackIndices.slice(chunkStart, chunkStart + CHUNK_SIZE);
              const pageNumbers = chunkZeroBased.map((p) => p + 1);
              const chunkResults = (await convertFallback.bulk(pageNumbers)) as unknown as ConversionResult[];
              if (Array.isArray(chunkResults)) {
                chunkResults.sort((a, b) => (a.page || 0) - (b.page || 0));
                const chunkPages = await Promise.all(
                  chunkResults.map(async (res, j): Promise<StandardizedPage | null> => {
                    const globalPageIndex = chunkZeroBased[j] ?? (chunkStart + j);
                    if (!res?.path) return null;
                    try {
                      const { data: optimizedBuffer, info } = await this.optimizeRasterizedPage(res.path);
                      await fs.unlink(res.path).catch(() => {});
                      if (info.width && info.height) {
                        return {
                          pageIndex: globalPageIndex,
                          imageData: `data:image/jpeg;base64,${optimizedBuffer.toString('base64')}`,
                          width: info.width,
                          height: info.height
                        };
                      }
                      return null;
                    } catch (err) {
                      await fs.unlink(res.path).catch(() => {});
                      return null;
                    }
                  })
                );
                chunkPages.forEach((p) => {
                  if (p) standardizedPages.push(p);
                });
              }
            }
          } else {
            const results = (await convertFallback.bulk(-1)) as unknown as ConversionResult[];
            if (Array.isArray(results)) {
              results.sort((a, b) => (a.page || 0) - (b.page || 0));
              for (let i = 0; i < results.length; i++) {
                const res = results[i];
                if (!res?.path) continue;
                try {
                  const { data: optimizedBuffer, info } = await this.optimizeRasterizedPage(res.path);

                  await fs.unlink(res.path).catch(() => {});

                  if (info.width && info.height) {
                    standardizedPages.push({
                      pageIndex: i,
                      imageData: `data:image/jpeg;base64,${optimizedBuffer.toString('base64')}`,
                      width: info.width,
                      height: info.height
                    });
                  }
                } catch (err) {
                  await fs.unlink(res.path).catch(() => {});
                }
              }
            }
          }
        } finally {
          await fs.unlink(fallbackPdfPath).catch(() => {});
        }
      }

      if (standardizedPages.length === 0) {
        throw new Error('PDF conversion returned no valid pages.');
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`✅ [PDF Processing] Converted ${standardizedPages.length} pages at ${TARGET_DENSITY} DPI in ${duration}s.`);
      return standardizedPages;

    } catch (error) {
      if (error instanceof UserFacingError) {
        throw error;
      }

      console.error('❌ [PDF Processing] PDF conversion failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes('Postscript delegate failed') || errorMessage.includes('gm identify')) {
        throw new UserFacingError({
          code: 'PDF_UNREADABLE',
          category: 'user_fixable',
          userMessage: 'We couldn\'t read this PDF because it appears corrupted, password-protected, or in an unsupported format.\n\n**How to fix:** Open the file, choose **Print → Save as PDF**, and upload the new file.',
          technicalMessage: errorMessage
        });
      }

      if (errorMessage.includes('Maximum supported image dimension')) {
        throw new UserFacingError({
          code: 'PDF_OVERSIZED_PAGE',
          category: 'user_fixable',
          userMessage: 'This PDF has an unusually large continuous page that couldn\'t be processed.\n\n**How to fix:** Open the file, choose **Print → Save as PDF** (as separate A4 pages), or upload screenshots of each page.',
          technicalMessage: errorMessage
        });
      }

      throw new Error(`PDF processing failed: ${errorMessage}`);
    } finally {
      try {
        if (tempDirPath) {
          await fs.rm(tempDirPath, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        console.error(`⚠️ [PDF Processing] Failed to clean up temporary directory ${tempDirPath}:`, cleanupError);
      }
    }
  }
}

export default PdfProcessingService;
