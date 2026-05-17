import type { ExtensionMessage, AudioParams } from '../shared/types';
import { AudioEngine } from './audio-engine';

/* ===== Audio Engine Instance ===== */

let engine: AudioEngine | null = null;

/* ===== Message Handling ===== */

async function handleMessage(message: ExtensionMessage): Promise<void> {
  console.log('[Offscreen] Received message:', message.type, message.payload);

  switch (message.type) {
    case 'STREAM_ID': {
      const { streamId } = message.payload as { streamId: string };
      if (!engine) {
        engine = new AudioEngine();
      }
      await engine.init(streamId);
      break;
    }

    case 'UPDATE_PARAMS': {
      const params = message.payload as AudioParams;
      if (engine) {
        engine.applyParams(params);
      }
      break;
    }

    case 'KILL_AUDIO': {
      if (engine) {
        await engine.destroy();
        engine = null;
      }
      break;
    }

    case 'GET_STATE': {
      // Respond with current capture state
      chrome.runtime
        .sendMessage({
          type: 'STATE_UPDATE',
          payload: { isCapturing: engine !== null },
        })
        .catch(() => {});
      break;
    }

    default:
      console.warn('[Offscreen] Unknown message type:', message.type);
  }
}

/* ===== Listeners ===== */

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  handleMessage(message).catch(console.error);
  sendResponse({ received: true });
  return true;
});

// Listen for port connection (if used)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen') {
    port.onMessage.addListener((message: ExtensionMessage) => {
      handleMessage(message).catch(console.error);
    });
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (engine) {
    engine.destroy().catch(console.error);
    engine = null;
  }
});

console.log('[Offscreen] Document loaded and ready');
