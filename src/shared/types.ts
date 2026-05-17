/* ===== Audio Parameters ===== */

export interface AudioParams {
  speed: number; // 0.5 to 2.0 (1.0 = 100%)
  pitch: number; // -12 to +12 semitones
  bypass: boolean; // true = effects disabled
}

export const DEFAULT_AUDIO_PARAMS: AudioParams = {
  speed: 1.0,
  pitch: 0,
  bypass: false,
};

/* ===== Audio Metrics ===== */

export interface AudioMetrics {
  bpm: number | null; // 60–200 BPM (from Aubio.js Tempo)
  key: string | null; // Camelot notation e.g. "8B" / "5A"
  confidence: number | null; // 0–1 confidence of key detection / tempo confidence
  frequency: number | null; // Hz (from Aubio.js Pitch, e.g. 440.0 for A4)
  isCapturing: boolean;
}

export const DEFAULT_AUDIO_METRICS: AudioMetrics = {
  bpm: null,
  key: null,
  confidence: null,
  frequency: null,
  isCapturing: false,
};

/* ===== Extension State ===== */

export interface ExtensionState {
  isCapturing: boolean;
  tabId: number | null;
  params: AudioParams;
  metrics: AudioMetrics;
}

export const DEFAULT_EXTENSION_STATE: ExtensionState = {
  isCapturing: false,
  tabId: null,
  params: DEFAULT_AUDIO_PARAMS,
  metrics: DEFAULT_AUDIO_METRICS,
};

/* ===== Message Types ===== */

export type MessageType =
  | 'START_CAPTURE'
  | 'STOP_CAPTURE'
  | 'STREAM_ID'
  | 'KILL_AUDIO'
  | 'UPDATE_PARAMS'
  | 'METRICS_UPDATE'
  | 'GET_STATE'
  | 'STATE_UPDATE'
  | 'OFFSCREEN_READY'
  | 'RESET_BPM'
  | 'ERROR';

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload?: T;
}

/* ===== Payload Types ===== */

export interface StartCapturePayload {
  tabId: number;
}

export interface StreamIdPayload {
  streamId: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}
