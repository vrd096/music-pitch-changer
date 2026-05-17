/**
 * Test setup file.
 * Provides mocks for Chrome Extension APIs.
 */

import { vi } from 'vitest';

// Mock chrome.runtime
const mockRuntime: Record<string, unknown> = {
  connect: vi.fn(() => ({
    postMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onDisconnect: {
      addListener: vi.fn(),
    },
  })),
  sendMessage: vi.fn(() => Promise.resolve()),
  onMessage: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
  onConnect: {
    addListener: vi.fn(),
  },
  lastError: null,
};

// Mock chrome.storage.session
const mockStorage: Record<string, unknown> = {
  session: {
    set: vi.fn(() => Promise.resolve()),
    get: vi.fn(() => Promise.resolve({})),
  },
};

// Mock chrome.tabs
const mockTabs: Record<string, unknown> = {
  query: vi.fn(() => Promise.resolve([{ id: 1, active: true, currentWindow: true }])),
  sendMessage: vi.fn(() => Promise.resolve()),
  create: vi.fn(() => Promise.resolve()),
  onRemoved: {
    addListener: vi.fn(),
  },
};

// Mock chrome.tabCapture
const mockTabCapture: Record<string, unknown> = {
  getMediaStreamId: vi.fn((_options: unknown, callback: (id: string) => void) => {
    callback('mock-stream-id');
  }),
};

// Mock chrome.offscreen
const mockOffscreen: Record<string, unknown> = {
  hasDocument: vi.fn(() => Promise.resolve(false)),
  createDocument: vi.fn(() => Promise.resolve()),
  closeDocument: vi.fn(() => Promise.resolve()),
  Reason: {
    AUDIO_PLAYBACK: 'AUDIO_PLAYBACK',
  },
};

// Mock chrome.alarms
const mockAlarms: Record<string, unknown> = {
  create: vi.fn(),
  get: vi.fn(() => Promise.resolve()),
  clear: vi.fn(() => Promise.resolve(true)),
  onAlarm: {
    addListener: vi.fn(),
  },
};

// Build the chrome mock
const chromeMock = {
  runtime: mockRuntime,
  storage: mockStorage,
  tabs: mockTabs,
  tabCapture: mockTabCapture,
  offscreen: mockOffscreen,
  alarms: mockAlarms,
};

// Assign to global
(globalThis as Record<string, unknown>).chrome = chromeMock;
