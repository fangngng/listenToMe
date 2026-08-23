class PCMCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch)
    return true
  }
}
registerProcessor('pcm-capture', PCMCapture)
