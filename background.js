const INTERVALS = [1, 3, 5, 15, 60];
const DEFAULT_MARKET_OPEN_TIME = "09:15";
const DEFAULT_MARKET_CLOSE_TIME = "15:30";
const DEFAULT_ALERT_TIMING = "before";
const DEFAULT_ALERT_OFFSET_SECONDS = 15;
const DEFAULT_ALERT_TONE = "beep";
let activeTonePlayback;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get("timers");
  if (!current.timers) {
    await chrome.storage.local.set({
      timers: {
        running: false,
        intervals: {},
        marketOpenTime: DEFAULT_MARKET_OPEN_TIME,
        marketCloseTime: DEFAULT_MARKET_CLOSE_TIME,
        startBlockedReason: "",
        alertTiming: DEFAULT_ALERT_TIMING,
        alertOffsetSeconds: DEFAULT_ALERT_OFFSET_SECONDS,
        alertTone: DEFAULT_ALERT_TONE
      }
    });
  }

  // Updating or reloading an unpacked extension does not necessarily clear
  // existing alarms, so rebuild them with the currently saved alert offset.
  const state = await getState();
  if (state.running) await recreateAlarms(state);
});

chrome.runtime.onStartup.addListener(async () => {
  // Restore alarms from persisted timer state after Chrome restarts.
  const state = await getState();
  if (state.running) {
    await recreateAlarms(state);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "setEnabled") {
      const state = await getState();
      state.intervals = state.intervals || {};
      state.intervals[message.minutes] = {
        enabled: message.enabled,
        startTime: message.enabled ? Date.now() : null
      };

      if (!message.enabled) {
        await chrome.alarms.clear(alarmName(message.minutes));
      }

      await chrome.storage.local.set({ timers: state });

      // If the user enables an interval while the master timer is already
      // running, start its repeating alarm immediately.
      if (message.enabled && state.running) {
        await chrome.alarms.clear(alarmName(message.minutes));
        await scheduleAlarm(message.minutes, state);
      }
    }

    if (message.type === "setMarketTimes") {
      const state = await getState();
      state.marketOpenTime = validMarketOpenTime(message.marketOpenTime)
        ? message.marketOpenTime
        : DEFAULT_MARKET_OPEN_TIME;
      state.marketCloseTime = validMarketCloseTime(message.marketCloseTime, state.marketOpenTime)
        ? message.marketCloseTime
        : DEFAULT_MARKET_CLOSE_TIME;
      await chrome.storage.local.set({ timers: state });

      if (state.running) await recreateAlarms(state);
    }

    if (message.type === "setAlertTiming") {
      const state = await getState();
      state.alertTiming = message.alertTiming === "after" ? "after" : DEFAULT_ALERT_TIMING;
      state.alertOffsetSeconds = validAlertOffset(message.alertOffsetSeconds)
        ? Number(message.alertOffsetSeconds) : DEFAULT_ALERT_OFFSET_SECONDS;
      await chrome.storage.local.set({ timers: state });
      if (state.running) await recreateAlarms(state);
    }

    if (message.type === "setAlertTone") {
      const state = await getState();
      state.alertTone = validAlertTone(message.alertTone)
        ? message.alertTone
        : DEFAULT_ALERT_TONE;
      await chrome.storage.local.set({ timers: state });
    }

    if (message.type === "tryTone") {
      await playTone(message.alertTone);
    }

    if (message.type === "start") {
      await startAll(message.enabled, message.marketOpenTime, message.marketCloseTime, message.alertTiming,
        message.alertOffsetSeconds, message.alertTone);
    }

    if (message.type === "stop") {
      await stopAll();
    }

    sendResponse({ ok: true, timers: await getState() });
  })();

  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === "market-close") {
    const state = await getState();
    if (state.running) await stopAll(true, marketEndNote(state));
    return;
  }

  const match = /^timer-(\d+)$/.exec(alarm.name);
  if (!match) return;

  const minutes = Number(match[1]);
  const state = await getState();
  const item = state.intervals?.[minutes];

  if (!state.running || !item?.enabled || isMarketClosed(state)) {
    if (isMarketClosed(state)) await stopAll(true, marketEndNote(state));
    await chrome.alarms.clear(alarm.name);
    return;
  }

  state.lastAlerts = {
    ...(state.lastAlerts || {}),
    [minutes]: Date.now()
  };
  await chrome.storage.local.set({ timers: state });
  await triggerAlert(minutes, state);
  // Schedule from the market-relative target again after every alert. This
  // avoids a delayed Chrome alarm shifting subsequent alert times.
  await scheduleAlarm(minutes, state);
});

async function getState() {
  const result = await chrome.storage.local.get("timers");
  const state = result.timers || {
    running: false,
    intervals: {},
    marketOpenTime: DEFAULT_MARKET_OPEN_TIME,
    marketCloseTime: DEFAULT_MARKET_CLOSE_TIME,
    startBlockedReason: "",
    alertTiming: DEFAULT_ALERT_TIMING,
    alertOffsetSeconds: DEFAULT_ALERT_OFFSET_SECONDS,
    alertTone: DEFAULT_ALERT_TONE,
    lastAlerts: {}
  };
  return {
    ...state,
    intervals: state.intervals || {},
    lastAlerts: state.lastAlerts || {},
    startBlockedReason: typeof state.startBlockedReason === "string" ? state.startBlockedReason : "",
    marketOpenTime: validMarketOpenTime(state.marketOpenTime)
      ? state.marketOpenTime
      : DEFAULT_MARKET_OPEN_TIME,
    marketCloseTime: validMarketCloseTime(state.marketCloseTime, state.marketOpenTime)
      ? state.marketCloseTime
      : DEFAULT_MARKET_CLOSE_TIME,
    alertTiming: state.alertTiming === "after" ? "after" : DEFAULT_ALERT_TIMING,
    alertOffsetSeconds: validAlertOffset(state.alertOffsetSeconds)
      ? Number(state.alertOffsetSeconds) : DEFAULT_ALERT_OFFSET_SECONDS,
    alertTone: validAlertTone(state.alertTone)
      ? state.alertTone : DEFAULT_ALERT_TONE
  };
}

function alarmName(minutes) {
  return `timer-${minutes}`;
}

async function startAll(enabled, marketOpenTime, marketCloseTime, alertTiming, alertOffsetSeconds, alertTone) {
  await stopAll(false);

  const now = Date.now();
  const intervals = {};

  for (const minutes of INTERVALS) {
    intervals[minutes] = {
      enabled: !!enabled[minutes],
      startTime: enabled[minutes] ? now : null
    };
  }

  const state = {
    running: true,
    intervals,
    lastAlerts: {},
    startBlockedReason: "",
    marketOpenTime: validMarketOpenTime(marketOpenTime)
      ? marketOpenTime
      : DEFAULT_MARKET_OPEN_TIME,
    marketCloseTime: validMarketCloseTime(marketCloseTime, marketOpenTime)
      ? marketCloseTime
      : DEFAULT_MARKET_CLOSE_TIME,
    alertTiming: alertTiming === "after" ? "after" : DEFAULT_ALERT_TIMING,
    alertOffsetSeconds: validAlertOffset(alertOffsetSeconds)
      ? Number(alertOffsetSeconds) : DEFAULT_ALERT_OFFSET_SECONDS,
    alertTone: validAlertTone(alertTone) ? alertTone : DEFAULT_ALERT_TONE
  };

  await chrome.storage.local.set({ timers: state });

  if (isMarketClosed(state)) {
    state.running = false;
    state.startBlockedReason = `Timers cannot start after the market end time (${state.marketCloseTime}).`;
    await chrome.storage.local.set({ timers: state });
    return;
  }

  await scheduleMarketCloseAlarm(state);

  for (const minutes of INTERVALS) {
    if (enabled[minutes]) {
      await scheduleAlarm(minutes, state);
    }
  }
}

async function stopAll(saveState = true, statusNote = "") {
  for (const minutes of INTERVALS) {
    await chrome.alarms.clear(alarmName(minutes));
  }
  await chrome.alarms.clear("market-close");

  if (saveState) {
    const state = await getState();
    state.running = false;
    if (statusNote) state.startBlockedReason = statusNote;
    await chrome.storage.local.set({ timers: state });
  }
}

async function recreateAlarms(state) {
  if (isMarketClosed(state)) {
    await stopAll(true, marketEndNote(state));
    return;
  }
  await scheduleMarketCloseAlarm(state);
  for (const minutes of INTERVALS) {
    await chrome.alarms.clear(alarmName(minutes));

    const item = state.intervals?.[minutes];
    if (!item?.enabled) continue;
    await scheduleAlarm(minutes, state);
  }
}

async function scheduleAlarm(minutes, state) {
  const periodMs = minutes * 60 * 1000;
  const now = Date.now();
  const openTime = marketOpenTimestamp(state.marketOpenTime);
  const offsetMs = state.alertOffsetSeconds * 1000;
  const adjustment = state.alertTiming === "before" ? offsetMs : -offsetMs;
  const intervalsElapsed = Math.max(
    1,
    Math.floor((now + adjustment - openTime) / periodMs) + 1
  );
  const nextMs = openTime + intervalsElapsed * periodMs +
    (state.alertTiming === "after" ? offsetMs : -offsetMs) - now;

  if (now + nextMs >= marketCloseTimestamp(state.marketCloseTime)) return;

  await chrome.alarms.create(alarmName(minutes), {
    delayInMinutes: Math.max(nextMs / 60000, 0.5)
  });
}

function marketOpenTimestamp(marketOpenTime) {
  const [hours, minutes] = (validMarketOpenTime(marketOpenTime)
    ? marketOpenTime
    : DEFAULT_MARKET_OPEN_TIME).split(":").map(Number);
  const open = new Date();
  open.setHours(hours, minutes, 0, 0);
  return open.getTime();
}

function marketCloseTimestamp(marketCloseTime) {
  const [hours, minutes] = (validMarketOpenTime(marketCloseTime)
    ? marketCloseTime
    : DEFAULT_MARKET_CLOSE_TIME).split(":").map(Number);
  const close = new Date();
  close.setHours(hours, minutes, 0, 0);
  return close.getTime();
}

function isMarketClosed(state) {
  return Date.now() >= marketCloseTimestamp(state.marketCloseTime);
}

function marketEndNote(state) {
  return `Timers stopped at the market end time (${state.marketCloseTime}).`;
}

async function scheduleMarketCloseAlarm(state) {
  await chrome.alarms.clear("market-close");
  await chrome.alarms.create("market-close", {
    when: marketCloseTimestamp(state.marketCloseTime)
  });
}

function validMarketOpenTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "");
}

function validMarketCloseTime(value, marketOpenTime) {
  return validMarketOpenTime(value) && validMarketOpenTime(marketOpenTime) && value > marketOpenTime;
}

function validAlertOffset(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 180;
}

function validAlertTone(value) {
  return ["beep", "double", "chime"].includes(value);
}

async function triggerAlert(minutes, state) {
  const timeStr = minutes < 60 ? `${minutes} Minute` : "1 Hour";
  const timingText = `${state.alertOffsetSeconds} seconds ${state.alertTiming}`;

  await chrome.notifications.create(`alert-${minutes}-${Date.now()}`, {
    type: "basic",
    iconUrl: "icon128.png",
    title: `⏰ ${timeStr} Candle Alert (${timingText})`,
    message: `${timeStr} candle alert: ${timingText} close.`,
    priority: 2,
    requireInteraction: false
  });

  // Play the selected embedded alert tone.
  try {
    await playTone(state.alertTone);
  } catch (e) {
    console.warn("Audio alert unavailable:", e);
  }
}

function playTone(alertTone) {
  // Multiple intervals often close at the same instant. Reuse the current
  // sequence so they produce one alert sound rather than overlapping repeats.
  if (activeTonePlayback) return activeTonePlayback;

  const tone = validAlertTone(alertTone) ? alertTone : DEFAULT_ALERT_TONE;
  activeTonePlayback = playToneNow(tone).catch(error => {
    console.warn("Audio alert unavailable:", error);
  }).finally(() => {
    activeTonePlayback = undefined;
  });
  return activeTonePlayback;
}

async function playToneNow(tone) {
  const contexts = await chrome.runtime.getContexts({});
  const exists = contexts.some(
    c => c.contextType === "OFFSCREEN_DOCUMENT"
  );

  if (exists) {
    await chrome.offscreen.closeDocument();
  }

  await chrome.offscreen.createDocument({
    url: `offscreen.html?tone=${tone}`,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play a short embedded timer alert tone."
  });

  // Keep all three repetitions separate when multiple intervals alert at once.
  await new Promise(resolve => {
    setTimeout(resolve, 6500);
  });
}
