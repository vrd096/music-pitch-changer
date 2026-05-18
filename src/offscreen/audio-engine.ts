import type { AudioParams, AudioMetrics, ExtensionMessage } from '../shared/types';
import { DEFAULT_AUDIO_PARAMS } from '../shared/types';
import { Messages } from '../shared/messaging';
import { KeyAnalyzer } from './key-analyzer';
import { BpmAnalyzer } from './bpm-analyzer';

/**
 * AudioEngine — core audio processing pipeline.
 * Runs inside the Offscreen Document.
 *
 * Двухфазная инициализация:
 *   Phase 1 (bypass): Source → outputGain → Destination (мгновенный звук, без тишины)
 *   Phase 2 (upgrade): Source → capture → Pitch → outputGain → Destination
 *
 * Phase 1: пользователь слышит аудио сразу после getUserMedia.
 * Phase 2: бесшовная замена графа (disconnect/reconnect в одном микротаске).
 *
 * Анализ BPM и KEY вынесены из AudioWorklet на main (offscreen) thread:
 *   - BpmAnalyzer: peak detection + BPM вычисление через realtime-bpm-analyzer
 *   - KeyAnalyzer: Radix-2 FFT → chromagram → корреляция с Krumhansl-Schmuckler
 *
 * Это исключает блокировку audio thread тяжёлыми вычислениями
 * и предотвращает audio break'и.
 *
 * CaptureProcessor передаёт аудио-чанки в оба анализатора через port.onmessage.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private pitchNode: AudioWorkletNode | null = null;
  private captureNode: AudioWorkletNode | null = null;
  /** BPM detection on main thread (offscreen) — не блокирует audio thread */
  private bpmAnalyzer: BpmAnalyzer | null = null;
  /** Key detection on main thread (offscreen) — не блокирует audio thread */
  private keyAnalyzer: KeyAnalyzer | null = null;
  /** Output gain — всегда подключён к destination, общий для bypass/full graph */
  private outputGain: GainNode | null = null;

  private params: AudioParams = { ...DEFAULT_AUDIO_PARAMS };
  private isRunning = false;
  private mediaStream: MediaStream | null = null;

  /** Последние отправленные метрики — для GET_STATE при переоткрытии popup */
  private lastMetrics: Partial<AudioMetrics> = {};

  // Port for communicating with the service worker
  private port: chrome.runtime.Port | null = null;

  /** Pre-emptive preparation state */
  private prepared = false;
  private preparePromise: Promise<void> | null = null;

  /* ===== Silence Detection (смена трека) ===== */

  /**
   * Порог RMS для определения "цифровой тишины" между треками.
   *
   * Стратегия: ultra-low threshold + короткое окно.
   * Тихие пассажи музыки (piano, паузы между фразами) имеют RMS ~0.01–0.05.
   * Реальная цифровая тишина между треками — RMS < 0.0005.
   *
   * При переключении трека в браузере/плеере между треками есть
   * короткая пауза (100–300ms) с практически нулевым сигналом.
   * Этого достаточно, чтобы счётчик достиг порога.
   */
  private static readonly SILENCE_THRESHOLD = 0.0005;
  /**
   * Сколько последовательных чанков (по 512 сэмплов) должны быть
   * **полной тишиной** (< 0.0005 RMS), чтобы считать, что трек сменился.
   *
   * ~150ms при 44100 Гц: 44100 * 0.15 / 512 ≈ 13 чанков
   *
   * Между треками в цифровом плеере обычно есть хотя бы 100–300ms
   * полной тишины. 150ms — достаточно, чтобы не реагировать на
   * паузы между фразами (где RMS ~0.01, выше порога).
   */
  private static readonly SILENCE_CHUNKS_REQUIRED = 13;

  /** Счётчик последовательных тихих чанков */
  private silentChunkCount = 0;
  /** Флаг: true = тишина уже обнаружена (анализаторы сброшены) */
  private wasSilent = false;

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

    // Сброс счётчиков тишины при старте захвата
    this.silentChunkCount = 0;
    this.wasSilent = false;

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
      // Connect Source → outputGain → Destination IMMEDIATELY so the user hears audio.
      // Worklets are ALREADY LOADED (from prepare()), so we upgrade right after.
      this.buildBypassGraph();
      this.isRunning = true;

      console.log('[AE] Bypass graph active — audio is playing');
      this.updateStatus('active', 'Processing audio...');
      this.reportMetrics({
        bpm: null,
        key: null,
        confidence: null,
        frequency: null,
        isCapturing: true,
      });

      // Create KeyAnalyzer (main-thread key detection) before upgradeGraph
      // так как upgradeGraph подключает captureNode.port.onmessage →
      // KeyAnalyzer.addChunk() и вызывает keyAnalyzer.start()
      this.keyAnalyzer = new KeyAnalyzer(ctx.sampleRate);
      this.keyAnalyzer.setCallback((result) => {
        this.handleKeyResult(result.key, result.confidence);
      });

      // Create BpmAnalyzer (main-thread BPM detection) — тоже до upgradeGraph
      this.bpmAnalyzer = new BpmAnalyzer(ctx.sampleRate);
      this.bpmAnalyzer.setCallback((result) => {
        this.handleBpmResult(result.bpm, result.confidence);
      });

      // ===== Phase 2: Upgrade to full graph =====
      // Worklets are already loaded from prepare() — upgrade immediately.
      this.upgradeGraph();

      console.log('[AE] Audio engine initialized successfully');
      console.log('[AE] Active nodes:', {
        pitch: !!this.pitchNode,
        capture: !!this.captureNode,
        bpmAnalyzer: !!this.bpmAnalyzer,
        keyAnalyzer: !!this.keyAnalyzer,
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

    // key-processor.js загружать не нужно — KeyAnalyzer работает на main thread
    // (см. key-analyzer.ts). Worklet загружается только если ключ детектится
    // внутри AudioWorklet (запасной вариант / будущая оптимизация).
    const worklets = [
      { name: 'capture-processor', file: '/worklets/capture-processor.js' },
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
   * Phase 1: Build bypass graph — Source → outputGain → Destination.
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
   *   Source → capture (passthrough) → Pitch → outputGain → Destination
   *
   * Анализ BPM и KEY вынесены на main (offscreen) thread:
   *   - BpmAnalyzer: peak detection через realtime-bpm-analyzer
   *   - KeyAnalyzer: Radix-2 FFT → chromagram → корреляция
   *
   * CaptureProcessor передаёт аудио-чанки через port.onmessage
   * напрямую в оба анализатора (addChunk()).
   *
   * The disconnect/reconnect happens synchronously — no audible gap.
   */
  private upgradeGraph(): void {
    if (!this.ctx || !this.sourceNode || !this.outputGain) {
      console.warn('[AE] Cannot upgrade graph — missing nodes');
      return;
    }

    // 1. Capture node (passthrough — передаёт аудио дальше по графу)
    //    Также отправляет копии аудио-чанков в main thread для KeyAnalyzer и BpmAnalyzer.
    try {
      this.captureNode = new AudioWorkletNode(this.ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
      });
      // Получаем аудио-чанки от capture-processor и передаём в оба анализатора
      this.captureNode.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'audio' && event.data.samples instanceof Float32Array) {
          // Детекция тишины для сброса BPM/KEY при смене трека
          this.detectSilence(event.data.samples);

          this.keyAnalyzer?.addChunk(event.data.samples);
          this.bpmAnalyzer?.addChunk(event.data.samples);
        }
      };
    } catch (e) {
      console.warn('[AE] Capture worklet node creation failed:', e);
    }

    // 2. Key + BPM detection — НЕ в AudioWorklet, а в KeyAnalyzer и BpmAnalyzer (main thread)
    //    (Инициализируются в init() до вызова upgradeGraph())
    //    CaptureProcessor отправляет аудио-чанки через port.onmessage (см. выше).

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

    // 5. Rebuild chain: Source → capture → Pitch → outputGain → Destination
    //    outputGain is already connected to destination from Phase 1.
    //    BPM и KEY анализируются на main thread, не в audio chain.
    let currentNode: AudioNode = this.sourceNode;

    if (this.captureNode) {
      currentNode.connect(this.captureNode);
      currentNode = this.captureNode;
    }
    if (this.pitchNode) {
      currentNode.connect(this.pitchNode);
      currentNode = this.pitchNode;
    }

    currentNode.connect(this.outputGain);

    // Apply stored params to the newly connected worklets
    this.applyParams(this.params);

    console.log('[AE] Graph upgraded to full processing chain');

    // Start periodic key analysis
    this.keyAnalyzer?.start();
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

  /* ===== Result Handlers ===== */

  private handleKeyResult(key: string, confidence: number): void {
    console.log(`[AE] Key result: ${key} (confidence: ${confidence})`);
    this.reportMetrics({
      key,
      confidence: Math.min(confidence, 1),
      isCapturing: true,
    });
  }

  private handleBpmResult(bpm: number, confidence: number): void {
    console.log(`[AE] BPM result: ${bpm} (confidence: ${confidence})`);
    this.reportMetrics({
      bpm,
      confidence: Math.min(confidence, 1),
      isCapturing: true,
    });
  }

  /* ===== Silence Detection (смена трека) ===== */

  /**
   * Анализирует RMS аудио-чанка для детекции тишины.
   * Если N последовательных чанков тихие → сбрасывает BPM/KEY анализаторы
   * и отправляет null метрики в UI.
   */
  private detectSilence(samples: Float32Array): void {
    // Вычисляем RMS (root mean square) — средняя громкость
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples.length);

    if (rms < AudioEngine.SILENCE_THRESHOLD) {
      this.silentChunkCount++;
    } else {
      // Есть звук — сбрасываем счётчик тишины
      this.silentChunkCount = 0;
      this.wasSilent = false;
    }

    // Если тишина держится достаточно долго — сбрасываем анализаторы
    if (!this.wasSilent && this.silentChunkCount >= AudioEngine.SILENCE_CHUNKS_REQUIRED) {
      this.wasSilent = true;
      this.resetAnalyzers();
    }
  }

  /** Сброс BPM/KEY анализаторов при смене трека */
  private resetAnalyzers(): void {
    console.log('[AE] Silence detected — resetting analyzers (track changed)');

    this.bpmAnalyzer?.reset();
    this.keyAnalyzer?.reset();

    // Отправляем null метрики — UI покажет "Detecting..." заново
    this.reportMetrics({
      bpm: null,
      key: null,
      confidence: null,
    });
  }

  /* ===== Metrics Reporting ===== */

  private reportMetrics(metrics: Partial<AudioMetrics>): void {
    // Merge с предыдущим lastMetrics — чтобы key не терялся при обновлении bpm
    // и наоборот (например, handleBpmResult → reportMetrics({ bpm }) не стирает key)
    this.lastMetrics = {
      ...this.lastMetrics,
      ...metrics,
      isCapturing: metrics.isCapturing ?? this.isRunning,
    };
    // Используем lastMetrics (уже смерджен) для отправки — иначе
    // handleKeyResult → reportMetrics({ key }) затрёт bpm (undefined → null)
    this.postMessage(
      Messages.metricsUpdate({
        bpm: this.lastMetrics.bpm ?? null,
        key: this.lastMetrics.key ?? null,
        confidence: this.lastMetrics.confidence ?? null,
        frequency: this.lastMetrics.frequency ?? null,
        isCapturing: this.lastMetrics.isCapturing ?? this.isRunning,
      }),
    );
  }

  /** Возвращает последние известные метрики — используется при GET_STATE */
  getState(): Partial<AudioMetrics> {
    return { ...this.lastMetrics };
  }

  /* ===== Utilities ===== */

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
    if (this.bpmAnalyzer) {
      this.bpmAnalyzer.destroy();
      this.bpmAnalyzer = null;
    }
    if (this.keyAnalyzer) {
      this.keyAnalyzer.destroy();
      this.keyAnalyzer = null;
    }
    if (this.captureNode) {
      this.captureNode.disconnect();
      this.captureNode = null;
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

    console.log('[AE] Audio engine destroyed (prepared state reset)');
    this.updateStatus('inactive', 'Audio processing stopped');
  }
}
