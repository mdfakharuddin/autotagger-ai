
import React, { useState } from 'react';
import { FileItem } from '../types';
import { calculateReadinessScore } from '../services/fileUtils';

interface MetadataSidebarProps {
  file: FileItem;
  onUpdate: (id: string, field: string, value: any) => void;
  onGenerateVariant: (id: string) => void;
  onClose: () => void;
  isProcessingVariant: boolean;
}

const MetadataSidebar: React.FC<MetadataSidebarProps> = ({ 
  file, 
  onUpdate, 
  onGenerateVariant, 
  onClose,
  isProcessingVariant 
}) => {
  const [newTagInput, setNewTagInput] = useState('');
  const currentMeta = file.metadata;
  const score = calculateReadinessScore(currentMeta, currentMeta.rejectionRisks || []);

  const addKeyword = (input?: string) => {
    const text = input || newTagInput;
    if (!text.trim()) return;
    const tags = text.split(',').map(t => t.trim().toLowerCase()).filter(t => t && !currentMeta.keywords.includes(t));
    const newKws = [...currentMeta.keywords, ...tags];
    
    // Also remove from backup pool if added
    const newBackup = currentMeta.backupKeywords?.filter(k => !tags.includes(k.toLowerCase()));
    
    onUpdate(file.id, 'metadata', { ...currentMeta, keywords: newKws, backupKeywords: newBackup });
    if (!input) setNewTagInput('');
  };

  const removeKeyword = (idx: number) => {
    const word = currentMeta.keywords[idx];
    const newKws = currentMeta.keywords.filter((_, i) => i !== idx);
    const newBackup = [...(currentMeta.backupKeywords || []), word];
    onUpdate(file.id, 'metadata', { ...currentMeta, keywords: newKws, backupKeywords: newBackup });
  };

  return (
    <aside className="fixed inset-y-0 right-0 w-[400px] bg-white dark:bg-slate-900 shadow-2xl z-50 flex flex-col border-l border-slate-200 dark:border-slate-800 animate-slide-in-right">
      {/* Sidebar Header */}
      <div className="px-6 h-16 flex items-center justify-between border-b border-slate-100 dark:border-slate-800 shrink-0">
        <h3 className="text-base font-medium">Asset Details</h3>
        <button onClick={onClose} className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-500">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
        {/* Preview Section */}
        <div className="space-y-4">
          <div className="aspect-video w-full bg-slate-100 dark:bg-slate-950 rounded-2xl overflow-hidden relative shadow-inner border border-slate-100 dark:border-slate-800">
            {file.previewUrl ? <img src={file.previewUrl} alt="" className="w-full h-full object-contain" /> : <div className="h-full flex items-center justify-center text-xs text-slate-400">No preview available</div>}
          </div>
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-brand-50 dark:bg-brand-900/20 flex items-center justify-center text-xs font-bold text-brand-700">
                {score}%
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Health</span>
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Stock Ready</span>
              </div>
            </div>
            <button 
              onClick={() => onGenerateVariant(file.id)}
              disabled={isProcessingVariant}
              className="px-5 py-2 rounded-full border border-brand-200 text-xs font-medium text-brand-600 hover:bg-brand-50 transition-all disabled:opacity-50"
              title="Runs a fresh analysis if needed"
            >
              {isProcessingVariant ? 'Refreshing...' : 'Regenerate'}
            </button>
          </div>
        </div>

        {/* Form Fields */}
        <div className="space-y-6">
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest ml-1">Title</label>
            <input 
              value={currentMeta.title}
              onChange={(e) => onUpdate(file.id, 'metadata', { ...currentMeta, title: e.target.value })}
              className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-transparent focus:border-brand-400 focus:bg-white transition-all text-sm outline-none"
              placeholder="Asset title"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest ml-1">Description</label>
            <textarea 
              rows={4}
              value={currentMeta.description}
              onChange={(e) => onUpdate(file.id, 'metadata', { ...currentMeta, description: e.target.value })}
              className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-transparent focus:border-brand-400 focus:bg-white transition-all text-sm outline-none resize-none leading-relaxed"
              placeholder="Stock description"
            />
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center px-1">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest block">Active Tags ({currentMeta.keywords.length}/50)</label>
            </div>
            <div className="flex gap-2">
              <input 
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
                placeholder="Add keyword..."
                className="flex-1 bg-transparent border-b border-slate-200 dark:border-slate-700 py-2 px-1 text-sm outline-none focus:border-brand-500 transition-colors"
              />
              <button 
                onClick={() => addKeyword()}
                className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-slate-600 hover:bg-slate-200 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" /></svg>
              </button>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              {currentMeta.keywords.map((kw, i) => (
                <div key={i} className="px-3 py-1.5 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300 rounded-lg text-[11px] font-medium flex items-center gap-1.5 hover:bg-brand-100 transition-colors group">
                  {kw}
                  <button onClick={() => removeKeyword(i)} className="text-brand-400 hover:text-rose-600 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Suggestion Pool (The "Make More Tags" feature) */}
          {(currentMeta.backupKeywords && currentMeta.backupKeywords.length > 0) && (
            <div className="space-y-3 pt-4 border-t border-slate-100 dark:border-slate-800">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest block ml-1">AI Suggestion Pool (Alternative Tags)</label>
              <div className="flex flex-wrap gap-2">
                {currentMeta.backupKeywords.map((kw, i) => (
                  <button 
                    key={i} 
                    onClick={() => addKeyword(kw)}
                    className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[10px] text-slate-500 hover:border-brand-300 hover:text-brand-600 hover:bg-brand-50 transition-all flex items-center gap-1"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-2.5 w-2.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" /></svg>
                    {kw}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

      </div>

      <div className="p-6 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
        <button 
          onClick={onClose}
          className="w-full py-3.5 bg-brand-600 text-white text-sm font-bold rounded-full shadow-lg hover:bg-brand-700 active:scale-[0.98] transition-all"
        >
          Confirm Metadata
        </button>
      </div>
    </aside>
  );
};

export default MetadataSidebar;
