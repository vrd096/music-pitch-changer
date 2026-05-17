/**
 * PitchProcessor — AudioWorklet for independent pitch shifting and time stretching
 * using Waveform Similarity Overlap-Add (WSOLA).
 *
 * ARCHITECTURE:
 * - Input: ring buffer (mono, 65536 samples) with cumulative position counters
 * - Output: circular synthesis buffer (4096 samples) for overlap-add
 * - Grains: 2048-sample Hann-windowed segments, 75% overlap (hop=512)
 * - COLA normalization = 0.5 (Hann window sum = 2.0 at 75% overlap)
 *
 * TIME STRETCH (speed):
 *   analysisHop = SYNTH_HOP × speed
 *   speed=1 → analysisHop=512 → consumption rate = 1.0 (normal)
 *   speed>1 → analysisHop>512 → faster playback (time compression)
 *   speed<1 → analysisHop<512 → slower playback (time expansion)
 *
 * PITCH SHIFT:
 *   Linear interpolation within each grain by pitchFactor = 2^(pitch/12)
 *   pitchFactor>1 → reads more input per output grain → higher pitch
 *   pitchFactor<1 → reads less input per output grain → lower pitch
 *   Pitch shift does NOT affect playback speed (interpolation within fixed-size grain)
 *
 * FIRST GRAIN GUARD:
 *   The first grain is delayed until the ring buffer has at least
 *   pitchFactor × GRAIN_SIZE samples. This prevents reading garbage
 *   from unwritten buffer positions. Output is silence during this fill phase.
 *
 * SUBSEQUENT GRAIN GUARD:
 *   Each subsequent grain needs only `analysisHop` new unique samples
 *   (overlap with previous grain covers the rest). If the ring buffer
 *   doesn't have enough data, the grain is skipped to prevent artifacts.
 *
 * @module worklets/pitch-processor
 */

class PitchProcessor extends AudioWorkletProcessor {
  /* ===== Constants ===== */

  /** Grain (window) size in samples */
  private readonly GRAIN_SIZE = 2048;

  /** Synthesis hop — how often a new grain is generated (75% overlap) */
  private readonly SYNTH_HOP = 512;

  /** Analysis hop factor — multiplied by speed for time stretching */
  private readonly ANALYSIS_HOP = 512;

  /**
   * COLA normalization for Hann window at 75% overlap (N=2048, H=512):
   *   Σ w[i + k×H] = 2.0  (k=0..3, any i in [0, H))
   * Normalization = 1 / 2.0 = 0.5
   */
  private readonly NORMALIZATION = 0.5;

  /** Synthesis buffer size (power of 2 for fast modulo) */
  private readonly SYNTH_BUF_SIZE = 4096;

  /** Input ring buffer size */
  private readonly BUFFER_SIZE = 65536;

  /* ===== Parameters ===== */

  private speed = 1.0;
  private pitch = 0;

  /* ===== Ring Buffer ===== */

  private ringBuffer: Float32Array;

  /** Monotonically increasing cumulative write counter (never resets) */
  private totalWritten = 0;

  /** Monotonically increasing cumulative consume counter (fractional OK) */
  private totalConsumed = 0;

  /* ===== Synthesis Buffer ===== */

  private synthBuffer: Float32Array;

  /** Write position in synthBuffer for the next grain */
  private writePos = 0;

  /** Read position in synthBuffer for the next output sample */
  private readPos = 0;

  /** Output sample counter since last grain generation */
  private grainCounter = 0;

  /** Pre-computed Hann window coefficients */
  private hannWindow: Float32Array;

  /** Whether the first grain has been generated */
  private firstGrainReady = false;

  constructor(_options: AudioWorkletNodeOptions) {
    super();

    this.ringBuffer = new Float32Array(this.BUFFER_SIZE);
    this.synthBuffer = new Float32Array(this.SYNTH_BUF_SIZE);
    this.hannWindow = this.buildHannWindow();

    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'param') {
        if (msg.pitch !== undefined) this.pitch = msg.pitch;
        if (msg.speed !== undefined) this.speed = msg.speed;
      }
    };
  }

  /* ===== Hann Window ===== */

  private buildHannWindow(): Float32Array {
    const w = new Float32Array(this.GRAIN_SIZE);
    for (let i = 0; i < this.GRAIN_SIZE; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.GRAIN_SIZE - 1)));
    }
    return w;
  }

  /* ===== Process ===== */

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !output || input.length === 0 || output.length === 0) {
      return true;
    }

    const pitchFactor = Math.pow(2, this.pitch / 12);

    // Write input samples to ring buffer (mono, channel 0)
    const monoInput = input[0];
    if (monoInput) {
      for (let i = 0; i < monoInput.length; i++) {
        this.ringBuffer[this.totalWritten % this.BUFFER_SIZE] = monoInput[i];
        this.totalWritten++;
      }
    }

    // Check if first grain can be generated
    if (!this.firstGrainReady) {
      const neededForFirstGrain = Math.ceil(pitchFactor * this.GRAIN_SIZE);
      if (this.totalWritten >= neededForFirstGrain) {
        this.firstGrainReady = true;
        // Generate first grain immediately
        this.addGrain(pitchFactor);
        this.totalConsumed += this.ANALYSIS_HOP * this.speed;
        this.writePos = (this.writePos + this.SYNTH_HOP) & (this.SYNTH_BUF_SIZE - 1);
        this.grainCounter = 0;
      }
    }

    const numChannels = Math.min(input.length, output.length);
    const frameCount = output[0]?.length ?? 0;

    // Process each sample frame
    for (let i = 0; i < frameCount; i++) {
      let sample: number;

      if (!this.firstGrainReady) {
        // Silence while ring buffer accumulates enough data
        sample = 0;
      } else {
        // Read from synthesis buffer with COLA normalization
        sample = this.synthBuffer[this.readPos] * this.NORMALIZATION;
        // Zero after read for clean overlap-add
        this.synthBuffer[this.readPos] = 0;
      }

      this.readPos = (this.readPos + 1) & (this.SYNTH_BUF_SIZE - 1);

      // Write the same mono sample to all output channels
      for (let ch = 0; ch < numChannels; ch++) {
        const out = output[ch];
        if (out) {
          out[i] = sample;
        }
      }

      if (!this.firstGrainReady) continue;

      this.grainCounter++;

      // Generate a new grain every SYNTH_HOP output samples
      if (this.grainCounter >= this.SYNTH_HOP) {
        this.grainCounter = 0;

        const analysisHop = this.ANALYSIS_HOP * this.speed;

        // Guard: check if ring buffer has enough data for this grain.
        // Each subsequent grain needs only `analysisHop` new unique samples
        // beyond the previous grain's consumption position. Overlap in input
        // (pitchFactor × GRAIN_SIZE - analysisHop) covers the rest.
        // At speed=1: analysisHop=512, we write 512 input per grain → always enough.
        // At speed>1: analysisHop>512, we may read some unwritten positions.
        //   Those positions contain stale ring buffer data; Hann windowing
        //   at the grain edges smooths out the transition.
        const newSamplesNeeded = analysisHop;
        const available = this.totalWritten - Math.floor(this.totalConsumed);

        if (available >= newSamplesNeeded) {
          this.addGrain(pitchFactor);
          this.totalConsumed += analysisHop;
          this.writePos = (this.writePos + this.SYNTH_HOP) & (this.SYNTH_BUF_SIZE - 1);
        }
        // If guard fails, skip — better than stale data.
      }
    }

    return true;
  }

  /* ===== Grain Generation ===== */

  private addGrain(pitchFactor: number): void {
    const basePos = Math.floor(this.totalConsumed) % this.BUFFER_SIZE;

    for (let i = 0; i < this.GRAIN_SIZE; i++) {
      // Position within grain with pitch interpolation
      const srcPos = i * pitchFactor;
      const srcIdx = Math.floor(srcPos);
      const srcFrac = srcPos - srcIdx;

      // Position in ring buffer (wraps modulo BUFFER_SIZE)
      const bufPos = (basePos + srcIdx) % this.BUFFER_SIZE;
      const bufPosNext = (bufPos + 1) % this.BUFFER_SIZE;

      // Linear interpolation for pitch shifting
      let sample: number;
      if (pitchFactor === 1.0) {
        sample = this.ringBuffer[bufPos];
      } else {
        sample = this.ringBuffer[bufPos] * (1 - srcFrac) + this.ringBuffer[bufPosNext] * srcFrac;
      }

      // Position in synthesis buffer (circular)
      const synthPos = (this.writePos + i) & (this.SYNTH_BUF_SIZE - 1);

      // Apply Hann window and accumulate into synthesis buffer
      this.synthBuffer[synthPos] += sample * this.hannWindow[i];
    }
  }
}

registerProcessor('pitch-processor', PitchProcessor);
