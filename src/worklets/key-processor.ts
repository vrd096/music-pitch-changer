/**
 * KeyProcessor — AudioWorklet for musical key detection.
 *
 * Detects the key/scale of the incoming audio using chromagram analysis
 * with pitch class profiling (PCP). The estimated key is sent back to
 * the main thread via port messages.
 *
 * This is a simplified self-contained implementation.
 * For production, use Essentia.js WASM which provides much more
 * accurate key detection using HPCP (Harmonic Pitch Class Profiles).
 *
 * Messages to main thread:
 *   { type: 'key', key: string, confidence: number }
 */

// Krumhansl-Schmuckler key profiles (major keys)
const MAJOR_PROFILES: Record<string, number[]> = {
  C: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  'C#': [2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29],
  D: [2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66],
  'D#': [3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39],
  E: [2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19],
  F: [5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52],
  'F#': [2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09],
  G: [4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38],
  'G#': [4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33],
  A: [2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48],
  'A#': [3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23],
  B: [2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35],
};

// Krumhansl-Schmuckler key profiles (minor keys)
const MINOR_PROFILES: Record<string, number[]> = {
  C: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  'C#': [3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34],
  D: [3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69],
  'D#': [2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98],
  E: [3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75],
  F: [4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54],
  'F#': [2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53],
  G: [3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6],
  'G#': [2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38],
  A: [5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52],
  'A#': [3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68],
  B: [2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33],
};

// Camelot wheel mapping
const CAMELOT_MAJOR: Record<string, string> = {
  C: '8B',
  G: '9B',
  D: '10B',
  A: '11B',
  E: '12B',
  B: '1B',
  'F#': '2B',
  'C#': '3B',
  'G#': '4B',
  'D#': '5B',
  'A#': '6B',
  F: '7B',
};

const CAMELOT_MINOR: Record<string, string> = {
  C: '5A',
  G: '6A',
  D: '7A',
  A: '8A',
  E: '9A',
  B: '10A',
  'F#': '11A',
  'C#': '12A',
  'G#': '1A',
  'D#': '2A',
  'A#': '3A',
  F: '4A',
};

class KeyProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array[] = [];
  private bufferSize = 8192;
  private writeIndex = 0;
  private sampleRate: number;
  private frameCount = 0;
  private analysisInterval = 0;

  // Key detection state
  private readonly KEY_HISTORY_SIZE = 5;
  private keyHistory: string[] = [];

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.sampleRate = (options.processorOptions as { sampleRate?: number })?.sampleRate ?? 44100;
    this.bufferSize = this.sampleRate; // 1 second buffer
    this.analysisInterval = Math.floor((this.sampleRate / 128) * 4); // ~4 seconds

    this.buffer[0] = new Float32Array(this.bufferSize);
    this.buffer[1] = new Float32Array(this.bufferSize);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    // Passthrough: copy input to output so Chrome doesn't optimize away
    // process() calls for analysis-only nodes.
    const output = outputs[0];
    if (output && output.length > 0) {
      for (let ch = 0; ch < Math.min(input.length, output.length); ch++) {
        const ic = input[ch];
        const oc = output[ch];
        if (ic && oc) {
          for (let s = 0; s < ic.length; s++) {
            oc[s] = ic[s];
          }
        }
      }
    }

    const channelData = input[0];

    // Write into ring buffer
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[0][this.writeIndex] = channelData[i];
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    }

    this.frameCount++;

    // Periodic key analysis
    if (this.frameCount >= this.analysisInterval) {
      this.frameCount = 0;

      const result = this.detectKey();
      if (result) {
        this.keyHistory.push(result.key);
        if (this.keyHistory.length > this.KEY_HISTORY_SIZE) {
          this.keyHistory.shift();
        }

        // Only report if we have consistent results
        if (this.keyHistory.length >= 3) {
          const stableKey = this.getMostFrequent(this.keyHistory);
          if (stableKey) {
            this.port.postMessage({
              type: 'key',
              key: stableKey,
              confidence: result.confidence,
            });
          }
        }
      }
    }

    return true;
  }

  /**
   * Detect musical key using chromagram + Krumhansl-Schmuckler correlation.
   */
  private detectKey(): { key: string; confidence: number } | null {
    const data = this.buffer[0];

    // Compute FFT-based chromagram
    const chromagram = this.computeChromagram(data);

    if (!chromagram) return null;

    // Correlate with key profiles
    let bestKey = '';
    let bestCorr = -Infinity;
    let bestType: 'major' | 'minor' = 'major';

    // Check major keys
    for (const [key, profile] of Object.entries(MAJOR_PROFILES)) {
      const corr = this.correlate(chromagram, profile);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestKey = key;
        bestType = 'major';
      }
    }

    // Check minor keys
    for (const [key, profile] of Object.entries(MINOR_PROFILES)) {
      const corr = this.correlate(chromagram, profile);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestKey = key;
        bestType = 'minor';
      }
    }

    if (!bestKey || bestCorr < 0.1) return null;

    // Convert to Camelot notation
    const camelot = bestType === 'major' ? CAMELOT_MAJOR[bestKey] : CAMELOT_MINOR[bestKey];

    // Return formatted key string
    const keyStr = bestType === 'major' ? `${bestKey} (${camelot})` : `${bestKey}m (${camelot})`;

    return { key: keyStr, confidence: Math.min(bestCorr / 10, 1) };
  }

  /**
   * Compute a 12-bin chromagram (pitch class profile) from time-domain data.
   * Uses a simplified spectral approach.
   */
  private computeChromagram(data: Float32Array): Float32Array | null {
    const fftSize = 2048;
    if (data.length < fftSize) return null;

    // Extract a segment from the middle of the buffer
    const start = Math.max(0, Math.floor((data.length - fftSize) / 2));
    const segment = data.slice(start, start + fftSize);

    // Apply Hann window
    const windowed = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      windowed[i] = segment[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }

    // Simple DFT for pitch class mapping
    const chromagram = new Float32Array(12);

    for (let bin = 1; bin < fftSize / 2; bin++) {
      // Compute magnitude (simplified - real FFT would be better)
      let real = 0;
      let imag = 0;
      for (let i = 0; i < fftSize; i++) {
        const angle = (2 * Math.PI * bin * i) / fftSize;
        real += windowed[i] * Math.cos(angle);
        imag -= windowed[i] * Math.sin(angle);
      }
      const magnitude = Math.sqrt(real * real + imag * imag);

      // Map frequency bin to pitch class
      // Frequency = bin * sampleRate / fftSize
      const freq = (bin * this.sampleRate) / fftSize;
      if (freq < 60 || freq > 4000) continue; // Ignore extremes

      // Convert frequency to MIDI note number
      const midiNote = 12 * Math.log2(freq / 440) + 69;
      const pitchClass = Math.round(midiNote) % 12;

      if (pitchClass >= 0 && pitchClass < 12) {
        chromagram[pitchClass] += magnitude;
      }
    }

    // Normalize
    const maxVal = Math.max(...chromagram, 0.001);
    for (let i = 0; i < 12; i++) {
      chromagram[i] /= maxVal;
    }

    return chromagram;
  }

  /**
   * Pearson correlation between two arrays.
   */
  private correlate(a: Float32Array, b: number[]): number {
    if (a.length !== b.length) return 0;

    const n = a.length;
    const meanA = a.reduce((s, v) => s + v, 0) / n;
    const meanB = b.reduce((s, v) => s + v, 0) / n;

    let cov = 0;
    let varA = 0;
    let varB = 0;

    for (let i = 0; i < n; i++) {
      const diffA = a[i] - meanA;
      const diffB = b[i] - meanB;
      cov += diffA * diffB;
      varA += diffA * diffA;
      varB += diffB * diffB;
    }

    const denom = Math.sqrt(varA * varB);
    return denom === 0 ? 0 : cov / denom;
  }

  private getMostFrequent(arr: string[]): string | null {
    if (arr.length === 0) return null;
    const freq: Record<string, number> = {};
    for (const item of arr) {
      freq[item] = (freq[item] ?? 0) + 1;
    }
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
}

registerProcessor('key-processor', KeyProcessor);
