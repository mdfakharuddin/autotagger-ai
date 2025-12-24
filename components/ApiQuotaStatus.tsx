import React, { useState, useEffect } from 'react';
import { ApiKeyRecord } from '../types';

interface ApiQuotaStatusProps {
  apiKeys: ApiKeyRecord[];
}

const ApiQuotaStatus: React.FC<ApiQuotaStatusProps> = ({ apiKeys }) => {
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
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700"
            title={`${key.label}: ${used}/${limit} requests - Resets in ${getTimeUntilReset(key.quotaResetAt)}`}
          >
            <div className="flex flex-col min-w-[120px]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate max-w-[80px]">
                  {key.label}
                </span>
                <span className={`text-xs font-bold ${isCooldown ? 'text-amber-600' : 'text-slate-600 dark:text-slate-400'}`}>
                  {used}/{limit}
                </span>
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

