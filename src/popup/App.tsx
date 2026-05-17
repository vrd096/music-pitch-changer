import React, { useCallback } from 'react';
import { useExtensionState } from './hooks/useExtensionState';
import { StartStopButton } from './components/StartStopButton';
import { BpmDisplay } from './components/BpmDisplay';
import { KeyDisplay } from './components/KeyDisplay';
import { SpeedSlider } from './components/SpeedSlider';
import { PitchSlider } from './components/PitchSlider';
import { BypassToggle } from './components/BypassToggle';
import type { AudioParams } from '../shared/types';
import { Messages, sendRuntimeMessage } from '../shared/messaging';

const App: React.FC = () => {
  const { state, updateParams, requestState } = useExtensionState();
  const { metrics, params, isCapturing } = state;

  // Request current state when popup opens (only on mount)
  React.useEffect(() => {
    requestState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getCurrentTabId = useCallback(async (): Promise<number | undefined> => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id;
    } catch {
      return undefined;
    }
  }, []);

  const handleStartCapture = useCallback(async () => {
    const tabId = await getCurrentTabId();
    if (!tabId) return;
    await sendRuntimeMessage(Messages.startCapture(tabId));
  }, [getCurrentTabId]);

  const handleStopCapture = useCallback(async () => {
    await sendRuntimeMessage(Messages.stopCapture());
  }, []);

  const handleParamsChange = useCallback(
    (newParams: Partial<AudioParams>) => {
      updateParams(newParams);
    },
    [updateParams],
  );

  return (
    <div className="w-[360px] min-h-[400px] bg-gradient-to-b from-surface-900 to-surface-950 text-slate-100 p-4 select-none">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-primary-500 pulse-glow" />
          <h1 className="text-sm font-semibold text-slate-200 tracking-wide">Pitch Changer</h1>
        </div>
        <StartStopButton
          isCapturing={isCapturing}
          onStart={handleStartCapture}
          onStop={handleStopCapture}
        />
      </div>

      <div className="h-px bg-gradient-to-r from-transparent via-primary-500/30 to-transparent mb-4" />

      {/* Metrics Section */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <BpmDisplay bpm={metrics.bpm} isCapturing={isCapturing} />
        <KeyDisplay
          keyValue={metrics.key}
          confidence={metrics.confidence}
          isCapturing={isCapturing}
        />
      </div>

      {/* DRM Warning */}
      {isCapturing && metrics.bpm === null && metrics.key === null && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
          Analyzing audio stream. If this persists, the audio may be DRM-protected or silent.
        </div>
      )}

      {/* Controls Section */}
      <div className="space-y-4">
        <SpeedSlider
          value={params.speed}
          onChange={(speed) => handleParamsChange({ speed })}
          disabled={!isCapturing}
        />
        <PitchSlider
          value={params.pitch}
          onChange={(pitch) => handleParamsChange({ pitch })}
          disabled={!isCapturing}
        />
      </div>

      {/* Bypass Toggle */}
      <div className="mt-4 pt-3 border-t border-white/5">
        <BypassToggle
          enabled={params.bypass}
          onChange={(bypass) => handleParamsChange({ bypass })}
          disabled={!isCapturing}
        />
      </div>

      {/* Footer */}
      <div className="mt-4 text-center">
        <a
          href="#"
          className="text-[10px] text-slate-600 hover:text-slate-500 transition-colors"
          onClick={(e) => {
            e.preventDefault();
            chrome.tabs.create({ url: 'https://github.com/your-username/music-pitch-changer' });
          }}>
          v1.0.0 — 100% on-device processing
        </a>
      </div>
    </div>
  );
};

export default App;
