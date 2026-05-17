/**
 * Type declarations for AudioWorklet globals.
 * AudioWorkletProcessor and registerProcessor are not in standard TS DOM types
 * because they only exist in the AudioWorklet scope.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;

/** Доступен как глобал в AudioWorklet */
declare var sampleRate: number;

interface AudioWorkletNodeOptions {
  numberOfInputs?: number;
  numberOfOutputs?: number;
  outputChannelCount?: number[];
  parameterData?: Record<string, number>;
  processorOptions?: Record<string, unknown>;
}
