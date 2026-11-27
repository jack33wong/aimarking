/**
 * File Utility Functions
 * Extracted from components for reusability and maintainability
 */

// File validation constants
export const FILE_CONSTRAINTS = {
  MAX_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_TYPES: [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/gif',
    'image/bmp',
    'image/tiff',
    'application/pdf'
  ],
  ACCEPT_ATTR:
    '.pdf,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,image/bmp,image/tiff,.jpg,.jpeg,.png,.webp,.heic,.heif,.gif,.bmp,.tif,.tiff',
  MIN_SIZE: 1024 // 1KB minimum
};

const STRICT_ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'application/pdf'
]);

const STRICT_ALLOWED_EXTENSIONS = /\.(?:jpe?g|png|webp|heic|heif|gif|bmp|tiff?|pdf)$/i;

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx',
  'heim', 'heis', 'hevm', 'hevs',
  'mif1', 'msf1'
]);

const CONVERTIBLE_IMAGE_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/gif',
  'image/bmp',
  'image/tiff'
]);

/**
 * Inspect the leading magic bytes of a File to verify it is genuinely a
 * supported PDF or image (JPEG, PNG, WebP, HEIC/HEIF, GIF, BMP, or TIFF).
 * Catches SVG/DOCX/corrupt/renamed files.
 * @param {File} file
 * @returns {Promise<'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/gif' | 'image/bmp' | 'image/tiff' | 'application/pdf' | null>}
 */
export const detectSupportedMagicMime = async (file) => {
  if (!file || typeof file.size !== 'number' || file.size === 0) return null;
  if (typeof file.slice !== 'function') {
    const mime = (file.type || '').toLowerCase();
    if (STRICT_ALLOWED_MIME_TYPES.has(mime)) {
      if (mime === 'image/jpg') return 'image/jpeg';
      if (mime === 'image/heif') return 'image/heic';
      return mime;
    }
    return STRICT_ALLOWED_EXTENSIONS.test(file.name || '') ? (mime || 'image/jpeg') : null;
  }

  try {
    // Scan up to 2048 bytes for %PDF- header (matches backend tolerance for BOM/leading bytes)
    const slice = file.slice(0, Math.min(file.size, 2048));
    const buf = typeof slice.arrayBuffer === 'function'
      ? await slice.arrayBuffer()
      : await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsArrayBuffer(slice);
        });

    const bytes = new Uint8Array(buf);
    if (bytes.length < 4) return null;

    // PDF: %PDF- anywhere within the first 2048 bytes
    for (let i = 0; i <= bytes.length - 5; i++) {
      if (
        bytes[i] === 0x25 &&
        bytes[i + 1] === 0x50 &&
        bytes[i + 2] === 0x44 &&
        bytes[i + 3] === 0x46 &&
        bytes[i + 4] === 0x2D
      ) {
        return 'application/pdf';
      }
    }

    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return 'image/jpeg';
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
    ) {
      return 'image/png';
    }
    // WebP: RIFF....WEBP
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return 'image/webp';
    }
    // GIF: GIF87a or GIF89a
    if (
      bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
    ) {
      return 'image/gif';
    }
    // BMP: BM
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
      return 'image/bmp';
    }
    // TIFF: II*\0 (little-endian) or MM\0* (big-endian)
    if (
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A && bytes[3] === 0x00) ||
      (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0x00 && bytes[3] === 0x2A)
    ) {
      return 'image/tiff';
    }
    // HEIC/HEIF: ISO BMFF 'ftyp' box at bytes 4..7 + known HEIF brand at bytes 8..11
    if (
      bytes.length >= 12 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
    ) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
      if (HEIF_BRANDS.has(brand)) {
        return 'image/heic';
      }
    }
    return null;
  } catch {
    return null;
  }
};

const replaceExtensionWithJpg = (filename) => {
  const base = (filename || 'image').replace(/\.[^.]+$/, '');
  return `${base}.jpg`;
};

/**
 * Convert a browser-decodable image File (e.g., HEIC on Safari, BMP, GIF, TIFF)
 * to a standard JPEG File using an offscreen canvas.
 * @param {File} file
 * @returns {Promise<File | null>}
 */
const convertFileToJpegViaCanvas = async (file) => {
  if (typeof document === 'undefined') return null;

  let width = 0;
  let height = 0;
  let drawSource = null;
  let cleanup = () => {};

  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      drawSource = bitmap;
      cleanup = () => bitmap.close?.();
    } else if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Image !== 'undefined') {
      const objectUrl = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = objectUrl;
      });
      width = img.naturalWidth || img.width;
      height = img.naturalHeight || img.height;
      drawSource = img;
      cleanup = () => URL.revokeObjectURL(objectUrl);
    } else {
      return null;
    }

    if (!width || !height) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(drawSource, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob || blob.size === 0) return null;

    const converted = new File([blob], replaceExtensionWithJpg(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified || Date.now()
    });
    converted._originalSize = file.size;
    return converted;
  } catch {
    return null;
  } finally {
    cleanup();
  }
};

/**
 * Normalize convertible image formats (HEIC/HEIF, GIF, BMP, TIFF) into standard JPEG Files
 * so downstream preview, compression, pre-inspect, and marking pipelines work uniformly.
 * @param {File} file
 * @param {string} detectedMime
 * @returns {Promise<File | null>}
 */
const normalizeConvertibleImageFile = async (file, detectedMime) => {
  if (!CONVERTIBLE_IMAGE_MIMES.has(detectedMime)) {
    return file;
  }

  // 1. Try fast native browser decode first (handles HEIC natively on Safari macOS/iOS, plus GIF/BMP/TIFF)
  const nativeConverted = await convertFileToJpegViaCanvas(file);
  if (nativeConverted) {
    return nativeConverted;
  }

  // 2. Fallback for HEIC/HEIF on non-Safari browsers (Chrome, Firefox, Edge): lazy-load heic2any
  if (detectedMime === 'image/heic' || detectedMime === 'image/heif') {
    try {
      const mod = await import('heic2any');
      const heic2any = mod?.default || mod;
      if (typeof heic2any === 'function') {
        const result = await heic2any({
          blob: file,
          toType: 'image/jpeg',
          quality: 0.9
        });
        const jpegBlob = Array.isArray(result) ? result[0] : result;
        if (jpegBlob && jpegBlob.size > 0) {
          const converted = new File([jpegBlob], replaceExtensionWithJpg(file.name), {
            type: 'image/jpeg',
            lastModified: file.lastModified || Date.now()
          });
          converted._originalSize = file.size;
          return converted;
        }
      }
    } catch (err) {
      console.warn(`[FileUtils] HEIC conversion failed for "${file.name}":`, err);
    }
  }

  return null;
};

/**
 * Validate a batch of uploaded files against the supported PDF/image allowlist
 * and real binary magic bytes before sending to the backend.
 * Automatically converts HEIC/HEIF, GIF, BMP, and TIFF images to JPEG.
 * @param {FileList | File[]} fileList
 * @returns {Promise<{ validFiles: File[], rejectedFiles: Array<{ file: File, reason: string }>, errorMessage: string | null }>}
 */
export const validateSupportedUploadFiles = async (fileList) => {
  const files = Array.from(fileList || []).filter(Boolean);
  const validFiles = [];
  const rejectedFiles = [];

  for (const file of files) {
    if (!file.size || file.size === 0) {
      rejectedFiles.push({ file, reason: 'empty' });
      continue;
    }
    const detectedMime = await detectSupportedMagicMime(file);
    if (!detectedMime) {
      rejectedFiles.push({ file, reason: 'unsupported_format' });
      continue;
    }
    if (CONVERTIBLE_IMAGE_MIMES.has(detectedMime)) {
      const normalized = await normalizeConvertibleImageFile(file, detectedMime);
      if (!normalized) {
        rejectedFiles.push({ file, reason: 'conversion_failed' });
        continue;
      }
      validFiles.push(normalized);
      continue;
    }
    validFiles.push(file);
  }

  let errorMessage = null;
  if (rejectedFiles.length > 0) {
    const names = rejectedFiles.map(r => `"${r.file.name || 'file'}"`).join(', ');
    errorMessage = `Unsupported or unreadable file format (${names}). Please upload a PDF or image file (JPG, PNG, WebP, HEIC, GIF, BMP, or TIFF).`;
  }

  return { validFiles, rejectedFiles, errorMessage };
};

/**
 * Convert file to base64 string
 * @param {File} file - File to convert
 * @returns {Promise<string>} - Base64 string
 */
export const convertFileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No file provided'));
      return;
    }

    const reader = new FileReader();
    
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result);
      } else {
        reject(new Error('Failed to convert file to base64'));
      }
    };
    
    reader.onerror = () => {
      reject(new Error('Error reading file'));
    };
    
    reader.readAsDataURL(file);
  });
};

/**
 * Get file size in human readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} - Human readable size (e.g., "2.5 MB")
 */
export const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Get file extension from filename
 * @param {string} filename - File name
 * @returns {string} - File extension (e.g., "jpg", "png")
 */
export const getFileExtension = (filename) => {
  if (!filename || typeof filename !== 'string') {
    return '';
  }
  
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) {
    return '';
  }
  
  return filename.substring(lastDot + 1).toLowerCase();
};

/**
 * Check if file is an image based on MIME type
 * @param {File} file - File to check
 * @returns {boolean} - True if file is an image
 */
export const isImageFile = (file) => {
  if (!file || !file.type) {
    return false;
  }
  
  return file.type.startsWith('image/');
};

/**
 * Check if file is a PDF based on MIME type
 * @param {File} file - File to check
 * @returns {boolean} - True if file is a PDF
 */
export const isPdfFile = (file) => {
  if (!file || !file.type) {
    return false;
  }
  
  return file.type === 'application/pdf';
};

/**
 * Generate a unique filename with timestamp
 * @param {string} originalName - Original filename
 * @param {string} prefix - Optional prefix
 * @returns {string} - Unique filename
 */
export const generateUniqueFilename = (originalName, prefix = '') => {
  const timestamp = Date.now();
  const extension = getFileExtension(originalName);
  const baseName = originalName.replace(/\.[^/.]+$/, '');
  
  const uniqueName = prefix 
    ? `${prefix}_${baseName}_${timestamp}.${extension}`
    : `${baseName}_${timestamp}.${extension}`;
    
  return uniqueName;
};

/**
 * Create a file preview URL for display
 * @param {File} file - File to create preview for
 * @returns {string} - Preview URL
 */
export const createFilePreviewUrl = (file) => {
  if (!file) {
    return null;
  }
  
  return URL.createObjectURL(file);
};

/**
 * Revoke file preview URL to free memory
 * @param {string} url - Preview URL to revoke
 */
export const revokeFilePreviewUrl = (url) => {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
};
