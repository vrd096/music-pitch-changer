/**
 * BPMProcessor — AudioWorklet for real-time beat detection via onset
 * autocorrelation.
 *
 * ALGORITHM:
 * 1. Downsample input 4× (44100 → 11025 Hz) for CPU efficiency
 * 2. Compute RMS energy per 64-sample block (~5.8ms resolution at 11025 Hz)
 * 3. Derive onset signal: half-wave rectified energy difference
 * 4. Zero-centered autocorrelation on onset signal finds periodic structure
 * 5. Quadratic interpolation for sub-lag peak accuracy
 * 6. Median filter (7 values) stabilises the reported BPM
 *
 * Onset autocorrelation is more reliable than raw energy envelope for
 * transient-rich music (drums, percussion, pop, electronic).
 * The higher block resolution (64 vs 128) captures shorter transients,
 * improving detection for fast BPMs and complex rhythms.
 *
 * @module worklets/bpm-processor
 */

class BPMProcessor extends AudioWorkletProcessor {
  /* ===== Constants ===== */

  /** Ring buffer duration in seconds */
  private readonly BUFFER_DURATION = 4;

  /** Downsample factor for CPU efficiency */
  private readonly DOWNSAMPLE_FACTOR = 4;

  /** BPM detection range */
  private readonly MIN_BPM = 60;
  private readonly MAX_BPM = 180;

  /**
   * Energy block size in downsampled samples.
   * At 11025 Hz, 64 samples = ~5.8ms per energy value.
   * This gives 172 Hz energy envelope — enough to resolve 60-180 BPM.
   */
  private readonly ENERGY_BLOCK = 64;

  /** Minimum RMS energy to skip silent sections */
  private readonly ENERGY_THRESHOLD = 0.001;

  /**
   * Minimum autocorrelation peak for valid BPM.
   * Onset-diff signal has lower auto-correlation than raw energy,
   * so threshold is set low (0.02). Peaks below this are considered noise.
   */
  private readonly MIN_PEAK = 0.02;

  /** Number of analysis runs per second (~2 Hz) */
  private analysisInterval: number;
  private frameCount = 0;

  /* ===== State ===== */

  private sampleRate: number;
  private downsampledRate: number;

  /* ===== Energy / Onset buffer ===== */

  /** Onset strength envelope (one value per ENERGY_BLOCK downsampled samples) */
  private energyBuffer: Float32Array;
  private energyIndex = 0;
  private energyCount = 0;

  /** Accumulator for current energy block */
  private blockSampleCount = 0;
  private blockEnergySum = 0;

  /** Previous block's RMS for onset-diff computation */
  private prevBlockRms = 0;

  /* ===== BPM smoothing ===== */

  private readonly BPM_HISTORY_SIZE = 7;
  private bpmHistory: number[] = [];
  private lastReportedBpm = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const opts = options.processorOptions as { sampleRate?: number } | undefined;
    this.sampleRate = opts?.sampleRate ?? 44100;
    this.downsampledRate = this.sampleRate / this.DOWNSAMPLE_FACTOR;

    // Energy buffer: one value per ENERGY_BLOCK downsampled samples
    const energyRate = this.downsampledRate / this.ENERGY_BLOCK; // ~172 Hz
    const energyLen = Math.ceil(energyRate * this.BUFFER_DURATION) + 2;
    this.energyBuffer = new Float32Array(energyLen);

    // Analyse ~2 times per second
    this.analysisInterval = Math.max(1, Math.floor(energyRate / 2));

    console.log(
      `[BPM] Init: sampleRate=${this.sampleRate}, ds=${this.downsampledRate}Hz, ` +
        `energyRate=${energyRate.toFixed(1)}Hz, bufLen=${energyLen}`,
    );
  }

  /* ===== Process ===== */

  process(inputs: Float32Array[][], _outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0];
    if (!channelData) return true;

    // Compute RMS energy per block
    for (let i = 0; i < channelData.length; i += this.DOWNSAMPLE_FACTOR) {
      const sample = channelData[i];
      this.blockEnergySum += sample * sample;
      this.blockSampleCount++;

      if (this.blockSampleCount >= this.ENERGY_BLOCK) {
        const rms = Math.sqrt(this.blockEnergySum / this.ENERGY_BLOCK);

        // Onset strength = positive energy change (half-wave rectified diff)
        const onset = Math.max(0, rms - this.prevBlockRms);
        this.prevBlockRms = rms;

        // Store onset strength in circular buffer
        this.energyBuffer[this.energyIndex] = onset;
        this.energyIndex = (this.energyIndex + 1) % this.energyBuffer.length;
        this.energyCount = Math.min(this.energyCount + 1, this.energyBuffer.length);

        // Reset block accumulator
        this.blockEnergySum = 0;
        this.blockSampleCount = 0;
      }
    }

    this.frameCount++;
    if (this.frameCount >= this.analysisInterval) {
      this.frameCount = 0;
      this.analyze();
    }

    return true;
  }

  /* ===== Analysis ===== */

  private analyze(): void {
    if (this.energyCount < 40) return;

    // Compute average RMS energy to skip silence
    const avgEnergy = this.computeAvgEnergy();
    if (avgEnergy < this.ENERGY_THRESHOLD) return;

    // Estimate BPM via onset autocorrelation
    const result = this.estimateBPM();
    if (!result) return;

    // -- Track-change detection: if a high-confidence BPM differs significantly
    //    from the last reported BPM, reset history to adapt faster. --
    const TRACK_CHANGE_CONFIDENCE = 0.4;
    const TRACK_CHANGE_THRESHOLD = 15; // BPM difference
    if (
      result.confidence >= TRACK_CHANGE_CONFIDENCE &&
      this.lastReportedBpm > 0 &&
      Math.abs(result.bpm - this.lastReportedBpm) >= TRACK_CHANGE_THRESHOLD
    ) {
      console.log(
        `[BPM] Track change detected: ${this.lastReportedBpm} → ${result.bpm} ` +
          `(conf=${result.confidence.toFixed(2)})`,
      );
      // Reset history with just the new BPM for fast convergence
      this.bpmHistory = [result.bpm];
    }

    // Median filter for stability
    this.bpmHistory.push(result.bpm);
    if (this.bpmHistory.length > this.BPM_HISTORY_SIZE) {
      this.bpmHistory.shift();
    }

    const stableBpm = this.getMedian(this.bpmHistory);

    console.log(
      `[BPM] raw=${result.bpm}, stable=${Math.round(stableBpm)}, ` +
        `conf=${result.confidence.toFixed(2)}`,
    );

    // Report BPM whenever it's stable, in range, and changed.
    // Only report when bpmHistory is full (for initial stability).
    if (
      stableBpm >= this.MIN_BPM &&
      stableBpm <= this.MAX_BPM &&
      this.bpmHistory.length >= this.BPM_HISTORY_SIZE &&
      Math.round(stableBpm) !== this.lastReportedBpm
    ) {
      this.lastReportedBpm = Math.round(stableBpm);
      this.port.postMessage({
        type: 'bpm',
        bpm: Math.round(stableBpm),
        confidence: Math.min(result.confidence, 1),
      });
    }
  }

  /* ===== Average Energy ===== */

  private computeAvgEnergy(): number {
    const len = Math.min(this.energyCount, this.energyBuffer.length);
    if (len === 0) return 0;

    let sum = 0;
    for (let i = 0; i < len; i++) {
      const idx =
        (this.energyIndex - len + i + this.energyBuffer.length) % this.energyBuffer.length;
      sum += this.energyBuffer[idx];
    }
    return sum / len;
  }

  /* ===== Onset Autocorrelation BPM Estimation ===== */

  private estimateBPM(): { bpm: number; confidence: number } | null {
    const energyCount = this.energyCount;
    if (energyCount < 40) return null;

    const energyRate = this.downsampledRate / this.ENERGY_BLOCK; // ~172 Hz
    const analysisLen = Math.min(energyCount, Math.floor(energyRate * 3.0));

    // BPM range → lag range in energy blocks
    const minLag = Math.ceil((energyRate * 60) / this.MAX_BPM);
    const maxLag = Math.floor((energyRate * 60) / this.MIN_BPM);
    const windowLen = analysisLen - maxLag;

    if (windowLen < maxLag) return null;

    // Helper to read onset value at circular buffer position
    const getOnset = (idx: number): number => {
      return this.energyBuffer[
        (this.energyIndex - analysisLen + idx + this.energyBuffer.length) % this.energyBuffer.length
      ];
    };

    // Zero-center the onset signal
    let mean = 0;
    for (let i = 0; i < analysisLen; i++) {
      mean += getOnset(i);
    }
    mean /= analysisLen;

    // Pre-compute normalisation energy
    let norm = 0;
    for (let i = 0; i < windowLen; i++) {
      const v = getOnset(i) - mean;
      norm += v * v;
    }
    if (norm < 1e-10) return null;

    // Autocorrelation
    let maxCorr = 0;
    let bestLag = 0;
    const correlations: number[] = [];

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < windowLen; i++) {
        sum += (getOnset(i) - mean) * (getOnset(i + lag) - mean);
      }
      const corr = sum / norm;
      correlations.push(corr);
      if (corr > maxCorr) {
        maxCorr = corr;
        bestLag = lag;
      }
    }

    if (maxCorr < this.MIN_PEAK) return null;

    // -- Octave bias: prefer higher BPM when there's a strong peak at double frequency --
    // Electronic music often has a strong downbeat every 2 beats (half-time feel).
    // Autocorrelation may pick the half-time lag as strongest. We check if a peak
    // at ~half the bestLag (double BPM) has >85% correlation and prefer it.
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (lag === bestLag) continue;
      const ratio = bestLag / lag;
      // Check for exact 2:1 or 3:2 ratio (full/half or triple/duple feel)
      if (Math.abs(ratio - 2.0) < 0.2 || Math.abs(ratio - 1.5) < 0.15) {
        const corr = correlations[lag - minLag];
        if (corr > maxCorr * 0.85) {
          bestLag = lag;
          maxCorr = corr;
        }
      }
    }

    // Quadratic interpolation for sub-lag accuracy
    const peakIdx = bestLag - minLag;
    const interpolatedLag = this.quadraticInterpolation(correlations, peakIdx, minLag);
    if (!interpolatedLag) return null;

    const bpm = (energyRate * 60) / interpolatedLag;
    const confidence = Math.min(maxCorr / 0.15, 1.0);

    return { bpm: Math.round(bpm), confidence };
  }

  /* ===== Quadratic Peak Interpolation ===== */

  private quadraticInterpolation(data: number[], peakIdx: number, offset: number): number | null {
    const len = data.length;
    if (peakIdx <= 0 || peakIdx >= len - 1) {
      return offset + peakIdx;
    }

    const y0 = data[peakIdx - 1];
    const y1 = data[peakIdx];
    const y2 = data[peakIdx + 1];

    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) < 1e-12) {
      return offset + peakIdx;
    }

    const frac = (0.5 * (y0 - y2)) / denom;

    if (frac < -0.5 || frac > 0.5) {
      return offset + peakIdx;
    }

    return offset + peakIdx + frac;
  }

  /* ===== Median ===== */

  private getMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
}

registerProcessor('bpm-processor', BPMProcessor);
