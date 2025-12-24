import React, { useCallback, useState } from 'react';

interface FileUploadProps {
  onFilesSelected: (files: File[]) => void;
  onFolderSelected?: () => void;
  isFolderMode?: boolean;
  folderName?: string | null;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFilesSelected, onFolderSelected, isFolderMode, folderName }) => {
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);
  
  const handleSelectFolder = useCallback(async () => {
    if (!onFolderSelected) return;
    setIsSelectingFolder(true);
    try {
      await onFolderSelected();
    } catch (error: any) {
      console.error('Error selecting folder:', error);
    } finally {
      setIsSelectingFolder(false);
    }
  }, [onFolderSelected]);
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        onFilesSelected(Array.from(e.dataTransfer.files));
        e.dataTransfer.clearData();
      }
    },
    [onFilesSelected]
  );

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      className="group relative border-2 border-dashed border-slate-300 dark:border-slate-800 rounded-3xl p-20 text-center hover:border-brand-500 hover:bg-white dark:hover:bg-slate-900 transition-all cursor-pointer bg-slate-50/50 dark:bg-slate-900/50 w-full max-w-4xl"
    >
      <input
        type="file"
        multiple
        className="hidden"
        id="file-upload"
        onChange={handleChange}
        accept="image/*,video/*,.pdf,.txt,.doc,.docx,.ai,.eps,.svg"
      />
      <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center gap-8">
        <div className="w-20 h-20 bg-brand-50 dark:bg-brand-900/20 rounded-full flex items-center justify-center text-brand-600 transition-transform group-hover:scale-105 duration-300">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
        </div>
        
        <div>
          <h3 className="text-2xl font-semibold text-slate-800 dark:text-white mb-2 tracking-tight">
            {isFolderMode && folderName ? `Working with: ${folderName}` : 'Import Asset Library'}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
            {isFolderMode 
              ? 'Files are processed directly from your local folder. Changes are saved automatically.'
              : 'Drag files here or click to browse. Supports stock-standard image, video, and design formats.'}
          </p>
        </div>

        <div className="flex flex-col items-center gap-3">
          {!isFolderMode && (
            <div className="flex gap-3">
              <span className="px-4 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-500 uppercase tracking-widest border border-slate-200 dark:border-slate-700">49 Tags</span>
              <span className="px-4 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-500 uppercase tracking-widest border border-slate-200 dark:border-slate-700">SEO Ready</span>
              <span className="px-4 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-500 uppercase tracking-widest border border-slate-200 dark:border-slate-700">N-Batch</span>
            </div>
          )}
          
          {onFolderSelected && (
            <button
              onClick={handleSelectFolder}
              disabled={isSelectingFolder}
              className="px-6 py-3 bg-brand-600 text-white rounded-full text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors shadow-sm flex items-center gap-2"
            >
              {isSelectingFolder ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Selecting...
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  {isFolderMode ? 'Change Folder' : 'Select Folder Instead'}
                </>
              )}
            </button>
          )}
        </div>
      </label>
    </div>
  );
};

export default FileUpload;