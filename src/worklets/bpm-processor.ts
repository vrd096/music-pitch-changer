/**
 * BPMProcessor — AudioWorklet for real-time beat detection.
 *
 * Uses autocorrelation on the incoming audio signal.
 * Sends results to main thread:
 *   { type: 'bpm', bpm: number }
 */

class BPMProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array[] = [];
  private bufferSize = 4096;
  private writeIndex = 0;
  private sampleRate: number;
  private analysisInterval = 0;
  private frameCount = 0;

  private readonly BPM_HISTORY_SIZE = 6;
  private bpmHistory: number[] = [];

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const opts = options.processorOptions as { sampleRate?: number } | undefined;
    this.sampleRate = opts?.sampleRate ?? 44100;
    this.bufferSize = this.sampleRate;

    this.analysisInterval = Math.floor((this.sampleRate / 128) * 2);

    this.buffer[0] = new Float32Array(this.bufferSize);
    this.buffer[1] = new Float32Array(this.bufferSize);
  }

  process(inputs: Float32Array[][], _outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const channelData = input[0];

    for (let i = 0; i < channelData.length; i++) {
      this.buffer[0][this.writeIndex] = channelData[i];
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    }

    this.frameCount++;

    if (this.frameCount >= this.analysisInterval) {
      this.frameCount = 0;
      const bpm = this.estimateBPM();

      if (bpm > 0) {
        this.bpmHistory.push(bpm);
        if (this.bpmHistory.length > this.BPM_HISTORY_SIZE) {
          this.bpmHistory.shift();
        }

        const stableBpm = this.getMedian(this.bpmHistory);
        if (stableBpm >= 60 && stableBpm <= 200) {
          this.port.postMessage({
            type: 'bpm',
            bpm: Math.round(stableBpm),
          });
        }
      }
    }

    return true;
  }

  private estimateBPM(): number {
    const data = this.buffer[0];
    const minLag = Math.floor(this.sampleRate / 200);
    const maxLag = Math.floor(this.sampleRate / 50);
    const windowLen = Math.min(data.length, this.sampleRate * 0.5);

    const correlations: number[] = [];
    let maxCorr = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < windowLen - lag; i++) {
        sum += data[i] * data[i + lag];
      }
      correlations.push(sum);
      if (sum > maxCorr) maxCorr = sum;
    }

    if (maxCorr < 0.001) return 0;

    const normalized = correlations.map((c) => c / maxCorr);

    let peakIdx = 0;
    let peakVal = 0;

    for (let i = 1; i < normalized.length - 1; i++) {
      if (normalized[i] > normalized[i - 1] && normalized[i] > normalized[i + 1]) {
        if (normalized[i] > peakVal && normalized[i] > 0.3) {
          peakVal = normalized[i];
          peakIdx = i;
        }
      }
    }

    if (peakVal < 0.3) return 0;

    const lag = minLag + peakIdx;
    return (this.sampleRate / lag) * 60;
  }

  private getMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }
}

registerProcessor('bpm-processor', BPMProcessor);
