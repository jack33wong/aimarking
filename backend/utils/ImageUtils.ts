import sharp from 'sharp';

/**
 * ImageUtils - Enhanced image processing for better AI classification
 */
export class ImageUtils {

  /**
   * Normalizes the image orientation based on EXIF data and optimizes encoding.
   * (Implementation remains the same as previous successful turns)
   */
  static async normalizeOrientation(imageData: string): Promise<string> {
    try {
      const startTime = Date.now();
      let imageBuffer: Buffer;
      if (imageData.startsWith('data:')) {
        const base64Data = imageData.split(',')[1];
        if (!base64Data) throw new Error('Invalid data URL format');
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        imageBuffer = Buffer.from(imageData, 'base64');
      }

      const normalizedBuffer = await sharp(imageBuffer)
        .rotate()
        .jpeg({ quality: 95, progressive: true })
        .toBuffer();

      const normalizedBase64 = normalizedBuffer.toString('base64');
      const normalizedDataUrl = `data:image/jpeg;base64,${normalizedBase64}`;

      return normalizedDataUrl;

    } catch (error) {
      console.error('❌ [IMAGE UTILS] Error normalizing orientation, returning original:', error);
      return imageData;
    }
  }

  /**
   * Preprocess image quality using techniques optimized for handwriting recognition.
   * Aims to remove shadows and normalize background without making handwriting look like print.
   * Assumes input image orientation is already normalized.
   * @param imageData Base64 image data (Normalized orientation, Color JPEG)
   * @returns Preprocessed base64 image data (Color JPEG)
   */
  static async preProcess(imageData: string): Promise<string> {
    const res = await this.preProcessWithMetadata(imageData);
    return res.imageData;
  }

  /**
   * Preprocess image quality and return both:
   * - `imageData`: clean resized WebP for UI display/annotations and Vision Marking (no sharpen/normalize halos)
   * - `ocrImageData`: grayscale + normalized + sharpened WebP tuned for Mathpix OCR
   * Both share the exact same resized pixel dimensions so OCR coordinates align 1:1.
   */
  static async preProcessWithMetadata(imageData: string): Promise<{ imageData: string; ocrImageData?: string; width?: number; height?: number }> {
    try {
      let imageBuffer: Buffer;
      if (imageData.startsWith('data:')) {
        const base64Data = imageData.split(',')[1];
        if (!base64Data) throw new Error('Invalid data URL format');
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        imageBuffer = Buffer.from(imageData, 'base64');
      }

      // Single resize pass so display and OCR images share identical pixel dimensions
      const { data: resizedBuffer, info } = await sharp(imageBuffer)
        .resize({ width: 2000, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });

      const [displayBuffer, ocrBuffer] = await Promise.all([
        sharp(resizedBuffer)
          .webp({ quality: 90 })
          .toBuffer(),
        sharp(resizedBuffer)
          .grayscale() // Drops file size by 66% (1 channel instead of 3 RGB channels)
          .normalize() // Forces background to pure white and text to pure black
          .sharpen() // Hardens the edges of faint decimal points for Mathpix
          .webp({ quality: 90 })
          .toBuffer()
      ]);

      return {
        imageData: `data:image/webp;base64,${displayBuffer.toString('base64')}`,
        ocrImageData: `data:image/webp;base64,${ocrBuffer.toString('base64')}`,
        width: info.width,
        height: info.height
      };
    } catch (error) {
      console.error('❌ [IMAGE UTILS] Error enhancing image, returning original:', error);
      return { imageData };
    }
  }
  /**
   * Rotates an image by a specified angle.
   * @param imageData Base64 image data (Data URL or raw base64)
   * @param angle Angle in degrees (90, 180, 270)
   * @returns Rotated image buffer
   */
  static async rotateImage(imageData: string, angle: number): Promise<Buffer> {
    try {
      let imageBuffer: Buffer;
      if (imageData.startsWith('data:')) {
        const base64Data = imageData.split(',')[1];
        if (!base64Data) throw new Error('Invalid data URL format');
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        imageBuffer = Buffer.from(imageData, 'base64');
      }

      return await sharp(imageBuffer)
        .rotate(angle)
        .toBuffer();
    } catch (error) {
      console.error(`❌ [IMAGE UTILS] Error rotating image by ${angle} degrees:`, error);
      throw error;
    }
  }

  /**
   * Splits an image into a symmetric grid (1x2, 2x1, or 2x2) in reading order
   * (row-major: left-to-right, top-to-bottom), refining internal cut lines within
   * ±8% of the midpoint to land on the whitest gutter rather than slicing through text.
   */
  static async splitImageGrid(
    imageData: string,
    rows: 1 | 2,
    cols: 1 | 2
  ): Promise<Array<{ imageData: string; width: number; height: number }>> {
    try {
      const isDataUrl = imageData.startsWith('data:');
      const mimeType = isDataUrl ? imageData.split(';')[0].split(':')[1] || 'image/jpeg' : 'image/jpeg';
      let imageBuffer: Buffer;

      if (isDataUrl) {
        const base64Data = imageData.split(',')[1];
        if (!base64Data) throw new Error('Invalid data URL format');
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        imageBuffer = Buffer.from(imageData, 'base64');
      }

      const metadata = await sharp(imageBuffer).metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error('Unable to extract dimensions for grid splitting.');
      }

      const origW = metadata.width;
      const origH = metadata.height;

      if (rows === 1 && cols === 1) {
        return [{ imageData, width: origW, height: origH }];
      }

      // Compute refined cut coordinates using a fast downscaled grayscale buffer
      let splitX = Math.floor(origW / 2);
      let splitY = Math.floor(origH / 2);

      try {
        const sampleW = Math.min(origW, 240);
        const sampleH = Math.max(1, Math.round((origH / origW) * sampleW));
        const { data: gray, info } = await sharp(imageBuffer)
          .resize({ width: sampleW, height: sampleH, fit: 'fill' })
          .grayscale()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const sW = info.width;
        const sH = info.height;

        if (cols === 2 && sW >= 20) {
          const midX = Math.floor(sW / 2);
          const band = Math.max(2, Math.floor(sW * 0.08));
          let bestX = midX;
          let bestScore = -1;
          for (let x = Math.max(1, midX - band); x <= Math.min(sW - 2, midX + band); x++) {
            let sum = 0;
            for (let y = 0; y < sH; y++) {
              sum += gray[y * sW + x];
            }
            const mean = sum / sH;
            // Tiny center bias (0.05 brightness units per pixel away) so uniform white picks exact midpoint
            const score = mean - Math.abs(x - midX) * 0.05;
            if (score > bestScore) {
              bestScore = score;
              bestX = x;
            }
          }
          splitX = Math.max(1, Math.min(origW - 1, Math.round((bestX / sW) * origW)));
        }

        if (rows === 2 && sH >= 20) {
          const midY = Math.floor(sH / 2);
          const band = Math.max(2, Math.floor(sH * 0.08));
          let bestY = midY;
          let bestScore = -1;
          for (let y = Math.max(1, midY - band); y <= Math.min(sH - 2, midY + band); y++) {
            let sum = 0;
            const rowOffset = y * sW;
            for (let x = 0; x < sW; x++) {
              sum += gray[rowOffset + x];
            }
            const mean = sum / sW;
            const score = mean - Math.abs(y - midY) * 0.05;
            if (score > bestScore) {
              bestScore = score;
              bestY = y;
            }
          }
          splitY = Math.max(1, Math.min(origH - 1, Math.round((bestY / sH) * origH)));
        }
      } catch {
        // Fallback safely to exact geometric midpoint
      }

      const xRanges: Array<{ left: number; width: number }> =
        cols === 2
          ? [
              { left: 0, width: splitX },
              { left: splitX, width: origW - splitX }
            ]
          : [{ left: 0, width: origW }];

      const yRanges: Array<{ top: number; height: number }> =
        rows === 2
          ? [
              { top: 0, height: splitY },
              { top: splitY, height: origH - splitY }
            ]
          : [{ top: 0, height: origH }];

      const tiles: Array<{ imageData: string; width: number; height: number }> = [];
      for (const yr of yRanges) {
        for (const xr of xRanges) {
          const tileBuf = await sharp(imageBuffer)
            .extract({ left: xr.left, top: yr.top, width: xr.width, height: yr.height })
            .toBuffer();
          tiles.push({
            imageData: `data:${mimeType};base64,${tileBuf.toString('base64')}`,
            width: xr.width,
            height: yr.height
          });
        }
      }

      return tiles;
    } catch (error) {
      console.error(`❌ [IMAGE UTILS] Error splitting image grid (${rows}x${cols}):`, error);
      throw error;
    }
  }

  /**
   * Fast grayscale check for OneNote-style infinite-canvas exports where real exam content
   * sits in one horizontal half (~45%) while the opposite half is overwhelmingly empty white.
   */
  static async detectAsymmetricCanvasWhitespace(imageData: string): Promise<{
    isAsymmetricCanvas: boolean;
    leftInkRatio: number;
    rightInkRatio: number;
  }> {
    try {
      const isDataUrl = imageData.startsWith('data:');
      const base64Data = isDataUrl ? imageData.split(',')[1] : imageData;
      if (!base64Data) {
        return { isAsymmetricCanvas: false, leftInkRatio: 0, rightInkRatio: 0 };
      }
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const { data: gray, info } = await sharp(imageBuffer)
        .resize({ width: 200, withoutEnlargement: true })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const w = info.width;
      const h = info.height;
      if (w < 20 || h < 20) {
        return { isAsymmetricCanvas: false, leftInkRatio: 0, rightInkRatio: 0 };
      }

      const leftEnd = Math.floor(w * 0.45);
      const rightStart = Math.floor(w * 0.55);
      let leftInk = 0;
      let leftTotal = 0;
      let rightInk = 0;
      let rightTotal = 0;

      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < leftEnd; x++) {
          leftTotal++;
          if (gray[row + x] < 235) leftInk++;
        }
        for (let x = rightStart; x < w; x++) {
          rightTotal++;
          if (gray[row + x] < 235) rightInk++;
        }
      }

      const leftInkRatio = leftTotal > 0 ? leftInk / leftTotal : 0;
      const rightInkRatio = rightTotal > 0 ? rightInk / rightTotal : 0;

      // One side has substantial printed/handwritten exam content (>= 2.5% dark pixels)
      // while the opposite 45% of the sheet is almost completely blank (<= 0.5% dark pixels, i.e. >= 99.5% white,
      // or <= 1.2% with >= 6x contrast ratio to allow minor stray rough scribbles in OneNote whitespace).
      const leftHeavyRightBlank =
        leftInkRatio >= 0.025 && rightInkRatio <= 0.012 && leftInkRatio / Math.max(rightInkRatio, 0.0001) >= 6;
      const rightHeavyLeftBlank =
        rightInkRatio >= 0.025 && leftInkRatio <= 0.012 && rightInkRatio / Math.max(leftInkRatio, 0.0001) >= 6;

      return {
        isAsymmetricCanvas: leftHeavyRightBlank || rightHeavyLeftBlank,
        leftInkRatio,
        rightInkRatio
      };
    } catch {
      return { isAsymmetricCanvas: false, leftInkRatio: 0, rightInkRatio: 0 };
    }
  }

  /**
   * Splits a wide image down the middle vertically into two separate images (Left and Right).
   * @param imageData Base64 image data (Data URL or raw base64)
   * @returns Array of two Base64 Data URLs [LeftHalf, RightHalf]
   */
  static async splitImageVertically(imageData: string): Promise<string[]> {
    const tiles = await this.splitImageGrid(imageData, 1, 2);
    return tiles.map(t => t.imageData);
  }

  /**
   * Creates a lightweight down-sampled copy of the image for fast AI classification.
   * Maintains aspect ratio while restricting maximum width to save token bandwidth.
   * @param imageData Base64 image data
   * @param maxWidth Maximum width in pixels (default: 800)
   * @returns Down-sampled base64 image data
   */
  static async createLightweightCopy(imageData: string, maxWidth: number = 800): Promise<string> {
    try {
      let imageBuffer: Buffer;
      let mimeType = 'image/jpeg';

      if (imageData.startsWith('data:')) {
        const matches = imageData.match(/^data:(image\/\w+);base64,/);
        if (matches) mimeType = matches[1];
        const base64Data = imageData.split(',')[1];
        if (!base64Data) throw new Error('Invalid data URL format');
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        imageBuffer = Buffer.from(imageData, 'base64');
      }

      // Tier 2 (Low-Res): Extremely lightweight copy for Gemini
      const resizedBuffer = await sharp(imageBuffer)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .webp({ quality: 70 }) // Extremely lightweight
        .toBuffer();
        
      return `data:image/webp;base64,${resizedBuffer.toString('base64')}`;
    } catch (error) {
      console.error(`❌ [IMAGE UTILS] Error creating lightweight copy, falling back to original:`, error);
      return imageData;
    }
  }
}