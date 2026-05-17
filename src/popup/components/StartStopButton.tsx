import React from 'react';

interface StartStopButtonProps {
  isCapturing: boolean;
  onStart: () => void;
  onStop: () => void;
}

export const StartStopButton: React.FC<StartStopButtonProps> = ({
  isCapturing,
  onStart,
  onStop,
}) => {
  return (
    <button
      onClick={isCapturing ? onStop : onStart}
      className={`
        btn-press relative px-4 py-1.5 rounded-full text-xs font-medium
        transition-all duration-200
        ${
          isCapturing
            ? 'bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30'
            : 'bg-primary-600/20 text-primary-400 border border-primary-500/30 hover:bg-primary-600/30'
        }
      `}>
      <span className="flex items-center gap-1.5">
        {isCapturing ? (
          <>
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            Stop
          </>
        ) : (
          <>
            <span className="w-2 h-2 rounded-full bg-primary-400" />
            Start
          </>
        )}
      </span>
    </button>
  );
};
