import { useState, useCallback, useRef, useEffect } from 'react';
import type { AudioParams, AudioMetrics, ExtensionState } from '../../shared/types';
import { DEFAULT_EXTENSION_STATE } from '../../shared/types';
import { Messages, sendRuntimeMessage } from '../../shared/messaging';

interface UseExtensionStateReturn {
  state: ExtensionState;
  isCapturing: boolean;
  updateParams: (partial: Partial<AudioParams>) => void;
  requestState: () => Promise<void>;
}

/**
 * Debounce helper: возвращает функцию, которая вызывает callback
 * не чаще чем раз в `delay` мс. Последний вызов всегда доходит.
 */
function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
}

export function useExtensionState(): UseExtensionStateReturn {
  const [state, setState] = useState<ExtensionState>({ ...DEFAULT_EXTENSION_STATE });
  const stateRef = useRef(state);
  stateRef.current = state;

  // Establish persistent port connection to keep SW alive while popup is open
  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'popup' });
    return () => {
      port.disconnect();
    };
  }, []);

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

  // Debounced send to background — не чаще чем раз в 80мс
  const debouncedSendParams = useRef(
    debounce(async (params: AudioParams) => {
      try {
        await sendRuntimeMessage(Messages.updateParams(params));
      } catch (error) {
        console.error('[Popup] Failed to update params:', error);
        // Revert on failure
        setState((prev) => {
          if (prev.params.speed !== params.speed || prev.params.pitch !== params.pitch) {
            return { ...prev, params };
          }
          return prev;
        });
      }
    }, 80),
  ).current;

  // Update audio params via service worker (debounced)
  const updateParams = useCallback(
    (partial: Partial<AudioParams>) => {
      const current = stateRef.current;
      const newParams: AudioParams = {
        ...current.params,
        ...partial,
      };

      // Optimistic update immediately (UI stays responsive)
      setState((prev) => ({
        ...prev,
        params: newParams,
      }));

      // Debounced send to background
      debouncedSendParams(newParams);
    },
    [debouncedSendParams],
  );

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
