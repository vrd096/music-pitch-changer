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
 * Стабилизация BPM: скользящее окно + жёсткий lock после стабилизации.
 *
 *   Фаза 1 — Collecting (без callback):
 *     Накапливаем значения в скользящем окне (макс. 50).
 *     Фильтруем по MIN_WEIGHT (count >= 2) — ранние ненадёжные пики отбрасываются.
 *     Ничего не показываем, пока не выполнены ОБА условия:
 *       a) В окне >= MIN_VALUES_FOR_SHOW (35) значений
 *       b) stddev окна < MAX_STDDEV (1.5) — значения плотно кластеризованы
 *
 *   Фаза 2 — Locked (один callback, навсегда):
 *     Вычисляем медиану стабильного окна, вызываем callback один раз.
 *     После этого handleResult() игнорирует все новые значения.
 *     Пользователь видит одно значение без скачков до конца сессии.
 *
 *   При сбросе (reset/Stop): все состояния очищаются, начинаем заново.
 *   При analyzerReset библиотеки: окно НЕ очищается (если locked — всё равно).
 *
 *   Такой подход гарантирует:
 *   - Никаких видимых скачков BPM (показываем только когда уверены)
 *   - Точный BPM (медиана большого стабильного кластера)
 *   - Не блокируется на неправильном значении (ждём реальной стабилизации)
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

  /* ===== Sliding Window + Lock ===== */

  /** Максимальный размер скользящего окна значений BPM.
   *  50 значений × ~93ms = ~4.7 секунды — большой буфер для точной медианы. */
  private readonly WINDOW_SIZE = 50;

  /** Минимальное количество значений в окне перед первым показом.
   *  35 значений × ~93ms = ~3.3 секунды.
   *  Этого достаточно, чтобы библиотека накопила достаточно пиков. */
  private readonly MIN_VALUES_FOR_SHOW = 35;

  /** Порог stddev для признания значений "стабильными".
   *  1.5 BPM — очень плотный кластер. Если stddev >= 1.5, значит значения
   *  всё ещё разбросаны (напр. смесь 131 и 134 даёт stddev ~1.5).
   *  Ждём, пока кластер сузится к истинному BPM. */
  private readonly MAX_STDDEV = 1.5;

  /** Скользящее окно сырых значений BPM */
  private valueWindow: number[] = [];

  /** Текущее отображаемое значение BPM.
   *  null = фаза 1 (Collecting), не null = фаза 2 (Locked). */
  private displayedBpm: number | null = null;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.buffer = new Float32Array(this.BUFFER_SIZE);

    // stabilizationTime: 60000ms — анализатор не сбрасывается 60 секунд,
    //   чтобы BPM успел стабилизироваться.
    // muteTimeInIndexes: 5000 — пауза между поиском пиков
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
    this.displayedBpm = null;
    this.valueWindow = [];
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
   *
   * Если BPM уже заблокирован (displayedBpm !== null) — reset не влияет
   * на отображение, handleResult всё равно игнорирует новые значения.
   * Если ещё в фазе Collecting — окно не очищаем, старые значения валидны.
   */
  private onAnalyzerReset(): void {
    console.log('[BpmAnalyzer] analyzer reset (internal peaks cleared)');
  }

  /**
   * Выбирает наилучший BPM из списка кандидатов с учётом гармоник.
   *
   * Библиотека сортирует candidates.bpm по count (количество peak-интервалов,
   * сошедшихся на этом BPM). Однако на некоторых треках триольное деление
   * (BPM * 2/3) даёт БОЛЬШЕ интервалов, чем основной темп. Например, для
   * трека 140 BPM: bpm[0] = 93 (count=5, триоль), bpm[1] = 140 (count=3, основной).
   *
   * Логика выбора:
   *   1. Берём кандидатов с count >= 1 и BPM в диапазоне 30–300
   *   2. Сортируем по count (desc) — это уже сделано библиотекой
   *   3. Проверяем гармонические связи между top-кандидатами:
   *      - Если ratio ≈ 1.5 (bpm[1] / bpm[0]): bpm[1] — основной темп,
   *        bpm[0] — триоль. Предпочитаем bpm[1] если его count >= 50% от bpm[0].
   *      - Если ratio ≈ 0.667 (bpm[1] / bpm[0]): bpm[0] — основной темп,
   *        bpm[1] — триоль. Оставляем bpm[0].
   *      - Если ratio ≈ 2.0 (bpm[1] / bpm[0]): bpm[1] — удвоение (октава).
   *        Предпочитаем bpm[0] (нижний темп ближе к реальному).
   *   4. Возвращаем выбранный BPM или null если ни один не подошёл.
   */
  private pickBestBpm(candidates: BpmCandidates): number | null {
    if (!candidates.bpm || candidates.bpm.length === 0) return null;

    const valid = candidates.bpm.filter(
      (c) => c.tempo >= 30 && c.tempo <= 300 && (c.count ?? 0) >= 1,
    );

    if (valid.length === 0) return null;

    // valid[0] — с наивысшим count (библиотека уже отсортировала)
    const top = valid[0];
    const topCount = top.count ?? 0;

    // Ищем гармоники среди остальных кандидатов
    for (let i = 1; i < valid.length; i++) {
      const cand = valid[i];
      const candCount = cand.count ?? 0;

      // Не рассматриваем кандидатов с существенно меньшим count
      if (candCount < topCount * 0.5) break;

      const ratio = cand.tempo / top.tempo;

      // ratio ≈ 1.5: кандидат — основной темп, top — триоль
      // Пример: top=93, cand=140 → ratio=1.505 → берём 140
      if (ratio > 1.45 && ratio < 1.56) {
        console.log(
          `[BpmAnalyzer] 🎯 harmonic 1.5x: cand=${cand.tempo} (count=${candCount}) > top=${top.tempo} (count=${topCount})`,
        );
        return cand.tempo;
      }

      // ratio ≈ 2.0: кандидат — удвоение (октава)
      // Пример: top=70, cand=140 → ratio=2.0 → берём 70 (нижний темп)
      if (ratio > 1.9 && ratio < 2.1) {
        console.log(
          `[BpmAnalyzer] 🎯 harmonic 2x: keeping top=${top.tempo} (count=${topCount}) > cand=${cand.tempo} (count=${candCount})`,
        );
        // Оставляем top (нижний темп)
        return top.tempo;
      }
    }

    // Ничего не нашли — возвращаем top как есть
    return top.tempo;
  }

  /**
   * Обработка результата от RealTimeBpmAnalyzer.
   *
   * Две фазы: Collecting (накопление) → Locked (заморожено).
   *
   * Collecting:
   *   - Выбираем лучший BPM через pickBestBpm (гармонический анализ)
   *   - Добавляем в скользящее окно (макс WINDOW_SIZE)
   *   - Ждём MIN_VALUES_FOR_SHOW и stddev < MAX_STDDEV
   *   - Пользователь видит "Detecting"
   *
   * Locked:
   *   - После стабилизации: вычисляем медиану, вызываем callback ОДИН раз
   *   - Все последующие handleResult игнорируются (displayedBpm !== null)
   *   - Только reset() может снять блокировку
   */
  private handleResult(candidates: BpmCandidates): void {
    // ================================================================
    //  ФАЗА 2 — LOCKED: BPM уже показан, игнорируем все новые значения
    // ================================================================
    if (this.displayedBpm !== null) return;

    // Выбираем лучший BPM с учётом гармоник
    const rawBpm = this.pickBestBpm(candidates);
    if (rawBpm === null) return;

    // ================================================================
    //  ФАЗА 1 — COLLECTING: накапливаем, ничего не показываем
    // ================================================================

    // Добавляем в скользящее окно
    this.valueWindow.push(rawBpm);
    if (this.valueWindow.length > this.WINDOW_SIZE) {
      this.valueWindow.shift();
    }

    // Недостаточно данных для стабильного вывода
    if (this.valueWindow.length < this.MIN_VALUES_FOR_SHOW) return;

    // Вычисляем медиану и stddev скользящего окна
    const sorted = [...this.valueWindow].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
    const stddev = Math.sqrt(variance);

    // Если stddev >= MAX_STDDEV — значения ещё разбросаны
    // (напр. смесь 131 и 134 даёт stddev ~1.5), продолжаем копить
    if (stddev >= this.MAX_STDDEV) {
      console.log(
        `[BpmAnalyzer] window=${this.valueWindow.length} median=${Math.round(median * 10) / 10}` +
          ` stddev=${stddev.toFixed(2)} (unstable, waiting...)`,
      );
      return;
    }

    // Стабильно! Вычисляем финальный BPM и блокируем навсегда
    this.displayedBpm = Math.round(median * 10) / 10;

    console.log(
      `[BpmAnalyzer] ✅ LOCKED at ${this.displayedBpm} BPM` +
        ` (window=${this.valueWindow.length}, stddev=${stddev.toFixed(2)})`,
    );

    this.callback?.({
      bpm: this.displayedBpm,
      confidence: 1,
    });
  }
}
