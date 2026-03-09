# PScharts

A Chrome extension that pulls your USPSA match results from PractiScore and displays them as interactive charts — score over time, placement, and per-stage breakdowns — all inside your browser, with no server or API key required.

![Alt text](/screenshots/PScharts.png?raw=true "PScharts Screenshot")
---

## Features

- **Score over time** — match percentage plotted chronologically with USPSA classification bands (GM / M / A / B / C / D)
- **Placement chart** — finish position at each match
- **Per-stage breakdown** — expand any match row to see hits, HF, and percentage for every stage
- **Division-aware** — automatically detects which division you shot in each match and shows division-specific results
- **Match type detection** — identifies USPSA, IDPA, IPSC, Steel Challenge, 3-Gun, PCSL, ICORE matches; non-USPSA matches are shown in history but excluded from charts
- **Filter matches** — checkboxes let you include or exclude individual matches from your charts without deleting them
- **Delete matches** — permanently remove a match from history and cache via the delete button on each row
- **Local caching** — match data is cached in browser storage; individual matches can be refreshed on demand
- **No external server** — everything runs locally in your browser using your existing PractiScore login session

---

## Requirements

- Google Chrome (or any Chromium-based browser that supports Manifest V3 extensions)
- A [PractiScore](https://practiscore.com) account with match history

---

## Installation

Chrome does not allow side-loading extensions from a zip file directly, so you load the extension folder manually. This takes about 30 seconds.

### 1 — Download the extension

**Option A — Download a release (recommended)**

1. Go to the [Releases page](https://github.com/lexxrexx/PScharts/releases)
2. Download the latest `pscharts.zip`
3. Unzip the archive anywhere on your computer

**Option B — Clone the repo**

```bash
git clone https://github.com/lexxrexx/PScharts.git
```

### 2 — Open Chrome Extensions

Navigate to `chrome://extensions` in your browser, or:

- Open Chrome menu → **More tools** → **Extensions**

### 3 — Enable Developer Mode

In the top-right corner of the Extensions page, toggle on **Developer mode**.

### 4 — Load the extension

1. Click **Load unpacked**
2. Navigate to the unzipped folder — if you used Option A (release ZIP), select the top-level unzipped folder; if you used Option B (cloned repo), select the `extension/` subfolder (the one containing `manifest.json`)
3. Click **Select Folder**

The PScharts icon will appear in your Chrome toolbar. Pin it for easy access via the puzzle-piece menu.

---

## Usage

1. **Log in to PractiScore** — visit [practiscore.com](https://practiscore.com) and sign in normally. The extension uses your existing browser session.

2. **Open PScharts** — click the PScharts icon in the toolbar. The dashboard opens in a new tab.

3. **Enter your member number and/or name** — type your USPSA member number (e.g. `A12345`) and/or your name as it appears on result sheets (e.g. `Smith, Jane`). At least one is required; providing both improves match accuracy. A warning banner appears if the member number is missing.

4. **Click Fetch Scores** — the extension navigates to your PractiScore history, opens each match's results page, selects your division, and records your score. Progress is shown in the status bar.

5. **Explore your data** — the summary bar shows matches found, average %, and best %. Toggle between **Ranked** (member number lookup) and **All** (any scored result) views. Click any match row to expand per-stage details.

### Filtering matches

Each match row has a checkbox. Uncheck a match to exclude it from the charts without deleting it. Checkboxes are disabled for non-USPSA matches (IDPA, IPSC, etc.), which are always excluded.

### Refreshing a single match

Each match row has a refresh button (↻). Click it to re-fetch just that match without re-scraping your entire history.

### Deleting a match

Click the delete button (✕) on a match row to permanently remove it from history and cache.

### Clearing all data

Use the **⚠ Clear All Data** button in the header to wipe all cached scores from browser storage and start fresh.

---

## Privacy

- No data ever leaves your browser. All scraping happens locally via Chrome's tab and scripting APIs.
- Your PractiScore credentials are never accessed by the extension — it only uses your existing login session cookies.
- Match data is stored in `chrome.storage.local` on your device only.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "No score data found" | Make sure you are logged in to PractiScore, then click Fetch Scores again |
| Scores show 0% or wrong division | Your name in the Name field must match the result sheet exactly (e.g. `Doe, John`) |
| Extension doesn't appear | Confirm Developer Mode is on and you loaded the `extension/` subfolder, not the repo root |
| Match list is empty | Visit [practiscore.com/associate/step2](https://practiscore.com/associate/step2) while logged in to verify your history is accessible |

---

## Building a release ZIP

A helper script is included to package the extension for distribution:

```bash
./build.sh
```

This creates `dist/pscharts.zip` containing only the extension files, ready to share or submit to the Chrome Web Store.

---

## Project structure

```
extension/          ← Load this folder in Chrome
  manifest.json
  background.js     ← Service worker: scraping logic
  dashboard.html    ← Dashboard UI
  dashboard.js      ← Charts and UI logic
  icons/
    icon16.png
    icon48.png
    icon128.png
build.sh            ← Packages extension/ into dist/pscharts.zip
```
