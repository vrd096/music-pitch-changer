/// <reference types="vitest/globals" />
import { describe, it, expect, vi } from 'vitest';
import {
  Messages,
  createMessage,
  sendRuntimeMessage,
  saveStateToStorage,
  loadStateFromStorage,
} from '../src/shared/messaging';
import { DEFAULT_EXTENSION_STATE } from '../src/shared/types';

const chrome = (globalThis as any).chrome;

describe('createMessage', () => {
  it('should create a message with type and payload', () => {
    const msg = createMessage('START_CAPTURE', { tabId: 1 });
    expect(msg.type).toBe('START_CAPTURE');
    expect(msg.payload).toEqual({ tabId: 1 });
  });

  it('should create a message without payload', () => {
    const msg = createMessage('GET_STATE');
    expect(msg.type).toBe('GET_STATE');
    expect(msg.payload).toBeUndefined();
  });
});

describe('Messages factory', () => {
  it('should create START_CAPTURE message', () => {
    const msg = Messages.startCapture(42);
    expect(msg.type).toBe('START_CAPTURE');
    expect(msg.payload).toEqual({ tabId: 42 });
  });

  it('should create STOP_CAPTURE message', () => {
    const msg = Messages.stopCapture();
    expect(msg.type).toBe('STOP_CAPTURE');
  });

  it('should create STREAM_ID message', () => {
    const msg = Messages.streamId('test-stream-123');
    expect(msg.type).toBe('STREAM_ID');
    expect(msg.payload).toEqual({ streamId: 'test-stream-123' });
  });

  it('should create KILL_AUDIO message', () => {
    const msg = Messages.killAudio();
    expect(msg.type).toBe('KILL_AUDIO');
  });

  it('should create UPDATE_PARAMS message', () => {
    const params = { speed: 1.5, pitch: 3, bypass: false };
    const msg = Messages.updateParams(params);
    expect(msg.type).toBe('UPDATE_PARAMS');
    expect(msg.payload).toEqual(params);
  });

  it('should create METRICS_UPDATE message', () => {
    const metrics = { bpm: 128, key: 'C major', confidence: 0.85, isCapturing: true };
    const msg = Messages.metricsUpdate(metrics);
    expect(msg.type).toBe('METRICS_UPDATE');
    expect(msg.payload).toEqual(metrics);
  });

  it('should create GET_STATE message', () => {
    const msg = Messages.getState();
    expect(msg.type).toBe('GET_STATE');
  });

  it('should create STATE_UPDATE message', () => {
    const msg = Messages.stateUpdate(DEFAULT_EXTENSION_STATE);
    expect(msg.type).toBe('STATE_UPDATE');
    expect(msg.payload).toEqual(DEFAULT_EXTENSION_STATE);
  });

  it('should create ERROR message', () => {
    const msg = Messages.error('TEST_ERROR', 'Something went wrong');
    expect(msg.type).toBe('ERROR');
    expect(msg.payload).toEqual({ code: 'TEST_ERROR', message: 'Something went wrong' });
  });
});

describe('sendRuntimeMessage', () => {
  it('should call chrome.runtime.sendMessage', async () => {
    const msg = Messages.startCapture(1);
    await sendRuntimeMessage(msg);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(msg);
  });
});

describe('Storage helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should save state to chrome.storage.session', async () => {
    await saveStateToStorage(DEFAULT_EXTENSION_STATE);

    expect(chrome.storage.session.set).toHaveBeenCalledWith({
      'extension-state': DEFAULT_EXTENSION_STATE,
    });
  });

  it('should load state from chrome.storage.session', async () => {
    const mockState = {
      ...DEFAULT_EXTENSION_STATE,
      isCapturing: true,
    };

    chrome.storage.session.get.mockResolvedValueOnce({
      'extension-state': mockState,
    });

    const result = await loadStateFromStorage();
    expect(result).toEqual(mockState);
  });

  it('should return default state when storage is empty', async () => {
    chrome.storage.session.get.mockResolvedValueOnce({});

    const result = await loadStateFromStorage();
    expect(result).toEqual(DEFAULT_EXTENSION_STATE);
  });
});
