import React, { useState } from 'react';
import { PlatformPreset, ApiKeyRecord } from '../types';
import ApiQuotaStatus from './ApiQuotaStatus';

interface HeaderProps {
  totalFiles: number;
  completedFiles: number;
  processingFiles: number;
  pendingFiles: number;
  isQueueActive: boolean;
  onExport: (preset: PlatformPreset) => void;
  onExportToSheets: () => void;
  onDownloadFiles: () => void;
  onSelectDirectory: () => void;
  onStartQueue: () => void;
  onStopQueue: () => void;
  onOpenSettings: () => void;
  directoryName: string | null;
  isSyncingToSheets: boolean;
  activeKeysCount: number;
  isDirectoryPickerSupported: boolean;
  apiKeys: ApiKeyRecord[];
  isProcessingUpload: boolean;
  onResetQuota: (id: string) => void;
  totalDailyQuota: { used: number; limit: number; remaining: number; percentage: number };
  processingProgress: { loaded: number; total: number };
}

const Header: React.FC<HeaderProps> = ({ 
  totalFiles, 
  completedFiles, 
  processingFiles,
  pendingFiles,
  isQueueActive,
  onExport, 
  onDownloadFiles,
  onStartQueue,
  onStopQueue,
  onOpenSettings,
  apiKeys,
  isProcessingUpload,
  onResetQuota,
  totalDailyQuota,
  processingProgress,
}) => {
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const allCompleted = totalFiles > 0 && completedFiles === totalFiles;

  return (
    <>
      <header className="sticky top-0 z-40 w-full bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="h-16 px-6 flex items-center justify-between">
          {/* Brand Section */}
          <div className="flex items-center gap-4">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 525.83 123.45" className="h-8 w-auto">
          <defs>
            <style>{`.logo-bg { fill: #1a73e8; } .logo-fg { fill: #fff; } .logo-text { fill: currentColor; font-weight: 700; font-size: 88.58px; }`}</style>
          </defs>
          <g>
            <rect className="logo-bg" width="118.1" height="118.1" rx="20"/>
            <g>
              <path className="logo-fg" d="M77.46,23.42l-2.58,11.05c6.82.91,11.36,9.09,5.56,16.44-1.21,1.54-3.09,2.42-5.05,2.42h-8.17s3.54-15.14,3.54-15.14h-11.61l-3.54,15.14h-9.48c-11.46,0-22.44,9.32-22.44,20.79s10.99,20.79,22.44,20.79h11.39l7.06-30.26h10.96c6.14,0,11.95-3.09,15.15-8.33,9.11-14.89.19-30.36-13.24-32.89ZM48.55,83.6h-4.19c-1.95,0-3.81-.86-5.02-2.39-6.18-7.82-.69-16.57,6.8-16.57h6.84l-4.43,18.96Z"/>
              <polygon className="logo-fg" points="71.76 34.38 74.28 23.19 62.54 23.19 60.02 34.38 60.04 34.38 71.76 34.38"/>
            </g>
            <text className="logo-text text-slate-800 dark:text-slate-100" transform="translate(145 94.9)">PiTagger</text>
          </g>
        </svg>
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-3">
        {totalFiles > 0 && !allCompleted && (
          <button
            onClick={isQueueActive ? onStopQueue : onStartQueue}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-medium transition-all shadow-sm hover:shadow-md ${isQueueActive ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 border border-amber-200' : 'bg-brand-600 text-white hover:bg-brand-700 active:scale-95'}`}
          >
            {isQueueActive ? (
              <>
                <div className="w-2 h-2 bg-amber-600 rounded-full animate-pulse" /> 
                <span>Pause</span>
                {processingFiles > 0 && (
                  <span className="ml-1 text-xs opacity-75">({processingFiles})</span>
                )}
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> 
                <span>Run Analysis</span>
                {pendingFiles > 0 && (
                  <span className="ml-1 text-xs opacity-90">({pendingFiles})</span>
                )}
              </>
            )}
          </button>
        )}

        <div className="flex items-center gap-1 border-l border-slate-200 dark:border-slate-800 pl-4 ml-1">
          <button
            onClick={onDownloadFiles}
            disabled={!allCompleted}
            className="p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 transition-colors"
            title="Download ZIP"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
          </button>

          <div className="relative">
            <button
              onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
              disabled={!allCompleted}
              className="p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 transition-colors"
              title="Export CSV"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            </button>
            {isExportMenuOpen && (
              <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 overflow-hidden py-1 animate-fade-in">
                {[PlatformPreset.STANDARD, PlatformPreset.ADOBE, PlatformPreset.SHUTTERSTOCK, PlatformPreset.GETTY].map(preset => (
                  <button
                    key={preset}
                    onClick={() => { onExport(preset); setIsExportMenuOpen(false); }}
                    className="w-full px-4 py-2.5 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={onOpenSettings}
            className="p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="Settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          </button>
        </div>
      </div>
        </div>
      
      {/* API Quota Status Bar */}
      {apiKeys.length > 0 && (
        <div className="px-6 py-2 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800">
          {/* Total Daily Quota Summary */}
          <div className="mb-3 pb-3 border-b border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex flex-col">
                  <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Daily Quota</span>
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    {totalDailyQuota.remaining.toLocaleString()} / {totalDailyQuota.limit.toLocaleString()} remaining
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-32 h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div 
                    className={`h-full transition-all duration-300 ${
                      totalDailyQuota.percentage >= 90 ? 'bg-rose-500' :
                      totalDailyQuota.percentage >= 75 ? 'bg-amber-500' :
                      'bg-emerald-500'
                    }`}
                    style={{ width: `${Math.min(100, totalDailyQuota.percentage)}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-slate-600 dark:text-slate-400 min-w-[50px] text-right">
                  {totalDailyQuota.used.toLocaleString()} used
                </span>
              </div>
            </div>
          </div>
          
          {/* Individual API Key Quotas */}
          <ApiQuotaStatus apiKeys={apiKeys} onResetQuota={onResetQuota} />
        </div>
      )}
      
      {/* Upload Progress Indicator */}
      {isProcessingUpload && (
        <div className="px-6 py-1.5 bg-blue-50 dark:bg-blue-900/20 border-t border-blue-100 dark:border-blue-900/20">
          <div className="flex items-center gap-2 text-xs text-blue-700 dark:text-blue-300">
            <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span className="font-medium">Processing file uploads...</span>
          </div>
        </div>
      )}

      {/* Always-visible Processing Progress Bar (smaller) */}
      {totalFiles > 0 && processingProgress.total > 0 && (
        <div className="px-6 py-1 bg-brand-50 dark:bg-brand-900/10 border-t border-brand-100 dark:border-brand-900/20">
          <div className="flex items-center justify-between gap-2 text-[10px] text-brand-700 dark:text-brand-300">
            <span className="font-medium">Processing: {processingProgress.loaded} / {processingProgress.total}</span>
            <span className="font-medium">{Math.round((processingProgress.loaded / processingProgress.total) * 100)}%</span>
          </div>
          <div className="w-full h-0.5 bg-brand-100 dark:bg-brand-900/40 rounded-full mt-1 overflow-hidden">
            <div 
              className="h-full bg-brand-500 rounded-full transition-all duration-300" 
              style={{ width: `${(processingProgress.loaded / processingProgress.total) * 100}%` }} 
            />
          </div>
        </div>
      )}
      </header>
    </>
  );
};

export default Header;