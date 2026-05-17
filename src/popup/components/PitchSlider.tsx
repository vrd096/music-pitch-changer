import React, { useCallback } from 'react';

interface PitchSliderProps {
  value: number; // -12 to +12 semitones
  onChange: (value: number) => void;
  disabled?: boolean;
}

export const PitchSlider: React.FC<PitchSliderProps> = ({ value, onChange, disabled = false }) => {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseInt(e.target.value, 10));
    },
    [onChange],
  );

  const handleReset = useCallback(() => {
    onChange(0);
  }, [onChange]);

  // Calculate percentage for visual feedback
  const percent = ((value + 12) / 24) * 100;

  return (
    <div className={`transition-opacity ${disabled ? 'opacity-40' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Pitch</label>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200 tabular-nums">
            {value > 0 ? `+${value}` : value} st
          </span>
          <button
            onClick={handleReset}
            disabled={disabled || value === 0}
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
          min="-12"
          max="12"
          step="1"
          value={value}
          onChange={handleChange}
          disabled={disabled}
          className="w-full cursor-pointer disabled:cursor-not-allowed"
          style={{
            background: `linear-gradient(to right, #4f46e5 0%, #818cf8 ${percent}%, #374151 ${percent}%, #374151 100%)`,
          }}
        />
        <div className="flex justify-between text-[10px] text-slate-600 mt-1">
          <span>-12</span>
          <span>0</span>
          <span>+12</span>
        </div>
      </div>
    </div>
  );
};
