import React, { useEffect, useRef, useState } from 'react';
import { FileItem, ProcessingStatus } from '../types';
import { fileSystemService } from '../services/fileSystemService';
import { getVideoFrames } from '../services/fileUtils';

interface LazyFileCardProps {
  item: FileItem;
  onRemove: (id: string) => void;
  onClick: (e: React.MouseEvent) => void;
  isSelected: boolean;
  onPreviewLoaded?: (id: string, previewUrl: string, file?: File, frames?: string[]) => void;
}

const LazyFileCard: React.FC<LazyFileCardProps> = ({ 
  item, 
  onRemove, 
  onClick, 
  isSelected,
  onPreviewLoaded 
}) => {
  const [previewUrl, setPreviewUrl] = useState(item.previewUrl);
  const [isLoadingPreview, setIsLoadingPreview] = useState(!item.previewUrl && item.isFromFileSystem);
  const cardRef = useRef<HTMLDivElement>(null);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    // If preview already exists, use it
    if (item.previewUrl) {
      setPreviewUrl(item.previewUrl);
      setIsLoadingPreview(false);
      return;
    }

    // If not from file system or already loaded, skip
    if (!item.isFromFileSystem || hasLoadedRef.current) return;

    // Use Intersection Observer to load preview when card is visible
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadPreview();
            observer.disconnect();
          }
        });
      },
      {
        rootMargin: '200px', // Start loading 200px before card is visible
        threshold: 0.1
      }
    );

    if (cardRef.current) {
      observer.observe(cardRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [item.id, item.previewUrl, item.isFromFileSystem]);

  const loadPreview = async () => {
    if (!item.fileHandle || hasLoadedRef.current) return;
    
    setIsLoadingPreview(true);
    try {
      const { file, previewUrl: url } = await fileSystemService.readFileForPreview(item.fileHandle);
      
      if (file.type.startsWith('image/')) {
        setPreviewUrl(url);
        setIsLoadingPreview(false);
        onPreviewLoaded?.(item.id, url, file);
      } else if (file.type.startsWith('video/')) {
        try {
          const { previewUrl: vidPreview, frames } = await getVideoFrames(file);
          setPreviewUrl(vidPreview);
          setIsLoadingPreview(false);
          onPreviewLoaded?.(item.id, vidPreview, file, frames);
        } catch (err) {
          setIsLoadingPreview(false);
          console.error('Error loading video preview:', err);
        }
      }
    } catch (err) {
      setIsLoadingPreview(false);
      console.error('Error loading preview:', err);
    }
  };

  const statusColors = {
    [ProcessingStatus.PENDING]: 'bg-slate-300',
    [ProcessingStatus.PROCESSING]: 'bg-brand-500 animate-pulse',
    [ProcessingStatus.COMPLETED]: 'bg-emerald-500',
    [ProcessingStatus.ERROR]: 'bg-rose-500',
  };

  return (
    <div 
      ref={cardRef}
      onClick={onClick}
      className={`group relative flex flex-col bg-white dark:bg-slate-900 rounded-2xl border transition-all cursor-pointer overflow-hidden select-none h-full animate-fade-in ${isSelected ? 'border-brand-500 ring-2 ring-brand-500/20 shadow-lg translate-y-[-2px]' : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-sm'}`}
    >
      {/* Utility Layer */}
      <div className="absolute top-3 left-3 right-3 z-20 flex justify-between pointer-events-none">
        <div className={`w-6 h-6 rounded-md border transition-all flex items-center justify-center pointer-events-auto ${isSelected ? 'bg-brand-600 border-brand-600 shadow-sm' : 'bg-white/90 border-slate-300 opacity-0 group-hover:opacity-100'}`}>
          {isSelected && <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
        </div>
        <button 
          onClick={(e) => { e.stopPropagation(); onRemove(item.id); }} 
          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-white rounded-full opacity-0 group-hover:opacity-100 transition-all pointer-events-auto shadow-sm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      {/* Visual Component */}
      <div className="relative aspect-[4/3] w-full bg-slate-50 dark:bg-slate-950 overflow-hidden flex items-center justify-center">
        {previewUrl ? (
          <img src={previewUrl} alt="" className={`w-full h-full object-cover transition-transform duration-700 group-hover:scale-105 ${item.status === ProcessingStatus.PROCESSING ? 'opacity-30 grayscale' : 'opacity-100'}`} />
        ) : isLoadingPreview ? (
          <div className="p-8 text-center flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
            <div className="text-[10px] font-mono text-slate-400">Loading...</div>
          </div>
        ) : (
          <div className="p-8 text-center flex flex-col items-center gap-2">
            <div className="w-10 h-10 bg-slate-200 dark:bg-slate-800 rounded-full flex items-center justify-center text-slate-400">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
            </div>
            <div className="text-[10px] font-mono text-slate-400 break-all truncate w-full">{item.fileName || (item.file ? item.file.name : 'Unknown')}</div>
          </div>
        )}
        
        {/* Dynamic Status Progress Bar */}
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-slate-100 dark:bg-slate-800">
          {item.status === ProcessingStatus.COMPLETED && (
            <div 
              className={`h-full transition-all duration-1000 ${item.metadata.readinessScore! > 80 ? 'bg-emerald-500' : 'bg-brand-500'}`}
              style={{ width: `${item.metadata.readinessScore || 0}%` }}
            />
          )}
          {item.status === ProcessingStatus.PROCESSING && (
            <div className="h-full bg-brand-400 animate-[pulse_1.5s_infinite]" style={{ width: '40%' }} />
          )}
        </div>
      </div>

      {/* Detail Area */}
      <div className="p-4 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${statusColors[item.status]}`} />
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest truncate">
            {item.metadata.category || 'Standard Asset'}
          </p>
        </div>
        <h4 className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate leading-tight">
          {item.metadata.title || item.fileName || (item.file ? item.file.name : 'Unknown')}
        </h4>
      </div>
    </div>
  );
};

export default LazyFileCard;

