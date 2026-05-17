import type {
  ExtensionMessage,
  AudioParams,
  AudioMetrics,
  ExtensionState,
  StartCapturePayload,
} from '../shared/types';
import { DEFAULT_EXTENSION_STATE, DEFAULT_AUDIO_PARAMS } from '../shared/types';
import { Messages, saveStateToStorage, loadStateFromStorage } from '../shared/messaging';

/* ===== State ===== */

let state: ExtensionState = { ...DEFAULT_EXTENSION_STATE };
let offscreenPort: chrome.runtime.Port | null = null;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let captureTabId: number | null = null;

/* ===== Initialization ===== */

async function init(): Promise<void> {
  state = await loadStateFromStorage();
  console.log('[SW] Initialized with state:', state);
}

/* ===== Keep-alive mechanism ===== */

function startKeepAlive(): void {
  if (keepAliveInterval) return;
  chrome.alarms.create('keep-alive', { periodInMinutes: 0.5 });
  keepAliveInterval = setInterval(() => {
    chrome.alarms.get('keep-alive', () => {});
  }, 20000);
}

function stopKeepAlive(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  chrome.alarms.clear('keep-alive');
}

/* ===== Offscreen Document Management ===== */

async function ensureOffscreenDocument(): Promise<void> {
  const existingDocs = await chrome.offscreen.hasDocument?.();
  if (existingDocs) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK as string] as chrome.offscreen.Reason[],
    justification:
      'Audio processing (pitch shifting, BPM/Key detection) requires a persistent AudioContext.',
  });
}

async function closeOffscreenDocument(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Document may already be closed
  }
}

/* ===== Tab Capture ===== */

async function captureTab(tabId: number): Promise<string> {
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ consumerTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(id);
    });
  });
  return streamId;
}

async function startCapture(tabId: number): Promise<void> {
  try {
    const streamId = await captureTab(tabId);

    await ensureOffscreenDocument();

    // Wait a bit for offscreen document to initialize
    await new Promise((r) => setTimeout(r, 300));

    await sendToOffscreen(Messages.streamId(streamId));

    captureTabId = tabId;
    state = {
      ...state,
      isCapturing: true,
      tabId,
      params: DEFAULT_AUDIO_PARAMS,
      metrics: { bpm: null, key: null, confidence: null, isCapturing: true },
    };
    await saveStateToStorage(state);
    startKeepAlive();

    console.log('[SW] Capture started for tab:', tabId);
  } catch (error) {
    console.error('[SW] Capture failed:', error);
    console.error(`[SW] Capture error: ${(error as Error).message}`);
  }
}

async function stopCapture(): Promise<void> {
  try {
    await sendToOffscreen(Messages.killAudio());
    await closeOffscreenDocument();

    captureTabId = null;
    state = {
      ...state,
      isCapturing: false,
      tabId: null,
      metrics: { bpm: null, key: null, confidence: null, isCapturing: false },
    };
    await saveStateToStorage(state);
    stopKeepAlive();

    console.log('[SW] Capture stopped');
  } catch (error) {
    console.error('[SW] Stop capture failed:', error);
  }
}

/* ===== Offscreen Communication ===== */

async function sendToOffscreen(message: ExtensionMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    if (offscreenPort) {
      offscreenPort.postMessage(message);
    }
  }
}

/* ===== Message Handlers ===== */

async function handleMessage(
  message: ExtensionMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  console.log('[SW] Received message:', message.type, message.payload);

  switch (message.type) {
    case 'START_CAPTURE': {
      const { tabId } = message.payload as StartCapturePayload;
      await startCapture(tabId);
      sendResponse({ success: true });
      break;
    }

    case 'STOP_CAPTURE': {
      await stopCapture();
      sendResponse({ success: true });
      break;
    }

    case 'UPDATE_PARAMS': {
      const params = message.payload as AudioParams;
      state = { ...state, params };
      await saveStateToStorage(state);
      await sendToOffscreen(Messages.updateParams(params));
      sendResponse({ success: true });
      break;
    }

    case 'METRICS_UPDATE': {
      const metrics = message.payload as AudioMetrics;
      state = { ...state, metrics };
      await saveStateToStorage(state);
      sendResponse({ success: true });
      break;
    }

    case 'GET_STATE': {
      sendResponse(state);
      break;
    }

    case 'ERROR': {
      console.error('[SW] Error from offscreen:', message.payload);
      sendResponse({ success: true });
      break;
    }

    default: {
      console.warn('[SW] Unknown message type:', (message as { type: string }).type);
      sendResponse({ success: false, error: 'Unknown message type' });
    }
  }
}

/* ===== Event Listeners ===== */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen') {
    offscreenPort = port;
    console.log('[SW] Offscreen port connected');

    port.onMessage.addListener((message: ExtensionMessage) => {
      console.log('[SW] Message from offscreen port:', message.type);

      if (message.type === 'METRICS_UPDATE') {
        const metrics = message.payload as AudioMetrics;
        state = { ...state, metrics };
        saveStateToStorage(state);
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('[SW] Offscreen port disconnected');
      offscreenPort = null;
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (captureTabId === tabId && state.isCapturing) {
    console.log('[SW] Captured tab closed, stopping capture');
    stopCapture();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keep-alive') {
    sendToOffscreen(Messages.getState()).catch(() => {});
  }
});

init();
