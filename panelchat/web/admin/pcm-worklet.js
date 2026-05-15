// AudioWorkletProcessor: downsamples the AudioContext's native rate (typically
// 48000) to 24000 Hz mono PCM16, batches into ~100ms frames, and posts each
// frame to the main thread as a transferable ArrayBuffer.

class PcmWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.targetRate = 24000;
        this.inputRate = sampleRate; // global in AudioWorkletGlobalScope
        this.ratio = this.inputRate / this.targetRate;
        this.frameSamples = this.targetRate / 10; // 2400 samples = 100 ms
        this.buffer = new Int16Array(this.frameSamples);
        this.bufferIdx = 0;
        this.fractional = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        const ch = input[0];
        for (let i = 0; i < ch.length; i++) {
            this.fractional += 1;
            if (this.fractional >= this.ratio) {
                this.fractional -= this.ratio;
                const s = Math.max(-1, Math.min(1, ch[i]));
                this.buffer[this.bufferIdx++] = s < 0 ? s * 0x8000 : s * 0x7fff;
                if (this.bufferIdx >= this.frameSamples) {
                    const out = new Int16Array(this.buffer);
                    this.port.postMessage(out.buffer, [out.buffer]);
                    this.bufferIdx = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('pcm-worklet', PcmWorklet);
