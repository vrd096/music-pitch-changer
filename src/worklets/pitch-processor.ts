/**
 * PitchProcessor — AudioWorkletProcessor with independent speed + pitch control.
 *
 * WSOLA (Waveform Similarity Overlap-Add) time-stretch with:
 * - Cross-correlation grain alignment (из Rubber Band Library)
 * - Hanning window, 50% overlap
 * - Parameter Ramping для плавного изменения параметров
 * - АБСОЛЮТНЫЕ МОНОТОННЫЕ УКАЗАТЕЛИ (без дрейфа дробной части)
 *
 * Ключевые особенности:
 * 1. WSOLA: поиск оптимального смещения зерна через cross-correlation
 *    (tail предыдущего зерна коррелирует с head нового, выбирается offset
 *    с максимальной корреляцией). Это устраняет фазовые разрывы при speed ≠ 1.0.
 * 2. Parameter Ramping (0.05) — плавное сглаживание speed/pitch за ~20-50ms.
 * 3. Непрерывная генерация зёрен: цикл работает, пока есть данные на входе
 *    И место в выходном буфере (независимо от n=128).
 * 4. Абсолютные указатели absInpWr/absInpRd/absOutWr/absOutRd — монотонные,
 *    никогда не сбрасываются. availInp = absInpWr - absInpRd всегда точен.
 * 5. WS=2048, HS=1024, PRIME_SAMPLES=8192.
 * 6. Аддитивный Overlap-Add для всех позиций.
 * 7. Pitch-сдвиг с линейной интерполяцией.
 * 8. Модульная арифметика (x % BL) только для доступа к буферу.
 */

class PitchProcessor extends AudioWorkletProcessor {
  private _targetSpeed = 1.0;
  private _targetPitch = 0;

  private _currentSpeed = 1.0;
  private _currentPitch = 0;

  private _hasParams = false;
  private _wsolaReady = false;

  private readonly WS = 2048;
  private readonly HA = 1024;
  private readonly HS = 1024;
  private readonly BL = 65536;
  private readonly PRIME_SAMPLES = 8192;

  // WSOLA: cross-correlation parameters
  private readonly WSOLA_SEARCH_RANGE = 128;
  private readonly WSOLA_DECIMATION = 4;

  private inpBuf: Float32Array[] = [];
  private outBuf: Float32Array[] = [];

  // АБСОЛЮТНЫЕ УКАЗАТЕЛИ (Монотонные, никогда не сбрасываются)
  // Для доступа к буферу используется модульная арифметика: buf[pos % BL]
  private absInpWr = 0; // Абсолютная позиция записи входа
  private absInpRd = 0.0; // Абсолютная позиция чтения входа (Float для точности)
  private absOutWr = 0; // Абсолютная позиция записи выхода
  private absOutRd = 0; // Абсолютная позиция чтения выхода

  private win: Float32Array;
  private _prevGrainRdPos: number = -1;

  constructor() {
    super();
    this.win = new Float32Array(this.WS);
    for (let i = 0; i < this.WS; i++) {
      this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.WS));
    }

    this.port.onmessage = (evt: MessageEvent) => {
      const d = evt.data;
      if (d?.type === 'params') {
        this._targetSpeed = d.speed ?? 1.0;
        this._targetPitch = d.pitch ?? 0;
        this._hasParams = true;
      }
    };
  }

  private ensureCh(ch: number): void {
    while (this.inpBuf.length <= ch) {
      this.inpBuf.push(new Float32Array(this.BL));
      this.outBuf.push(new Float32Array(this.BL));
    }
  }

  /**
   * WSOLA: поиск оптимального смещения для следующего зерна.
   *
   * Коррелируем tail предыдущего зерна (последние HS семплов)
   * с head нового зерна (первые HS семплов) в диапазоне ±SEARCH_RANGE.
   * Выбираем offset с максимальной корреляцией — это даёт наиболее
   * плавный стык фаз при overlap-add.
   */
  private findBestGrainOffset(candidateStart: number): number {
    const inp = this.inpBuf[0];
    const prevEnd = Math.floor(this._prevGrainRdPos) + this.WS;
    const tailStart = prevEnd - this.HS;
    const dec = this.WSOLA_DECIMATION;
    const corrLen = Math.floor(this.HS / dec);

    let bestOffset = 0;
    let bestCorr = -Infinity;

    for (let offset = -this.WSOLA_SEARCH_RANGE; offset <= this.WSOLA_SEARCH_RANGE; offset++) {
      const newStart = Math.floor(candidateStart) + offset;
      let corr = 0;

      for (let j = 0; j < corrLen; j++) {
        const i = j * dec;
        const a = inp[(tailStart + i) % this.BL];
        const b = inp[(newStart + i) % this.BL];
        corr += a * b;
      }

      if (corr > bestCorr) {
        bestCorr = corr;
        bestOffset = offset;
      }
    }

    return bestOffset;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const inpCh = inputs[0];
    const outCh = outputs[0];
    if (!inpCh || !outCh || !inpCh[0] || !outCh[0]) return true;

    const numCh = Math.min(inpCh.length, outCh.length);
    const n = inpCh[0].length;
    for (let ch = 0; ch < numCh; ch++) this.ensureCh(ch);

    // ── 1. Запись входных данных ──
    for (let ch = 0; ch < numCh; ch++) {
      const buf = this.inpBuf[ch];
      const src = inpCh[ch];
      for (let i = 0; i < n; i++) {
        buf[(this.absInpWr + i) % this.BL] = src[i];
      }
    }
    this.absInpWr += n;

    // ── 2. Ожидание Prime Buffer ──
    if (!this._wsolaReady) {
      if (this.absInpWr >= this.PRIME_SAMPLES) {
        this._wsolaReady = true;
      } else {
        for (let ch = 0; ch < numCh; ch++) outCh[ch].set(inpCh[ch]);
        return true;
      }
    }

    // ── 3. Ramping ──
    this._currentSpeed += (this._targetSpeed - this._currentSpeed) * 0.05;
    this._currentPitch += (this._targetPitch - this._currentPitch) * 0.05;

    const speed = this._hasParams ? this._currentSpeed : 1.0;
    const pitchSemitones = this._hasParams ? this._currentPitch : 0;
    const pitchFactor = Math.pow(2, pitchSemitones / 12);
    const grainHop = this.HA * speed;

    // ── 4. WSOLA: Производство зерен ──
    // ТОЧНЫЙ подсчет доступных данных через абсолютные указатели.
    // Без дрейфа! availInp всегда математически точен.
    let availInp = this.absInpWr - this.absInpRd;
    let availOut = this.BL - (this.absOutWr - this.absOutRd);

    const requiredInput = Math.ceil(this.WS * pitchFactor) + this.WSOLA_SEARCH_RANGE;

    while (availInp >= requiredInput && availOut >= this.HS) {
      // WSOLA: поиск смещения относительно идеальной позиции
      let currentReadPos = this.absInpRd;
      if (this._prevGrainRdPos >= 0) {
        const bestOffset = this.findBestGrainOffset(currentReadPos);
        currentReadPos += bestOffset;
      }

      const rdInt = Math.floor(currentReadPos);

      for (let ch = 0; ch < numCh; ch++) {
        const inp = this.inpBuf[ch];
        const out = this.outBuf[ch];
        const outIdx = this.absOutWr % this.BL;

        for (let i = 0; i < this.WS; i++) {
          const readPos = rdInt + i * pitchFactor;
          const rIdx1 = Math.floor(readPos) % this.BL;
          const rIdx2 = (rIdx1 + 1) % this.BL;

          const sample = inp[rIdx1] * (1 - (readPos % 1)) + inp[rIdx2] * (readPos % 1);

          const oi = (outIdx + i) % this.BL;
          out[oi] += sample * this.win[i];
        }
      }

      // Запоминаем позицию текущего зерна (абсолютную)
      this._prevGrainRdPos = currentReadPos;

      // Сдвигаем абсолютные указатели (без потери дробной части!)
      this.absInpRd += grainHop;
      this.absOutWr += this.HS;

      // Обновляем условия цикла
      availInp = this.absInpWr - this.absInpRd;
      availOut = this.BL - (this.absOutWr - this.absOutRd);
    }

    // ── 5. Чтение из выходного буфера ──
    const outAvail = Math.min(n, this.absOutWr - this.absOutRd);

    for (let ch = 0; ch < numCh; ch++) {
      const buf = this.outBuf[ch];
      const dst = outCh[ch];

      for (let i = 0; i < outAvail; i++) {
        const idx = (this.absOutRd + i) % this.BL;
        dst[i] = buf[idx];
        buf[idx] = 0;
      }

      for (let i = outAvail; i < n; i++) {
        dst[i] = 0;
      }
    }

    this.absOutRd += outAvail;

    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);
