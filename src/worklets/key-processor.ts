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

  /* ===== FFT buffers (pre-allocated, zero GC pressure) ===== */

  /** FFT real part buffer (2048) */
  private _reBuf!: Float32Array;
  /** FFT imaginary part buffer (2048) */
  private _imBuf!: Float32Array;
  /** Magnitude spectrum buffer (1024) */
  private _magBuf!: Float32Array;
  /** Pre-computed twiddle factor tables for each stage (log2(2048)=11 stages) */
  private _cosTbl: Float64Array[] = [];
  private _sinTbl: Float64Array[] = [];

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.sampleRate = (options.processorOptions as { sampleRate?: number })?.sampleRate ?? 44100;
    this.bufferSize = this.sampleRate; // 1 second buffer
    this.analysisInterval = Math.floor((this.sampleRate / 128) * 4); // ~4 seconds

    this.buffer[0] = new Float32Array(this.bufferSize);
    this.buffer[1] = new Float32Array(this.bufferSize);

    // Pre-allocate FFT buffers
    const fftSize = 2048;
    this._reBuf = new Float32Array(fftSize);
    this._imBuf = new Float32Array(fftSize);
    this._magBuf = new Float32Array(fftSize >> 1);

    // Pre-compute twiddle factors for all stages
    for (let len = 2; len <= fftSize; len <<= 1) {
      const halfLen = len >> 1;
      const cosTbl = new Float64Array(halfLen);
      const sinTbl = new Float64Array(halfLen);
      for (let j = 0; j < halfLen; j++) {
        const angle = (Math.PI * j) / halfLen;
        cosTbl[j] = Math.cos(angle);
        sinTbl[j] = -Math.sin(angle);
      }
      this._cosTbl.push(cosTbl);
      this._sinTbl.push(sinTbl);
    }
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
   * Uses Radix-2 FFT (Cooley-Tukey) for ~89× speedup over naive DFT at N=2048.
   *
   * Pre-allocated buffers (re, im, mag) prevent GC pressure on the audio thread.
   */
  private computeChromagram(data: Float32Array): Float32Array | null {
    const fftSize = 2048;
    if (data.length < fftSize) return null;

    // Extract a segment from the middle of the buffer
    const start = Math.max(0, Math.floor((data.length - fftSize) / 2));

    // Apply Hann window + copy to real buffer (imag is zero for real input)
    for (let i = 0; i < fftSize; i++) {
      const windowVal = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
      this._reBuf[i] = data[start + i] * windowVal;
      this._imBuf[i] = 0;
    }

    // ---- Radix-2 DIT FFT ----
    const n = fftSize;
    const re = this._reBuf;
    const im = this._imBuf;

    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; (j & bit) !== 0; bit >>= 1) {
        j ^= bit;
      }
      j ^= bit;
      if (i < j) {
        let tmp = re[i];
        re[i] = re[j];
        re[j] = tmp;
        tmp = im[i];
        im[i] = im[j];
        im[j] = tmp;
      }
    }

    // Butterfly stages with pre-computed twiddle factors
    for (let stage = 0, len = 2; len <= n; stage++, len <<= 1) {
      const halfLen = len >> 1;
      const cosTbl = this._cosTbl[stage];
      const sinTbl = this._sinTbl[stage];

      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < halfLen; j++) {
          const wr = cosTbl[j];
          const wi = sinTbl[j];
          const k = i + j;

          const tRe = wr * re[k + halfLen] - wi * im[k + halfLen];
          const tIm = wr * im[k + halfLen] + wi * re[k + halfLen];

          re[k + halfLen] = re[k] - tRe;
          im[k + halfLen] = im[k] - tIm;

          re[k] += tRe;
          im[k] += tIm;
        }
      }
    }

    // ---- Magnitude spectrum (positive frequencies) ----
    const halfN = n >> 1;
    const mag = this._magBuf;
    for (let i = 0; i < halfN; i++) {
      mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    }

    // ---- Map to 12 pitch classes ----
    const chromagram = new Float32Array(12);

    for (let bin = 1; bin < halfN; bin++) {
      const freq = (bin * this.sampleRate) / fftSize;
      if (freq < 65 || freq > 4000) continue; // Ignore extremes

      // Convert frequency to MIDI note number
      const midiNote = 12 * Math.log2(freq / 440) + 69;
      const pitchClass = Math.round(midiNote) % 12;

      if (pitchClass >= 0 && pitchClass < 12) {
        chromagram[pitchClass] += mag[bin];
      }
    }

    // Normalize
    let maxVal = 0;
    for (let i = 0; i < 12; i++) {
      if (chromagram[i] > maxVal) maxVal = chromagram[i];
    }
    if (maxVal > 0.001) {
      for (let i = 0; i < 12; i++) {
        chromagram[i] /= maxVal;
      }
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
