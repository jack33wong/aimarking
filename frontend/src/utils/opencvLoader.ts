const OPENCV_CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://docs.opencv.org/4.x/opencv.js'
];

let openCvLoadPromise: Promise<any> | null = null;

const isOpenCvReady = (): boolean =>
  typeof window !== 'undefined' && Boolean((window as any).cv && (window as any).cv.Mat);

const waitForRuntimeReady = (timeoutMs = 20000): Promise<any> =>
  new Promise((resolve, reject) => {
    if (isOpenCvReady()) {
      resolve((window as any).cv);
      return;
    }

    const start = Date.now();
    const timer = window.setInterval(() => {
      if (isOpenCvReady()) {
        window.clearInterval(timer);
        resolve((window as any).cv);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        window.clearInterval(timer);
        reject(new Error('OpenCV runtime initialization timed out'));
      }
    }, 100);
  });

const loadScript = (src: string, timeoutMs = 20000): Promise<void> =>
  new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = src;
    script.type = 'text/javascript';

    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error(`Timed out loading OpenCV from ${src}`));
    }, timeoutMs);

    script.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };

    script.onerror = () => {
      window.clearTimeout(timeout);
      script.remove();
      reject(new Error(`Failed to load OpenCV from ${src}`));
    };

    document.head.appendChild(script);
  });

/**
 * Lazily loads OpenCV.js only when the document scanner is used,
 * preventing page-load blocking when docs.opencv.org is slow or unavailable.
 */
export const ensureOpenCvLoaded = (): Promise<any> => {
  if (isOpenCvReady()) {
    return Promise.resolve((window as any).cv);
  }

  if (openCvLoadPromise) {
    return openCvLoadPromise;
  }

  openCvLoadPromise = (async () => {
    let lastError: unknown = null;

    for (const url of OPENCV_CDN_URLS) {
      try {
        await loadScript(url);
        return await waitForRuntimeReady();
      } catch (err) {
        lastError = err;
      }
    }

    openCvLoadPromise = null;
    throw lastError instanceof Error ? lastError : new Error('Failed to load OpenCV');
  })();

  return openCvLoadPromise;
};
