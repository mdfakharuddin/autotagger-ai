import React, { useState } from 'react';
import { GenerationProfile, ApiKeyRecord } from '../types';
import { geminiService } from '../services/geminiService';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiKeys: ApiKeyRecord[];
  onAddKey: (key: string, label: string) => void;
  onRemoveKey: (id: string) => void;
  onResetQuota?: (id: string) => void;
  customProfilePrompts: Record<GenerationProfile, string>;
  onUpdateProfilePrompt: (profile: GenerationProfile, prompt: string) => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ 
  isOpen, 
  onClose, 
  apiKeys,
  onAddKey,
  onRemoveKey,
  onResetQuota,
  customProfilePrompts,
  onUpdateProfilePrompt
}) => {
  const [activeTab, setActiveTab] = useState<'keys' | 'profiles'>('keys');
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; msg: string } | null>(null);

  if (!isOpen) return null;

  const handleAddKey = async () => {
    if (!newKey.trim()) return;
    setIsTesting(true);
    setTestResult(null);
    
    const isValid = await geminiService.testKey(newKey.trim());
    setIsTesting(false);
    
    if (isValid) {
      onAddKey(newKey.trim(), newLabel.trim() || `Key ${apiKeys.length + 1}`);
      setNewKey('');
      setNewLabel('');
      setTestResult({ success: true, msg: "Key verified and added" });
      setTimeout(() => setTestResult(null), 3000);
    } else {
      setTestResult({ success: false, msg: "Invalid API Key" });
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-fade-in">
      <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] animate-slide-up border border-slate-200 dark:border-slate-800">
        
        {/* Simple Header */}
        <div className="px-8 pt-8 pb-4 flex justify-between items-center">
          <h3 className="text-xl font-medium text-slate-900 dark:text-white">Settings</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Minimal Tabs */}
        <div className="px-8 flex border-b border-slate-100 dark:border-slate-800">
          <button
            onClick={() => setActiveTab('keys')}
            className={`pb-3 px-1 mr-8 text-sm font-medium transition-all relative ${activeTab === 'keys' ? 'text-brand-600' : 'text-slate-500 hover:text-slate-700'}`}
          >
            API Keys
            {activeTab === 'keys' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-600 rounded-full" />}
          </button>
          <button
            onClick={() => setActiveTab('profiles')}
            className={`pb-3 px-1 text-sm font-medium transition-all relative ${activeTab === 'profiles' ? 'text-brand-600' : 'text-slate-500 hover:text-slate-700'}`}
          >
            AI Profiles
            {activeTab === 'profiles' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-600 rounded-full" />}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
          {activeTab === 'keys' ? (
            <div className="space-y-8">
              {apiKeys.length === 0 && (
                <div className="p-5 bg-blue-50 dark:bg-blue-900/20 rounded-2xl border border-blue-100 dark:border-blue-900/20">
                  <div className="flex items-start gap-3">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-2">Get started with your API key</p>
                      <p className="text-xs text-blue-700 dark:text-blue-300">Add a Google Gemini API key to start generating metadata. Your keys are stored securely in your browser and never sent to any server except Google's API.</p>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500 ml-1">Key Label</label>
                    <input
                      type="text"
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="e.g. Workspace Key"
                      className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 outline-none transition-all"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500 ml-1">Gemini API Key</label>
                    <input
                      type="password"
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      placeholder="Enter your Gemini API key (AIza...)"
                      className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-mono focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 outline-none transition-all"
                    />
                  </div>
                </div>
                <button 
                  onClick={handleAddKey}
                  disabled={!newKey.trim() || isTesting}
                  className="w-full py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors shadow-sm"
                >
                  {isTesting ? 'Verifying...' : 'Add Key'}
                </button>
                {testResult && (
                  <p className={`text-xs text-center font-medium ${testResult.success ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {testResult.msg}
                  </p>
                )}
              </div>

              {apiKeys.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-widest text-slate-400 ml-1">Manage Keys</h4>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-100 dark:border-slate-800 rounded-2xl overflow-hidden">
                    {apiKeys.map(k => {
                      const used = k.requestCount || 0;
                      const limit = k.requestsPerMinute || 50;
                      const hasUsage = used > 0;
                      
                      return (
                        <div key={k.id} className="flex items-center justify-between p-4 bg-white dark:bg-slate-900 group">
                          <div className="flex flex-col flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{k.label}</span>
                              {hasUsage && (
                                <span className="text-xs text-slate-500">
                                  ({used}/{limit} requests)
                                </span>
                              )}
                            </div>
                            <span className="text-xs font-mono text-slate-400">••••{k.key.slice(-4)}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            {hasUsage && onResetQuota && (
                              <button 
                                onClick={() => onResetQuota(k.id)} 
                                className="p-2 text-slate-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20 rounded-full transition-all"
                                title="Reset quota"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              </button>
                            )}
                            <button 
                              onClick={() => onRemoveKey(k.id)} 
                              className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-full transition-all"
                              title="Remove key"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              <p className="text-xs text-slate-500 leading-relaxed px-1">
                Customize how the AI analyzes different types of assets. These instructions are appended to every metadata request.
              </p>
              <div className="space-y-6">
                {Object.values(GenerationProfile).map(profile => (
                  <div key={profile} className="space-y-2">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1">{profile}</label>
                    <textarea 
                      rows={3}
                      value={customProfilePrompts[profile] || ''}
                      onChange={(e) => onUpdateProfilePrompt(profile, e.target.value)}
                      placeholder={`Enter custom logic for ${profile}...`}
                      className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 outline-none transition-all resize-none"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-slate-100 dark:border-slate-800 flex justify-end">
          <button 
            onClick={onClose}
            className="px-6 py-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-full text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;