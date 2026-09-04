const INTERVALS = [1, 3, 5, 15, 60];
const DEFAULT_MARKET_OPEN_TIME = "09:15";
const DEFAULT_MARKET_CLOSE_TIME = "15:30";
const DEFAULT_ALERT_TIMING = "before";
const DEFAULT_ALERT_OFFSET_SECONDS = 15;
const DEFAULT_ALERT_TONE = "beep";
const DEFAULT_MARKET = "nse";
const FREE_INTERVALS = [5, 15];
const EXTPAY_APP_ID = "multi-interval-trading-timer";
importScripts("ExtPay.js");
const extpay = ExtPay(EXTPAY_APP_ID);
extpay.startBackground();
extpay.onPaid.addListener(async user => {
  const state = await getState();
  state.extPayPaid = Boolean(user?.paidAt);
  state.paidMode = state.testPaidMode === true || state.extPayPaid;
  await chrome.storage.local.set({ timers: state });
  await chrome.notifications.create("extpay-paid", {
    type: "basic",
    iconUrl: "icon128.png",
    title: "Pro mode activated",
    message: "Reopen the extension popup to use all Pro features."
  });
});
const MARKETS = {
  nse: { open: "09:15", close: "15:30" },
  nikkei: { open: "05:30", close: "12:00" },
  kospi: { open: "05:30", close: "12:00" },
  ftse: { open: "13:30", close: "22:00" },
  dax: { open: "13:30", close: "23:00" },
  sp500: { open: "20:00", close: "02:30" },
  dow: { open: "20:00", close: "02:30" },
  nasdaq: { open: "20:00", close: "02:30" },
  gold: { open: "03:30", close: "02:30" },
  bitcoin: { open: "00:00", close: "23:59" }
};
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
        market: DEFAULT_MARKET,
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
      if (!state.paidMode && !FREE_INTERVALS.includes(Number(message.minutes))) {
        sendResponse({ ok: false, error: "This interval requires Paid mode.", timers: state });
        return;
      }
      state.intervals = state.intervals || {};
      state.intervals[message.minutes] = {
        enabled: message.enabled
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
      const marketOpenTime = validMarketOpenTime(message.marketOpenTime)
        ? message.marketOpenTime
        : DEFAULT_MARKET_OPEN_TIME;
      const marketCloseTime = validMarketCloseTime(message.marketCloseTime, marketOpenTime)
        ? message.marketCloseTime
        : DEFAULT_MARKET_CLOSE_TIME;
      const marketChanged = state.marketOpenTime !== marketOpenTime ||
        state.marketCloseTime !== marketCloseTime;
      state.marketOpenTime = marketOpenTime;
      state.marketCloseTime = marketCloseTime;
      state.market = "custom";

      if (state.running && marketChanged) {
        await restartAllTimers(state);
      } else {
        await chrome.storage.local.set({ timers: state });
      }
    }

    if (message.type === "setMarket") {
      const market = validMarket(message.market) ? message.market : DEFAULT_MARKET;
      const state = await getState();
      const preset = MARKETS[market];
      const marketChanged = state.market !== market || (preset &&
        (state.marketOpenTime !== preset.open || state.marketCloseTime !== preset.close));
      state.market = market;
      if (preset) {
        state.marketOpenTime = preset.open;
        state.marketCloseTime = preset.close;
      }

      if (state.running && marketChanged) {
        await restartAllTimers(state);
      } else {
        await chrome.storage.local.set({ timers: state });
      }
    }

    if (message.type === "setAlertTiming") {
      const state = await getState();
      if (!state.paidMode) {
        sendResponse({ ok: false, error: "Alert timing requires Paid mode.", timers: state });
        return;
      }
      const alertTiming = message.alertTiming === "after" ? "after" : DEFAULT_ALERT_TIMING;
      const alertOffsetSeconds = validAlertOffset(message.alertOffsetSeconds)
        ? Number(message.alertOffsetSeconds) : DEFAULT_ALERT_OFFSET_SECONDS;
      const alertTimeChanged = state.alertTiming !== alertTiming ||
        state.alertOffsetSeconds !== alertOffsetSeconds;
      state.alertTiming = alertTiming;
      state.alertOffsetSeconds = alertOffsetSeconds;

      if (state.running && alertTimeChanged) {
        await restartAllTimers(state);
      } else {
        await chrome.storage.local.set({ timers: state });
      }
    }

    if (message.type === "setAlertTone") {
      const state = await getState();
      if (!state.paidMode) {
        sendResponse({ ok: false, error: "Alert sounds require Paid mode.", timers: state });
        return;
      }
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
        message.alertOffsetSeconds, message.alertTone, message.market);
    }

    if (message.type === "stop") {
      await stopAll();
    }

    if (message.type === "setTestPaidMode") {
      const state = await getState();
      state.testPaidMode = message.paidMode === true;
      state.paidMode = state.testPaidMode || state.extPayPaid === true;
      if (!state.paidMode) {
        state.alertTiming = DEFAULT_ALERT_TIMING;
        state.alertOffsetSeconds = DEFAULT_ALERT_OFFSET_SECONDS;
        state.alertTone = DEFAULT_ALERT_TONE;
        for (const minutes of Object.keys(state.intervals || {})) {
          if (!FREE_INTERVALS.includes(Number(minutes))) state.intervals[minutes].enabled = false;
        }
      }
      await chrome.storage.local.set({ timers: state });
      if (state.running) await restartAllTimers(state);
    }

    if (message.type === "getExtPayStatus") {
      try {
        const user = await extpay.getUser();
        const state = await getState();
        state.extPayPaid = Boolean(user?.paidAt);
        state.paidMode = state.testPaidMode === true || state.extPayPaid;
        await chrome.storage.local.set({ timers: state });
        sendResponse({ ok: true, timers: state, extPayConfigured: true });
        return;
      } catch (error) {
        console.warn("ExtensionPay status unavailable:", error);
        sendResponse({ ok: false, timers: await getState(), extPayConfigured: true });
        return;
      }
    }

    if (message.type === "openExtPayPayment") {
      try {
        await extpay.openPaymentPage();
        sendResponse({ ok: true, message: "Checkout opened in a new tab." });
      } catch (error) {
        console.warn("ExtensionPay checkout unavailable:", error);
        sendResponse({ ok: false, error: "ExtensionPay checkout is unavailable." });
      }
      return;
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
    market: DEFAULT_MARKET,
    startBlockedReason: "",
    alertTiming: DEFAULT_ALERT_TIMING,
    alertOffsetSeconds: DEFAULT_ALERT_OFFSET_SECONDS,
    alertTone: DEFAULT_ALERT_TONE,
    lastAlerts: {}
  };
  return {
    ...state,
    paidMode: state.paidMode === true,
    intervals: Object.fromEntries(Object.entries(state.intervals || {}).map(([minutes, item]) => [minutes, {
      ...item,
      enabled: state.paidMode === true || FREE_INTERVALS.includes(Number(minutes)) ? !!item.enabled : false
    }])),
    lastAlerts: state.lastAlerts || {},
    startBlockedReason: typeof state.startBlockedReason === "string" ? state.startBlockedReason : "",
    marketOpenTime: validMarketOpenTime(state.marketOpenTime)
      ? state.marketOpenTime
      : DEFAULT_MARKET_OPEN_TIME,
    marketCloseTime: validMarketCloseTime(state.marketCloseTime, state.marketOpenTime)
      ? state.marketCloseTime
      : DEFAULT_MARKET_CLOSE_TIME,
    market: validMarket(state.market)
      ? state.market
      : marketForTimes(state.marketOpenTime, state.marketCloseTime),
    alertTiming: state.paidMode === true && state.alertTiming === "after" ? "after" : DEFAULT_ALERT_TIMING,
    alertOffsetSeconds: state.paidMode === true && validAlertOffset(state.alertOffsetSeconds)
      ? Number(state.alertOffsetSeconds) : DEFAULT_ALERT_OFFSET_SECONDS,
    alertTone: state.paidMode === true && validAlertTone(state.alertTone)
      ? state.alertTone : DEFAULT_ALERT_TONE
  };
}

function alarmName(minutes) {
  return `timer-${minutes}`;
}

async function startAll(enabled, marketOpenTime, marketCloseTime, alertTiming, alertOffsetSeconds, alertTone, market) {
  await stopAll(false);

  const savedState = await getState();
  const paidMode = savedState.paidMode === true;
  const intervals = {};

  for (const minutes of INTERVALS) {
    intervals[minutes] = {
      enabled: paidMode ? !!enabled[minutes] : FREE_INTERVALS.includes(minutes) && !!enabled[minutes]
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
    market: validMarket(market) ? market : DEFAULT_MARKET,
    alertTiming: paidMode && alertTiming === "after" ? "after" : DEFAULT_ALERT_TIMING,
    alertOffsetSeconds: paidMode && validAlertOffset(alertOffsetSeconds)
      ? Number(alertOffsetSeconds) : DEFAULT_ALERT_OFFSET_SECONDS,
    alertTone: paidMode && validAlertTone(alertTone) ? alertTone : DEFAULT_ALERT_TONE,
    paidMode
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

async function restartAllTimers(state) {
  await stopAll(false);

  for (const minutes of INTERVALS) {
    const item = state.intervals?.[minutes];
    // Keep existing enabled state, just restart alarms based on market time
  }
  state.lastAlerts = {};
  state.startBlockedReason = "";
  await chrome.storage.local.set({ timers: state });

  if (isMarketClosed(state)) {
    state.running = false;
    state.startBlockedReason = marketEndNote(state);
    await chrome.storage.local.set({ timers: state });
    return;
  }

  await scheduleMarketCloseAlarm(state);
  for (const minutes of INTERVALS) {
    if (state.intervals?.[minutes]?.enabled) {
      await scheduleAlarm(minutes, state);
    }
  }
}

async function scheduleAlarm(minutes, state) {
  const periodMs = minutes * 60 * 1000;
  const now = Date.now();
  const openTime = marketOpenTimestamp(state.marketOpenTime, state.marketCloseTime);
  const offsetMs = state.alertOffsetSeconds * 1000;
  const adjustment = state.alertTiming === "before" ? offsetMs : -offsetMs;
  const intervalsElapsed = Math.max(
    1,
    Math.floor((now + adjustment - openTime) / periodMs) + 1
  );
  const nextMs = openTime + intervalsElapsed * periodMs +
    (state.alertTiming === "after" ? offsetMs : -offsetMs) - now;

  if (now + nextMs >= marketCloseTimestamp(state.marketCloseTime, state.marketOpenTime)) return;

  await chrome.alarms.create(alarmName(minutes), {
    delayInMinutes: Math.max(nextMs / 60000, 0.5)
  });
}

function marketOpenTimestamp(marketOpenTime, marketCloseTime) {
  const openValid = validMarketOpenTime(marketOpenTime) ? marketOpenTime : DEFAULT_MARKET_OPEN_TIME;
  const closeValid = validMarketOpenTime(marketCloseTime) ? marketCloseTime : DEFAULT_MARKET_CLOSE_TIME;
  
  const [hours, minutes] = openValid.split(":").map(Number);
  const [closeHours, closeMins] = closeValid.split(":").map(Number);
  
  const open = new Date();
  open.setHours(hours, minutes, 0, 0);
  
  const close = new Date();
  close.setHours(closeHours, closeMins, 0, 0);
  
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

function marketCloseTimestamp(marketCloseTime, marketOpenTime) {
  const closeValid = validMarketOpenTime(marketCloseTime) ? marketCloseTime : DEFAULT_MARKET_CLOSE_TIME;
  const openValid = validMarketOpenTime(marketOpenTime) ? marketOpenTime : DEFAULT_MARKET_OPEN_TIME;
  
  const [closeHours, closeMins] = closeValid.split(":").map(Number);
  const [openHours, openMins] = openValid.split(":").map(Number);
  
  const close = new Date();
  close.setHours(closeHours, closeMins, 0, 0);
  
  const closeInMinutes = closeHours * 60 + closeMins;
  const openInMinutes = openHours * 60 + openMins;
  
  // If close time is before open time (numerically), it's a next-day close
  if (closeInMinutes < openInMinutes) {
    close.setDate(close.getDate() + 1);
  }
  
  return close.getTime();
}

function isMarketClosed(state) {
  return Date.now() >= marketCloseTimestamp(state.marketCloseTime, state.marketOpenTime);
}

function marketEndNote(state) {
  return `Timers stopped at the market end time (${state.marketCloseTime}).`;
}

async function scheduleMarketCloseAlarm(state) {
  await chrome.alarms.clear("market-close");
  await chrome.alarms.create("market-close", {
    when: marketCloseTimestamp(state.marketCloseTime, state.marketOpenTime)
  });
}

function validMarketOpenTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "");
}

function validMarketCloseTime(value, marketOpenTime) {
  if (!validMarketOpenTime(value) || !validMarketOpenTime(marketOpenTime)) return false;
  
  const [openHours, openMins] = marketOpenTime.split(":").map(Number);
  const [closeHours, closeMins] = value.split(":").map(Number);
  const openInMinutes = openHours * 60 + openMins;
  const closeInMinutes = closeHours * 60 + closeMins;
  
  // Allow same-day (close > open) or next-day (close < open) closes
  return closeInMinutes !== openInMinutes;
}

function validAlertOffset(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 180;
}

function validMarket(value) {
  return value === "custom" || Object.prototype.hasOwnProperty.call(MARKETS, value);
}

function marketForTimes(open, close) {
  return Object.entries(MARKETS).find(([, preset]) => preset.open === open && preset.close === close)?.[0] || "custom";
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
