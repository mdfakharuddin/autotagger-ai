
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
    const frames: string[] = [];
    let previewUrl = '';

    const captureFrame = () => {
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        if (!previewUrl) previewUrl = dataUrl;
        frames.push(dataUrl.split(',')[1]);
      }
    };

    video.onloadeddata = () => {
      const duration = video.duration;
      
      /**
       * ENHANCED VIDEO ANALYSIS
       * Capturing two distinct points to better understand subject motion and environment:
       * 1. 3 seconds (Industry standard for subject establishment)
       * 2. Midpoint (To capture peak action or transition)
       */
      const points = [
        Math.min(3, Math.max(0, duration - 0.1)), // 3s mark, or near end if shorter
        duration / 2
      ].filter(p => isFinite(p));
      
      // Remove duplicates if video is very short
      const uniquePoints = Array.from(new Set(points));
      
      let currentPoint = 0;
      const seekAndCapture = () => {
        if (currentPoint < uniquePoints.length) {
          video.currentTime = uniquePoints[currentPoint];
          currentPoint++;
        } else {
          URL.revokeObjectURL(objectUrl);
          resolve({ previewUrl, frames });
        }
      };

      video.onseeked = () => {
        // Small delay to ensure frame is decoded
        setTimeout(() => {
          captureFrame();
          seekAndCapture();
        }, 200);
      };

      seekAndCapture();
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
    const fn = toCsvField(item.newFilename || item.file.name);
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