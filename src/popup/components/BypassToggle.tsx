import React, { useCallback } from 'react';

interface BypassToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}

export const BypassToggle: React.FC<BypassToggleProps> = ({
  enabled,
  onChange,
  disabled = false,
}) => {
  const handleToggle = useCallback(() => {
    onChange(!enabled);
  }, [enabled, onChange]);

  return (
    <div className={`flex items-center justify-between ${disabled ? 'opacity-40' : ''}`}>
      <div>
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Bypass</span>
        <p className="text-[10px] text-slate-600 mt-0.5">
          {enabled ? 'Effects disabled — original audio' : 'Pitch & speed processing active'}
        </p>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={enabled} onChange={handleToggle} disabled={disabled} />
        <span className="toggle-slider" />
      </label>
    </div>
  );
};
