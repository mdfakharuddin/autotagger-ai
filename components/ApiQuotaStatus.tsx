import React, { useState, useEffect } from 'react';
import { ApiKeyRecord } from '../types';

interface ApiQuotaStatusProps {
  apiKeys: ApiKeyRecord[];
  onResetQuota: (id: string) => void;
}

const ApiQuotaStatus: React.FC<ApiQuotaStatusProps> = ({ apiKeys, onResetQuota }) => {
  const [currentTime, setCurrentTime] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000); // Update every second for countdown

    return () => clearInterval(interval);
  }, []);

  if (apiKeys.length === 0) return null;

  const getTimeUntilReset = (resetAt: number | undefined): string => {
    if (!resetAt) return '--';
    const seconds = Math.max(0, Math.floor((resetAt - currentTime) / 1000));
    if (seconds === 0) return 'Reset!';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  };

  const getQuotaPercentage = (key: ApiKeyRecord): number => {
    const limit = key.requestsPerMinute || 60;
    const used = key.requestCount || 0;
    return Math.min(100, (used / limit) * 100);
  };

  const getQuotaColor = (percentage: number): string => {
    if (percentage >= 90) return 'bg-rose-500';
    if (percentage >= 75) return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  return (
    <div className="flex items-center gap-2">
      {apiKeys.map(key => {
        const percentage = getQuotaPercentage(key);
        const limit = key.requestsPerMinute || 60;
        const used = key.requestCount || 0;
        const isCooldown = key.status === 'cooldown' || (key.cooldownUntil && currentTime < key.cooldownUntil);
        
        return (
          <div 
            key={key.id} 
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 group"
            title={`${key.label}: ${used}/${limit} requests - Resets in ${getTimeUntilReset(key.quotaResetAt)}`}
          >
            <div className="flex flex-col min-w-[120px]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate max-w-[80px]">
                  {key.label}
                </span>
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-bold ${isCooldown ? 'text-amber-600' : 'text-slate-600 dark:text-slate-400'}`}>
                    {used}/{limit}
                  </span>
                  {(used > 0 || isCooldown) && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onResetQuota(key.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-500 hover:text-brand-600 dark:hover:text-brand-400"
                      title="Reset quota"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all duration-300 ${getQuotaColor(percentage)}`}
                  style={{ width: `${percentage}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span className={`text-[10px] ${isCooldown ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500'}`}>
                  {isCooldown ? 'Cooldown' : 'Active'}
                </span>
                <span className="text-[10px] text-slate-400">
                  {getTimeUntilReset(key.quotaResetAt)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default ApiQuotaStatus;

