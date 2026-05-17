import type { ExtensionMessage, AudioParams } from '../shared/types';
import { AudioEngine } from './audio-engine';

/* ===== Audio Engine Instance ===== */

let engine: AudioEngine | null = null;

// Pre-emptively create AudioEngine and start preparation (AudioContext + worklets).
// This runs as soon as the offscreen document loads — well before the user clicks Start.
// When init() is called later, it skips AudioContext creation and worklet loading,
// going straight to getUserMedia + graph connect. This eliminates ~1-3s of startup delay.
engine = new AudioEngine();
engine.prepare().catch((err) => console.warn('[Offscreen] Early prepare failed:', err));

/* ===== Message Handling ===== */

async function handleMessage(message: ExtensionMessage): Promise<void> {
  console.log('[Offscreen] Received message:', message.type, message.payload);

  switch (message.type) {
    case 'STREAM_ID': {
      const { streamId } = message.payload as { streamId: string };
      // engine is always created (from top-level prepare), so this is just a safety check
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
        // Don't null the engine — keep it for future init cycles.
        // destroy() resets prepare state internally.
      }
      break;
    }

    case 'GET_STATE': {
      // Respond with current capture state + last known metrics.
      // Важно: bpm/key передаются ВНУТРИ metrics, т.к. popup читает metrics.bpm / metrics.key.
      const state = engine?.getState() ?? {};
      chrome.runtime
        .sendMessage({
          type: 'STATE_UPDATE',
          payload: {
            isCapturing: state.isCapturing ?? false,
            metrics: {
              bpm: state.bpm ?? null,
              key: state.key ?? null,
              confidence: state.confidence ?? null,
              frequency: state.frequency ?? null,
            },
          },
        })
        .catch(() => {});
      break;
    }

    default:
    // Ignore — runtime.sendMessage delivers to all extension pages
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

// Signal that the offscreen document is fully loaded and listeners are registered
chrome.runtime
  .sendMessage({ type: 'OFFSCREEN_READY', payload: {} } as ExtensionMessage)
  .catch(() => {});
console.log('[Offscreen] Document loaded and ready');
