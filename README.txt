MULTI-INTERVAL TRADING TIMER - CHROME EXTENSION
Release label: NSE Time V2

This is the Chrome-extension equivalent of the supplied GTK Python program.

FEATURES
- 1-minute, 3-minute, 5-minute, 15-minute and 1-hour timers
- Editable market opening time (defaults to 09:15); alert boundaries align to it
- Market selector with NSE, Nikkei, KOSPI, FTSE, DAX, S&P 500, Dow Jones, Nasdaq, Gold, and Bitcoin session presets; changing the preset restarts enabled timers
- Choose a shared alert offset before or after candle close; select 15, 30, or 60 seconds from the dropdown or enter another value
- Expand or collapse the alert timing and alert sound settings as needed
- Enable/disable intervals independently
- Start / Restart All
- Stop All
- Continuous repeating intervals
- Chrome desktop notifications
- Three embedded alert tones (Beep, Double, and Chime), with a Try and Set control
- Timers continue when the popup is closed
- Timer state is persisted in Chrome storage

INSTALL
1. Extract this ZIP.
2. Open Chrome.
3. Go to chrome://extensions
4. Enable "Developer mode".
5. Click "Load unpacked".
6. Select the extracted folder.

IMPORTANT DIFFERENCES FROM THE PYTHON VERSION
- GTK is replaced by an HTML/CSS popup.
- notify-send is replaced by Chrome Notifications.
- speaker-test is replaced by Web Audio API.
- Python threads are replaced by Chrome alarms.
- The popup itself is not responsible for keeping timers alive.

TIMING
Chrome's alarms API is designed for background scheduling, but browser scheduling is
not a hard real-time system. Every enabled interval is calculated from the market
opening time, rather than from when Start is pressed. The countdown shown in the
popup is calculated from that saved opening time, while alert delivery is handled
by Chrome alarms.

ICON
The extension uses icon128.png for its toolbar and notification icon.
