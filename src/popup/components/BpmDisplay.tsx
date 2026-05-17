import React from 'react';

interface BpmDisplayProps {
  bpm: number | null;
  isCapturing: boolean;
}

export const BpmDisplay: React.FC<BpmDisplayProps> = ({ bpm, isCapturing }) => {
  const isLoading = isCapturing && bpm === null;

  return (
    <div className="relative px-4 py-3 rounded-xl bg-surface-800/60 border border-white/5 overflow-hidden">
      {/* Background gradient pulse */}
      <div
        className={`
          absolute inset-0 opacity-10 transition-opacity duration-500
          ${isCapturing ? 'bg-gradient-to-br from-primary-500/20 to-transparent' : ''}
        `}
      />

      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">
            BPM
          </span>
          {isCapturing && !isLoading && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          )}
          {isLoading && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
        </div>
        <div className="text-2xl font-bold tabular-nums">
          {bpm !== null ? (
            <span className="text-slate-100">{bpm}</span>
          ) : isLoading ? (
            <span className="text-slate-500 inline-flex items-center gap-1">
              <span className="animate-bounce [animation-delay:0ms]">·</span>
              <span className="animate-bounce [animation-delay:150ms]">·</span>
              <span className="animate-bounce [animation-delay:300ms]">·</span>
              <span className="ml-1.5 text-xs font-normal text-slate-600 tracking-normal">
                Detecting
              </span>
            </span>
          ) : (
            <span className="text-slate-600">--</span>
          )}
        </div>
        {bpm !== null && isCapturing && (
          <div className="mt-1 h-0.5 rounded-full bg-gradient-to-r from-primary-500 to-primary-400" />
        )}
        {isLoading && (
          <div className="mt-1 h-0.5 rounded-full bg-gradient-to-r from-amber-500/50 to-amber-400/20 overflow-hidden">
            <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-amber-400 to-amber-300 animate-loading-bar" />
          </div>
        )}
      </div>
    </div>
  );
};
