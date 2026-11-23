/**
 * File Utility Functions
 * Extracted from components for reusability and maintainability
 */

// File validation constants
export const FILE_CONSTRAINTS = {
  MAX_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_TYPES: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'],
  ACCEPT_ATTR: '.pdf,application/pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp',
  MIN_SIZE: 1024 // 1KB minimum
};

const STRICT_ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf'
]);

const STRICT_ALLOWED_EXTENSIONS = /\.(?:jpe?g|png|webp|pdf)$/i;

/**
 * Inspect the leading magic bytes of a File to verify it is genuinely a
 * JPEG, PNG, WebP, or PDF (catches HEIC/BMP/SVG/DOCX/corrupt/renamed files).
 * @param {File} file
 * @returns {Promise<'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | null>}
 */
export const detectSupportedMagicMime = async (file) => {
  if (!file || typeof file.size !== 'number' || file.size === 0) return null;
  if (typeof file.slice !== 'function') {
    const mime = (file.type || '').toLowerCase();
    if (STRICT_ALLOWED_MIME_TYPES.has(mime)) {
      return mime === 'image/jpg' ? 'image/jpeg' : mime;
    }
    return STRICT_ALLOWED_EXTENSIONS.test(file.name || '') ? (mime || 'image/jpeg') : null;
  }

  try {
    const slice = file.slice(0, 12);
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

    // PDF: %PDF-
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return 'application/pdf';
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
    return null;
  } catch {
    return null;
  }
};

/**
 * Validate a batch of uploaded files against the strict PDF/JPG/PNG/WebP allowlist
 * and real binary magic bytes before sending to the backend.
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
    validFiles.push(file);
  }

  let errorMessage = null;
  if (rejectedFiles.length > 0) {
    const names = rejectedFiles.map(r => `"${r.file.name || 'file'}"`).join(', ');
    errorMessage = `Unsupported or unreadable file format (${names}). Please upload a PDF, JPG, PNG, or WebP file.`;
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
