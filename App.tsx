import React, { useState, useEffect, useCallback, useRef } from 'react';
import Header from './components/Header';
import FileUpload from './components/FileUpload';
import FileCard from './components/FileCard';
import Toast from './components/Toast';
import BatchActions from './components/BatchActions';
import MetadataSidebar from './components/MetadataSidebar';
import SettingsModal from './components/SettingsModal';
import ApiQuotaStatus from './components/ApiQuotaStatus';
import { FileItem, ProcessingStatus, ApiKeyRecord, PlatformPreset, GenerationProfile, StyleMemory } from './types';
import { generateId, readFileAsBase64, getVideoFrames, downloadCsv, generateFilename, downloadAllFiles, calculateReadinessScore } from './services/fileUtils';
import { geminiService, QuotaExceededInternal } from './services/geminiService';
import { fileSystemService, FileSystemDirectoryHandle, FileSystemFileHandle } from './services/fileSystemService';

const MIN_SAFE_INTERVAL_MS = 1200; // 1.2 seconds = ~50 requests per minute (safe limit)
const REQUESTS_PER_MINUTE = 50; // Conservative limit to avoid 429 errors
const REQUESTS_PER_DAY = 1500; // Free tier daily limit (conservative estimate) 

function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [processingCount, setProcessingCount] = useState(0);
  const [variantProcessingId, setVariantProcessingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [sidebarFileId, setSidebarFileId] = useState<string | null>(null);
  const [isQueueActive, setIsQueueActive] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [currentProfile, setCurrentProfile] = useState<GenerationProfile>(GenerationProfile.COMMERCIAL);
  
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [styleMemory, setStyleMemory] = useState<StyleMemory>({ 
    rejectedKeywords: [], 
    preferredTones: [], 
    lastUsedProfile: GenerationProfile.COMMERCIAL,
    customProfilePrompts: {} as any
  });
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);
  const [isProcessingUpload, setIsProcessingUpload] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);

  const activeProcessingIds = useRef<Set<string>>(new Set());
  const GEMINI_FREE_TIER_LIMIT = REQUESTS_PER_MINUTE; // Conservative limit to avoid 429 errors

  useEffect(() => {
    const mem = localStorage.getItem('autotagger_style_mem_v4');
    if (mem) setStyleMemory(JSON.parse(mem));

    const keys = localStorage.getItem('autotagger_api_vault_v4');
    if (keys) {
      const parsedKeys: ApiKeyRecord[] = JSON.parse(keys);
      const now = Date.now();
      setApiKeys(parsedKeys.map(k => {
        // Reset quota if window expired
        const quotaResetAt = k.quotaResetAt && k.quotaResetAt > now 
          ? k.quotaResetAt 
          : (now + 60000);
        const requestCount = (k.quotaResetAt && k.quotaResetAt > now) 
          ? (k.requestCount || 0) 
          : 0; // Reset count if window expired
        
        // Reset daily quota if window expired (24 hours)
        const dailyQuotaResetAt = k.dailyQuotaResetAt && k.dailyQuotaResetAt > now
          ? k.dailyQuotaResetAt
          : (now + 86400000); // 24 hours
        const dailyRequestCount = (k.dailyQuotaResetAt && k.dailyQuotaResetAt > now)
          ? (k.dailyRequestCount || 0)
          : 0; // Reset daily count if window expired
        
        return { 
          ...k, 
          status: 'active', 
          cooldownUntil: 0, 
          lastUsedAt: 0, 
          nextAllowedAt: 0,
          requestCount,
          quotaResetAt,
          requestsPerMinute: k.requestsPerMinute || REQUESTS_PER_MINUTE,
          dailyRequestCount,
          dailyQuotaResetAt,
          requestsPerDay: k.requestsPerDay || REQUESTS_PER_DAY
        };
      }));
    }
  }, []);

  const handleUpdateStyleMemory = (update: Partial<StyleMemory>) => {
    const newMem = { ...styleMemory, ...update };
    setStyleMemory(newMem);
    localStorage.setItem('autotagger_style_mem_v4', JSON.stringify(newMem));
  };

  const handleAddKey = (key: string, label: string) => {
    const now = Date.now();
    const newKeyRecord: ApiKeyRecord = { 
      id: generateId(), 
      key, 
      label, 
      addedAt: now,
      status: 'active',
      cooldownUntil: 0,
      lastUsedAt: 0,
      nextAllowedAt: 0,
      requestCount: 0,
      quotaResetAt: now + 60000,
      requestsPerMinute: GEMINI_FREE_TIER_LIMIT,
      dailyRequestCount: 0,
      dailyQuotaResetAt: now + 86400000, // 24 hours
      requestsPerDay: REQUESTS_PER_DAY
    };
    const newKeys = [...apiKeys, newKeyRecord];
    setApiKeys(newKeys);
    localStorage.setItem('autotagger_api_vault_v4', JSON.stringify(
      newKeys.map(({id, key, label, addedAt, requestCount, quotaResetAt, requestsPerMinute, dailyRequestCount, dailyQuotaResetAt, requestsPerDay}) => 
        ({id, key, label, addedAt, requestCount, quotaResetAt, requestsPerMinute, dailyRequestCount, dailyQuotaResetAt, requestsPerDay})
      )
    ));
  };

  const handleRemoveKey = (id: string) => {
    const newKeys = apiKeys.filter(k => k.id !== id);
    setApiKeys(newKeys);
    localStorage.setItem('autotagger_api_vault_v4', JSON.stringify(
      newKeys.map(({id, key, label, addedAt, requestCount, quotaResetAt, requestsPerMinute, dailyRequestCount, dailyQuotaResetAt, requestsPerDay}) => 
        ({id, key, label, addedAt, requestCount, quotaResetAt, requestsPerMinute, dailyRequestCount, dailyQuotaResetAt, requestsPerDay})
      )
    ));
  };

  const handleResetQuota = (id: string) => {
    const now = Date.now();
    setApiKeys(prev => prev.map(k => {
      if (k.id === id) {
        return {
          ...k,
          requestCount: 0,
          quotaResetAt: now + 60000, // Reset to new 1-minute window
          status: 'active',
          cooldownUntil: 0,
          nextAllowedAt: now,
          dailyRequestCount: 0, // Also reset daily quota
          dailyQuotaResetAt: now + 86400000 // Reset daily window
        };
      }
      return k;
    }));
    
    // Persist updated keys
    setApiKeys(currentKeys => {
      localStorage.setItem('autotagger_api_vault_v4', JSON.stringify(
        currentKeys.map(({id, key, label, addedAt, requestCount, quotaResetAt, requestsPerMinute, dailyRequestCount, dailyQuotaResetAt, requestsPerDay}) => 
          ({id, key, label, addedAt, requestCount, quotaResetAt, requestsPerMinute, dailyRequestCount, dailyQuotaResetAt, requestsPerDay})
        )
      ));
      return currentKeys;
    });
    
    setToast({ message: "Quota reset successfully", type: "success" });
  };

  // Calculate total daily quota remaining across all API keys
  const getTotalDailyQuotaRemaining = useCallback(() => {
    const now = Date.now();
    let totalUsed = 0;
    let totalLimit = 0;
    
    apiKeys.forEach(k => {
      const dailyLimit = k.requestsPerDay || REQUESTS_PER_DAY;
      const dailyUsed = (k.dailyQuotaResetAt && now < k.dailyQuotaResetAt)
        ? (k.dailyRequestCount || 0)
        : 0;
      
      totalUsed += dailyUsed;
      totalLimit += dailyLimit;
    });
    
    return {
      used: totalUsed,
      limit: totalLimit,
      remaining: Math.max(0, totalLimit - totalUsed),
      percentage: totalLimit > 0 ? (totalUsed / totalLimit) * 100 : 0
    };
  }, [apiKeys]);

  const getNextAvailableKeySlot = useCallback((): ApiKeyRecord | null => {
    const now = Date.now();
    const available = apiKeys
      .filter(k => {
        // Check timing constraints
        const timingOk = now >= (k.nextAllowedAt || 0) && (k.status === 'active' || (k.status === 'cooldown' && k.cooldownUntil! < now));
        if (!timingOk) return false;
        
        // Check quota limits - reset if window expired
        if (k.quotaResetAt && now >= k.quotaResetAt) {
          // Quota window expired, will be reset on next use
          return true;
        }
        
        // Check if quota limit reached
        const requestCount = k.requestCount || 0;
        const limit = k.requestsPerMinute || REQUESTS_PER_MINUTE;
        const quotaOk = requestCount < limit;
        
        return quotaOk;
      })
      .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));

    return available.length > 0 ? available[0] : null;
  }, [apiKeys]);

  const updateKeySlotTiming = useCallback((id: string, quotaTriggered: boolean = false) => {
    setApiKeys(prev => prev.map(k => {
      if (k.id === id) {
        const now = Date.now();
        
        // Check if quota window needs reset
        if (k.quotaResetAt && now >= k.quotaResetAt) {
          // Reset quota window - start fresh countdown
          const newQuotaResetAt = now + 60000; // 1 minute window
          if (quotaTriggered) {
            return { 
              ...k, 
              status: 'cooldown', 
              cooldownUntil: now + 60000, 
              lastUsedAt: now, 
              nextAllowedAt: now + 60000,
              requestCount: 1,
              quotaResetAt: newQuotaResetAt
            };
          }
          // Reset daily quota if window expired
          const dailyQuotaResetAt = k.dailyQuotaResetAt && now < k.dailyQuotaResetAt
            ? k.dailyQuotaResetAt
            : (now + 86400000);
          const dailyRequestCount = (k.dailyQuotaResetAt && now < k.dailyQuotaResetAt)
            ? (k.dailyRequestCount || 0) + 1
            : 1;
          
          return { 
            ...k, 
            status: 'active', 
            cooldownUntil: 0, 
            lastUsedAt: now, 
            nextAllowedAt: now + MIN_SAFE_INTERVAL_MS,
            requestCount: 1, // Reset to 1 (this request)
            quotaResetAt: newQuotaResetAt,
            dailyRequestCount,
            dailyQuotaResetAt
          };
        }
        
        // Update within current quota window
        if (quotaTriggered) {
          // Update daily quota
          const dailyQuotaResetAt = k.dailyQuotaResetAt && now < k.dailyQuotaResetAt
            ? k.dailyQuotaResetAt
            : (now + 86400000);
          const newDailyRequestCount = (k.dailyQuotaResetAt && now < k.dailyQuotaResetAt)
            ? (k.dailyRequestCount || 0) + 1
            : 1;
          
          return { 
            ...k, 
            status: 'cooldown', 
            cooldownUntil: now + 60000, 
            lastUsedAt: now, 
            nextAllowedAt: now + 60000,
            requestCount: (k.requestCount || 0) + 1,
            dailyRequestCount: newDailyRequestCount,
            dailyQuotaResetAt
          };
        }
        
        const newRequestCount = (k.requestCount || 0) + 1;
        const limit = k.requestsPerMinute || REQUESTS_PER_MINUTE;
        const isAtLimit = newRequestCount >= limit;
        
        // Update daily quota
        const dailyQuotaResetAt = k.dailyQuotaResetAt && now < k.dailyQuotaResetAt
          ? k.dailyQuotaResetAt
          : (now + 86400000);
        const newDailyRequestCount = (k.dailyQuotaResetAt && now < k.dailyQuotaResetAt)
          ? (k.dailyRequestCount || 0) + 1
          : 1;
        
        // If at limit, set cooldown until quota resets
        if (isAtLimit) {
          const resetTime = k.quotaResetAt || (now + 60000);
          return { 
            ...k, 
            status: 'cooldown', 
            cooldownUntil: resetTime, 
            lastUsedAt: now, 
            nextAllowedAt: resetTime,
            requestCount: newRequestCount,
            dailyRequestCount: newDailyRequestCount,
            dailyQuotaResetAt
          };
        }
        
        return { 
          ...k, 
          status: 'active', 
          cooldownUntil: 0, 
          lastUsedAt: now, 
          nextAllowedAt: now + MIN_SAFE_INTERVAL_MS,
          requestCount: newRequestCount,
          dailyRequestCount: newDailyRequestCount,
          dailyQuotaResetAt
        };
      }
      return k;
    }));
    
    // Persist updated keys
    setApiKeys(currentKeys => {
      localStorage.setItem('autotagger_api_vault_v4', JSON.stringify(
        currentKeys.map(({id, key, label, addedAt, requestCount, quotaResetAt, requestsPerMinute}) => 
          ({id, key, label, addedAt, requestCount, quotaResetAt, requestsPerMinute})
        )
      ));
      return currentKeys;
    });
  }, []);

  const processFile = useCallback(async (item: FileItem) => {
    if (activeProcessingIds.current.has(item.id)) return;
    
    const keySlot = getNextAvailableKeySlot();
    if (!keySlot) return;

    activeProcessingIds.current.add(item.id);
    
    try {
      setProcessingCount(p => p + 1);
      setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.PROCESSING } : f));

      // Get file for processing (either from handle or existing file object)
      let processingFile: File;
      if (item.isFromFileSystem && item.fileHandle) {
        processingFile = await fileSystemService.readFileForProcessing(item.fileHandle);
        // Cache the file object for future use
        setFiles(prev => prev.map(f => f.id === item.id ? { ...f, file: processingFile } : f));
      } else if (item.file) {
        processingFile = item.file;
      } else {
        throw new Error('No file available for processing');
      }

      const isVideo = processingFile.type.startsWith('video/');
      let payload: { base64?: string; frames?: string[]; mimeType: string };
      
      if (isVideo) {
        // Use existing frames if available, otherwise generate them
        if (item.base64Frames && item.base64Frames.length > 0) {
          payload = { frames: item.base64Frames, mimeType: 'image/jpeg' };
        } else {
          const { frames } = await getVideoFrames(processingFile);
          setFiles(prev => prev.map(f => f.id === item.id ? { ...f, base64Frames: frames } : f));
          payload = { frames, mimeType: 'image/jpeg' };
        }
      } else {
        payload = { base64: await readFileAsBase64(processingFile), mimeType: processingFile.type };
      }

      let currentKeySlot = keySlot;
      let apiKey = currentKeySlot.key;
      
      let metadata;
      let retries = 0;
      const maxRetries = 3;
      
      while (retries < maxRetries) {
        try {
          metadata = await geminiService.generateMetadata(apiKey, payload, currentProfile, styleMemory);
          updateKeySlotTiming(currentKeySlot.id);
          break; // Success, exit retry loop
        } catch (e: any) {
          const isRateLimit = e instanceof QuotaExceededInternal || 
                             (e.message && (e.message.includes('429') || e.message.toLowerCase().includes('quota') || e.message.toLowerCase().includes('rate limit')));
          
          if (isRateLimit) {
            // Rate limited - update timing and retry with backoff
            updateKeySlotTiming(currentKeySlot.id, true);
            retries++;
            if (retries < maxRetries) {
              // Exponential backoff: 2s, 4s, 8s
              const backoffMs = Math.min(8000, 2000 * Math.pow(2, retries - 1));
              await new Promise(resolve => setTimeout(resolve, backoffMs));
              // Get a new key slot after backoff
              const newKeySlot = getNextAvailableKeySlot();
              if (newKeySlot) {
                currentKeySlot = newKeySlot;
                apiKey = newKeySlot.key;
              } else {
                // No available keys, wait longer
                await new Promise(resolve => setTimeout(resolve, 10000));
                const retryKeySlot = getNextAvailableKeySlot();
                if (retryKeySlot) {
                  currentKeySlot = retryKeySlot;
                  apiKey = retryKeySlot.key;
                } else {
                  throw new QuotaExceededInternal();
                }
              }
            } else {
              throw new QuotaExceededInternal();
            }
          } else {
            // Other error, don't retry
            throw e;
          }
        }
      }

      const originalFilename = item.fileName || (item.file ? item.file.name : 'unknown');
      const newFilename = generateFilename(metadata.title, originalFilename);
      const readinessScore = calculateReadinessScore(metadata, metadata.rejectionRisks || []);
      
      // Save metadata to file system if using folder mode
      if (item.isFromFileSystem && selectedFolder && item.fileName) {
        try {
          await fileSystemService.saveMetadataFile(selectedFolder, item.fileName, {
            ...metadata,
            readinessScore,
            generatedAt: new Date().toISOString(),
            originalFilename,
            newFilename
          });
        } catch (error) {
          console.error('Error saving metadata file:', error);
        }
      }
      
      setFiles(prev => prev.map(f => f.id === item.id ? { 
        ...f, 
        status: ProcessingStatus.COMPLETED, 
        metadata: { ...metadata, readinessScore },
        newFilename 
      } : f));
    } catch (e: any) {
      const isRateLimit = e instanceof QuotaExceededInternal || 
                         (e.message && (e.message.includes('429') || e.message.toLowerCase().includes('quota') || e.message.toLowerCase().includes('rate limit')));
      
      if (isRateLimit) {
        // Re-queue the file for later processing
        setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.PENDING } : f));
      } else {
        setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.ERROR, error: "Analysis failed." } : f));
      }
    } finally {
      activeProcessingIds.current.delete(item.id);
      setProcessingCount(p => Math.max(0, p - 1));
    }
  }, [currentProfile, styleMemory, getNextAvailableKeySlot, updateKeySlotTiming]);

  const handleSelectFolder = async () => {
    try {
      const folderHandle = await fileSystemService.selectFolder();
      if (!folderHandle) return; // User cancelled
      
      setSelectedFolder(folderHandle);
      setFolderName(folderHandle.name);
      fileSystemService.setDirectory(folderHandle);
      
      setIsProcessingUpload(true);
      
      // Get all files from folder
      const folderFiles = await fileSystemService.getFilesFromFolder(folderHandle);
      
      // Create file items without loading files into memory
      const newFiles: FileItem[] = folderFiles.map(({ handle, name, path }) => ({
        id: generateId(),
        fileHandle: handle,
        fileName: name,
        filePath: path,
        previewUrl: '', // Will be loaded on-demand
        status: ProcessingStatus.PENDING,
        metadata: { title: '', description: '', keywords: [], category: '' },
        isFromFileSystem: true
      }));
      
      setFiles(newFiles);
      
      // Load previews sequentially (on-demand, not all at once)
      for (const item of newFiles) {
        try {
          const { file, previewUrl } = await fileSystemService.readFileForPreview(item.fileHandle);
          if (file.type.startsWith('image/')) {
            setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl, file } : f));
          } else if (file.type.startsWith('video/')) {
            try {
              const { previewUrl: vidPreview, frames } = await getVideoFrames(file);
              setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl: vidPreview, base64Frames: frames, file } : f));
            } catch (err) {
              setFiles(curr => curr.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.ERROR, error: "Preview error." } : f));
            }
          }
        } catch (err) {
          console.error('Error loading preview:', err);
        }
        
        // Small delay to prevent browser overload
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      setIsProcessingUpload(false);
      setToast({ message: `Loaded ${newFiles.length} files from folder`, type: "success" });
    } catch (error: any) {
      setIsProcessingUpload(false);
      if (error.message?.includes('not supported')) {
        setToast({ message: "Folder access is only available in Chrome, Edge, or Opera browsers", type: "error" });
      } else {
        setToast({ message: "Error accessing folder", type: "error" });
      }
    }
  };

  const handleFilesSelected = async (selectedFiles: File[]) => {
    // Clear folder mode when uploading files
    setSelectedFolder(null);
    setFolderName(null);
    fileSystemService.setDirectory(null);
    
    // Add all files to queue immediately (basic info only)
    const newFiles: FileItem[] = selectedFiles.map(f => ({
      id: generateId(),
      file: f,
      fileName: f.name,
      previewUrl: '', // Will be set sequentially
      status: ProcessingStatus.PENDING,
      metadata: { title: '', description: '', keywords: [], category: '' },
      isFromFileSystem: false
    }));

    setFiles(prev => [...prev, ...newFiles]);
    
    // Process uploads sequentially to prevent browser crashes
    for (const item of newFiles) {
      setIsProcessingUpload(true);
      
      try {
        // Generate preview for images immediately (lightweight)
        if (item.file && item.file.type.startsWith('image/')) {
          const previewUrl = URL.createObjectURL(item.file);
          setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl } : f));
        } 
        // Process videos sequentially (heavy operation)
        else if (item.file && item.file.type.startsWith('video/')) {
          try {
            const { previewUrl, frames } = await getVideoFrames(item.file);
            setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl, base64Frames: frames } : f));
          } catch (err) {
            setFiles(curr => curr.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.ERROR, error: "Preview error." } : f));
          }
        }
      } catch (err) {
        console.error('Error processing file:', err);
      }
      
      // Small delay between files to prevent browser overload
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    setIsProcessingUpload(false);
  };

  useEffect(() => {
    if (!isQueueActive) return;
    
    const tick = setInterval(() => {
      const now = Date.now();
      const activeKeys = apiKeys.filter(k => {
        const timingOk = now >= (k.nextAllowedAt || 0) && (k.status === 'active' || (k.status === 'cooldown' && k.cooldownUntil! < now));
        if (!timingOk) return false;
        
        // Check quota limits
        if (k.quotaResetAt && now >= k.quotaResetAt) {
          return true; // Quota window expired, will reset
        }
        
        const requestCount = k.requestCount || 0;
        const limit = k.requestsPerMinute || REQUESTS_PER_MINUTE;
        return requestCount < limit;
      });
      
      // Process files in parallel based on available API keys, but respect rate limits
      // Limit concurrent processing to number of available keys
      const maxConcurrent = Math.min(activeKeys.length, apiKeys.length);
      if (activeKeys.length > 0 && processingCount < maxConcurrent) {
        const pending = files.filter(f => f.status === ProcessingStatus.PENDING);
        const nextFile = pending.find(f => !activeProcessingIds.current.has(f.id));
        if (nextFile) {
          processFile(nextFile);
        }
      }
    }, 1000);

    return () => clearInterval(tick);
  }, [files, isQueueActive, processingCount, apiKeys, processFile]);

  const handleGenerateVariant = async (id: string) => {
    const item = files.find(f => f.id === id);
    const keySlot = getNextAvailableKeySlot();
    if (!item || !keySlot) return;

    setVariantProcessingId(id);
    try {
      const isVideo = item.file.type.startsWith('video/');
      const payload = isVideo 
        ? { frames: item.base64Frames, mimeType: 'image/jpeg' }
        : { base64: await readFileAsBase64(item.file), mimeType: item.file.type };

      const variantMetadata = await geminiService.generateMetadata(keySlot.key, payload, currentProfile, styleMemory, true);
      updateKeySlotTiming(keySlot.id);
      setFiles(prev => prev.map(f => f.id === id ? { ...f, variantB: variantMetadata } : f));
    } catch (e: any) {
      if (e instanceof QuotaExceededInternal) {
        updateKeySlotTiming(keySlot.id, true);
      }
    } finally {
      setVariantProcessingId(null);
    }
  };

  const toggleSelection = (id: string, isShift: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSidebarFileId(id);
  };

  const handleBatchApplyCategory = (category: string) => {
    setFiles(prev => prev.map(f => {
      if (selectedIds.size === 0 || selectedIds.has(f.id)) {
        return { ...f, metadata: { ...f.metadata, category } };
      }
      return f;
    }));
    setToast({ message: `Category updated for ${selectedIds.size || files.length} assets.`, type: 'success' });
  };

  return (
    <div className="min-h-screen flex flex-col font-sans selection:bg-brand-100 selection:text-brand-900">
      <Header 
        totalFiles={files.length} 
        completedFiles={files.filter(f => f.status === ProcessingStatus.COMPLETED).length}
        processingFiles={processingCount}
        pendingFiles={files.filter(f => f.status === ProcessingStatus.PENDING).length}
        isQueueActive={isQueueActive}
        onStartQueue={() => {
          if (apiKeys.length === 0) {
            setToast({ message: "Add an API Key in settings to start processing.", type: "error" });
            setIsSettingsOpen(true);
            return;
          }
          setIsQueueActive(true);
        }}
        onStopQueue={() => setIsQueueActive(false)}
        onExport={p => downloadCsv(files, p)}
        onDownloadFiles={async () => {
          if (selectedFolder) {
            // In folder mode, just export CSV (files are already local)
            setToast({ message: "Files are already in your local folder. Export CSV to get metadata.", type: "success" });
          } else {
            downloadAllFiles(files);
          }
        }}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onExportToSheets={() => {}} 
        onSelectDirectory={handleSelectFolder}
        directoryName={folderName}
        isSyncingToSheets={false}
        activeKeysCount={apiKeys.length}
        isDirectoryPickerSupported={typeof window !== 'undefined' && 'showDirectoryPicker' in window}
        apiKeys={apiKeys}
        isProcessingUpload={isProcessingUpload}
        onResetQuota={handleResetQuota}
        totalDailyQuota={getTotalDailyQuotaRemaining()}
      />

      <main className="flex-1 px-4 lg:px-12 py-8 max-w-[1920px] mx-auto w-full">
        {files.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] animate-fade-in">
            <FileUpload 
              onFilesSelected={handleFilesSelected} 
              onFolderSelected={handleSelectFolder}
              isFolderMode={!!selectedFolder}
              folderName={folderName}
            />
            <div className="mt-12 text-center max-w-xl text-slate-500">
               <p className="text-lg font-medium mb-4">Start your stock workflow.</p>
               <div className="grid grid-cols-3 gap-8 opacity-60">
                  <div className="space-y-2">
                    <div className="text-2xl">⚡</div>
                    <p className="text-xs uppercase font-bold tracking-widest">N-Parallel</p>
                  </div>
                  <div className="space-y-2">
                    <div className="text-2xl">🎯</div>
                    <p className="text-xs uppercase font-bold tracking-widest">SEO Validated</p>
                  </div>
                  <div className="space-y-2">
                    <div className="text-2xl">📁</div>
                    <p className="text-xs uppercase font-bold tracking-widest">Batch ZIP</p>
                  </div>
               </div>
               {apiKeys.length === 0 && (
                 <div className="mt-8 p-4 bg-amber-50 dark:bg-amber-900/20 rounded-2xl border border-amber-100 dark:border-amber-900/20 max-w-md mx-auto">
                   <p className="text-sm text-amber-800 dark:text-amber-200 mb-2 font-medium">💡 Get Started</p>
                   <p className="text-xs text-amber-700 dark:text-amber-300 mb-3">Add your Gemini API key in Settings to enable AI-powered metadata generation.</p>
                   <button
                     onClick={() => setIsSettingsOpen(true)}
                     className="text-xs font-medium text-amber-900 dark:text-amber-100 hover:underline inline-flex items-center gap-1"
                   >
                     Open Settings
                     <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                       <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                     </svg>
                   </button>
                 </div>
               )}
            </div>
          </div>
        ) : (
          <div className="animate-fade-in space-y-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
               <div>
                  <h2 className="text-2xl font-bold tracking-tight">Project Assets</h2>
                  <p className="text-sm text-slate-500 mt-0.5">Manage and analyze your metadata queue.</p>
               </div>
               <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setSelectedIds(selectedIds.size === files.length ? new Set() : new Set(files.map(f => f.id)))}
                    className="px-4 py-2 rounded-full text-xs font-medium border border-slate-300 dark:border-slate-700 hover:bg-white transition-all"
                  >
                    {selectedIds.size === files.length ? 'Deselect All' : 'Select All'}
                  </button>
                  <button 
                    onClick={() => { setFiles([]); setSelectedIds(new Set()); setIsQueueActive(false); }}
                    className="px-4 py-2 rounded-full text-xs font-medium text-rose-600 border border-rose-100 hover:bg-rose-50 transition-all"
                  >
                    Clear All
                  </button>
               </div>
            </div>

            <BatchActions 
              currentProfile={currentProfile}
              onApplyProfile={p => setCurrentProfile(p)}
              onApplyCategory={handleBatchApplyCategory}
              onClearAll={() => {}}
              hasFiles={true}
              disabled={false}
              selectedCount={selectedIds.size}
            />

            {/* Bootstrap-inspired 12-column grid */}
            <div className="grid grid-cols-12 gap-5 pb-32">
              {files.map(f => (
                <div key={f.id} className="col-span-12 sm:col-span-6 lg:col-span-4 xl:col-span-2">
                  <FileCard 
                    item={f} 
                    onClick={(e) => toggleSelection(f.id, e.shiftKey)} 
                    onRemove={id => {
                      setFiles(curr => curr.filter(x => x.id !== id));
                      setSelectedIds(prev => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                      });
                    }}
                    isSelected={selectedIds.has(f.id)} 
                  />
                </div>
              ))}
              
              <div className="col-span-12 sm:col-span-6 lg:col-span-4 xl:col-span-2">
                <button 
                  onClick={() => document.getElementById('file-upload-input')?.click()}
                  className="w-full aspect-square border-2 border-dashed border-slate-300 dark:border-slate-800 rounded-2xl flex flex-col items-center justify-center gap-3 text-slate-400 hover:border-brand-500 hover:text-brand-500 hover:bg-white dark:hover:bg-slate-900 transition-all group"
                >
                  <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-full group-hover:bg-brand-50 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
                  </div>
                  <span className="text-sm font-medium">Upload Assets</span>
                  <input id="file-upload-input" type="file" multiple className="hidden" onChange={(e) => e.target.files && handleFilesSelected(Array.from(e.target.files))} />
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="w-full py-6 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 mt-auto">
        <div className="max-w-[1920px] mx-auto px-6 md:px-12 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 525.83 123.45" className="h-5 w-auto">
              <defs>
                <style>{`.logo-bg-f { fill: #1a73e8; } .logo-fg-f { fill: #fff; } .logo-text-f { fill: currentColor; font-weight: 700; font-size: 88.58px; }`}</style>
              </defs>
              <g>
                <rect className="logo-bg-f" width="118.1" height="118.1" rx="20"/>
                <g>
                  <path className="logo-fg-f" d="M77.46,23.42l-2.58,11.05c6.82.91,11.36,9.09,5.56,16.44-1.21,1.54-3.09,2.42-5.05,2.42h-8.17s3.54-15.14,3.54-15.14h-11.61l-3.54,15.14h-9.48c-11.46,0-22.44,9.32-22.44,20.79s10.99,20.79,22.44,20.79h11.39l7.06-30.26h10.96c6.14,0,11.95-3.09,15.15-8.33,9.11-14.89.19-30.36-13.24-32.89ZM48.55,83.6h-4.19c-1.95,0-3.81-.86-5.02-2.39-6.18-7.82-.69-16.57,6.8-16.57h6.84l-4.43,18.96Z"/>
                  <polygon className="logo-fg-f" points="71.76 34.38 74.28 23.19 62.54 23.19 60.02 34.38 60.04 34.38 71.76 34.38"/>
                </g>
                <text className="logo-text-f text-slate-800 dark:text-slate-100" transform="translate(145 94.9)">PiTagger</text>
              </g>
            </svg>
            <div className="h-4 w-px bg-slate-200 dark:bg-slate-800" />
            <p className="text-[10px] text-slate-400 font-medium uppercase tracking-[0.1em]">
              &copy; {new Date().getFullYear()} designpi.com
            </p>
          </div>
          
          <div className="flex items-center gap-8">
            <a href="https://designpi.com" target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-500 hover:text-brand-600 transition-colors font-medium">Terms</a>
            <a href="https://designpi.com" target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-500 hover:text-brand-600 transition-colors font-medium">Privacy</a>
            <a href="https://designpi.com" target="_blank" rel="noopener noreferrer" className="px-4 py-1.5 rounded-full border border-slate-200 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900 transition-all font-semibold">Visit designpi.com</a>
          </div>
        </div>
      </footer>

      {sidebarFileId && (
        <MetadataSidebar 
          file={files.find(f => f.id === sidebarFileId)!}
          onUpdate={(id, field, value) => {
             setFiles(prev => prev.map(f => f.id === id ? { ...f, [field]: value } : f));
          }}
          onGenerateVariant={handleGenerateVariant}
          onClose={() => setSidebarFileId(null)}
          isProcessingVariant={variantProcessingId === sidebarFileId}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      
      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        apiKeys={apiKeys}
        onAddKey={handleAddKey}
        onRemoveKey={handleRemoveKey}
        onResetQuota={handleResetQuota}
        customProfilePrompts={styleMemory.customProfilePrompts || {} as any}
        onUpdateProfilePrompt={(profile, prompt) => {
           const newPrompts = { ...styleMemory.customProfilePrompts, [profile]: prompt };
           handleUpdateStyleMemory({ customProfilePrompts: newPrompts as any });
        }}
      />
    </div>
  );
}

export default App;