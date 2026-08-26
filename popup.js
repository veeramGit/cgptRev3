const intervals = [1, 3, 5, 15, 60];
const DEFAULT_STATE = {
  running: false,
  intervals: {},
  marketOpenTime: "09:15",
  marketCloseTime: "15:30",
  alertTiming: "before",
  alertOffsetSeconds: 15,
  alertTone: "beep"
};
let alertTimingDirty = false;
let alertToneDirty = false;
let previewAudioContext;
const PREVIEW_TONES = {
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

function getState() {
  return new Promise(resolve => chrome.storage.local.get(["timers"], result => {
    const state = result.timers || DEFAULT_STATE;
    resolve({ ...DEFAULT_STATE, ...state, intervals: state.intervals || {},
      marketOpenTime: validMarketOpenTime(state.marketOpenTime) ? state.marketOpenTime : "09:15",
      marketCloseTime: validMarketCloseTime(state.marketCloseTime, state.marketOpenTime) ? state.marketCloseTime : "15:30",
      alertTiming: state.alertTiming === "after" ? "after" : "before",
      alertOffsetSeconds: validAlertOffset(state.alertOffsetSeconds) ? Number(state.alertOffsetSeconds) : 15,
      alertTone: validAlertTone(state.alertTone) ? state.alertTone : "beep" });
  }));
}
function send(message) { return chrome.runtime.sendMessage(message); }

async function refresh() {
  const state = await getState();
  document.getElementById("actual-time").dateTime = new Date().toISOString();
  document.getElementById("actual-time").textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
  });
  const marketOpenInput = document.getElementById("market-open-time");
  const marketCloseInput = document.getElementById("market-close-time");
  if (document.activeElement !== marketOpenInput) marketOpenInput.value = state.marketOpenTime;
  if (document.activeElement !== marketCloseInput) marketCloseInput.value = state.marketCloseTime;
  if (!alertTimingDirty) {
    document.querySelector(`input[name="alert-timing"][value="${state.alertTiming}"]`).checked = true;
  }
  const offsetInput = document.getElementById("alert-offset-seconds");
  if (!alertTimingDirty && document.activeElement !== offsetInput) {
    offsetInput.value = state.alertOffsetSeconds;
  }
  document.getElementById("save-alert-timing").disabled = !alertTimingDirty;
  if (!alertToneDirty) {
    document.querySelector(`input[name="alert-tone"][value="${state.alertTone}"]`).checked = true;
  }
  document.getElementById("save-alert-tone").disabled = !alertToneDirty;
  for (const minutes of intervals) {
    const item = state.intervals[minutes];
    document.getElementById(`timer-${minutes}`).checked = !!item?.enabled;
    const status = document.getElementById(`status-${minutes}`);
    if (!item?.enabled) {
      status.className = "";
      status.textContent = "Disabled";
    } else if (!state.running) {
      status.className = "";
      status.textContent = "Stopped";
    } else {
      status.className = "timer-status";
      const timerRemaining = getTimerRemaining(state, minutes);
      const timerProgress = Math.max(0, Math.min(100,
        100 - timerRemaining / (minutes * 60 * 1000) * 100));
      const markerPosition = getAlertMarkerPosition(state, minutes);
      status.innerHTML = `<div class="interval-progress"><div class="progress-track">` +
        `<div class="progress-fill" style="width: ${timerProgress}%"></div>` +
        `<span class="alert-marker" style="left: ${markerPosition}%" title="Alert time"></span></div>` +
        `<span>${formatCountdown(timerRemaining)}</span></div>` +
        `<span class="alert-left">${formatAlertRemaining(state, minutes)} for Alert</span>`;
    }
  }
  document.getElementById("stop").disabled = !state.running;
  const timerNote = document.getElementById("timer-note");
  timerNote.textContent = state.startBlockedReason || "Timers continue while this popup is closed.";
  timerNote.classList.toggle("note-error", Boolean(state.startBlockedReason));
}

function getTimerRemaining(state, minutes) {
  const now = Date.now(), openTime = marketOpenTimestamp(state.marketOpenTime);
  const periodMs = minutes * 60 * 1000;
  const candleNumber = Math.max(1, Math.floor((now - openTime) / periodMs) + 1);
  return openTime + candleNumber * periodMs - now;
}

function formatAlertRemaining(state, minutes) {
  const lastAlertAt = state.lastAlerts?.[minutes];
  // Display the actual alarm event as zero before moving to the next target.
  if (lastAlertAt && Date.now() - lastAlertAt >= 0 && Date.now() - lastAlertAt < 1500) {
    return "00:00";
  }
  const now = Date.now(), openTime = marketOpenTimestamp(state.marketOpenTime);
  const periodMs = minutes * 60 * 1000, offsetMs = state.alertOffsetSeconds * 1000;
  const adjustment = state.alertTiming === "before" ? offsetMs : -offsetMs;
  const candleNumber = Math.max(1, Math.floor((now + adjustment - openTime) / periodMs) + 1);
  const target = openTime + candleNumber * periodMs + (state.alertTiming === "after" ? offsetMs : -offsetMs);
  return formatCountdown(target - now);
}

function getAlertMarkerPosition(state, minutes) {
  const offsetPercent = state.alertOffsetSeconds / (minutes * 60) * 100;
  const position = state.alertTiming === "after" ? offsetPercent : 100 - offsetPercent;
  return Math.max(0, Math.min(100, position));
}

function formatCountdown(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function marketOpenTimestamp(value) {
  const [hours, minutes] = (validMarketOpenTime(value) ? value : "09:15").split(":").map(Number);
  const open = new Date(); open.setHours(hours, minutes, 0, 0); return open.getTime();
}
function validMarketOpenTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || ""); }
function validMarketCloseTime(value, marketOpenTime) {
  return validMarketOpenTime(value) && validMarketOpenTime(marketOpenTime) && value > marketOpenTime;
}
function validAlertOffset(value) { return Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 180; }
function validAlertTone(value) { return ["beep", "double", "chime"].includes(value); }

async function playPreviewTone(toneName) {
  try {
    previewAudioContext ||= new AudioContext();
    if (previewAudioContext.state === "suspended") await previewAudioContext.resume();

    const startTime = previewAudioContext.currentTime;
    for (const note of PREVIEW_TONES[toneName] || PREVIEW_TONES.beep) {
      const oscillator = previewAudioContext.createOscillator();
      const gain = previewAudioContext.createGain();
      const noteStart = startTime + note.delay;

      oscillator.type = note.wave;
      oscillator.frequency.value = note.frequency;
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.3, noteStart + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + note.duration);
      oscillator.connect(gain);
      gain.connect(previewAudioContext.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + note.duration + 0.01);
    }
  } catch (error) {
    console.error("Could not play tone preview:", error);
    document.getElementById("alert-tone-confirmation").textContent = "Audio preview unavailable.";
  }
}

document.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener("change", async () => {
  await send({ type: "setEnabled", minutes: Number(input.id.replace("timer-", "")), enabled: input.checked }); refresh();
}));
document.getElementById("start").addEventListener("click", async () => {
  const enabled = Object.fromEntries(intervals.map(minutes => [minutes, document.getElementById(`timer-${minutes}`).checked]));
  await send({ type: "start", enabled, marketOpenTime: document.getElementById("market-open-time").value,
    marketCloseTime: document.getElementById("market-close-time").value,
    alertTiming: document.querySelector('input[name="alert-timing"]:checked').value,
    alertOffsetSeconds: document.getElementById("alert-offset-seconds").value,
    alertTone: document.querySelector('input[name="alert-tone"]:checked').value });
  alertTimingDirty = false;
  alertToneDirty = false;
  refresh();
});
document.querySelectorAll("#market-open-time, #market-close-time").forEach(input => input.addEventListener("change", async () => {
  await send({
    type: "setMarketTimes",
    marketOpenTime: document.getElementById("market-open-time").value,
    marketCloseTime: document.getElementById("market-close-time").value
  });
  refresh();
}));
async function saveAlertTiming() {
  const response = await send({ type: "setAlertTiming", alertTiming: document.querySelector('input[name="alert-timing"]:checked').value,
    alertOffsetSeconds: document.getElementById("alert-offset-seconds").value });
  const savedOffset = response?.timers?.alertOffsetSeconds;
  if (validAlertOffset(savedOffset)) {
    document.getElementById("alert-offset-seconds").value = savedOffset;
  }
  alertTimingDirty = false;
  document.getElementById("save-alert-timing").disabled = true;
  await refresh();
}
function markAlertTimingDirty() {
  alertTimingDirty = true;
  document.getElementById("save-alert-timing").disabled = false;
  document.getElementById("alert-timing-confirmation").textContent = "";
}
document.querySelectorAll('input[name="alert-timing"]').forEach(input => input.addEventListener("change", markAlertTimingDirty));
const alertOffsetInput = document.getElementById("alert-offset-seconds");
alertOffsetInput.addEventListener("input", () => {
  if (Number(alertOffsetInput.value) > 180) alertOffsetInput.value = 180;
  markAlertTimingDirty();
});
document.querySelectorAll(".alert-presets button").forEach(button => button.addEventListener("click", () => {
  alertOffsetInput.value = button.dataset.seconds;
  alertOffsetInput.focus();
  markAlertTimingDirty();
}));
document.getElementById("save-alert-timing").addEventListener("click", async () => {
  await saveAlertTiming();
  document.getElementById("alert-timing-confirmation").textContent = "Done — alert settings applied.";
});
function markAlertToneDirty() {
  alertToneDirty = true;
  document.getElementById("save-alert-tone").disabled = false;
  document.getElementById("alert-tone-confirmation").textContent = "";
}
document.querySelectorAll('input[name="alert-tone"]').forEach(input => input.addEventListener("change", markAlertToneDirty));
document.querySelectorAll(".try-tone").forEach(button => button.addEventListener("click", async () => {
  const selectedTone = document.querySelector('input[name="alert-tone"]:checked').value;
  document.getElementById("alert-tone-confirmation").textContent = `Playing ${selectedTone}…`;
  await playPreviewTone(selectedTone);
}));
document.getElementById("save-alert-tone").addEventListener("click", async () => {
  await send({
    type: "setAlertTone",
    alertTone: document.querySelector('input[name="alert-tone"]:checked').value
  });
  alertToneDirty = false;
  document.getElementById("save-alert-tone").disabled = true;
  document.getElementById("alert-tone-confirmation").textContent = "Sound set.";
  await refresh();
});
document.getElementById("stop").addEventListener("click", async () => { await send({ type: "stop" }); refresh(); });
refresh(); setInterval(refresh, 250);
