/**
 * CaptureProcessor — passthrough AudioWorkletProcessor.
 *
 * Пропускает аудио без изменений (input → output) и отправляет
 * копии аудио-чанков в main thread через port.postMessage().
 *
 * Это отделяет "ветку анализатора" (Aubio.js: BPM + Pitch) от
 * "ветки обработки" (WSOLA pitch-shift, key detection).
 *
 * hopSize = 512 сэмплов (стандарт для aubiojs Tempo + Pitch).
 * TransferList не используется — не все реализации AudioWorklet
 * в Chrome Extension поддерживают передачу владения буфером.
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
      if (output && output[0]) {
        output[0].fill(0);
      }
      return true;
    }

    const inputChannel = input[0];
    const outputChannel = output?.[0];

    // Passthrough: копируем вход в выход без изменений
    if (outputChannel) {
      outputChannel.set(inputChannel);
    }

    // Буферизируем сэмплы для отправки в analyzer
    const samples = inputChannel;
    let written = 0;
    while (written < samples.length) {
      const space = HOP_SIZE - this.offset;
      const chunk = Math.min(space, samples.length - written);

      this.buffer.set(samples.subarray(written, written + chunk), this.offset);
      this.offset += chunk;
      written += chunk;

      if (this.offset >= HOP_SIZE) {
        // Отправляем копию (без TransferList для совместимости)
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
