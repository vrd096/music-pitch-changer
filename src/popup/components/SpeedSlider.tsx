import React, { useCallback } from 'react';

interface SpeedSliderProps {
  value: number; // 0.5 to 2.0
  onChange: (value: number) => void;
  disabled?: boolean;
}

export const SpeedSlider: React.FC<SpeedSliderProps> = ({ value, onChange, disabled = false }) => {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseFloat(e.target.value));
    },
    [onChange],
  );

  const handleReset = useCallback(() => {
    onChange(1.0);
  }, [onChange]);

  // Calculate percentage for visual feedback
  const percent = ((value - 0.5) / (2.0 - 0.5)) * 100;

  return (
    <div className={`transition-opacity ${disabled ? 'opacity-40' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Speed</label>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200 tabular-nums">
            {Math.round(value * 100)}%
          </span>
          <button
            onClick={handleReset}
            disabled={disabled || value === 1.0}
            className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-slate-500
              hover:bg-white/10 hover:text-slate-300 transition-colors
              disabled:opacity-30 disabled:cursor-not-allowed">
            Reset
          </button>
        </div>
      </div>
      <div className="relative">
        <input
          type="range"
          min="0.5"
          max="2.0"
          step="0.01"
          value={value}
          onChange={handleChange}
          disabled={disabled}
          className="w-full cursor-pointer disabled:cursor-not-allowed"
          style={{
            background: `linear-gradient(to right, #4f46e5 0%, #818cf8 ${percent}%, #374151 ${percent}%, #374151 100%)`,
          }}
        />
        <div className="flex justify-between text-[10px] text-slate-600 mt-1">
          <span>50%</span>
          <span>100%</span>
          <span>200%</span>
        </div>
      </div>
    </div>
  );
};
