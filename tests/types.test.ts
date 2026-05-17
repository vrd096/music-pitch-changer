import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUDIO_PARAMS,
  DEFAULT_AUDIO_METRICS,
  DEFAULT_EXTENSION_STATE,
} from '../src/shared/types';

describe('DEFAULT_AUDIO_PARAMS', () => {
  it('should have correct default speed', () => {
    expect(DEFAULT_AUDIO_PARAMS.speed).toBe(1.0);
  });

  it('should have correct default pitch', () => {
    expect(DEFAULT_AUDIO_PARAMS.pitch).toBe(0);
  });

  it('should have bypass disabled by default', () => {
    expect(DEFAULT_AUDIO_PARAMS.bypass).toBe(false);
  });
});

describe('DEFAULT_AUDIO_METRICS', () => {
  it('should have null bpm', () => {
    expect(DEFAULT_AUDIO_METRICS.bpm).toBeNull();
  });

  it('should have null key', () => {
    expect(DEFAULT_AUDIO_METRICS.key).toBeNull();
  });

  it('should have null confidence', () => {
    expect(DEFAULT_AUDIO_METRICS.confidence).toBeNull();
  });

  it('should not be capturing', () => {
    expect(DEFAULT_AUDIO_METRICS.isCapturing).toBe(false);
  });
});

describe('DEFAULT_EXTENSION_STATE', () => {
  it('should not be capturing', () => {
    expect(DEFAULT_EXTENSION_STATE.isCapturing).toBe(false);
  });

  it('should have null tabId', () => {
    expect(DEFAULT_EXTENSION_STATE.tabId).toBeNull();
  });

  it('should contain default audio params', () => {
    expect(DEFAULT_EXTENSION_STATE.params).toEqual(DEFAULT_AUDIO_PARAMS);
  });

  it('should contain default audio metrics', () => {
    expect(DEFAULT_EXTENSION_STATE.metrics).toEqual(DEFAULT_AUDIO_METRICS);
  });
});

describe('Type consistency', () => {
  it('should update audio params correctly', () => {
    const updated = { ...DEFAULT_AUDIO_PARAMS, speed: 1.5, pitch: 2 };
    expect(updated.speed).toBe(1.5);
    expect(updated.pitch).toBe(2);
    expect(updated.bypass).toBe(false);
  });

  it('should update audio metrics correctly', () => {
    const updated = { ...DEFAULT_AUDIO_METRICS, bpm: 128, key: 'C major', confidence: 0.85 };
    expect(updated.bpm).toBe(128);
    expect(updated.key).toBe('C major');
    expect(updated.confidence).toBe(0.85);
    expect(updated.isCapturing).toBe(false);
  });
});
