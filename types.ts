
export enum ProcessingStatus {
  PENDING = 'Queued',
  PROCESSING = 'Analyzing',
  COMPLETED = 'Completed',
  ERROR = 'Unavailable',
}

export enum AIProvider {
  GEMINI = 'Google Gemini',
}

export enum GenerationProfile {
  COMMERCIAL = 'Commercial Lifestyle',
  EDITORIAL = 'Editorial News',
  PRODUCT = 'Minimal Product',
  SCIENTIFIC = 'Medical / Scientific',
}

export enum PlatformPreset {
  STANDARD = 'Standard CSV',
  ADOBE = 'Adobe Stock',
  SHUTTERSTOCK = 'Shutterstock',
  GETTY = 'Getty / iStock',
}

export interface ApiKeyRecord {
  id: string;
  key: string;
  label: string;
  addedAt: number;
  // Internal scheduling tracking
  status: 'active' | 'cooldown';
  cooldownUntil?: number;
  lastUsedAt?: number;
  nextAllowedAt?: number;
  // Quota tracking (per minute)
  requestCount?: number;
  quotaResetAt?: number;
  requestsPerMinute?: number;
  // Daily quota tracking
  dailyRequestCount?: number;
  dailyQuotaResetAt?: number;
  requestsPerDay?: number;
}

export interface KeywordScore {
  word: string;
  score: 'strong' | 'medium' | 'weak';
  specificity: number;
  demand: number;
  platformFit: number;
  reason?: string;
}

export interface ValidationError {
  type: 'error' | 'warning';
  message: string;
  field: keyof Metadata;
}

export interface Metadata {
  title: string;
  description: string;
  keywords: string[];
  backupKeywords?: string[]; // New pool of additional suggestions
  keywordScores?: KeywordScore[];
  rejectionRisks?: string[];
  category: string;
  releases?: string;
  readinessScore?: number;
  validationErrors?: ValidationError[];
}

export interface StyleMemory {
  rejectedKeywords: string[];
  preferredTones: string[];
  lastUsedProfile: GenerationProfile;
  customProfilePrompts?: Record<GenerationProfile, string>;
  selectedModel?: string; // User-selected Gemini model
}

export interface FileItem {
  id: string;
  file?: File; // Optional when using file system handles
  fileHandle?: any; // FileSystemFileHandle when using folder access
  fileName: string; // Original filename
  filePath?: string; // Path in folder structure
  previewUrl: string;
  status: ProcessingStatus;
  metadata: Metadata;
  variantB?: Metadata;
  error?: string;
  base64Data?: string;
  base64Frames?: string[];
  newFilename?: string;
  isFromFileSystem?: boolean; // Flag to indicate if using file system API
  previewRetryCount?: number; // Track retry attempts for preview loading
  previewLoadFailed?: boolean; // Flag to indicate preview failed to load
}
