import React from 'react';

interface KeyDisplayProps {
  keyValue: string | null;
  confidence: number | null;
  isCapturing: boolean;
}

export const KeyDisplay: React.FC<KeyDisplayProps> = ({ keyValue, confidence, isCapturing }) => {
  return (
    <div className="relative px-4 py-3 rounded-xl bg-surface-800/60 border border-white/5 overflow-hidden">
      {/* Background gradient pulse */}
      <div
        className={`
          absolute inset-0 opacity-10 transition-opacity duration-500
          ${isCapturing ? 'bg-gradient-to-bl from-primary-500/20 to-transparent' : ''}
        `}
      />

      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">
            Key
          </span>
          {keyValue && <span className="w-1.5 h-1.5 rounded-full bg-green-400" />}
        </div>
        <div className="text-2xl font-bold tabular-nums">
          {keyValue !== null ? (
            <span className="text-slate-100">{keyValue}</span>
          ) : (
            <span className="text-slate-600">{isCapturing ? '···' : '--'}</span>
          )}
        </div>
        {confidence !== null && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary-500 transition-all duration-300"
                style={{ width: `${Math.round((confidence ?? 0) * 100)}%` }}
              />
            </div>
            <span className="text-[10px] text-slate-500 tabular-nums">
              {Math.round((confidence ?? 0) * 100)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
