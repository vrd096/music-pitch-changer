/**
 * PitchProcessor — AudioWorklet for pitch shifting and time stretching.
 *
 * Uses linear interpolation resampling with phase tracking.
 * Communicates with the main thread via port messages:
 *   { type: 'param', speed: number, pitch: number, bypass: boolean }
 *
 * @module worklets/pitch-processor
 */

class PitchProcessor extends AudioWorkletProcessor {
  private speed = 1.0;
  private pitch = 0;
  private bypass = false;
  private playbackRate = 1.0;
  private phaseIndex = 0;

  constructor(_options: AudioWorkletNodeOptions) {
    super();

    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data.type === 'param') {
        this.speed = data.speed ?? this.speed;
        this.pitch = data.pitch ?? this.pitch;
        this.bypass = data.bypass ?? this.bypass;
        this.playbackRate = Math.pow(2, this.pitch / 12) * this.speed;
      } else if (data.type === 'bypass') {
        this.bypass = data.enabled;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !output || input.length === 0 || output.length === 0) {
      return true;
    }

    if (this.bypass || (this.speed === 1.0 && this.pitch === 0)) {
      for (let ch = 0; ch < Math.min(input.length, output.length); ch++) {
        const inp = input[ch];
        const out = output[ch];
        if (inp && out) {
          for (let i = 0; i < inp.length; i++) {
            out[i] = inp[i];
          }
        }
      }
      return true;
    }

    for (let ch = 0; ch < Math.min(input.length, output.length); ch++) {
      const inp = input[ch];
      const out = output[ch];
      if (!inp || !out) continue;
      this.processChannel(inp, out);
    }

    return true;
  }

  private processChannel(input: Float32Array, output: Float32Array): void {
    const length = output.length;

    for (let i = 0; i < length; i++) {
      const sourcePos = this.phaseIndex;
      const idx = Math.floor(sourcePos);
      const frac = sourcePos - idx;

      if (idx >= 0 && idx < input.length - 1) {
        output[i] = input[idx] * (1 - frac) + input[idx + 1] * frac;
      } else {
        output[i] = 0;
      }

      this.phaseIndex += this.playbackRate;

      if (this.phaseIndex >= input.length) {
        this.phaseIndex -= input.length;
      }
    }
  }
}

registerProcessor('pitch-processor', PitchProcessor);
