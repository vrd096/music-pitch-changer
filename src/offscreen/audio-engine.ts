import type { AudioParams, AudioMetrics, ExtensionMessage } from '../shared/types';
import { DEFAULT_AUDIO_PARAMS } from '../shared/types';
import { Messages } from '../shared/messaging';

/**
 * AudioEngine — core audio processing pipeline.
 * Runs inside the Offscreen Document.
 *
 * Two-phase initialization:
 *   Phase 1 (bypass): Source → Gain → Destination (instant audio, no silence)
 *   Phase 2 (full):   Source → BPM → Key → Pitch → Gain → Destination
 *
 * Phase 1 ensures the user hears audio immediately after getUserMedia resolves.
 * Phase 2 upgrades the graph once worklets finish loading — the disconnect/reconnect
 * happens synchronously in one microtask, so no audible gap occurs.
 *
 * Analysis nodes (BPM, Key) have passthrough (input → output) and are
 * placed IN the audio chain so Chrome MUST call AudioWorkletProcessor.process()
 * for them. This is the only reliable way to ensure analysis runs.
 *
 * BPM and Key detection run inside AudioWorklets for precise audio-thread timing.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private pitchNode: AudioWorkletNode | null = null;
  private bpmNode: AudioWorkletNode | null = null;
  private keyNode: AudioWorkletNode | null = null;
  /** Output gain — always connected to destination, shared between bypass/full graph */
  private outputGain: GainNode | null = null;

  private params: AudioParams = { ...DEFAULT_AUDIO_PARAMS };
  private isRunning = false;
  private mediaStream: MediaStream | null = null;

  // Port for communicating with the service worker
  private port: chrome.runtime.Port | null = null;

  // BPM smoothing state (from worklet messages)
  private bpmHistory: number[] = [];
  private readonly BPM_HISTORY_SIZE = 5;

  /** Pre-emptive preparation state */
  private prepared = false;
  private preparePromise: Promise<void> | null = null;

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

  /* ===== Pre-emptive Preparation ===== */

  /**
   * Pre-emptively create AudioContext and load worklets.
   * Called when the offscreen document loads — well before the user clicks Start.
   * When init() is called later, it skips AudioContext creation and worklet loading,
   * going straight to getUserMedia + graph connect. This eliminates ~1-3s of startup delay.
   *
   * Safe to call multiple times — the promise is deduplicated.
   */
  async prepare(): Promise<void> {
    if (this.preparePromise) return this.preparePromise;

    this.preparePromise = (async () => {
      if (this.ctx) {
        // Already created (e.g. from previous init cycle), nothing to do
        this.prepared = true;
        return;
      }

      console.log('[AE] Pre-emptively preparing AudioContext + worklets...');

      this.ctx = new AudioContext({
        sampleRate: 44100,
        latencyHint: 'interactive',
      });

      // Resume AudioContext and wait until it transitions to 'running'.
      // Chrome may keep it suspended briefly — poll up to 1s, checking every 50ms.
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume().catch(() => {});
        const pollStart = Date.now();
        const ctx = this.ctx as AudioContext;
        while (ctx.state !== 'running' && Date.now() - pollStart < 1000) {
          await new Promise((r) => setTimeout(r, 50));
          if (ctx.state === 'suspended') {
            await ctx.resume().catch(() => {});
          }
        }
      }
      if (this.ctx && this.ctx.state !== 'running') {
        console.warn(
          `[AE] AudioContext state: ${this.ctx.state} after resume poll — audio may be silent`,
        );
      }

      // Load worklets while we have time
      await this.loadWorklets();

      this.prepared = true;
      console.log('[AE] Preparation complete (AudioContext + worklets ready)');
    })();

    return this.preparePromise;
  }

  /* ===== Initialization ===== */

  async init(streamId: string): Promise<void> {
    if (this.isRunning) {
      await this.destroy();
    }

    // Reset BPM history on fresh start
    this.bpmHistory = [];

    try {
      // Ensure AudioContext + worklets are prepared.
      // If prepare() was called early (e.g. when offscreen doc loaded), this is instant.
      // If not (edge case), prepare() runs inline.
      if (!this.prepared) {
        await this.prepare();
      } else if (!this.ctx) {
        // ctx was closed by a previous destroy() — re-prepare
        this.prepared = false;
        this.preparePromise = null;
        await this.prepare();
      }

      // At this point ctx is guaranteed to exist
      const ctx = this.ctx!;

      console.log('[AE] AudioContext ready, calling getUserMedia...');

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

      this.sourceNode = ctx.createMediaStreamSource(this.mediaStream);

      // ===== Phase 1: Bypass graph =====
      // Connect Source → Gain → Destination IMMEDIATELY so the user hears audio.
      // Worklets are ALREADY LOADED (from prepare()), so we upgrade right after.
      this.buildBypassGraph();
      this.isRunning = true;

      console.log('[AE] Bypass graph active — audio is playing');
      this.updateStatus('active', 'Processing audio...');
      this.reportMetrics({ bpm: null, key: null, confidence: null, isCapturing: true });

      // ===== Phase 2: Upgrade to full graph =====
      // Worklets are already loaded from prepare() — upgrade immediately.
      this.upgradeGraph();

      console.log('[AE] Audio engine initialized successfully');
      console.log('[AE] Active nodes:', {
        pitch: !!this.pitchNode,
        bpm: !!this.bpmNode,
        key: !!this.keyNode,
      });

      // Send ready signal to service worker
      this.postMessage({ type: 'OFFSCREEN_READY', payload: {} } as ExtensionMessage);
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
      { name: 'bpm-processor', file: '/worklets/bpm-processor.js' },
      { name: 'key-processor', file: '/worklets/key-processor.js' },
      { name: 'pitch-processor', file: '/worklets/pitch-processor.js' },
    ];

    for (const w of worklets) {
      try {
        await this.ctx.audioWorklet.addModule(w.file);
        console.log(`[AE] Worklet loaded: ${w.name}`);
      } catch (e) {
        console.warn(`[AE] ${w.name} failed to load:`, e);
      }
    }
  }

  /* ===== Audio Graph ===== */

  /**
   * Phase 1: Build bypass graph — Source → Gain → Destination.
   * Called immediately after getUserMedia so the user hears audio without delay.
   * Worklets are loaded in the background, then upgradeGraph() is called.
   */
  private buildBypassGraph(): void {
    if (!this.ctx || !this.sourceNode) throw new Error('AudioContext or source not ready');

    this.outputGain = this.ctx.createGain();
    this.outputGain.gain.value = 1.0;

    this.sourceNode.connect(this.outputGain);
    this.outputGain.connect(this.ctx.destination);

    console.log('[AE] Bypass graph active');
  }

  /**
   * Phase 2: Upgrade from bypass to full processing graph.
   * Disconnects source from outputGain, inserts worklet nodes:
   *   Source → BPM → Key → Pitch → Gain → Destination
   *
   * The disconnect/reconnect happens synchronously — no audible gap.
   */
  private upgradeGraph(): void {
    if (!this.ctx || !this.sourceNode || !this.outputGain) {
      console.warn('[AE] Cannot upgrade graph — missing nodes');
      return;
    }

    // 1. BPM detection node (passthrough + analysis)
    try {
      this.bpmNode = new AudioWorkletNode(this.ctx, 'bpm-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { sampleRate: this.ctx.sampleRate },
      });
      this.bpmNode.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'bpm') {
          console.log('[AE] BPM result from worklet:', event.data.bpm);
          this.handleBpmResult(event.data.bpm);
        }
      };
    } catch (e) {
      console.warn('[AE] BPM worklet node creation failed:', e);
    }

    // 2. Key detection node (passthrough + analysis)
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
    } catch (e) {
      console.warn('[AE] Key worklet node creation failed:', e);
    }

    // 3. Pitch shifting node
    try {
      this.pitchNode = new AudioWorkletNode(this.ctx, 'pitch-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { sampleRate: this.ctx.sampleRate },
      });
    } catch (e) {
      console.warn('[AE] Pitch worklet node creation failed:', e);
    }

    // 4. Disconnect source from bypass (synchronous — no audible gap)
    this.sourceNode.disconnect();

    // 5. Rebuild chain: Source → BPM → Key → Pitch → outputGain → Destination
    // outputGain is already connected to destination from Phase 1.
    let currentNode: AudioNode = this.sourceNode;

    if (this.bpmNode) {
      currentNode.connect(this.bpmNode);
      currentNode = this.bpmNode;
    }
    if (this.keyNode) {
      currentNode.connect(this.keyNode);
      currentNode = this.keyNode;
    }
    if (this.pitchNode) {
      currentNode.connect(this.pitchNode);
      currentNode = this.pitchNode;
    }

    currentNode.connect(this.outputGain);

    // Apply stored params to the newly connected worklets
    this.applyParams(this.params);

    console.log('[AE] Graph upgraded to full processing chain');
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
    // Validate range
    if (bpm < 50 || bpm > 200) {
      console.log(`[AE] BPM out of range: ${bpm}`);
      return;
    }

    this.bpmHistory.push(bpm);
    if (this.bpmHistory.length > this.BPM_HISTORY_SIZE) {
      this.bpmHistory.shift();
    }

    const stableBpm = this.median(this.bpmHistory);
    const rounded = Math.round(stableBpm);
    console.log(`[AE] BPM: ${rounded} (raw: ${bpm}, history: [${this.bpmHistory.join(',')}])`);
    this.reportMetrics({
      bpm: rounded,
      isCapturing: true,
    });
  }

  private handleKeyResult(key: string, confidence: number): void {
    console.log(`[AE] Key result: ${key} (confidence: ${confidence})`);
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
    this.prepared = false;
    this.preparePromise = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    // Disconnect in reverse order
    if (this.pitchNode) {
      this.pitchNode.disconnect();
      this.pitchNode = null;
    }
    if (this.keyNode) {
      this.keyNode.disconnect();
      this.keyNode = null;
    }
    if (this.bpmNode) {
      this.bpmNode.disconnect();
      this.bpmNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.outputGain) {
      this.outputGain.disconnect();
      this.outputGain = null;
    }

    if (this.ctx && this.ctx.state !== 'closed') {
      await this.ctx.close();
      this.ctx = null;
    }

    this.bpmHistory = [];
    console.log('[AE] Audio engine destroyed (prepared state reset)');
    this.updateStatus('inactive', 'Audio processing stopped');
  }
}
