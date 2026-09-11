const intervals = [1, 3, 5, 15, 60];
const DEFAULT_STATE = {
  running: false,
  intervals: {},
  marketOpenTime: "09:15",
  marketCloseTime: "15:30",
  market: "nse",
  alertTiming: "before",
  alertOffsetSeconds: 15,
  alertTone: "beep"
};
const FREE_INTERVALS = [5, 15];
const SHOW_TEST_ACCESS = false;  // Set to true to enable temporary test access controls in the popup for development/testing.
let alertTimingDirty = false;
let alertToneDirty = false;
let extPayStatusChecked = false;
let subscriptionPlansLoaded = false;
let subscriptionRefreshInProgress = false;
let subscriptionRefreshTimer;
let subscriptionHideTimer;
let proPreviewActive = false;
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
      paidMode: state.paidMode === true,
      marketOpenTime: validMarketOpenTime(state.marketOpenTime) ? state.marketOpenTime : "09:15",
      marketCloseTime: validMarketCloseTime(state.marketCloseTime, state.marketOpenTime) ? state.marketCloseTime : "15:30",
      market: validMarket(state.market)
        ? state.market
        : marketForTimes(state.marketOpenTime, state.marketCloseTime),
      alertTiming: state.alertTiming === "after" ? "after" : "before",
      alertOffsetSeconds: validAlertOffset(state.alertOffsetSeconds) ? Number(state.alertOffsetSeconds) : 15,
      alertTone: validAlertTone(state.alertTone) ? state.alertTone : "beep" });
  }));
}
function send(message) { return chrome.runtime.sendMessage(message); }

function formatPlanPrice(plan) {
  const amountCents = plan.unitAmountCents ?? plan.unit_amount;
  const amount = amountCents != null
    ? Number(amountCents) / 100
    : plan.price ?? plan.amount;
  if (amount == null) return "View plan";
  const currency = String(plan.currency || plan.currency_code || "USD").toUpperCase();
  const interval = plan.interval || plan.billing_interval || plan.billingInterval || "";
  const intervalCount = plan.intervalCount && plan.intervalCount !== 1
    ? `${plan.intervalCount} ` : "";
  const intervalLabel = interval === "once" ? "lifetime" : `${intervalCount}${interval}`;
  return `${currency} ${amount}${intervalLabel ? ` / ${intervalLabel}` : ""}`;
}

function formatPlanName(plan) {
  if (plan.name || plan.display_name || plan.nickname) {
    return plan.name || plan.display_name || plan.nickname;
  }
  if (plan.interval === "once") return "Lifetime";
  if (plan.interval === "year") return "Yearly";
  if (plan.interval === "month") return "Monthly";
  return "Plan";
}

function isActivePlan(plan, activePlan) {
  if (!activePlan) return false;
  const planNickname = String(plan.nickname || plan.plan_nickname || "").trim().toLowerCase();
  const activeNickname = String(activePlan.nickname || activePlan.plan_nickname || "").trim().toLowerCase();
  if (planNickname && activeNickname) return planNickname === activeNickname;

  const planAmount = Number(plan.unitAmountCents ?? plan.unit_amount ?? plan.price * 100);
  const activeAmount = Number(activePlan.unitAmountCents ?? activePlan.unit_amount ?? activePlan.price * 100);
  const planCurrency = String(plan.currency || plan.currency_code || "").toLowerCase();
  const activeCurrency = String(activePlan.currency || activePlan.currency_code || "").toLowerCase();
  const planInterval = String(plan.interval || "").toLowerCase();
  const activeInterval = String(activePlan.interval || "").toLowerCase();
  const planCount = plan.intervalCount == null ? null : Number(plan.intervalCount);
  const activeCount = activePlan.intervalCount == null ? null : Number(activePlan.intervalCount);

  return Number.isFinite(planAmount) && planAmount === activeAmount &&
    planCurrency === activeCurrency && planInterval === activeInterval &&
    planCount === activeCount;
}

function planAmountCents(plan) {
  const amount = plan.unitAmountCents ?? plan.unit_amount ??
    (plan.price == null ? null : Number(plan.price) * 100);
  return amount == null ? Number.POSITIVE_INFINITY : Number(amount);
}

function showPlanPreview(plan) {
  proPreviewActive = true;
  document.querySelectorAll("[data-pro-preview]").forEach(feature => {
    feature.hidden = false;
  });
}

async function refreshSubscription() {
  if (SHOW_TEST_ACCESS) return;
  if (subscriptionRefreshInProgress) return;
  subscriptionRefreshInProgress = true;
  try {
    const response = await send({ type: "getExtPayPlans" });
    renderSubscriptionPlans(response);
    subscriptionPlansLoaded = true;
    extPayStatusChecked = true;
    return response?.timers;
  } finally {
    subscriptionRefreshInProgress = false;
  }
}

function renderSubscriptionPlans(response) {
  const status = document.getElementById("subscription-status");
  const summary = document.getElementById("subscription-summary");
  const plansElement = document.getElementById("subscription-plans");
  if (!response?.ok) {
    status.textContent = "Unavailable";
    summary.textContent = "Unavailable";
    plansElement.textContent = response?.error || "Plans unavailable.";
    return;
  }
  const activePlan = response.user?.plan;
  const activeName = activePlan ? formatPlanName(activePlan) : "Free";
  summary.textContent = activeName;
  status.textContent = response.user?.paid
    ? `Pro active${response.user.subscriptionStatus ? ` (${response.user.subscriptionStatus})` : ""}`
    : "Free plan";
  plansElement.replaceChildren();
  if (!response.plans?.length) {
    plansElement.textContent = "No plans available.";
    return;
  }
  const plans = response.plans.slice().sort((left, right) =>
    planAmountCents(left) - planAmountCents(right)).slice(0, 3);
  const activeAmount = activePlan ? planAmountCents(activePlan) : null;
  for (const plan of plans) {
    const row = document.createElement("div");
    const active = isActivePlan(plan, activePlan);
    const isHigherPlan = activeAmount != null && planAmountCents(plan) > activeAmount;
    row.className = active ? "subscription-plan active-plan" : "subscription-plan";
    const details = document.createElement("span");
    details.textContent = `${formatPlanName(plan)} - ${formatPlanPrice(plan)}${active ? " (Active)" : ""}`;
    row.append(details);
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "plan-preview-button";
    previewButton.textContent = "Preview";
    previewButton.title = "Preview plan features";
    previewButton.setAttribute("aria-label", "Preview plan features");
    previewButton.addEventListener("click", () => showPlanPreview(plan));
    if (!active) row.append(previewButton);
    if (active || !activePlan || isHigherPlan) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = active ? "Cancel" : "Upgrade";
      button.title = active ? "Manage or cancel subscription" : "Upgrade plan";
      button.setAttribute("aria-label", active ? "Manage or cancel subscription" : "Upgrade plan");
      button.addEventListener("click", async () => {
        const result = await send({
          type: "openExtPayPayment",
          planNickname: active ? undefined : plan.nickname || plan.plan_nickname || plan.name
        });
        document.getElementById("timer-note").textContent = result?.message ||
          result?.error || "Checkout opened in a new tab.";
      });
      row.append(button);
    }
    plansElement.append(row);
  }
}

async function refresh() {
  let state = await getState();
  document.querySelector(".test-controls").hidden = !SHOW_TEST_ACCESS;
  document.getElementById("subscription-toggle").hidden = SHOW_TEST_ACCESS;
  if (SHOW_TEST_ACCESS) {
    document.getElementById("subscription-panel").hidden = true;
  }
  if (!SHOW_TEST_ACCESS && !subscriptionPlansLoaded) {
    state = (await refreshSubscription()) || state;
  }
  const isPaid = state.paidMode === true;
  const testPaidMode = state.testPaidMode === true;
  document.getElementById("test-paid-mode").checked = testPaidMode;
  document.querySelectorAll("[data-pro-preview]").forEach(feature => {
    feature.hidden = !isPaid && !proPreviewActive;
  });
  document.getElementById("alert-timing-heading").textContent = isPaid
    ? `Alert Time: ${state.alertOffsetSeconds} Secs ${capitalize(state.alertTiming)}`
    : "Alert Time: 15 Secs Before";
  document.getElementById("alert-sound-heading").textContent = isPaid
    ? `Alert Sound: ${capitalize(state.alertTone)}`
    : "Alert Sound: Beep";
  document.querySelectorAll(".timer-row").forEach(row => {
    const minutes = Number(row.dataset.minutes);
    const freeRestricted = !isPaid && !FREE_INTERVALS.includes(minutes);
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (freeRestricted) checkbox.checked = false;
    checkbox.disabled = freeRestricted;
    row.classList.toggle("feature-locked", freeRestricted);
  });
  const alertControls = document.querySelectorAll(".alert-settings input, .alert-settings button");
  const toneControls = document.querySelectorAll(".audio-settings input, .audio-settings button");
  alertControls.forEach(control => { control.disabled = !isPaid; });
  toneControls.forEach(control => { control.disabled = !isPaid; });
  document.getElementById("actual-time").dateTime = new Date().toISOString();
  document.getElementById("actual-time").textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
  });
  const marketOpenInput = document.getElementById("market-open-time");
  const marketCloseInput = document.getElementById("market-close-time");
  const marketSelect = document.getElementById("market-select");
  if (document.activeElement !== marketOpenInput) marketOpenInput.value = state.marketOpenTime;
  if (document.activeElement !== marketCloseInput) marketCloseInput.value = state.marketCloseTime;
  if (document.activeElement !== marketSelect) marketSelect.value = state.market;
  if (!alertTimingDirty) {
    document.querySelector(`input[name="alert-timing"][value="${state.alertTiming}"]`).checked = true;
  }
  document.getElementById("alert-timing-heading").textContent = isPaid
    ? `Alert Time: ${state.alertOffsetSeconds} Secs ${capitalize(state.alertTiming)}`
    : "Alert Time: 15 Secs Before";
  const offsetInput = document.getElementById("alert-offset-seconds");
  if (!alertTimingDirty && document.activeElement !== offsetInput) {
    offsetInput.value = state.alertOffsetSeconds;
  }
  document.getElementById("save-alert-timing").disabled = !alertTimingDirty;
  if (!alertToneDirty) {
    document.querySelector(`input[name="alert-tone"][value="${state.alertTone}"]`).checked = true;
  }
  document.getElementById("alert-sound-heading").textContent = isPaid
    ? `Alert Sound: ${capitalize(state.alertTone)}`
    : "Alert Sound: Beep";
  document.getElementById("save-alert-tone").disabled = !alertToneDirty;
  for (const minutes of intervals) {
    const item = state.intervals[minutes];
    const freeRestricted = !isPaid && !FREE_INTERVALS.includes(minutes);
    document.getElementById(`timer-${minutes}`).checked = !freeRestricted && !!item?.enabled;
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
  const now = Date.now(), openTime = marketOpenTimestamp(state.marketOpenTime, state.marketCloseTime);
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
  const now = Date.now(), openTime = marketOpenTimestamp(state.marketOpenTime, state.marketCloseTime);
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
function capitalize(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
function marketOpenTimestamp(marketOpenTime, marketCloseTime) {
  const validOpen = validMarketOpenTime(marketOpenTime) ? marketOpenTime : "09:15";
  const validClose = validMarketOpenTime(marketCloseTime) ? marketCloseTime : "15:30";
  
  const [hours, minutes] = validOpen.split(":").map(Number);
  const [closeHours, closeMins] = validClose.split(":").map(Number);
  
  const open = new Date(); open.setHours(hours, minutes, 0, 0);
  const close = new Date(); close.setHours(closeHours, closeMins, 0, 0);
  
  const closeInMinutes = closeHours * 60 + closeMins;
  const openInMinutes = hours * 60 + minutes;
  
  // If close time is before open time (numerically), close is next day
  if (closeInMinutes < openInMinutes) {
    close.setDate(close.getDate() + 1);
  }
  
  // If we're past the market close time, use tomorrow's market open
  if (Date.now() >= close.getTime()) {
    open.setDate(open.getDate() + 1);
  }
  
  return open.getTime();
}
function validMarketOpenTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || ""); }
function validMarketCloseTime(value, marketOpenTime) {
  if (!validMarketOpenTime(value) || !validMarketOpenTime(marketOpenTime)) return false;
  
  const [openHours, openMins] = marketOpenTime.split(":").map(Number);
  const [closeHours, closeMins] = value.split(":").map(Number);
  const openInMinutes = openHours * 60 + openMins;
  const closeInMinutes = closeHours * 60 + closeMins;
  
  // Allow same-day (close > open) or next-day (close < open) closes
  return closeInMinutes !== openInMinutes;
}
function validMarket(value) {
  return ["nse", "nikkei", "kospi", "ftse", "dax", "sp500", "dow", "nasdaq", "gold", "bitcoin", "custom"].includes(value);
}
function marketForTimes(open, close) {
  const presets = {
    "09:15-15:30": "nse", "05:30-12:00": "nikkei", "05:30-12:00": "kospi", "13:30-22:00": "ftse",
    "13:30-23:00": "dax", "20:00-02:30": "sp500", "20:00-02:30": "dow", "20:00-02:30": "nasdaq", "03:30-02:30": "gold",
    "00:00-23:59": "bitcoin"
  };
  return presets[`${open}-${close}`] || "custom";
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

document.querySelectorAll('.timer-row input[type="checkbox"]').forEach(input => input.addEventListener("change", async () => {
  await send({ type: "setEnabled", minutes: Number(input.id.replace("timer-", "")), enabled: input.checked }); refresh();
}));
document.getElementById("test-paid-mode").addEventListener("change", async event => {
  await send({ type: "setTestPaidMode", paidMode: event.target.checked });
  await refresh();
});
document.getElementById("subscription-toggle").addEventListener("click", async () => {
  if (SHOW_TEST_ACCESS) return;
  const panel = document.getElementById("subscription-panel");
  const toggle = document.getElementById("subscription-toggle");
  const arrow = document.getElementById("subscription-arrow");
  const expanded = panel.hidden;
  panel.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  arrow.textContent = expanded ? "⌃" : "⌄";
  if (expanded) {
    await refreshSubscription();
    clearTimeout(subscriptionHideTimer);
    subscriptionHideTimer = setTimeout(() => {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      arrow.textContent = "⌄";
    }, 10000);
  }
});
document.getElementById("subscription-status").addEventListener("click", () => {});
document.getElementById("start").addEventListener("click", async () => {
  const enabled = Object.fromEntries(intervals.map(minutes => [minutes, document.getElementById(`timer-${minutes}`).checked]));
  await send({ type: "start", enabled, marketOpenTime: document.getElementById("market-open-time").value,
    marketCloseTime: document.getElementById("market-close-time").value,
    market: document.getElementById("market-select").value,
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
document.getElementById("market-select").addEventListener("change", async event => {
  const response = await send({ type: "setMarket", market: event.target.value });
  const state = response?.timers;
  if (state && validMarketOpenTime(state.marketOpenTime) &&
    validMarketCloseTime(state.marketCloseTime, state.marketOpenTime)) {
    document.getElementById("market-open-time").value = state.marketOpenTime;
    document.getElementById("market-close-time").value = state.marketCloseTime;
  }
  await refresh();
});
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
  const numericValue = Number(alertOffsetInput.value);
  if (!Number.isFinite(numericValue)) {
    alertOffsetInput.value = 0;
  } else if (numericValue > 180) {
    alertOffsetInput.value = 180;
  } else if (numericValue < 0) {
    alertOffsetInput.value = 0;
  }
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
if (!SHOW_TEST_ACCESS) {
  subscriptionRefreshTimer = setInterval(refreshSubscription, 180000);
}
