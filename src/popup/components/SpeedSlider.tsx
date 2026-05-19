import React, { useCallback, useMemo } from 'react';

interface SpeedSliderProps {
  value: number; // 0.5 to 2.0
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Detected original BPM (used to display computed BPM value) */
  bpm?: number | null;
}

export const SpeedSlider: React.FC<SpeedSliderProps> = ({
  value,
  onChange,
  disabled = false,
  bpm = null,
}) => {
  // Показываем computed BPM только когда BPM определён, иначе — ratio
  const displayLabel =
    bpm !== null && bpm !== undefined ? `${Math.round(bpm * value)} BPM` : `${value.toFixed(2)}x`;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseFloat(e.target.value));
    },
    [onChange],
  );

  const handleReset = useCallback(() => {
    onChange(1.0);
  }, [onChange]);

  const adjustBpm = useCallback(
    (delta: number) => {
      if (bpm === null || bpm === undefined) return;
      const step = delta / bpm; // 1 BPM change → speed delta
      const newSpeed = Math.max(0.5, Math.min(2.0, value + step));
      onChange(newSpeed);
    },
    [bpm, value, onChange],
  );

  // Calculate percentage for visual feedback
  const percent = ((value - 0.5) / (2.0 - 0.5)) * 100;

  // +/- BPM buttons работают только когда BPM определён
  const canDecrease = useMemo(() => bpm !== null && bpm !== undefined && value > 0.5, [bpm, value]);
  const canIncrease = useMemo(() => bpm !== null && bpm !== undefined && value < 2.0, [bpm, value]);

  return (
    <div className={`transition-opacity ${disabled ? 'opacity-40' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Speed</label>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200 tabular-nums">{displayLabel}</span>
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
          <span>0.50x</span>
          <span>1.00x</span>
          <span>2.00x</span>
        </div>
      </div>
      {/* +/- Buttons */}
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => adjustBpm(-1)}
          disabled={disabled || !canDecrease}
          className="flex-1 text-xs py-1 rounded bg-white/5 text-slate-400
            hover:bg-white/10 hover:text-slate-200 transition-colors
            disabled:opacity-30 disabled:cursor-not-allowed">
          −1 BPM
        </button>
        <button
          onClick={() => adjustBpm(1)}
          disabled={disabled || !canIncrease}
          className="flex-1 text-xs py-1 rounded bg-white/5 text-slate-400
            hover:bg-white/10 hover:text-slate-200 transition-colors
            disabled:opacity-30 disabled:cursor-not-allowed">
          +1 BPM
        </button>
      </div>
    </div>
  );
};
