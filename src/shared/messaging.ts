import type { ExtensionMessage, AudioParams, AudioMetrics, ExtensionState } from './types';
import { DEFAULT_AUDIO_PARAMS, DEFAULT_AUDIO_METRICS, DEFAULT_EXTENSION_STATE } from './types';

/**
 * Send a message to the extension runtime (background service worker).
 */
export function sendRuntimeMessage<T = unknown>(message: ExtensionMessage<T>): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

/**
 * Send a message to a specific tab via the background service worker.
 */
export function sendTabMessage<T = unknown>(
  tabId: number,
  message: ExtensionMessage<T>,
): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message);
}

/**
 * Create a typed extension message.
 */
export function createMessage<T>(type: ExtensionMessage['type'], payload?: T): ExtensionMessage<T> {
  return { type, payload } as ExtensionMessage<T>;
}

/* ===== Helper factories ===== */

export const Messages = {
  startCapture: (tabId: number): ExtensionMessage<{ tabId: number }> =>
    createMessage('START_CAPTURE', { tabId }),

  stopCapture: (): ExtensionMessage<undefined> => createMessage('STOP_CAPTURE'),

  streamId: (streamId: string): ExtensionMessage<{ streamId: string }> =>
    createMessage('STREAM_ID', { streamId }),

  killAudio: (): ExtensionMessage<undefined> => createMessage('KILL_AUDIO'),

  updateParams: (params: AudioParams): ExtensionMessage<AudioParams> =>
    createMessage('UPDATE_PARAMS', params),

  metricsUpdate: (metrics: AudioMetrics): ExtensionMessage<AudioMetrics> =>
    createMessage('METRICS_UPDATE', metrics),

  getState: (): ExtensionMessage<undefined> => createMessage('GET_STATE'),

  stateUpdate: (state: ExtensionState): ExtensionMessage<ExtensionState> =>
    createMessage('STATE_UPDATE', state),

  error: (code: string, message: string): ExtensionMessage<{ code: string; message: string }> =>
    createMessage('ERROR', { code, message }),
};

/* ===== Storage helpers ===== */

const STORAGE_KEY = 'extension-state';

export async function saveStateToStorage(state: ExtensionState): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEY]: state });
}

export async function loadStateFromStorage(): Promise<ExtensionState> {
  const result = await chrome.storage.session.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as ExtensionState) ?? DEFAULT_EXTENSION_STATE;
}

export { DEFAULT_AUDIO_PARAMS, DEFAULT_AUDIO_METRICS, DEFAULT_EXTENSION_STATE };
