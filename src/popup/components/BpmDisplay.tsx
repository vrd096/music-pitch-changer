import React from 'react';

interface BpmDisplayProps {
  bpm: number | null;
  isCapturing: boolean;
}

export const BpmDisplay: React.FC<BpmDisplayProps> = ({ bpm, isCapturing }) => {
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
          {isCapturing && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
        </div>
        <div className="text-2xl font-bold tabular-nums">
          {bpm !== null ? (
            <span className="text-slate-100">{bpm}</span>
          ) : (
            <span className="text-slate-600">{isCapturing ? '···' : '--'}</span>
          )}
        </div>
        {bpm !== null && isCapturing && (
          <div className="mt-1 h-0.5 rounded-full bg-gradient-to-r from-primary-500 to-primary-400" />
        )}
      </div>
    </div>
  );
};
