
import { FileItem, PlatformPreset, Metadata, ValidationError } from '../types';
import JSZip from 'jszip';

export const generateId = (): string => {
  return Math.random().toString(36).substring(2, 9);
};

export const readFileAsBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

// Optimized version that compresses images before sending to API
export const readFileAsBase64ForAPI = (file: File, maxWidth: number = 1024, maxHeight: number = 1024, quality: number = 0.7): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      // For non-images, use regular base64
      readFileAsBase64(file).then(resolve).catch(reject);
      return;
    }

    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      readFileAsBase64(file).then(resolve).catch(reject);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    
    img.onload = () => {
      // Calculate new dimensions while maintaining aspect ratio
      let width = img.width;
      let height = img.height;
      
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width = width * ratio;
        height = height * ratio;
      }

      canvas.width = width;
      canvas.height = height;
      
      // Draw and compress
      ctx.drawImage(img, 0, 0, width, height);
      const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
      const base64 = compressedDataUrl.split(',')[1];
      
      // Clean up and resolve
      URL.revokeObjectURL(objectUrl);
      resolve(base64);
    };

    img.onerror = () => {
      // Fallback to regular base64 if image processing fails
      URL.revokeObjectURL(objectUrl);
      readFileAsBase64(file).then(resolve).catch(reject);
    };

    img.src = objectUrl;
  });
};

export const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsText(file);
    });
};

export const getVideoFrames = (file: File): Promise<{ previewUrl: string, frames: string[] }> => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject('Not in browser');
    
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    const canvas = document.createElement('canvas');
    const apiCanvas = document.createElement('canvas'); // Separate canvas for API frames (smaller)
    const frames: string[] = [];
    let previewUrl = '';

    video.onloadeddata = () => {
      const duration = video.duration;
      
      // Strategic frame capture: 2-3 frames for better AI context
      // 1. Early frame (2s) - subject establishment
      // 2. Midpoint - action/transition
      // 3. Near end (if video is long enough) - conclusion
      const framePoints: number[] = [];
      
      if (duration > 10) {
        // Long video: capture 3 frames
        framePoints.push(Math.min(2, duration * 0.1)); // Early (2s or 10%)
        framePoints.push(duration * 0.5); // Middle
        framePoints.push(duration * 0.9); // Near end
      } else if (duration > 3) {
        // Medium video: capture 2 frames
        framePoints.push(Math.min(2, duration * 0.2)); // Early (2s or 20%)
        framePoints.push(duration * 0.7); // Later
      } else {
        // Short video: just 1 frame at midpoint
        framePoints.push(duration * 0.5);
      }

      let currentFrameIndex = 0;
      
      const captureFrame = () => {
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          // Retry after a small delay
          setTimeout(() => {
            if (video.videoWidth === 0 || video.videoHeight === 0) {
              URL.revokeObjectURL(objectUrl);
              reject(new Error("Video dimensions not available"));
              return;
            }
            captureFrame();
          }, 300);
          return;
        }

        const ctx = canvas.getContext('2d');
        const apiCtx = apiCanvas.getContext('2d');
        
        if (!ctx || !apiCtx) {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("Canvas context not available"));
          return;
        }

        // Full size for preview (only capture once)
        if (!previewUrl) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          previewUrl = canvas.toDataURL('image/jpeg', 0.8);
        }

        // Small size (512x512 max) for API to reduce payload
        const maxApiSize = 512;
        let apiWidth = video.videoWidth;
        let apiHeight = video.videoHeight;
        
        if (apiWidth > maxApiSize || apiHeight > maxApiSize) {
          const ratio = Math.min(maxApiSize / apiWidth, maxApiSize / apiHeight);
          apiWidth = apiWidth * ratio;
          apiHeight = apiHeight * ratio;
        }

        apiCanvas.width = apiWidth;
        apiCanvas.height = apiHeight;
        apiCtx.drawImage(video, 0, 0, apiWidth, apiHeight);
        
        // Low quality for API (0.5) to minimize payload size
        const apiDataUrl = apiCanvas.toDataURL('image/jpeg', 0.5);
        frames.push(apiDataUrl.split(',')[1]);

        // Move to next frame
        currentFrameIndex++;
        if (currentFrameIndex < framePoints.length) {
          video.currentTime = framePoints[currentFrameIndex];
        } else {
          // All frames captured
          URL.revokeObjectURL(objectUrl);
          resolve({ previewUrl, frames });
        }
      };

      video.onseeked = () => {
        // Small delay to ensure frame is decoded
        setTimeout(captureFrame, 200);
      };

      // Start capturing first frame
      video.currentTime = framePoints[0];
    };

    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Video load failed"));
    };

    // Fail-safe timeout
    setTimeout(() => {
      if (frames.length === 0) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Video frame capture timed out"));
      }
    }, 15000);
  });
};

export const calculateOverlap = (a: string[], b: string[]): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a.map(k => k.toLowerCase()));
  const setB = new Set(b.map(k => k.toLowerCase()));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
};

export const validateMetadata = (meta: Metadata): ValidationError[] => {
  const errors: ValidationError[] = [];
  if (meta.title.length < 5) errors.push({ type: 'error', message: 'Title is too short for SEO.', field: 'title' });
  if (meta.title.length > 200) errors.push({ type: 'error', message: 'Title exceeds platform limits (200 chars).', field: 'title' });
  
  if (meta.keywords.length < 49) {
    errors.push({ type: 'warning', message: 'Fewer than 49 keywords reduces discoverability.', field: 'keywords' });
  } else if (meta.keywords.length > 50) {
    errors.push({ type: 'error', message: 'Over 50 keywords may cause upload rejection.', field: 'keywords' });
  }
  
  const uniqueKws = new Set(meta.keywords.map(k => k.toLowerCase().trim()));
  if (uniqueKws.size < meta.keywords.length) {
    errors.push({ type: 'error', message: 'Duplicate keywords detected.', field: 'keywords' });
  }

  const forbidden = ['best', 'free', 'new', 'cheap', 'high quality'];
  const foundForbidden = meta.keywords.filter(k => forbidden.includes(k.toLowerCase()));
  if (foundForbidden.length > 0) {
    errors.push({ type: 'error', message: `Remove generic promotional words: ${foundForbidden.join(', ')}`, field: 'keywords' });
  }

  return errors;
};

export const calculateReadinessScore = (meta: Metadata, risks: string[]): number => {
  let score = 100;
  if (meta.title.length < 30 || meta.title.length > 180) score -= 15;
  if (meta.keywords.length < 40) score -= 20;
  else if (meta.keywords.length < 49) score -= 5;
  score -= (risks.length * 20);
  const validationErrors = validateMetadata(meta);
  const hardErrors = validationErrors.filter(e => e.type === 'error').length;
  score -= (hardErrors * 25);
  return Math.max(0, Math.min(100, score));
};

export const generateFilename = (title: string, originalFilename: string): string => {
    if (!title) return originalFilename;
    const extension = originalFilename.split('.').pop();
    const nameWithoutExt = originalFilename.substring(0, originalFilename.lastIndexOf('.'));
    let slug = title.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-');
    if (!slug) slug = nameWithoutExt.toLowerCase().replace(/\s+/g, '-');
    return `${slug}.${extension}`;
};

export const generateCsvContent = (files: FileItem[], preset: PlatformPreset = PlatformPreset.STANDARD): string => {
  let headers: string[] = [];
  switch(preset) {
    case PlatformPreset.GETTY: headers = ['Filename', 'Title', 'Keywords', 'Description']; break;
    case PlatformPreset.ADOBE: headers = ['Filename', 'Title', 'Keywords', 'Category', 'Releases']; break;
    default: headers = ['Filename', 'Title', 'Keywords', 'Category', 'Releases', 'Description'];
  }
  
  const toCsvField = (v: string) => {
    const val = v || '';
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const rows = files.map(item => {
    const filename = item.newFilename || item.fileName || (item.file ? item.file.name : 'unknown');
    const fn = toCsvField(filename);
    const title = toCsvField(item.metadata.title);
    const kws = toCsvField(item.metadata.keywords.join(', '));
    const cat = toCsvField(item.metadata.category);
    const rel = toCsvField(item.metadata.releases || '');
    const desc = toCsvField(item.metadata.description);

    if (preset === PlatformPreset.GETTY) return `${fn},${title},${kws},${desc}`;
    if (preset === PlatformPreset.ADOBE) return `${fn},${title},${kws},${cat},${rel}`;
    return `${fn},${title},${kws},${cat},${rel},${desc}`;
  });

  return [headers.join(','), ...rows].join('\n');
};

export const downloadCsv = (files: FileItem[], preset: PlatformPreset = PlatformPreset.STANDARD) => {
  if (typeof window === 'undefined') return;
  const content = generateCsvContent(files, preset);
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pitagger_${preset.toLowerCase().replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const downloadAllFiles = async (files: FileItem[]) => {
  if (typeof window === 'undefined') return;
  const zip = new JSZip();
  
  for (const item of files) {
    if (item.file) {
      const filename = item.newFilename || item.fileName || item.file.name;
      zip.file(filename, item.file);
    }
  }
  
  const content = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pitagger_batch_${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};