let audioContext;
const ALERT_REPETITIONS = 3;
const REPEAT_GAP = 1;

const TONE_PATTERNS = {
  beep: [{ frequency: 880, duration: 0.3, delay: 0, wave: "sine" }],
  double: [
    { frequency: 440, duration: 0.16, delay: 0, wave: "square" },
    { frequency: 440, duration: 0.16, delay: 0.32, wave: "square" }
  ],
  chime: [
    { frequency: 523, duration: 0.25, delay: 0, wave: "triangle" },
    { frequency: 659, duration: 0.25, delay: 0.16, wave: "triangle" },
    { frequency: 784, duration: 0.35, delay: 0.32, wave: "triangle" }
  ]
};

async function playTone(toneName) {
  try {
    audioContext ||= new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    // A freshly resumed context can drop or attenuate its first few samples on
    // some Linux audio stacks. Give the output device time to become active.
    await new Promise(resolve => setTimeout(resolve, 250));

    const notes = TONE_PATTERNS[toneName] || TONE_PATTERNS.beep;
    const startTime = audioContext.currentTime;
    const patternDuration = Math.max(...notes.map(note => note.delay + note.duration));
    const repeatDuration = patternDuration + REPEAT_GAP;

    for (let repeat = 0; repeat < ALERT_REPETITIONS; repeat += 1) {
      for (const note of notes) {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const noteStart = startTime + repeat * repeatDuration + note.delay;

        oscillator.type = note.wave;
        oscillator.frequency.value = note.frequency;
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(0.55, noteStart + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + note.duration);

        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(noteStart);
        oscillator.stop(noteStart + note.duration + 0.01);
      }
    }
  } catch (error) {
    console.error("Could not play alert tone:", error);
  }
}

const toneName = new URLSearchParams(location.search).get("tone");
void playTone(toneName);
