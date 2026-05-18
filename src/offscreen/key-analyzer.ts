/**
 * KeyAnalyzer — детекция тональности (key) на главном (offscreen) потоке.
 *
 * Вынесен из AudioWorklet (key-processor.ts), чтобы не блокировать
 * audio thread. Использует Radix-2 FFT (Cooley-Tukey) вместо наивного DFT,
 * что даёт ускорение ~89× для N=2048.
 *
 * Алгоритм:
 * 1. Накопление аудио-чанков от CaptureProcessor
 * 2. Каждые ~4 секунды: FFT → magnitude spectrum → chromagram (12 bins)
 * 3. Корреляция хромаграммы с профилями Krumhansl-Schmuckler (12 major + 12 minor)
 * 4. Выбор лучшей тональности + форматирование в Camelot
 *
 * @module offscreen/key-analyzer
 */

// ===== Krumhansl-Schmuckler Key Profiles =====

const MAJOR_PROFILES: Record<string, number[]> = {
  C: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  'C#': [2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29],
  D: [2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66],
  'D#': [3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39],
  E: [2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19],
  F: [5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52],
  'F#': [2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38, 4.09],
  G: [4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33, 4.38],
  'G#': [4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48, 2.33],
  A: [2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23, 3.48],
  'A#': [3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35, 2.23],
  B: [2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88, 6.35],
};

const MINOR_PROFILES: Record<string, number[]> = {
  C: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  'C#': [3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34],
  D: [3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69],
  'D#': [2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98],
  E: [3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75],
  F: [4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54],
  'F#': [2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6, 3.53],
  G: [3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38, 2.6],
  'G#': [2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52, 5.38],
  A: [5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68, 3.52],
  'A#': [3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33, 2.68],
  B: [2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17, 6.33],
};

const CAMELOT_MAJOR: Record<string, string> = {
  C: '8B',
  G: '9B',
  D: '10B',
  A: '11B',
  E: '12B',
  B: '1B',
  'F#': '2B',
  'C#': '3B',
  'G#': '4B',
  'D#': '5B',
  'A#': '6B',
  F: '7B',
};

const CAMELOT_MINOR: Record<string, string> = {
  C: '5A',
  G: '6A',
  D: '7A',
  A: '8A',
  E: '9A',
  B: '10A',
  'F#': '11A',
  'C#': '12A',
  'G#': '1A',
  'D#': '2A',
  'A#': '3A',
  F: '4A',
};

/* ===== Key Result ===== */

export interface KeyResult {
  key: string;
  confidence: number;
}

/* ===== Radix-2 FFT (in-place, Cooley-Tukey) ===== */

/**
 * In-place Radix-2 Decimation-in-Time FFT.
 * N must be power of 2. Reuses pre-allocated buffers for zero GC pressure.
 *
 * После вызова:
 *   re[0..N-1] — действительная часть спектра
 *   im[0..N-1] — мнимая часть спектра
 *   magnitude[0..N/2-1] — амплитудный спектр (положительные частоты)
 */
class FFT {
  private n: number;

  /** Pre-computed cos/sin tables for all stages */
  private cosTables: Float64Array[];
  private sinTables: Float64Array[];

  constructor(n: number) {
    if ((n & (n - 1)) !== 0) throw new Error(`FFT size must be power of 2, got ${n}`);
    this.n = n;

    // Pre-compute twiddle factors for each stage
    this.cosTables = [];
    this.sinTables = [];
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const cosTbl = new Float64Array(halfLen);
      const sinTbl = new Float64Array(halfLen);
      for (let j = 0; j < halfLen; j++) {
        const angle = (Math.PI * j) / halfLen;
        cosTbl[j] = Math.cos(angle);
        sinTbl[j] = -Math.sin(angle);
      }
      this.cosTables.push(cosTbl);
      this.sinTables.push(sinTbl);
    }
  }

  /**
   * Выполнить FFT над re, im (in-place).
   * re и im должны быть длины n.
   */
  transform(re: Float32Array, im: Float32Array): void {
    const n = this.n;

    // === Bit-reversal permutation ===
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; (j & bit) !== 0; bit >>= 1) {
        j ^= bit;
      }
      j ^= bit;
      if (i < j) {
        let tmp = re[i];
        re[i] = re[j];
        re[j] = tmp;
        tmp = im[i];
        im[i] = im[j];
        im[j] = tmp;
      }
    }

    // === Butterfly stages ===
    for (let stage = 0, len = 2; len <= n; stage++, len <<= 1) {
      const halfLen = len >> 1;
      const cosTbl = this.cosTables[stage];
      const sinTbl = this.sinTables[stage];

      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < halfLen; j++) {
          const wr = cosTbl[j];
          const wi = sinTbl[j];
          const k = i + j;

          const tRe = wr * re[k + halfLen] - wi * im[k + halfLen];
          const tIm = wr * im[k + halfLen] + wi * re[k + halfLen];

          re[k + halfLen] = re[k] - tRe;
          im[k + halfLen] = im[k] - tIm;

          re[k] += tRe;
          im[k] += tIm;
        }
      }
    }
  }

  /**
   * Вычислить magnitude-спектр (положительные частоты, bins 0..N/2-1).
   * Результат записывается в выходной массив mag (должен быть длины n/2).
   */
  magnitudeSpectrum(re: Float32Array, im: Float32Array, mag: Float32Array): void {
    const halfN = this.n >> 1;
    for (let i = 0; i < halfN; i++) {
      mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    }
  }
}

/* ===== Chromagram ===== */

/**
 * 12-биновая хромаграмма (Pitch Class Profile).
 */
class Chromagram {
  private fft: FFT;
  private fftSize: number;
  private sampleRate: number;

  /** Pre-allocated working buffers */
  private re: Float32Array;
  private im: Float32Array;
  private mag: Float32Array;

  constructor(fftSize: number, sampleRate: number) {
    this.fftSize = fftSize;
    this.sampleRate = sampleRate;
    this.fft = new FFT(fftSize);

    // Pre-allocate zero buffer for imaginary part (signal is real)
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.mag = new Float32Array(fftSize >> 1);
  }

  /**
   * Вычислить 12-биновую хромаграмму из time-domain сигнала.
   * data должен быть длины >= fftSize.
   * Возвращает Float32Array[12] (нормализован от 0 до 1).
   */
  compute(data: Float32Array): Float32Array {
    const fftSize = this.fftSize;

    // 1. Применить Hann window к середине буфера
    const start = Math.max(0, Math.floor((data.length - fftSize) / 2));
    for (let i = 0; i < fftSize; i++) {
      const windowVal = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
      this.re[i] = data[start + i] * windowVal;
      this.im[i] = 0;
    }

    // 2. FFT
    this.fft.transform(this.re, this.im);

    // 3. Magnitude spectrum (positive frequencies)
    this.fft.magnitudeSpectrum(this.re, this.im, this.mag);

    // 4. Map to 12 pitch classes
    //    Frequency = bin * sampleRate / fftSize
    //    MIDI note = 12 * log2(freq / 440) + 69
    //    Pitch class = round(midiNote) % 12
    const chroma = new Float32Array(12);
    const halfN = fftSize >> 1;

    for (let bin = 1; bin < halfN; bin++) {
      const freq = (bin * this.sampleRate) / fftSize;
      // Ignore extremes — guitar/bass range ~80-1200 Hz covers most music
      if (freq < 65 || freq > 4000) continue;

      const midiNote = 12 * Math.log2(freq / 440) + 69;
      const pitchClass = Math.round(midiNote) % 12;

      if (pitchClass >= 0 && pitchClass < 12) {
        chroma[pitchClass] += this.mag[bin];
      }
    }

    // 5. Normalize
    let maxVal = 0;
    for (let i = 0; i < 12; i++) {
      if (chroma[i] > maxVal) maxVal = chroma[i];
    }
    if (maxVal > 0.001) {
      for (let i = 0; i < 12; i++) {
        chroma[i] /= maxVal;
      }
    }

    return chroma;
  }

  /** Освободить ресурсы (сбросить ссылки для GC) */
  destroy(): void {
    this.re = null!;
    this.im = null!;
    this.mag = null!;
  }
}

/* ===== Pearson correlation (module-level, reusable) ===== */

/**
 * Pearson correlation между chromagram (Float32Array) и profile (number[]).
 * Используется как KeyDetector.detect(), так и KeyAnalyzer.analyzeNow().
 */
function correlate(chroma: Float32Array, profile: number[]): number {
  const n = 12;
  let meanC = 0,
    meanP = 0;
  for (let i = 0; i < n; i++) {
    meanC += chroma[i];
    meanP += profile[i];
  }
  meanC /= n;
  meanP /= n;

  let cov = 0,
    varC = 0,
    varP = 0;
  for (let i = 0; i < n; i++) {
    const dc = chroma[i] - meanC;
    const dp = profile[i] - meanP;
    cov += dc * dp;
    varC += dc * dc;
    varP += dp * dp;
  }

  const denom = Math.sqrt(varC * varP);
  return denom === 0 ? 0 : cov / denom;
}

/* ===== Key Detector ===== */

class KeyDetector {
  private chromagram: Chromagram;

  constructor(fftSize: number, sampleRate: number) {
    this.chromagram = new Chromagram(fftSize, sampleRate);
  }

  /**
   * Определить тональность аудио-буфера.
   * @param data — минимум fftSize сэмплов
   * @returns KeyResult или null если confidence слишком низкий
   */
  detect(data: Float32Array): KeyResult | null {
    const chroma = this.chromagram.compute(data);

    // Correlate with key profiles
    let bestKey = '';
    let bestCorr = -Infinity;
    let bestType: 'major' | 'minor' = 'major';

    for (const [key, profile] of Object.entries(MAJOR_PROFILES)) {
      const corr = correlate(chroma, profile);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestKey = key;
        bestType = 'major';
      }
    }

    for (const [key, profile] of Object.entries(MINOR_PROFILES)) {
      const corr = correlate(chroma, profile);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestKey = key;
        bestType = 'minor';
      }
    }

    if (!bestKey || bestCorr < 0.1) return null;

    const camelot = bestType === 'major' ? CAMELOT_MAJOR[bestKey] : CAMELOT_MINOR[bestKey];
    const keyStr = bestType === 'major' ? `${bestKey} (${camelot})` : `${bestKey}m (${camelot})`;

    return {
      key: keyStr,
      confidence: Math.min(bestCorr / 10, 1),
    };
  }

  destroy(): void {
    this.chromagram.destroy();
  }
}

/* ===== KeyAnalyzer (public interface) ===== */

export type KeyCallback = (result: KeyResult) => void;

/**
 * KeyAnalyzer — периодическая детекция тональности из потока аудио-чанков.
 *
 * Использование:
 * ```ts
 * const analyzer = new KeyAnalyzer(44100);
 * analyzer.setCallback((result) => { console.log(result.key); });
 * analyzer.addChunk(chunk); // вызывать для каждого чанка от capture-processor
 * analyzer.start(); // запустить периодический анализ
 * analyzer.stop();  // остановить
 * ```
 *
 * Стабилизация (lock-in, как в BpmAnalyzer):
 * - Скользящее окно хромаграмм (5 шт × 2с = ~10с)
 * - Усреднение хромаграммы по окну перед корреляцией с профилями
 * - Фаза 1 (Collecting): накопление, callback не вызывается
 * - Фаза 2 (Locked): после первого определения — навсегда, без обновлений
 */
export class KeyAnalyzer {
  private detector: KeyDetector;

  /** Кольцевой буфер для накопления аудио */
  private buffer: Float32Array;
  private writeOffset = 0;
  private totalSamples = 0;

  /** Размер окна анализа (1 секунда) */
  private readonly ANALYSIS_WINDOW: number;

  /** Интервал анализа в миллисекундах (~2 секунды) */
  private readonly ANALYSIS_INTERVAL_MS = 2000;

  /** ID таймера */
  private timerId: ReturnType<typeof setTimeout> | null = null;

  /** Callback для результатов */
  private callback: KeyCallback | null = null;

  /**
   * Скользящее окно хромаграмм для усреднения.
   * 5 хромаграмм × 2с интервал = ~10s окно сглаживания.
   */
  private readonly CHROMAGRAM_WINDOW_SIZE = 5;
  private chromagramWindow: Float32Array[] = [];

  /**
   * Lock-in состояние (как в BpmAnalyzer).
   * null = Фаза 1 (Collecting), callback не вызывается.
   * non-null = Фаза 2 (Locked), навсегда заблокировано.
   */
  private displayedKey: string | null = null;

  constructor(sampleRate: number) {
    // 1 секунда аудио для анализа
    this.ANALYSIS_WINDOW = sampleRate;
    // Кольцевой буфер ~2 секунды
    this.buffer = new Float32Array(sampleRate * 2);
    this.detector = new KeyDetector(2048, sampleRate);
  }

  /** Установить callback для получения результатов */
  setCallback(cb: KeyCallback): void {
    this.callback = cb;
  }

  /**
   * Добавить аудио-чанк от CaptureProcessor.
   * Может вызываться из port.onmessage — безопасно.
   */
  addChunk(samples: Float32Array): void {
    const bufLen = this.buffer.length;

    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writeOffset] = samples[i];
      this.writeOffset = (this.writeOffset + 1) % bufLen;
    }

    this.totalSamples += samples.length;
  }

  /** Запустить периодический анализ */
  start(): void {
    if (this.timerId !== null) return;
    this.tick();
  }

  /** Остановить периодический анализ */
  stop(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /** Сбросить состояние */
  reset(): void {
    this.buffer.fill(0);
    this.writeOffset = 0;
    this.totalSamples = 0;
    this.displayedKey = null;
    this.chromagramWindow = [];
  }

  /** Принудительный запуск анализа (без ожидания таймера) */
  analyzeNow(): void {
    // Фаза 2 (Locked) — навсегда заблокировано, ни одного обновления
    if (this.displayedKey !== null) return;

    if (this.totalSamples < this.ANALYSIS_WINDOW) return;

    // Извлечь последние ANALYSIS_WINDOW сэмплов из кольцевого буфера
    const windowData = new Float32Array(this.ANALYSIS_WINDOW);
    const bufLen = this.buffer.length;
    const startOffset = (this.writeOffset - this.ANALYSIS_WINDOW + bufLen) % bufLen;

    for (let i = 0; i < this.ANALYSIS_WINDOW; i++) {
      windowData[i] = this.buffer[(startOffset + i) % bufLen];
    }

    // Вычислить хромаграмму
    const chroma = this.detector['chromagram'].compute(windowData);

    // Добавить в скользящее окно
    this.chromagramWindow.push(chroma);
    if (this.chromagramWindow.length > this.CHROMAGRAM_WINDOW_SIZE) {
      this.chromagramWindow.shift();
    }

    // Ждём заполнения окна перед первым определением
    if (this.chromagramWindow.length < this.CHROMAGRAM_WINDOW_SIZE) return;

    // Усреднённая хромаграмма по всему окну
    const meanChroma = new Float32Array(12);
    for (let i = 0; i < 12; i++) {
      let sum = 0;
      for (let j = 0; j < this.chromagramWindow.length; j++) {
        sum += this.chromagramWindow[j][i];
      }
      meanChroma[i] = sum / this.chromagramWindow.length;
    }

    // Корреляция усреднённой хромаграммы с профилями
    let bestKey = '';
    let bestCorr = -Infinity;
    let bestType: 'major' | 'minor' = 'major';

    for (const [key, profile] of Object.entries(MAJOR_PROFILES)) {
      const corr = correlate(meanChroma, profile);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestKey = key;
        bestType = 'major';
      }
    }
    for (const [key, profile] of Object.entries(MINOR_PROFILES)) {
      const corr = correlate(meanChroma, profile);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestKey = key;
        bestType = 'minor';
      }
    }

    if (!bestKey || bestCorr < 0.1) return;

    const camelot = bestType === 'major' ? CAMELOT_MAJOR[bestKey] : CAMELOT_MINOR[bestKey];
    const keyStr = bestType === 'major' ? `${bestKey} (${camelot})` : `${bestKey}m (${camelot})`;
    const confidence = Math.min(bestCorr / 10, 1);

    // Фаза 1 → Фаза 2: lock-in после первого стабильного определения
    this.displayedKey = keyStr;
    this.callback?.({ key: keyStr, confidence });
  }

  /** Освободить ресурсы */
  destroy(): void {
    this.stop();
    this.detector.destroy();
    this.callback = null;
    this.chromagramWindow = [];
    this.displayedKey = null;
  }

  /* ===== Private ===== */

  private tick(): void {
    this.analyzeNow();
    this.timerId = setTimeout(() => this.tick(), this.ANALYSIS_INTERVAL_MS);
  }
}
