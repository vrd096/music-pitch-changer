import { RealTimeBpmAnalyzer } from 'realtime-bpm-analyzer';
import type { BpmCandidates } from 'realtime-bpm-analyzer';

export interface BpmResult {
  bpm: number;
  confidence: number;
}

export type BpmCallback = (result: BpmResult) => void;

/**
 * BpmAnalyzer — main-thread BPM detection wrapping RealTimeBpmAnalyzer.
 *
 * Собирает аудио-чанки от CaptureProcessor (128 сэмплов каждый),
 * накапливает до bufferSize (4096), затем вызывает
 * RealTimeBpmAnalyzer.analyzeChunk() для peak detection + BPM вычисления.
 *
 * Стабилизация BPM (DJ-software подход):
 *   1. Защита от половинного/двойного BPM — ratio < 0.75 || > 1.5 → игнор
 *   2. Sliding window history (5 значений)
 *   3. Median-фильтр для устойчивости к выбросам
 *   4. Dead zone: не репортим изменения < 1 BPM
 *   5. Округление до десятых
 *
 * Аналогично KeyAnalyzer — не блокирует audio thread.
 */
export class BpmAnalyzer {
  private analyzer: RealTimeBpmAnalyzer;
  private sampleRate: number;

  /** Буфер для накопления аудио-сэмплов до bufferSize */
  private buffer: Float32Array;
  private readonly BUFFER_SIZE = 4096;
  private bufferOffset = 0;

  /** Promise chain для последовательного вызова analyzeChunk.
   *  Предотвращает race condition без отбрасывания чанков. */
  private analysisChain: Promise<void> = Promise.resolve();

  /** Callback для результатов */
  private callback: BpmCallback | null = null;

  /** Сглаживание через историю BPM */
  private readonly BPM_HISTORY_SIZE = 7;
  private bpmHistory: number[] = [];
  private confidenceHistory: number[] = [];

  /** Последнее отправленное значение (для dead zone) */
  private lastReportedBpm: number | null = null;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.buffer = new Float32Array(this.BUFFER_SIZE);

    // stabilizationTime: 60000ms — анализатор не сбрасывается 60 секунд,
    //   чтобы BPM успел стабилизироваться. После сброса всё равно заполняем
    //   историю последним известным значением (onAnalyzerReset).
    // muteTimeInIndexes: 5000 — пауза между поиском пиков, чтобы не находить один и тот же
    // continuousAnalysis: true — автосброс после stabilizationTime
    this.analyzer = new RealTimeBpmAnalyzer({
      continuousAnalysis: true,
      stabilizationTime: 60000,
      muteTimeInIndexes: 5000,
      debug: false,
    });
  }

  /** Установить callback для получения результатов */
  setCallback(cb: BpmCallback): void {
    this.callback = cb;
  }

  /**
   * Добавить аудио-чанк от CaptureProcessor.
   * Накапливает сэмплы до BUFFER_SIZE, затем запускает анализ.
   * Анализ асинхронный — буфер копируется перед вызовом, чтобы
   * избежать race condition с addChunk.
   */
  addChunk(samples: Float32Array): void {
    let offset = 0;
    while (offset < samples.length) {
      const remaining = this.BUFFER_SIZE - this.bufferOffset;
      const toCopy = Math.min(remaining, samples.length - offset);
      this.buffer.set(samples.subarray(offset, offset + toCopy), this.bufferOffset);
      this.bufferOffset += toCopy;
      offset += toCopy;

      if (this.bufferOffset >= this.BUFFER_SIZE) {
        // Копируем буфер для анализа
        const data = new Float32Array(this.buffer);
        this.bufferOffset = 0;
        // Цепочка promise для последовательного вызова — без race condition
        this.analysisChain = this.analysisChain.then(() => this.analyzeChunk(data));
      }
    }
  }

  /** Запуск (no-op — анализ триггерится addChunk) */
  start(): void {
    // nothing to do
  }

  /** Остановка (no-op) */
  stop(): void {
    // nothing to do
  }

  /** Сброс состояния */
  reset(): void {
    this.analyzer.reset();
    this.buffer.fill(0);
    this.bufferOffset = 0;
    this.bpmHistory = [];
    this.confidenceHistory = [];
    this.lastReportedBpm = null;
    this.analysisChain = Promise.resolve();
  }

  /** Освобождение ресурсов */
  destroy(): void {
    this.callback = null;
    this.reset();
  }

  /* ===== Private ===== */

  private async analyzeChunk(data: Float32Array): Promise<void> {
    try {
      await this.analyzer.analyzeChunk({
        audioSampleRate: this.sampleRate,
        channelData: data,
        bufferSize: this.BUFFER_SIZE,
        postMessage: (msg) => {
          if (msg.type === 'bpm' || msg.type === 'bpmStable') {
            this.handleResult(msg.data);
          } else if (msg.type === 'analyzerReset') {
            this.onAnalyzerReset();
          }
        },
      });
    } catch (err) {
      console.warn('[BpmAnalyzer] analyzeChunk error:', err);
    }
  }

  /**
   * Вызывается при analyzerReset от RealTimeBpmAnalyzer (каждые stabilizationTime).
   * Заполняет историю последним известным BPM, чтобы после сброса анализатора
   * BPM не начинал скакать, а сразу показывал стабильное значение.
   */
  private onAnalyzerReset(): void {
    if (this.lastReportedBpm !== null) {
      // Заполняем историю последним известным значением,
      // чтобы median сразу был стабильным
      this.bpmHistory = Array(this.BPM_HISTORY_SIZE).fill(this.lastReportedBpm);
      // Вес — средний от предыдущей истории (если есть)
      if (this.confidenceHistory.length > 0) {
        const avg =
          this.confidenceHistory.reduce((s, v) => s + v, 0) / this.confidenceHistory.length;
        this.confidenceHistory = Array(this.BPM_HISTORY_SIZE).fill(avg);
      }
    }
    console.log(
      '[BpmAnalyzer] analyzer reset, history refilled with last bpm:',
      this.lastReportedBpm,
    );
  }

  /**
   * Обработка результата от RealTimeBpmAnalyzer.
   *
   * Применяет DJ-software стабилизацию:
   * 1. Защита от половинного/двойного BPM (ratio 0.75–1.5)
   * 2. Sliding window history → median
   * 3. Dead zone (< 1 BPM)
   * 4. Округление до десятых
   */
  private handleResult(candidates: BpmCandidates): void {
    if (!candidates.bpm || candidates.bpm.length === 0) return;

    const best = candidates.bpm[0];
    const rawBpm = best.tempo;

    // confidence из библиотеки ВСЕГДА 0 (см. groupByTempo: confidence: 0).
    // Используем count (количество интервалов, сошедшихся на этом BPM) как вес.
    const weight = best.count ?? 0;

    // Отбрасываем явно нереалистичные BPM (< 30 или > 300)
    if (rawBpm < 30 || rawBpm > 300) return;

    // Требуем хотя бы count > 0 (чтобы был хоть один интервал)
    if (weight < 1) return;

    // === Защита от половинного/двойного BPM (DJ-software подход) ===
    // Если уже есть стабильное значение, проверяем ratio.
    // Например, stable=128, raw=64 (ratio=0.5) или raw=256 (ratio=2.0) → игнор.
    if (this.lastReportedBpm !== null) {
      const ratio = rawBpm / this.lastReportedBpm;
      if (ratio < 0.75 || ratio > 1.5) {
        console.log(
          `[BpmAnalyzer] ignored halving/doubling: raw=${rawBpm} stable=${this.lastReportedBpm} ratio=${ratio.toFixed(2)}`,
        );
        return;
      }
    }

    console.log(
      `[BpmAnalyzer] raw bpm=${rawBpm} count=${weight} threshold=${candidates.threshold}`,
    );

    // Sliding window history (5 значений)
    this.bpmHistory.push(rawBpm);
    this.confidenceHistory.push(weight);
    if (this.bpmHistory.length > this.BPM_HISTORY_SIZE) {
      this.bpmHistory.shift();
      this.confidenceHistory.shift();
    }

    // Median-фильтр для устойчивости к выбросам
    const sorted = [...this.bpmHistory].sort((a, b) => a - b);
    const medianBpm = sorted[Math.floor(sorted.length / 2)];
    const avgWeight =
      this.confidenceHistory.reduce((s, v) => s + v, 0) / this.confidenceHistory.length;

    // Dead zone: не репортим, если изменение меньше 2 BPM
    // (увеличено с 1 для дополнительной стабильности)
    if (this.lastReportedBpm !== null && Math.abs(medianBpm - this.lastReportedBpm) < 2) {
      return;
    }

    // Репорт — confidence на основе среднего веса (нормализованный к [0,1])
    // BPM округляем до десятых (DJ-стиль: 128.0, 140.2, etc.)
    const confidence = Math.min(avgWeight / 50, 1);
    this.lastReportedBpm = medianBpm;
    this.callback?.({
      bpm: Math.round(medianBpm * 10) / 10,
      confidence,
    });
  }
}
