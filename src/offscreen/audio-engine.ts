import type { AudioParams, AudioMetrics, ExtensionMessage } from '../shared/types';
import { DEFAULT_AUDIO_PARAMS } from '../shared/types';
import { Messages } from '../shared/messaging';

/**
 * AudioEngine — core audio processing pipeline.
 * Runs inside the Offscreen Document.
 *
 * Pipeline:
 *   Source → PitchNode → GainNode → Destination (audio output)
 *   Source → BPMNode (analysis only, no output)
 *   Source → KeyNode (analysis only, no output)
 *
 * BPM and Key detection run inside AudioWorklets for precise audio-thread timing.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private pitchNode: AudioWorkletNode | null = null;
  private bpmNode: AudioWorkletNode | null = null;
  private keyNode: AudioWorkletNode | null = null;
  private bypassGain: GainNode | null = null;
  private params: AudioParams = { ...DEFAULT_AUDIO_PARAMS };
  private isRunning = false;
  private mediaStream: MediaStream | null = null;

  // Port for communicating with the service worker
  private port: chrome.runtime.Port | null = null;

  // BPM smoothing state (from worklet messages)
  private bpmHistory: number[] = [];
  private readonly BPM_HISTORY_SIZE = 5;

  constructor() {
    this.setupPort();
  }

  /* ===== Port Communication ===== */

  private setupPort(): void {
    try {
      this.port = chrome.runtime.connect({ name: 'offscreen' });
    } catch {
      console.warn('[AE] Could not connect port, using runtime messages');
    }
  }

  private postMessage(message: ExtensionMessage): void {
    if (this.port) {
      this.port.postMessage(message);
    } else {
      chrome.runtime.sendMessage(message).catch(() => {});
    }
  }

  /* ===== Initialization ===== */

  async init(streamId: string): Promise<void> {
    if (this.isRunning) {
      await this.destroy();
    }

    try {
      this.ctx = new AudioContext({
        sampleRate: 44100,
        latencyHint: 'interactive',
      });

      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // @ts-expect-error - Chrome-specific constraints for tab audio capture
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      });

      this.sourceNode = this.ctx.createMediaStreamSource(this.mediaStream);
      await this.loadWorklets();
      this.buildGraph();
      this.isRunning = true;

      console.log('[AE] Audio engine initialized successfully');
      this.updateStatus('active', 'Processing audio...');
      this.reportMetrics({ bpm: null, key: null, confidence: null, isCapturing: true });
    } catch (error) {
      console.error('[AE] Initialization failed:', error);
      this.updateStatus('inactive', `Error: ${(error as Error).message}`);
      this.postMessage(Messages.error('INIT_FAILED', (error as Error).message));
    }
  }

  /* ===== Worklet Loading ===== */

  private async loadWorklets(): Promise<void> {
    if (!this.ctx) throw new Error('AudioContext not initialized');

    const worklets = [
      { name: 'pitch-processor', file: '/worklets/pitch-processor.js' },
      { name: 'bpm-processor', file: '/worklets/bpm-processor.js' },
      { name: 'key-processor', file: '/worklets/key-processor.js' },
    ];

    for (const w of worklets) {
      try {
        await this.ctx.audioWorklet.addModule(w.file);
        console.log(`[AE] Worklet loaded: ${w.name}`);
      } catch (e) {
        if (w.name === 'pitch-processor') {
          console.warn('[AE] Pitch worklet failed, using fallback:', e);
          await this.loadFallbackPitchWorklet();
        } else {
          console.warn(`[AE] ${w.name} not available, BPM/key will not be detected:`, e);
        }
      }
    }
  }

  private async loadFallbackPitchWorklet(): Promise<void> {
    if (!this.ctx) return;

    const blob = new Blob(
      [
        `
        class PassthroughProcessor extends AudioWorkletProcessor {
          process(inputs, outputs) {
            const input = inputs[0];
            const output = outputs[0];
            if (input && output && input.length > 0 && output.length > 0) {
              for (let ch = 0; ch < Math.min(input.length, output.length); ch++) {
                const ic = input[ch]; const oc = output[ch];
                if (ic && oc) { for (let i = 0; i < ic.length; i++) oc[i] = ic[i]; }
              }
            }
            return true;
          }
        }
        registerProcessor('pitch-processor', PassthroughProcessor);
        `,
      ],
      { type: 'application/javascript' },
    );
    const url = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  }

  /* ===== Audio Graph ===== */

  private buildGraph(): void {
    if (!this.ctx || !this.sourceNode) throw new Error('AudioContext or source not ready');

    // 1. Pitch shifting node (audio output path)
    this.pitchNode = new AudioWorkletNode(this.ctx, 'pitch-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { sampleRate: this.ctx.sampleRate },
    });

    // 2. BPM detection node (analysis tap, output unconnected)
    if (this.ctx.audioWorklet.addModule !== undefined) {
      try {
        this.bpmNode = new AudioWorkletNode(this.ctx, 'bpm-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          processorOptions: { sampleRate: this.ctx.sampleRate },
        });
        this.bpmNode.port.onmessage = (event: MessageEvent) => {
          if (event.data?.type === 'bpm') {
            this.handleBpmResult(event.data.bpm);
          }
        };
      } catch {
        console.warn('[AE] BPM worklet node creation failed');
      }
    }

    // 3. Key detection node (analysis tap, output unconnected)
    if (this.ctx.audioWorklet.addModule !== undefined) {
      try {
        this.keyNode = new AudioWorkletNode(this.ctx, 'key-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          processorOptions: { sampleRate: this.ctx.sampleRate },
        });
        this.keyNode.port.onmessage = (event: MessageEvent) => {
          if (event.data?.type === 'key') {
            this.handleKeyResult(event.data.key, event.data.confidence);
          }
        };
      } catch {
        console.warn('[AE] Key worklet node creation failed');
      }
    }

    // 4. Gain node
    this.bypassGain = this.ctx.createGain();
    this.bypassGain.gain.value = 1.0;

    // Connect main audio graph: Source → PitchNode → GainNode → Destination
    this.sourceNode.connect(this.pitchNode);
    this.pitchNode.connect(this.bypassGain);
    this.bypassGain.connect(this.ctx.destination);

    // Connect analysis taps (outputs intentionally unconnected — process() still fires)
    if (this.bpmNode) {
      this.sourceNode.connect(this.bpmNode);
    }
    if (this.keyNode) {
      this.sourceNode.connect(this.keyNode);
    }

    this.applyParams(this.params);
  }

  /* ===== Parameter Updates ===== */

  applyParams(params: AudioParams): void {
    this.params = { ...params };

    if (!this.pitchNode) return;

    this.pitchNode.port.postMessage({
      type: 'param',
      speed: params.speed,
      pitch: params.pitch,
      bypass: params.bypass,
    });
  }

  /* ===== BPM / Key Result Handlers ===== */

  private handleBpmResult(bpm: number): void {
    if (bpm < 60 || bpm > 200) return;

    this.bpmHistory.push(bpm);
    if (this.bpmHistory.length > this.BPM_HISTORY_SIZE) {
      this.bpmHistory.shift();
    }

    const stableBpm = this.median(this.bpmHistory);
    this.reportMetrics({
      bpm: Math.round(stableBpm),
      isCapturing: true,
    });
  }

  private handleKeyResult(key: string, confidence: number): void {
    this.reportMetrics({
      key,
      confidence: Math.min(confidence, 1),
      isCapturing: true,
    });
  }

  /* ===== Metrics Reporting ===== */

  private reportMetrics(metrics: Partial<AudioMetrics>): void {
    this.postMessage(
      Messages.metricsUpdate({
        bpm: metrics.bpm ?? null,
        key: metrics.key ?? null,
        confidence: metrics.confidence ?? null,
        isCapturing: metrics.isCapturing ?? this.isRunning,
      }),
    );
  }

  /* ===== Utilities ===== */

  private median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private updateStatus(className: string, text: string): void {
    const el = document.getElementById('status');
    if (el) {
      el.className = className;
      el.textContent = text;
    }
  }

  /* ===== Cleanup ===== */

  async destroy(): Promise<void> {
    this.isRunning = false;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.pitchNode) {
      this.pitchNode.disconnect();
      this.pitchNode = null;
    }
    if (this.bpmNode) {
      this.bpmNode.disconnect();
      this.bpmNode = null;
    }
    if (this.keyNode) {
      this.keyNode.disconnect();
      this.keyNode = null;
    }
    if (this.bypassGain) {
      this.bypassGain.disconnect();
      this.bypassGain = null;
    }

    if (this.ctx && this.ctx.state !== 'closed') {
      await this.ctx.close();
      this.ctx = null;
    }

    this.bpmHistory = [];
    console.log('[AE] Audio engine destroyed');
    this.updateStatus('inactive', 'Audio processing stopped');
  }
}
