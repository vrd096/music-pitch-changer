import { useState, useCallback, useRef, useEffect } from 'react';
import type { AudioParams, AudioMetrics, ExtensionState } from '../../shared/types';
import { DEFAULT_EXTENSION_STATE } from '../../shared/types';
import { Messages, sendRuntimeMessage } from '../../shared/messaging';

interface UseExtensionStateReturn {
  state: ExtensionState;
  isCapturing: boolean;
  updateParams: (partial: Partial<AudioParams>) => Promise<void>;
  requestState: () => Promise<void>;
}

export function useExtensionState(): UseExtensionStateReturn {
  const [state, setState] = useState<ExtensionState>({ ...DEFAULT_EXTENSION_STATE });
  const stateRef = useRef(state);
  stateRef.current = state;

  // Listen for metrics updates and state from background
  useEffect(() => {
    const handleMessage = (message: unknown) => {
      const msg = message as { type: string; payload?: unknown };

      switch (msg.type) {
        case 'METRICS_UPDATE': {
          const metrics = msg.payload as AudioMetrics;
          setState((prev) => ({
            ...prev,
            metrics: {
              bpm: metrics.bpm !== undefined ? metrics.bpm : prev.metrics.bpm,
              key: metrics.key !== undefined ? metrics.key : prev.metrics.key,
              confidence:
                metrics.confidence !== undefined ? metrics.confidence : prev.metrics.confidence,
              frequency:
                metrics.frequency !== undefined ? metrics.frequency : prev.metrics.frequency,
              isCapturing: metrics.isCapturing ?? prev.isCapturing,
            },
          }));
          break;
        }

        case 'STATE_UPDATE': {
          const newState = msg.payload as Partial<ExtensionState>;
          if (newState) {
            setState((prev) => ({ ...prev, ...newState }));
          }
          break;
        }

        case 'ERROR': {
          const error = msg.payload as { code: string; message: string };
          console.error('[Popup] Error:', error.code, error.message);
          break;
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  // Update audio params via service worker
  const updateParams = useCallback(async (partial: Partial<AudioParams>) => {
    const current = stateRef.current;
    const newParams: AudioParams = {
      ...current.params,
      ...partial,
    };

    // Optimistic update
    setState((prev) => ({
      ...prev,
      params: newParams,
    }));

    // Send to background
    try {
      await sendRuntimeMessage(Messages.updateParams(newParams));
    } catch (error) {
      console.error('[Popup] Failed to update params:', error);
      // Revert on failure
      setState((prev) => ({
        ...prev,
        params: current.params,
      }));
    }
  }, []);

  // Request full state from service worker
  const requestState = useCallback(async () => {
    try {
      const response = await sendRuntimeMessage(Messages.getState());
      if (response && typeof response === 'object' && 'isCapturing' in response) {
        setState(response as ExtensionState);
      }
    } catch (error) {
      console.error('[Popup] Failed to fetch state:', error);
    }
  }, []);

  return {
    state,
    isCapturing: state.isCapturing,
    updateParams,
    requestState,
  };
}
