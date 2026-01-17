import React, { useState, useEffect, useCallback, useRef } from 'react';
import Header from './components/Header';
import FileUpload from './components/FileUpload';
import FileCard from './components/FileCard';
import LazyFileCard from './components/LazyFileCard';
import Toast from './components/Toast';
import BatchActions from './components/BatchActions';
import MetadataSidebar from './components/MetadataSidebar';
import SettingsModal from './components/SettingsModal';
import ApiQuotaStatus from './components/ApiQuotaStatus';
import { FileItem, ProcessingStatus, ApiKeyRecord, PlatformPreset, GenerationProfile, StyleMemory, AIProvider } from './types';
import { generateId, readFileAsBase64, readFileAsBase64ForAPI, getVideoFrames, downloadCsv, generateFilename, downloadAllFiles, calculateReadinessScore, generateCsvContent, generateCsvRow, parseCsvContent } from './services/fileUtils';
import { geminiService, QuotaExceededInternal } from './services/geminiService';
import { fileSystemService, FileSystemDirectoryHandle, FileSystemFileHandle } from './services/fileSystemService';

const MIN_SAFE_INTERVAL_MS = 2000; // 2 seconds = ~30 requests per minute (more conservative)
const REQUESTS_PER_MINUTE = 30; // More conservative limit to avoid 429 errors
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
    customProfilePrompts: {} as any,
    selectedProvider: AIProvider.LOCAL_PROXY
  });
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);
  const [isProcessingUpload, setIsProcessingUpload] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [previewLoadProgress, setPreviewLoadProgress] = useState({ loaded: 0, total: 0 });
  const [searchQuery, setSearchQuery] = useState('');
  const [csvFilename, setCsvFilename] = useState<string>('pitagger_export.csv');
  const [processingProgress, setProcessingProgress] = useState({ loaded: 0, total: 0 });
  const [workingApiModels, setWorkingApiModels] = useState<Array<{ apiKeyId: string; model: string; inUse: boolean }>>([]);
  const [allApisExhausted, setAllApisExhausted] = useState(false);
  const [apiModelTestResults, setApiModelTestResults] = useState<Map<string, { apiKeyId: string; model: string; works: boolean }>>(new Map());
  const [isTestingApis, setIsTestingApis] = useState(false);

  const activeProcessingIds = useRef<Set<string>>(new Set());
  const GEMINI_FREE_TIER_LIMIT = REQUESTS_PER_MINUTE; // Conservative limit to avoid 429 errors

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      // Clean up all blob URLs when component unmounts
      files.forEach(f => {
        if (f.previewUrl && f.previewUrl.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(f.previewUrl);
          } catch (e) {
            // Ignore errors when revoking
          }
        }
      });
    };
  }, []); // Only run on unmount

  useEffect(() => {
    const mem = localStorage.getItem('autotagger_style_mem_v4');
    if (mem) {
      const parsed = JSON.parse(mem);
      setStyleMemory({
        ...parsed,
        selectedModel: parsed.selectedModel || 'auto', // Default to auto if not set
        selectedProvider: parsed.selectedProvider || AIProvider.LOCAL_PROXY, // Default to Proxy if not set
      });
    }

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
        
        // Reset daily quota if window expired (24 hours from when it was first set)
        // Only reset if the window has actually expired, otherwise preserve the count
        let dailyQuotaResetAt = k.dailyQuotaResetAt;
        let dailyRequestCount = k.dailyRequestCount || 0;
        
        if (!dailyQuotaResetAt || dailyQuotaResetAt <= now) {
          // Window expired or never set - start a new 24-hour window
          dailyQuotaResetAt = now + 86400000; // 24 hours from now
          dailyRequestCount = 0; // Reset count
        }
        // If window hasn't expired, keep existing count and reset time
        
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
                 // Handle daily quota - only reset if window expired, otherwise increment
                 let dailyQuotaResetAt = k.dailyQuotaResetAt;
                 let dailyRequestCount = k.dailyRequestCount || 0;
                 
                 if (!dailyQuotaResetAt || dailyQuotaResetAt <= now) {
                   // Daily window expired - start new window
                   dailyQuotaResetAt = now + 86400000; // 24 hours from now
                   dailyRequestCount = 1; // Start at 1 (this request)
                 } else {
                   // Daily window still active - increment count
                   dailyRequestCount = dailyRequestCount + 1;
                 }
          
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
                 // Handle daily quota - only reset if window expired, otherwise increment
                 let dailyQuotaResetAt = k.dailyQuotaResetAt;
                 let newDailyRequestCount = k.dailyRequestCount || 0;
                 
                 if (!dailyQuotaResetAt || dailyQuotaResetAt <= now) {
                   // Daily window expired - start new window
                   dailyQuotaResetAt = now + 86400000; // 24 hours from now
                   newDailyRequestCount = 1; // Start at 1 (this request)
                 } else {
                   // Daily window still active - increment count
                   newDailyRequestCount = newDailyRequestCount + 1;
                 }
          
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
               
               // Handle daily quota - only reset if window expired, otherwise increment
               let dailyQuotaResetAt = k.dailyQuotaResetAt;
               let newDailyRequestCount = k.dailyRequestCount || 0;
               
               if (!dailyQuotaResetAt || dailyQuotaResetAt <= now) {
                 // Daily window expired - start new window
                 dailyQuotaResetAt = now + 86400000; // 24 hours from now
                 newDailyRequestCount = 1; // Start at 1 (this request)
               } else {
                 // Daily window still active - increment count
                 newDailyRequestCount = newDailyRequestCount + 1;
               }
        
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

  // Get next available API+model combination
  const getNextAvailableApiModel = useCallback((): { apiKeyId: string; model: string } | null => {
    const available = workingApiModels.find(w => !w.inUse);
    if (available) {
      // Mark as in use
      setWorkingApiModels(prev => prev.map(w => 
        w.apiKeyId === available.apiKeyId && w.model === available.model 
          ? { ...w, inUse: true } 
          : w
      ));
      return { apiKeyId: available.apiKeyId, model: available.model };
    }
    return null;
  }, [workingApiModels]);

  // Release API+model combination when done
  const releaseApiModel = useCallback((apiKeyId: string, model: string) => {
    setWorkingApiModels(prev => prev.map(w => 
      w.apiKeyId === apiKeyId && w.model === model 
        ? { ...w, inUse: false } 
        : w
    ));
  }, []);

  const processFile = useCallback(async (item: FileItem) => {
    // STRICT ENFORCEMENT: Do not process if already processing
    if (activeProcessingIds.current.has(item.id)) return;
    
    // STRICT ENFORCEMENT: Must have a working API+model combination available
    // OR: If workingApiModels.length === 0, allow one file to discover first API
    let apiModelCombo = getNextAvailableApiModel();
    let currentKeySlot = null;
    let currentModel = styleMemory.selectedModel || 'auto';
    
    // If no working combos yet, try to get an available key slot for discovery
    if (!apiModelCombo && workingApiModels.length === 0) {
      currentKeySlot = getNextAvailableKeySlot();
      if (!currentKeySlot) {
        // No available API keys at all - do NOT process
        return;
      }
      // Will discover model during processing
    } else if (!apiModelCombo) {
      // No available combinations - do NOT process
      return;
    } else {
      // Use the reserved combo
      currentKeySlot = apiKeys.find(k => k.id === apiModelCombo!.apiKeyId);
      if (!currentKeySlot) {
        return; // API key was removed
      }
      currentModel = apiModelCombo.model;
    }

    // STRICT ENFORCEMENT: Reserve slot BEFORE marking as processing
    // This ensures activeProcessingIds.size <= max(workingApiModels.length, 1)
    activeProcessingIds.current.add(item.id);
    
    try {
      setProcessingCount(p => p + 1);
      // Mark as PROCESSING only after slot is reserved
      setFiles(prev => {
        const updated = prev.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.PROCESSING } : f);
        // Update progress
        const completed = updated.filter(f => f.status === ProcessingStatus.COMPLETED).length;
        setProcessingProgress({ loaded: completed, total: updated.length });
        return updated;
      });

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
        // Use optimized compression for API calls - reduces payload size significantly
        payload = { base64: await readFileAsBase64ForAPI(processingFile), mimeType: processingFile.type };
      }

      // Use the API key and model (either from reserved combo or discovery mode)
      if (!currentKeySlot) {
        // API key was removed - release slot and abort
        activeProcessingIds.current.delete(item.id);
        setProcessingCount(p => Math.max(0, p - 1));
        if (apiModelCombo) {
          releaseApiModel(apiModelCombo.apiKeyId, apiModelCombo.model);
        }
        setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.PENDING } : f));
        return;
      }
      
      const apiKey = currentKeySlot.key;
      
      // If in discovery mode (no apiModelCombo), determine model to use
      if (!apiModelCombo) {
        // If using Proxy, skip model listing (avoids 429s on official API)
        if (styleMemory.selectedProvider === AIProvider.LOCAL_PROXY) {
          currentModel = 'gemini-proxy-model'; // Dummy model name for proxy
        } else {
          // Try to get available models for this API key
          let availableModels: string[] = [];
          try {
            availableModels = await geminiService.listAvailableModels(apiKey);
          } catch (err) {
            availableModels = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
          }
          
          // Use selected model if available, otherwise use first available
          if (currentModel === 'auto' || !availableModels.includes(currentModel)) {
            currentModel = availableModels[0] || 'gemini-2.5-flash';
          }
        }
      }
      
      // STRICT 1:1 MAPPING: Use ONLY the reserved API+model combination
      // Do NOT switch to other combos - if this one fails, remove it and re-queue
      let metadata;
      try {
        metadata = await geminiService.generateMetadata(apiKey, payload, currentProfile, styleMemory, false, currentModel, item.fileName);
        updateKeySlotTiming(currentKeySlot.id);
        
        // CRITICAL: Add to workingApiModels ONLY after REAL metadata request succeeds
        // This is the ONLY place where workingApiModels is updated (not from test pings)
        setWorkingApiModels(prev => {
          const exists = prev.some(w => w.apiKeyId === currentKeySlot.id && w.model === currentModel);
          if (!exists) {
            // This combination is now confirmed working via real request
            return [...prev, { apiKeyId: currentKeySlot.id, model: currentModel, inUse: true }];
          }
          // Ensure inUse is true for this combination
          return prev.map(w => 
            w.apiKeyId === currentKeySlot.id && w.model === currentModel
              ? { ...w, inUse: true }
              : w
          );
        });
        
        // Add delay after successful request to respect rate limits
        // If using Proxy, use a longer delay (5s) to be "slow" and safe as requested
        const delay = styleMemory.selectedProvider === AIProvider.LOCAL_PROXY ? 5000 : MIN_SAFE_INTERVAL_MS;
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (e: any) {
        const isRateLimit = e instanceof QuotaExceededInternal || 
                           (e.message && (e.message.includes('429') || e.message.toLowerCase().includes('quota') || e.message.toLowerCase().includes('rate limit')));
        
        if (isRateLimit) {
          // Remove exhausted combination from workingApiModels
          setWorkingApiModels(prev => {
            const filtered = prev.filter(w => 
              !(w.apiKeyId === currentKeySlot.id && w.model === currentModel)
            );
            // Check if all APIs are now exhausted
            if (filtered.length === 0) {
              setAllApisExhausted(true);
            }
            return filtered;
          });
          
          // Mark key as rate limited
          updateKeySlotTiming(currentKeySlot.id, true);
          
          // Re-throw to be handled by outer catch block (will re-queue file)
          throw new QuotaExceededInternal();
        } else {
          // Other error - remove combination if it's invalid
          const isApiKeyIssue = e.message && (
            e.message.toLowerCase().includes('invalid api key') ||
            e.message.toLowerCase().includes('api key') ||
            e.message.toLowerCase().includes('authentication')
          );
          
          if (isApiKeyIssue) {
            // Remove invalid combination
            setWorkingApiModels(prev => prev.filter(w => 
              !(w.apiKeyId === currentKeySlot.id && w.model === currentModel)
            ));
          }
          
          // Re-throw to be handled by outer catch block
          throw e;
        }
      }

      const originalFilename = item.fileName || (item.file ? item.file.name : 'unknown');
      const newFilename = generateFilename(metadata.title, originalFilename);
      const readinessScore = calculateReadinessScore(metadata, metadata.rejectionRisks || []);
      
      // Save metadata to file system if using folder mode
      if (item.isFromFileSystem && selectedFolder && item.fileName) {
        try {
          await fileSystemService.saveMetadataFile(selectedFolder, item.filePath || item.fileName, {
            ...metadata,
            readinessScore,
            generatedAt: new Date().toISOString(),
            originalFilename,
            newFilename
          });
          
          // Rename file if newFilename is different from original
          if (newFilename !== originalFilename && item.filePath) {
            try {
              await fileSystemService.renameFileInFolder(selectedFolder, item.filePath, newFilename);
              // Update the file path after renaming
              setFiles(prev => prev.map(f => f.id === item.id ? { 
                ...f, 
                fileName: newFilename,
                filePath: item.filePath?.replace(item.fileName, newFilename) || newFilename
              } : f));
            } catch (renameError) {
              console.error('Error renaming file:', renameError);
              // Continue even if rename fails
            }
          }
          
          // Update JSON database (backend) with all metadata
          try {
            await fileSystemService.updateJsonDatabase(selectedFolder, item.fileName, {
              originalFilename: originalFilename,
              newFilename: newFilename,
              filePath: item.filePath || item.fileName,
              metadata: {
                ...metadata,
                readinessScore,
                generatedAt: new Date().toISOString()
              }
            });
            console.log(`JSON database updated for file: ${newFilename || item.fileName}`);
          } catch (jsonError) {
            console.error('Error updating JSON database:', jsonError);
            // Continue even if JSON update fails
          }
          
          // Update CSV file in real-time with the completed file (final export format)
          try {
            const csvRow = generateCsvRow({
              ...item,
              newFilename: newFilename || item.fileName,
              metadata: { ...metadata, readinessScore }
            }, PlatformPreset.STANDARD);
            await fileSystemService.appendToCsvFile(selectedFolder, csvRow, csvFilename);
            console.log(`CSV updated for file: ${newFilename || item.fileName}`);
          } catch (csvError) {
            console.error('Error updating CSV file:', csvError);
            // Continue even if CSV update fails, but log it
            setToast({ 
              message: `Warning: CSV update failed for ${item.fileName}. Metadata saved to JSON database.`, 
              type: "error" 
            });
          }
        } catch (error) {
          console.error('Error saving metadata file:', error);
        }
      }
      
      setFiles(prev => {
        const updated = prev.map(f => f.id === item.id ? { 
          ...f, 
          status: ProcessingStatus.COMPLETED, 
          metadata: { ...metadata, readinessScore },
          newFilename 
        } : f);
        // Update progress
        const completed = updated.filter(f => f.status === ProcessingStatus.COMPLETED).length;
        setProcessingProgress({ loaded: completed, total: updated.length });
        return updated;
      });
    } catch (e: any) {
      const isRateLimit = e instanceof QuotaExceededInternal || 
                         (e.message && (e.message.includes('429') || 
                          e.message.toLowerCase().includes('quota') || 
                          e.message.toLowerCase().includes('rate limit') ||
                          e.message.toLowerCase().includes('quota limit')));
      
      const isApiKeyIssue = e.message && (
        e.message.toLowerCase().includes('invalid api key') ||
        e.message.toLowerCase().includes('api key') ||
        e.message.toLowerCase().includes('authentication')
      );
      
      const isBillingIssue = e.message && (
        e.message.toLowerCase().includes('billing') ||
        e.message.toLowerCase().includes('payment required')
      );
      
      if (isRateLimit) {
        // Remove exhausted combination from workingApiModels
        if (apiModelCombo) {
          setWorkingApiModels(prev => prev.filter(w => 
            !(w.apiKeyId === apiModelCombo.apiKeyId && w.model === apiModelCombo.model)
          ));
        }
        
        // Re-queue the file for later processing
        setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.PENDING } : f));
        
        // Check if all APIs are now exhausted
        setWorkingApiModels(prev => {
          if (prev.length === 0) {
            setAllApisExhausted(true);
          }
          return prev;
        });
        
        // Show helpful message about quota
        if (apiKeys.length > 0) {
          setToast({ 
            message: "Quota limit reached. Files will be processed when quota resets. You can manually reset quota in Settings.", 
            type: "error" 
          });
        }
      } else if (isApiKeyIssue || isBillingIssue) {
        // Remove invalid combination from workingApiModels
        if (apiModelCombo) {
          setWorkingApiModels(prev => prev.filter(w => 
            !(w.apiKeyId === apiModelCombo.apiKeyId && w.model === apiModelCombo.model)
          ));
        }
        
        // Stop processing queue for API key/billing issues
        setIsQueueActive(false);
        const errorMsg = e.message || (isApiKeyIssue ? "Invalid API key" : "Billing issue");
        setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.ERROR, error: errorMsg } : f));
        setToast({ 
          message: isApiKeyIssue 
            ? "Invalid API key. Please check your API key in Settings." 
            : "Billing or quota issue. Please check your Google Cloud Console.",
          type: "error" 
        });
      } else {
        const errorMsg = e.message || "Analysis failed.";
        setFiles(prev => prev.map(f => f.id === item.id ? { ...f, status: ProcessingStatus.ERROR, error: errorMsg } : f));
      }
    } finally {
      // CRITICAL: Release slot ONLY after processing completes (success or error)
      // This allows the next file to start processing
      activeProcessingIds.current.delete(item.id);
      setProcessingCount(p => Math.max(0, p - 1));
      
      // Release API+model combination (mark as not in use)
      // If we discovered a new combo, it was already added to workingApiModels with inUse=true
      // So we need to release it
      if (apiModelCombo) {
        releaseApiModel(apiModelCombo.apiKeyId, apiModelCombo.model);
      } else if (currentKeySlot) {
        // Discovery mode: release the combo we just added
        releaseApiModel(currentKeySlot.id, currentModel);
      }
    }
  }, [currentProfile, styleMemory, getNextAvailableKeySlot, updateKeySlotTiming, apiKeys, getNextAvailableApiModel, releaseApiModel]);

  // REMOVED: testAllApiModelCombinations
  // Testing APIs with generateContent consumes quota and causes 429 errors.
  // Instead, we use passive discovery: workingApiModels is populated ONLY
  // when real metadata requests succeed in processFile.
  // This ensures zero API calls on queue start and zero 429s from testing.
  const testAllApiModelCombinations = useCallback(async (background: boolean = false) => {
    // NO-OP: Do not test APIs. Let real processing discover working combinations.
    // This prevents quota consumption and 429 errors during testing.
    if (!background) {
      setToast({ 
        message: "Queue started. APIs will be discovered as files are processed.", 
        type: "success" 
      });
    }
    setIsTestingApis(false);
  }, []);

  const handleSelectFolder = async () => {
    try {
      const folderHandle = await fileSystemService.selectFolder();
      if (!folderHandle) return; // User cancelled
      
      setSelectedFolder(folderHandle);
      setFolderName(folderHandle.name);
      fileSystemService.setDirectory(folderHandle);
      
      setIsProcessingUpload(true);
      
      // Check for existing CSV file to detect already processed files
      const existingCsvHandle = await fileSystemService.findExistingCsvFile(folderHandle);
      let processedFilesMap = new Map<string, { title: string; keywords: string[]; category: string; description: string }>();
      let csvFileName = 'pitagger_export.csv';
      
      if (existingCsvHandle) {
        try {
          csvFileName = existingCsvHandle.name;
          const csvContent = await fileSystemService.readCsvFile(existingCsvHandle);
          const parsedCsv = parseCsvContent(csvContent);
          // Convert array to Map for compatibility
          processedFilesMap = new Map(parsedCsv.map(row => [row.filename, {
            title: row.title,
            keywords: row.keywords.split(',').map(t => t.trim()).filter(Boolean),
            category: row.category || '',
            description: ''
          }]));
          setToast({ message: `Found existing CSV with ${processedFilesMap.size} processed files. Skipping those.`, type: "success" });
        } catch (e) {
          console.warn('Error reading existing CSV:', e);
        }
      } else {
        // New folder - create CSV file with headers
        try {
          await fileSystemService.createCsvFile(folderHandle, csvFileName);
          setToast({ message: `Created new CSV file: ${csvFileName}`, type: "success" });
        } catch (e) {
          console.warn('Error creating CSV file:', e);
        }
      }
      
      setCsvFilename(csvFileName);
      
      // Check for existing JSON database and load it if available
      try {
        const jsonDb = await fileSystemService.readJsonDatabase(folderHandle);
        if (jsonDb) {
          console.log(`Found existing JSON database with ${Object.keys(jsonDb).length} entries`);
        }
      } catch (e) {
        console.log('No existing JSON database found, will create new one');
      }
      
      // Get all files from folder
      const folderFiles = await fileSystemService.getFilesFromFolder(folderHandle);
      
      // Create file items and check if already processed
      // We'll check both CSV and .pitagger.json files
      const newFiles: FileItem[] = await Promise.all(folderFiles.map(async ({ handle, name, path }) => {
        // First check CSV - if filename is in CSV, it's processed
        let isProcessed = false;
        let processedMetadata = null;
        let processedNewFilename = null;
        
        if (processedFilesMap.has(name)) {
          // File is in CSV with current name
          isProcessed = true;
          const csvData = processedFilesMap.get(name)!;
          processedMetadata = {
            title: csvData.title,
            description: csvData.description,
            keywords: csvData.keywords,
            category: csvData.category,
            releases: '',
            backupKeywords: []
          };
          processedNewFilename = name;
        } else {
          // Check if file has .pitagger.json (backup method)
          const { isProcessed: hasMetadata, metadata: jsonMetadata } = await fileSystemService.checkIfFileProcessed(folderHandle, path);
          if (hasMetadata && jsonMetadata) {
            isProcessed = true;
            processedMetadata = {
              title: jsonMetadata.title || '',
              description: jsonMetadata.description || '',
              keywords: jsonMetadata.keywords || [],
              category: jsonMetadata.category || '',
              releases: jsonMetadata.releases || '',
              backupKeywords: jsonMetadata.backupKeywords || []
            };
            processedNewFilename = jsonMetadata.newFilename || name;
          }
        }
        
        return {
          id: generateId(),
          fileHandle: handle,
          fileName: name,
          filePath: path,
          previewUrl: '', // Will be loaded in parallel
          status: isProcessed ? ProcessingStatus.COMPLETED : ProcessingStatus.PENDING,
          metadata: processedMetadata || { title: '', description: '', keywords: [], category: '' },
          newFilename: processedNewFilename,
          isFromFileSystem: true
        };
      }));
      
      // Show all files immediately - no waiting for previews
      setFiles(newFiles);
      setIsProcessingUpload(false);
      setPreviewLoadProgress({ loaded: 0, total: newFiles.length });
      
      // Load previews in parallel batches for faster loading with retry logic
      const loadPreview = async (item: FileItem, retryCount: number = 0): Promise<void> => {
        try {
          const { file, previewUrl } = await fileSystemService.readFileForPreview(item.fileHandle);
          if (file.type.startsWith('image/')) {
            setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl, file, previewRetryCount: 0, previewLoadFailed: false } : f));
            setPreviewLoadProgress(prev => ({ ...prev, loaded: prev.loaded + 1 }));
          } else if (file.type.startsWith('video/')) {
            try {
              const { previewUrl: vidPreview, frames } = await getVideoFrames(file);
              setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl: vidPreview, base64Frames: frames, file, previewRetryCount: 0, previewLoadFailed: false } : f));
              setPreviewLoadProgress(prev => ({ ...prev, loaded: prev.loaded + 1 }));
            } catch (err) {
              // Don't mark as error, just retry
              console.warn(`Video preview load failed for ${item.fileName} (attempt ${retryCount + 1}):`, err);
              handlePreviewRetry(item, retryCount);
            }
          }
        } catch (err) {
          // Don't mark as error, just retry
          console.warn(`Preview load failed for ${item.fileName} (attempt ${retryCount + 1}):`, err);
          handlePreviewRetry(item, retryCount);
        }
      };

      const handlePreviewRetry = (item: FileItem, retryCount: number) => {
        // Update retry count
        setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewRetryCount: retryCount + 1, previewLoadFailed: true } : f));
        setPreviewLoadProgress(prev => ({ ...prev, loaded: prev.loaded + 1 }));
        
        // Limit retries to 10 attempts
        if (retryCount >= 10) {
          console.warn(`Max retry attempts reached for file ${item.fileName}`);
          return;
        }
        
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
        
        setTimeout(() => {
          loadPreview(item, retryCount + 1);
        }, delay);
      };
      
      // Load previews one by one to prevent system overload
      // This provides immediate visual feedback as each preview becomes available
      const loadAllPreviews = async () => {
        // Load files sequentially, one at a time
        for (let i = 0; i < newFiles.length; i++) {
          await loadPreview(newFiles[i]);
          // Small delay between files to prevent overwhelming the system
          if (i < newFiles.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        setToast({ message: `Loaded ${newFiles.length} files with previews`, type: "success" });
      };
      
      // Start loading all previews in background - they'll appear as they load
      loadAllPreviews();
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
    
    // Check for very large files and warn user
    const largeFiles = selectedFiles.filter(f => f.size > 100 * 1024 * 1024); // > 100MB
    if (largeFiles.length > 0) {
      setToast({ 
        message: `Warning: ${largeFiles.length} file(s) over 100MB detected. Processing may be slow.`, 
        type: "error" 
      });
    }
    
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
    // For large files, process one at a time with longer delays
    for (const item of newFiles) {
      setIsProcessingUpload(true);
      
      const isLargeFile = item.file && item.file.size > 50 * 1024 * 1024; // > 50MB
      
      try {
        // Generate preview for images immediately (lightweight)
        if (item.file && item.file.type.startsWith('image/')) {
          // For large images, use a smaller preview to save memory
          if (isLargeFile) {
            // Create a compressed preview for large images
            try {
              const img = new Image();
              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              const objectUrl = URL.createObjectURL(item.file);
              
              img.onload = () => {
                // Resize to max 800px for preview
                const maxSize = 800;
                let width = img.width;
                let height = img.height;
                if (width > maxSize || height > maxSize) {
                  const ratio = Math.min(maxSize / width, maxSize / height);
                  width = width * ratio;
                  height = height * ratio;
                }
                
                canvas.width = width;
                canvas.height = height;
                ctx?.drawImage(img, 0, 0, width, height);
                const previewUrl = canvas.toDataURL('image/jpeg', 0.7);
                URL.revokeObjectURL(objectUrl);
                setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl } : f));
              };
              
              img.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                // Try fallback: direct blob URL
                try {
                  const previewUrl = URL.createObjectURL(item.file);
                  setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl, previewRetryCount: 0, previewLoadFailed: false } : f));
                } catch (fallbackErr) {
                  // If fallback also fails, schedule retry
                  console.warn(`Image preview load failed for ${item.file?.name}, will retry...`);
                  const retryCount = 0;
                  setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewRetryCount: retryCount + 1, previewLoadFailed: true } : f));
                  
                  // Retry after delay
                  setTimeout(() => {
                    const retryObjectUrl = URL.createObjectURL(item.file!);
                    const retryImg = new Image();
                    retryImg.onload = () => {
                      URL.revokeObjectURL(retryObjectUrl);
                      const previewUrl = URL.createObjectURL(item.file!);
                      setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl, previewRetryCount: 0, previewLoadFailed: false } : f));
                    };
                    retryImg.onerror = () => {
                      URL.revokeObjectURL(retryObjectUrl);
                      const previewUrl = URL.createObjectURL(item.file!);
                      setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl, previewRetryCount: 1, previewLoadFailed: true } : f));
                    };
                    retryImg.src = retryObjectUrl;
                  }, 1000);
                }
              };
              
              img.src = objectUrl;
            } catch (err) {
              // Fallback to regular blob URL
              const previewUrl = URL.createObjectURL(item.file);
              setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl } : f));
            }
          } else {
            const previewUrl = URL.createObjectURL(item.file);
            setFiles(curr => curr.map(f => f.id === item.id ? { ...f, previewUrl } : f));
          }
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
      
      // Longer delay for large files to prevent browser overload
      const delay = isLargeFile ? 200 : 50;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    setIsProcessingUpload(false);
  };

  useEffect(() => {
    if (!isQueueActive) return;
    
    const tick = setInterval(() => {
      // STRICT CONCURRENCY ENFORCEMENT: Capacity based ONLY on workingApiModels.length
      // BUT: Allow 1 file to process when workingApiModels.length === 0 to discover first API
      // AND: If using Proxy, STRICTLY limit to 1 concurrent request
      const isProxy = styleMemory.selectedProvider === AIProvider.LOCAL_PROXY;
      const maxConcurrent = isProxy ? 1 : (workingApiModels.length === 0 ? 1 : workingApiModels.length);
      
      // Calculate available slots (strict enforcement)
      const availableSlots = maxConcurrent - activeProcessingIds.current.size;
      
      // If no slots available, do nothing
      if (availableSlots <= 0) {
        return;
      }
      
      // Get pending files that are not already processing
      const pending = files.filter(f => 
        f.status === ProcessingStatus.PENDING && 
        !activeProcessingIds.current.has(f.id)
      );
      
      // Process exactly as many files as we have available slots
      const filesToProcess = pending.slice(0, availableSlots);
      
      // Dispatch files for processing (each will reserve a slot in processFile)
      for (const file of filesToProcess) {
        processFile(file);
      }
      
      // No background testing - APIs are discovered through real processing only
      // This prevents 429 errors and quota consumption from testing
    }, 1000);

    return () => clearInterval(tick);
  }, [files, isQueueActive, apiKeys, processFile, allApisExhausted, workingApiModels, isTestingApis, testAllApiModelCombinations]);

  const handleGenerateVariant = async (id: string) => {
    const item = files.find(f => f.id === id);
    const keySlot = getNextAvailableKeySlot();
    if (!item || !keySlot) return;

    setVariantProcessingId(id);
    try {
      // Get file for processing (either from handle or existing file object)
      let processingFile: File;
      if (item.isFromFileSystem && item.fileHandle) {
        processingFile = await fileSystemService.readFileForProcessing(item.fileHandle);
      } else if (item.file) {
        processingFile = item.file;
      } else {
        throw new Error('No file available for processing');
      }

      const isVideo = processingFile.type.startsWith('video/');
      const payload = isVideo 
        ? { frames: item.base64Frames || [], mimeType: 'image/jpeg' }
        : { base64: await readFileAsBase64ForAPI(processingFile), mimeType: processingFile.type };

      const variantMetadata = await geminiService.generateMetadata(keySlot.key, payload, currentProfile, styleMemory, true, styleMemory.selectedModel, item.fileName);
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
        onStartQueue={async () => {
          if (apiKeys.length === 0) {
            setToast({ message: "Add an API Key in settings to start processing.", type: "error" });
            setIsSettingsOpen(true);
            return;
          }
          
          // NO TESTING: Start queue immediately. APIs will be discovered through real processing.
          // This ensures zero API calls on start and zero 429 errors from testing.
          // workingApiModels will be populated as files are processed and succeed.
          setIsQueueActive(true);
          setToast({ 
            message: "Queue started. Processing will begin as APIs become available.", 
            type: "success" 
          });
        }}
        onStopQueue={() => setIsQueueActive(false)}
        onExport={async (p) => {
          if (selectedFolder) {
            // Save CSV to local folder
            try {
              const csvContent = generateCsvContent(files, p);
              const filename = `pitagger_${p.toLowerCase().replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
              await fileSystemService.saveCsvFile(selectedFolder, csvContent, filename);
              setToast({ message: `CSV saved to folder: ${filename}`, type: "success" });
            } catch (error) {
              console.error('Error saving CSV:', error);
              setToast({ message: "Error saving CSV to folder", type: "error" });
            }
          } else {
            // Download CSV normally
            downloadCsv(files, p);
          }
        }}
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
        processingProgress={processingProgress}
        allApisExhausted={allApisExhausted}
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
            <div className="mt-12 text-center max-w-xl">
               <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-2">Start Your Stock Workflow</h2>
               <p className="text-sm text-slate-500 dark:text-slate-400 mb-8">Professional AI-powered metadata generation for stock assets</p>
               <div className="grid grid-cols-3 gap-6 mb-8">
                  <div className="space-y-2 p-4 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-blue-100 dark:border-blue-900/20">
                    <div className="text-3xl mb-2">⚡</div>
                    <p className="text-xs uppercase font-bold tracking-widest text-blue-700 dark:text-blue-300">Fast Processing</p>
                    <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70">Optimized API usage</p>
                  </div>
                  <div className="space-y-2 p-4 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-100 dark:border-emerald-900/20">
                    <div className="text-3xl mb-2">🎯</div>
                    <p className="text-xs uppercase font-bold tracking-widest text-emerald-700 dark:text-emerald-300">SEO Optimized</p>
                    <p className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">70 keywords per asset</p>
                  </div>
                  <div className="space-y-2 p-4 rounded-xl bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 border border-purple-100 dark:border-purple-900/20">
                    <div className="text-3xl mb-2">📁</div>
                    <p className="text-xs uppercase font-bold tracking-widest text-purple-700 dark:text-purple-300">Folder Mode</p>
                    <p className="text-[10px] text-purple-600/70 dark:text-purple-400/70">Direct file access</p>
                  </div>
               </div>
               {apiKeys.length === 0 && (
                 <div className="mt-8 p-5 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl border border-blue-100 dark:border-blue-900/20 shadow-sm">
                   <div className="flex items-start gap-3 mb-3">
                     <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                       <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                     </svg>
                     <div className="flex-1 text-left">
                       <p className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-1">No API Keys Configured</p>
                       <p className="text-xs text-blue-700 dark:text-blue-300 mb-4">Add your Google Gemini API key(s) in settings to start processing files. Your keys are stored securely in your browser.</p>
                       <button 
                         onClick={() => setIsSettingsOpen(true)}
                         className="px-5 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-all shadow-sm hover:shadow-md"
                       >
                         Open Settings
                       </button>
                     </div>
                   </div>
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

            {/* Search/Filter Bar for large folders */}
            {files.length >= 50 && (
              <div className="mb-6">
                <div className="relative max-w-md">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search files by name..."
                    className="w-full px-4 py-2.5 pl-10 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 outline-none transition-all"
                  />
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                {searchQuery && (
                  <p className="mt-2 text-xs text-slate-500">
                    Showing {files.filter(f => 
                      f.fileName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      f.metadata.title.toLowerCase().includes(searchQuery.toLowerCase())
                    ).length} of {files.length} files
                  </p>
                )}
              </div>
            )}

            {/* Preview Loading Progress for folders */}
            {previewLoadProgress.total > 0 && previewLoadProgress.loaded < previewLoadProgress.total && (
              <div className="mb-4 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl border border-blue-100 dark:border-blue-900/20 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                      Loading previews...
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">
                    {previewLoadProgress.loaded} / {previewLoadProgress.total}
                  </span>
                </div>
                <div className="w-full bg-blue-200/50 dark:bg-blue-900/50 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-gradient-to-r from-blue-500 to-indigo-500 h-2 rounded-full transition-all duration-500 ease-out shadow-sm" 
                    style={{ width: `${(previewLoadProgress.loaded / previewLoadProgress.total) * 100}%` }} 
                  />
                </div>
                <p className="text-xs text-blue-600/70 dark:text-blue-400/70 mt-2">
                  {Math.round((previewLoadProgress.loaded / previewLoadProgress.total) * 100)}% complete
                </p>
              </div>
            )}
            
            {/* Processing Progress Indicator */}
            {isQueueActive && processingCount > 0 && (
              <div className="mb-4 p-4 bg-gradient-to-r from-brand-50 to-emerald-50 dark:from-brand-900/20 dark:to-emerald-900/20 rounded-xl border border-brand-100 dark:border-brand-900/20 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm font-medium text-brand-700 dark:text-brand-300">
                      Processing {processingCount} file{processingCount > 1 ? 's' : ''}...
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-brand-600 dark:text-brand-400">
                    {files.filter(f => f.status === ProcessingStatus.COMPLETED).length} / {files.length} completed
                  </span>
                </div>
                <div className="w-full bg-brand-200/50 dark:bg-brand-900/50 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-gradient-to-r from-brand-500 to-emerald-500 h-2 rounded-full transition-all duration-500 ease-out shadow-sm" 
                    style={{ width: `${files.length > 0 ? (files.filter(f => f.status === ProcessingStatus.COMPLETED).length / files.length) * 100 : 0}%` }} 
                  />
                </div>
                <p className="text-xs text-brand-600/70 dark:text-brand-400/70 mt-2">
                  {files.length > 0 ? Math.round((files.filter(f => f.status === ProcessingStatus.COMPLETED).length / files.length) * 100) : 0}% complete • {files.filter(f => f.status === ProcessingStatus.PENDING).length} remaining
                </p>
              </div>
            )}

            {/* Bootstrap-inspired 12-column grid */}
            <div className="grid grid-cols-12 gap-5 pb-32">
              {files
                .filter(f => {
                  if (!searchQuery) return true;
                  const query = searchQuery.toLowerCase();
                  return f.fileName.toLowerCase().includes(query) || 
                         f.metadata.title.toLowerCase().includes(query) ||
                         f.metadata.keywords.some(k => k.toLowerCase().includes(query));
                })
                .map(f => (
                <div key={f.id} className="col-span-12 sm:col-span-6 lg:col-span-4 xl:col-span-2">
                  {f.isFromFileSystem && files.length >= 20 ? (
                    <LazyFileCard 
                      item={f} 
                      onClick={(e) => toggleSelection(f.id, e.shiftKey)} 
                      onRemove={id => {
                        // Clean up blob URL before removing file
                        const fileToRemove = files.find(file => file.id === id);
                        if (fileToRemove?.previewUrl && fileToRemove.previewUrl.startsWith('blob:')) {
                          try {
                            URL.revokeObjectURL(fileToRemove.previewUrl);
                          } catch (e) {
                            // Ignore errors when revoking
                          }
                        }
                        setFiles(curr => curr.filter(x => x.id !== id));
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          next.delete(id);
                          return next;
                        });
                      }}
                      isSelected={selectedIds.has(f.id)}
                      onPreviewLoaded={(id, previewUrl, file, frames) => {
                        setFiles(curr => curr.map(item => 
                          item.id === id 
                            ? { ...item, previewUrl, file, base64Frames: frames } 
                            : item
                        ));
                        setPreviewLoadProgress(prev => ({ ...prev, loaded: prev.loaded + 1 }));
                      }}
                    />
                  ) : (
                           <FileCard 
                             item={f} 
                             onClick={(e) => toggleSelection(f.id, e.shiftKey)} 
                             onRemove={id => {
                               // Clean up blob URL before removing file
                               const fileToRemove = files.find(file => file.id === id);
                               if (fileToRemove?.previewUrl && fileToRemove.previewUrl.startsWith('blob:')) {
                                 try {
                                   URL.revokeObjectURL(fileToRemove.previewUrl);
                                 } catch (e) {
                                   // Ignore errors when revoking
                                 }
                               }
                               setFiles(curr => curr.filter(x => x.id !== id));
                               setSelectedIds(prev => {
                                 const next = new Set(prev);
                                 next.delete(id);
                                 return next;
                               });
                             }}
                             isSelected={selectedIds.has(f.id)} 
                           />
                  )}
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
          onUpdate={async (id, field, value) => {
            const file = files.find(f => f.id === id);
            setFiles(prev => prev.map(f => {
              if (f.id !== id) return f;
              if (field === 'metadata') {
                const readinessScore = calculateReadinessScore(value, value.rejectionRisks || []);
                return { ...f, metadata: { ...value, readinessScore } };
              }
              return { ...f, [field]: value };
            }));
            
            // Save metadata to folder if using file system mode
            if (field === 'metadata' && file && file.isFromFileSystem && selectedFolder && file.fileName) {
              try {
                const updatedFile = files.find(f => f.id === id);
                if (updatedFile) {
                  const readinessScore = calculateReadinessScore(value, value.rejectionRisks || []);
                  const fullMetadata = {
                    ...value,
                    readinessScore,
                    generatedAt: new Date().toISOString(),
                    originalFilename: file.fileName,
                    newFilename: updatedFile.newFilename || file.fileName
                  };
                  
                  // Save to individual .pitagger.json file
                  await fileSystemService.saveMetadataFile(selectedFolder, file.filePath || file.fileName, fullMetadata);
                  
                  // Update JSON database (backend)
                  await fileSystemService.updateJsonDatabase(selectedFolder, file.fileName, {
                    originalFilename: file.fileName,
                    newFilename: updatedFile.newFilename || file.fileName,
                    filePath: file.filePath || file.fileName,
                    metadata: fullMetadata
                  });
                  
                  // Update CSV with simplified format
                  const csvRow = generateCsvRow({
                    ...updatedFile,
                    newFilename: updatedFile.newFilename || file.fileName,
                    metadata: { ...value, readinessScore }
                  }, PlatformPreset.STANDARD);
                  await fileSystemService.appendToCsvFile(selectedFolder, csvRow, csvFilename);
                }
              } catch (error) {
                console.error('Error saving updated metadata:', error);
              }
            }
          }}
          onGenerateVariant={handleGenerateVariant}
          onClose={() => setSidebarFileId(null)}
          isProcessingVariant={variantProcessingId === sidebarFileId}
        />
      )}

            {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
            
            {/* All APIs Exhausted Modal */}
            {allApisExhausted && (
              <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-md p-8 border border-rose-200 dark:border-rose-900/40">
                  <div className="flex items-center gap-4 mb-4">
                    <div className="w-12 h-12 bg-rose-100 dark:bg-rose-900/20 rounded-full flex items-center justify-center">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-rose-600 dark:text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-white">All API Keys Exhausted</h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400">All API keys have reached their rate limits</p>
                    </div>
                  </div>
                  
                  <div className="mb-6 space-y-2 text-sm text-slate-600 dark:text-slate-300">
                    <p>• Wait for the cooldown period to expire</p>
                    <p>• Or manually reset quotas in Settings</p>
                    <p>• Processing will resume automatically when an API recovers</p>
                  </div>
                  
                  <div className="flex gap-3">
                    <button
                      onClick={() => setIsSettingsOpen(true)}
                      className="flex-1 px-4 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 transition-colors"
                    >
                      Open Settings
                    </button>
                    <button
                      onClick={() => setAllApisExhausted(false)}
                      className="px-4 py-2.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl text-sm font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            )}
      
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
        selectedModel={styleMemory.selectedModel || 'auto'}
        onSelectModel={(model) => handleUpdateStyleMemory({ selectedModel: model })}
        selectedProvider={styleMemory.selectedProvider}
        onSelectProvider={(provider) => handleUpdateStyleMemory({ selectedProvider: provider })}
      />
    </div>
  );
}

export default App;