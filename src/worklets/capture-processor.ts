/**
 * CaptureProcessor — passthrough AudioWorkletProcessor.
 *
 * Пропускает аудио без изменений (input → output) для ВСЕХ каналов и отправляет
 * копии аудио-чанков (первый канал) в main thread через port.postMessage().
 *
 * hopSize = 512 сэмплов (стандарт для aubiojs Tempo + Pitch).
 */

const HOP_SIZE = 512;

class CaptureProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array;
  private offset: number;

  constructor(_options: AudioWorkletNodeOptions) {
    super();
    this.buffer = new Float32Array(HOP_SIZE);
    this.offset = 0;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0]) {
      // Нет входа — пропускаем пустые выходы
      const numOutCh = output?.length ?? 1;
      for (let ch = 0; ch < numOutCh; ch++) {
        if (output?.[ch]) output[ch].fill(0);
      }
      return true;
    }

    const numCh = Math.max(input.length, output?.length ?? 1);

    // Passthrough: копируем ВСЕ каналы входа в выход без изменений
    for (let ch = 0; ch < numCh; ch++) {
      const inCh = input[Math.min(ch, input.length - 1)];
      const outCh = output?.[Math.min(ch, output?.length - 1)];
      if (inCh && outCh) {
        outCh.set(inCh);
      } else if (outCh) {
        outCh.fill(0);
      }
    }

    // Буферизируем сэмплы первого канала для отправки в analyzer
    const samples = input[0];
    let written = 0;
    while (written < samples.length) {
      const space = HOP_SIZE - this.offset;
      const chunk = Math.min(space, samples.length - written);

      this.buffer.set(samples.subarray(written, written + chunk), this.offset);
      this.offset += chunk;
      written += chunk;

      if (this.offset >= HOP_SIZE) {
        const frame = new Float32Array(this.buffer);

        this.port.postMessage({
          type: 'audio',
          samples: frame,
          sampleRate: sampleRate,
        });

        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
