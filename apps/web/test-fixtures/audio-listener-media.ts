/** Real generated Opus/WebM, shared by H2 and D3 browser regressions.
 * This is synthetic audio, not microphone or public/P2P evidence.
 * Serialized into page.evaluate: keep this function self-contained.
 */
export async function recordAudioFixture() {
  const mimeType = "audio/webm;codecs=opus";
  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();
  gain.gain.value = 0.035;
  oscillator.frequency.value = 440;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  const chunks = await new Promise<number[][]>((resolve, reject) => {
    const recorded: number[][] = [];
    const recorder = new MediaRecorder(destination.stream, {
      mimeType,
      audioBitsPerSecond: 16_000,
    });
    recorder.addEventListener("dataavailable", (event) => {
      void event.data.arrayBuffer().then((buffer) => {
        if (buffer.byteLength > 0 && recorded.length < 20)
          recorded.push([...new Uint8Array(buffer)]);
        if (recorded.length === 20 && recorder.state === "recording")
          recorder.stop();
      });
    });
    recorder.addEventListener("stop", () => resolve(recorded.slice(0, 20)), {
      once: true,
    });
    recorder.addEventListener(
      "error",
      () => reject(new Error("Synthetic H1 audio recorder failed")),
      { once: true },
    );
    recorder.start(3_000);
  });
  oscillator.stop();
  destination.stream.getTracks().forEach((track) => track.stop());
  await audioContext.close();
  return { mimeType, chunks };
}

// H1 packet-to-packet intervals; the initial 80.3063 s without media is omitted.
export const h1ArrivalScheduleMs = [
  0, 4116.1, 7032.1, 9041.5, 13976.1, 16973.7, 19975.1, 21993.9, 24975.8,
  27239.2, 31978.8, 33991.4, 36981.2, 40039.6, 43975.6, 46063.6, 49237.8,
  51979.8, 56018.2, 58993,
];
