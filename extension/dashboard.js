// dashboard.js

// ── Size canvases to fill their containers ────────────────────────────────────
function sizeCanvases() {
  document.querySelectorAll('canvas').forEach(c => {
    const w = c.parentElement?.offsetWidth || 860;
    if (c.width !== w) c.width = w;
  });
}
window.addEventListener('resize', () => { sizeCanvases(); renderAll(); });
document.addEventListener('DOMContentLoaded', sizeCanvases);

// ── DOM refs ──────────────────────────────────────────────────────────────────
const memberInput  = document.getElementById('memberInput');
const nameInput    = document.getElementById('nameInput');
const fetchBtn     = document.getElementById('fetchBtn');
const editBtn      = document.getElementById('editBtn');
const saveBtn      = document.getElementById('saveBtn');
const cancelBtn    = document.getElementById('cancelBtn');
const statusEl     = document.getElementById('status');
const summaryBar   = document.getElementById('summaryBar');
const noDataEl     = document.getElementById('noData');
const chartsEl     = document.getElementById('charts');
const debugLogEl   = document.getElementById('debugLog');
const matchHistory = document.getElementById('matchHistory');
const matchRowsEl  = document.getElementById('matchRows');
const tooltipEl    = document.getElementById('tooltip');

// ── Update check ─────────────────────────────────────────────────────────────
const RELEASES_API      = 'https://api.github.com/repos/johnwaldo/PScharts/releases/latest';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // re-check at most every 4 hours

function parseVersion(v) {
  return (v || '').replace(/^v/, '').split('.').map(Number);
}

function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Escape HTML special characters to prevent XSS when inserting untrusted text into innerHTML
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function checkForUpdate() {
  // Don't show banner if user dismissed this version already
  const { updateCheck, updateDismissed } = await chrome.storage.local.get(['updateCheck', 'updateDismissed']);
  const now = Date.now();

  // Use cached result if fresh enough
  if (updateCheck && (now - updateCheck.checkedAt) < CHECK_INTERVAL_MS) {
    if (updateCheck.latestVersion && updateCheck.zipUrl &&
        updateDismissed !== updateCheck.latestVersion) {
      showUpdateBanner(updateCheck.latestVersion, updateCheck.zipUrl, updateCheck.releasePageUrl, updateCheck.releaseNotes || '');
    }
    return;
  }

  try {
    const res = await fetch(RELEASES_API);
    if (!res.ok) return;
    const data = await res.json();
    const latestVersion = (data.tag_name || '').replace(/^v/, '');

    // Sanitize release page URL — must be github.com
    const rawPageUrl   = data.html_url || '';
    const releasePageUrl = /^https:\/\/github\.com\//.test(rawPageUrl)
      ? rawPageUrl
      : 'https://github.com/johnwaldo/PScharts/releases/latest';

    // Find the ZIP asset — prefer pscharts-*.zip, fall back to any .zip
    const assets  = Array.isArray(data.assets) ? data.assets : [];
    const zipAsset = assets.find(a => /pscharts.*\.zip$/i.test(a.name))
                  || assets.find(a => /\.zip$/i.test(a.name));
    // Sanitize asset download URL — must be github.com or objects.githubusercontent.com
    const rawZip  = zipAsset?.browser_download_url || '';
    const zipUrl  = /^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(rawZip)
      ? rawZip
      : releasePageUrl; // fall back to release page if no ZIP attached

    const releaseNotes = (data.body || '').trim();

    await chrome.storage.local.set({
      updateCheck: { latestVersion, zipUrl, releasePageUrl, releaseNotes, checkedAt: now },
    });

    if (updateDismissed !== latestVersion) {
      showUpdateBanner(latestVersion, zipUrl, releasePageUrl, releaseNotes);
    }
  } catch (_) {}
}

function showUpdateBanner(latestVersion, zipUrl, releasePageUrl, releaseNotes) {
  const currentVersion = chrome.runtime.getManifest().version;
  if (!isNewer(latestVersion, currentVersion)) return;

  // Wire up version badge
  document.getElementById('updateVersionBadge').textContent = `v${escHtml(latestVersion)}`;

  // Wire up download button — points to ZIP if available, release page otherwise
  const dlBtn = document.getElementById('updateDownloadBtn');
  dlBtn.href = escHtml(zipUrl);

  // If the URL is the release page (no ZIP asset), update button label
  if (zipUrl === releasePageUrl) {
    dlBtn.textContent = '↗ View release';
  }

  // Release notes toggle
  const notesWrap = document.getElementById('updateNotesWrap');
  const notesEl   = document.getElementById('updateBannerNotes');
  const toggleBtn = document.getElementById('updateNotesToggle');
  if (releaseNotes) {
    notesWrap.style.display = '';
    notesEl.textContent = releaseNotes;
    toggleBtn.addEventListener('click', () => {
      const open = notesEl.classList.toggle('open');
      toggleBtn.textContent = open ? "What's new ▴" : "What's new ▾";
    });
  }

  // Dismiss button — stores the version so banner stays gone until next release
  document.getElementById('updateDismissBtn').addEventListener('click', () => {
    chrome.storage.local.set({ updateDismissed: latestVersion });
    document.getElementById('updateBanner').classList.remove('visible');
  });

  document.getElementById('updateBanner').classList.add('visible');
}

checkForUpdate();

// ── Module state ──────────────────────────────────────────────────────────────
let allResults       = [];
let currentView      = 'ranked'; // 'ranked' | 'all'
let deselectedMatches = new Set(); // match IDs manually excluded from charts
let selectedDiv      = null;     // division filter for stats + charts (null = All)
let selectedYear     = null;     // year filter for charts (null = All Time)
let classificationData = null;  // data from uspsa.org/classification/[memberNumber]
let classifiersOnly  = false;   // when true, charts show only classifier stage scores

const NON_USPSA_TYPES = new Set(['IDPA', 'IPSC', 'Steel Challenge', '3-Gun', 'PCSL', 'ICORE', 'SCSA']);
function isLikelyUSPSA(matchType) { return !NON_USPSA_TYPES.has(matchType); }

function isChartable(r) {
  return isLikelyUSPSA(r.match_type || 'Unknown');
}

// ── USPSA Classifier lookup ───────────────────────────────────────────────────
// Maps classifier number (e.g. "99-11") → official name.
// isClassifierStage() checks this table first, then falls back to regex for
// any number matching the XX-YY pattern (covers new/unlisted classifiers).
const USPSA_CLASSIFIERS = new Map([
  // 99-series
  ['99-01', 'Back to Basics Standards'],
  ['99-02', 'Night Moves'],
  ['99-03', 'Celeritas and Diligentia'],
  ['99-04', 'American Standard'],
  ['99-05', 'Mob Job'],
  ['99-06', 'Toe The Line'],
  ['99-07', 'Both Sides Now #1'],
  ['99-08', 'Melody Line'],
  ['99-09', 'Long Range Standards'],
  ['99-10', 'Times Two'],
  ['99-11', 'El Presidente'],
  ['99-12', 'Take Your Choice'],
  ['99-13', 'Quicky II'],
  ['99-14', 'Hoser Heaven'],
  ['99-15', 'Diligentia and Celeritas'],
  ['99-16', 'Both Sides Now #2'],
  ['99-17', "It's All in the Upper Zone"],
  ['99-18', 'You Snooze, You Lose'],
  ['99-19', "Payne's Pain"],
  ['99-20', 'Fish House Encounter'],
  ['99-21', 'Mini Mart'],
  ['99-22', 'Nueve El Presidente'],
  ['99-23', 'Front Sight'],
  ['99-24', 'Front Sight 2'],
  ['99-27', "Lefty's Revenge"],
  ['99-28', 'Hillbillton Drill'],
  ['99-29', 'Near to Far Standards'],
  ['99-30', 'Man Down'],
  // 03-series
  ['03-02', 'Six Chickens'],
  ['03-03', 'Take Em Down'],
  ['03-04', '3-V'],
  ['03-05', 'Paper Poppers'],
  ['03-07', 'Riverdale Standards'],
  ['03-08', 'Madness'],
  ['03-09', 'On the Move'],
  ['03-10', 'Area 5 Standards'],
  ['03-11', 'El Strong & Weak Pres'],
  ['03-12', 'Ironsides'],
  ['03-14', 'Baseball Standards'],
  ['03-18', 'High Standards'],
  // 06-series
  ['06-01', 'Big Barricade'],
  // 08-series
  ['08-01', '4 Bill Drill'],
  // 09-series
  ['09-01', 'Six in Six Challenge'],
  ['09-02', 'Diamond Cutter'],
  ['09-03', 'Oh No'],
  ['09-04', 'Pucker Factor'],
  ['09-05', 'Quad Standards'],
  ['09-06', 'Quad Standards 2'],
  ['09-07', "It's Not Brain Surgery"],
  ['09-08', 'Crackerjack'],
  ['09-09', 'Lightning and Thunder'],
  ['09-10', "Life's Little Problems"],
  // 13-series
  ['13-01', 'Disaster Factor'],
  ['13-02', 'Down the Middle'],
  ['13-03', 'Short Sprint Standards'],
  ['13-04', 'The Roscoe Rattle'],
  ['13-05', 'Tick Tock'],
  ['13-06', 'Too Close for Comfort'],
  ['13-07', 'Double Deal 2'],
  ['13-08', 'More Disaster Factor'],
  ['13-09', 'Window Pain'],
  // 18-series
  ['18-01', 'Of Course It Did'],
  ['18-02', 'What Is With You People'],
  ['18-03', 'We Play Games'],
  ['18-04', "Didn't You Send the Mailman"],
  ['18-05', 'No Need to Believe in Either Side'],
  ['18-06', 'For That Day'],
  ['18-07', 'Someone Is Always Willing to Pay'],
  ['18-08', 'The Condor'],
  ['18-09', 'I Miss That Kind of Clarity'],
  // 19-series
  ['19-01', 'HI-Jinx'],
  ['19-02', 'HI-Way Robbery'],
  ['19-03', "HI'er Love"],
  ['19-04', 'HI Cost of Living'],
  // 20-series
  ['20-01', 'Wish You Were Here'],
  ['20-02', 'Deja Vu'],
  ['20-03', 'Deja Vu All Over Again'],
  // 21-series
  ['21-01', '8 x 3 Trigger Freeze'],
  // 22-series
  ['22-01', 'Righty Tighty'],
  ['22-02', 'Lefty Loosey'],
  // 23-series
  ['23-01', 'THS Short Course'],
  ['23-02', 'This Could Be the Greatest Night of Our Lives'],
  // 24-series
  ['24-01', 'Can You Strong and Weak Hand?'],
  ['24-02', 'This Is More Better Now'],
  ['24-03', 'One Box at a Time'],
  ['24-04', 'The Thrill of the Bill Drill'],
  ['24-05', 'Little Bit of Everything'],
  ['24-06', "Surely You Can't Be Serious"],
  ['24-07', 'The Near to Far Drill'],
  ['24-08', 'And Now for Something Completely Different'],
  // 25-series
  ['25-01', 'Return to Monke'],
  ['25-02', 'Look at Me I Am the Captain Now'],
  ['25-03', 'Let Him Cook'],
  ['25-04', 'We Did Our Homework'],
  ['25-05', "It's All Part of the Plan"],
  ['25-06', 'They All Count'],
  ['25-07', 'Absolute Cinema'],
  ['25-08', 'We Lost Hero or Zero'],
  ['25-09', 'Descent Into Madness'],
]);

// Returns { number, name } if the stage is a known classifier, or null if not.
// Checks stored match_def fields first (authoritative), then falls back to name pattern matching.
function isClassifierStage(stage) {
  // Accept either a stage object or a bare name string (backwards compat)
  const stageName = typeof stage === 'string' ? stage : (stage?.name ?? '');

  // 1. Authoritative: match_def.json told us explicitly
  if (typeof stage === 'object' && stage !== null) {
    if (stage.is_classifier === true || stage.classifier_code) {
      const code = stage.classifier_code || null;
      const name = code ? (USPSA_CLASSIFIERS.get(code) ?? null) : null;
      return { number: code, name };
    }
    if (stage.is_classifier === false) return null;  // explicitly not a classifier
  }

  // 2. Fallback: extract XX-YY pattern from stage name
  const m = stageName.match(/\b(\d{2}-\d{2})\b/);
  if (!m) return null;
  const num  = m[1];
  const name = USPSA_CLASSIFIERS.get(num) ?? null;
  if (name != null) return { number: num, name };
  if (/\bCM\b/i.test(stageName)) return { number: num, name: null };
  return null;
}

// Normalize USPSA date "M/D/YY" or "MM/DD/YYYY" → "YYYY-MM" for comparison
function normalizeUSPSADate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${year}-${m[1].padStart(2, '0')}`;
}

// Cross-reference allResults stages against USPSA.org classifier records.
// Annotates stages with is_classifier / classifier_code when a match is found by
// HF value (exact to 3 decimal places) + month of match date.
function crossReferenceClassifiers(results, clfData) {
  if (!clfData?.classifiers?.length) return results;
  return results.map(r => {
    if (!r.stages?.length) return r;
    const stages = r.stages.map(s => {
      if (s.is_classifier) return s; // already identified by match_def.json
      const clf = clfData.classifiers.find(c => {
        if (!c.hf || !s.hf) return false;
        const cDate = normalizeUSPSADate(c.date);
        const rDate = r.date ? r.date.slice(0, 7) : null;
        if (!cDate || !rDate || cDate !== rDate) return false;
        return Math.abs(c.hf - s.hf) < 0.001;
      });
      if (!clf) return s;
      return { ...s, is_classifier: true, classifier_code: clf.code || null,
               clf_pct: clf.pct || null }; // official USPSA % (vs national reference HF)
    });
    return { ...r, stages };
  });
}

function saveDeselected() {
  chrome.storage.local.set({ deselectedMatches: [...deselectedMatches] });
}

// ── Input lock / edit ─────────────────────────────────────────────────────────
let _editSnapshot = { member: '', name: '' }; // values before edit started

function lockInputs() {
  memberInput.disabled = true;
  nameInput.disabled   = true;
  editBtn.style.display   = 'inline-block';
  saveBtn.style.display   = 'none';
  cancelBtn.style.display = 'none';
  fetchBtn.style.display  = 'inline-block';
}

function unlockInputs() {
  _editSnapshot = { member: memberInput.value, name: nameInput.value };
  memberInput.disabled = false;
  nameInput.disabled   = false;
  memberInput.focus();
  editBtn.style.display   = 'none';
  saveBtn.style.display   = 'inline-block';
  cancelBtn.style.display = 'inline-block';
  fetchBtn.style.display  = 'none';
}

editBtn.addEventListener('click', unlockInputs);


cancelBtn.addEventListener('click', () => {
  memberInput.value = _editSnapshot.member;
  nameInput.value   = _editSnapshot.name;
  lockInputs();
});

saveBtn.addEventListener('click', async () => {
  const newMember = memberInput.value.trim().toUpperCase();
  const newName   = nameInput.value.trim();

  const changed = newMember !== _editSnapshot.member.toUpperCase() ||
                  newName   !== _editSnapshot.name;

  if (changed) {
    const ok = confirm(
      'Changing your member number or name will clear all cached match data and re-fetch everything.\n\nContinue?'
    );
    if (!ok) {
      memberInput.value = _editSnapshot.member;
      nameInput.value   = _editSnapshot.name;
      lockInputs();
      return;
    }
    // Clear cache and reset UI
    await chrome.storage.local.remove(['matchCache', 'lastMatchList']);
    allResults = [];
    summaryBar.classList.remove('visible');
    chartsEl.classList.remove('visible');
    matchHistory.classList.remove('visible');
    noDataEl.style.display   = 'none';
    debugLogEl.style.display = 'none';
    setStatus('Cache cleared. Click Fetch Scores to reload.', '');
  }

  memberInput.value = newMember;
  chrome.storage.local.set({ memberNumber: newMember, name: newName });
  lockInputs();
});

// ── Restore persisted state on load ──────────────────────────────────────────
chrome.storage.local.get(['memberNumber', 'name', 'lastMatchList', 'matchCache', 'deselectedMatches', 'classificationData'], d => {
  if (d.memberNumber) memberInput.value = d.memberNumber;
  if (d.name)         nameInput.value   = d.name;
  if (d.deselectedMatches) deselectedMatches = new Set(d.deselectedMatches);

  // Lock inputs if we already have saved credentials
  if (d.memberNumber || d.name) {
    lockInputs();
  }

  if (d.lastMatchList) {
    const cache = d.matchCache || {};
    const restored = d.lastMatchList.map(m => ({
      ...m,
      ...(cache[m.match_id] || {}),
      _cached: true,
    }));
    if (restored.length > 0) {
      classificationData = d.classificationData || null;
      allResults = crossReferenceClassifiers(restored, classificationData);
      if (!d.memberNumber) switchView('all');
      renderAll();
      renderMatchList();
      const scored = restored.filter(r => r.overall_pct != null).length;
      const uspsa  = restored.filter(r => isLikelyUSPSA(r.match_type || 'Unknown')).length;
      setStatus(`Showing cached data — ${scored}/${uspsa} USPSA matches scored. Click Fetch Scores to check for new matches.`, 'success');
    }
  }
});

// ── View toggle ───────────────────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const toggleWrap = document.getElementById('classifiersToggleWrap');
  if (view !== 'ranked') {
    classifiersOnly = false;
    document.getElementById('classifiersOnlyChk').checked = false;
    toggleWrap.classList.remove('active');
    toggleWrap.style.display = 'none';
  } else {
    toggleWrap.style.display = 'flex';
  }
}

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view);
    renderAll();
  });
});

document.getElementById('classifiersOnlyChk').addEventListener('change', e => {
  classifiersOnly = e.target.checked;
  document.getElementById('classifiersToggleWrap').classList.toggle('active', classifiersOnly);
  renderAll();
});

// ── Fetch button ──────────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', async () => {
  const memberNumber = memberInput.value.trim().toUpperCase();
  const name         = nameInput.value.trim();
  if (!memberNumber && !name) { setStatus('Please enter your USPSA member number and/or your name.', 'error'); return; }

  const noMemberWarningEl = document.getElementById('noMemberWarning');
  if (!memberNumber) {
    noMemberWarningEl.style.display = 'block';
  } else {
    noMemberWarningEl.style.display = 'none';
  }

  // Guard: if credentials differ from what's cached, require going through Save
  const stored = await chrome.storage.local.get(['memberNumber', 'name', 'matchCache', 'lastMatchList']);
  const hasCachedData = stored.matchCache && Object.keys(stored.matchCache).length > 0;
  const credentialsChanged = hasCachedData && (
    memberNumber !== (stored.memberNumber || '').toUpperCase() ||
    name         !== (stored.name || '')
  );
  if (credentialsChanged) {
    const ok = confirm(
      'Your member number or name has changed. This will clear all cached match data and re-fetch everything.\n\nContinue?'
    );
    if (!ok) return;
    await chrome.storage.local.remove(['matchCache', 'lastMatchList']);
    allResults = [];
    summaryBar.classList.remove('visible');
    chartsEl.classList.remove('visible');
    matchHistory.classList.remove('visible');
  }

  chrome.storage.local.set({ memberNumber, name });
  lockInputs();
  setStatus('Opening PractiScore tab…', '', true);
  fetchBtn.disabled = true;
  noDataEl.style.display   = 'none';
  debugLogEl.style.display = 'none';
  allResults = [];

  try {
    const response = await chrome.runtime.sendMessage({ action: 'fetchScores', memberNumber, name });
    if (!response.ok) throw new Error(response.error || 'Unknown error');
    if (response.data._not_logged_in_ps) {
      document.getElementById('psLoginWarning').style.display = 'block';
      setStatus('Not logged into PractiScore. Please log in and try again.', 'error');
      return;
    }
    document.getElementById('psLoginWarning').style.display = 'none';

    const { results, log } = response.data;

    if (log?.length) {
      debugLogEl.textContent = log.join('\n');
      debugLogEl.style.display = 'block';
    }

    if (!results?.length) {
      noDataEl.style.display = 'block';
      setStatus('No matches found.', 'error');
      return;
    }

    if (response.data.classificationData) {
      classificationData = response.data.classificationData;
    }
    allResults = crossReferenceClassifiers(results, classificationData);

    // Handle login warnings
    const uspsaLoginWarn = document.getElementById('uspsaLoginWarning');
    if (response.data._not_logged_in_uspsa) {
      uspsaLoginWarn.style.display = 'block';
    } else {
      uspsaLoginWarn.style.display = 'none';
    }

    // No member number → name-only results won't appear in "Scored Matches" view; switch automatically
    if (!memberNumber) switchView('all');

    renderAll();
    renderMatchList();
    updateStatusCounts('Loaded');

  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    debugLogEl.textContent = err.stack || err.message;
    debugLogEl.style.display = 'block';
  } finally {
    fetchBtn.disabled = false;
  }
});

// ── Year filter pills ─────────────────────────────────────────────────────────
function renderYearFilter(years) {
  const el = document.getElementById('timeFilter');
  el.innerHTML = '';
  if (years.length === 0) { el.style.display = 'none'; return; }
  el.style.display = 'flex';

  const pill = document.createElement('button');
  pill.className = 'time-btn' + (selectedYear ? ' active' : '');
  pill.textContent = selectedYear || 'All Time';
  pill.onclick = (e) => {
    e.stopPropagation();
    const existing = el.querySelector('.div-dropdown');
    if (existing) { existing.remove(); return; }
    const dropdown = document.createElement('div');
    dropdown.className = 'div-dropdown';
    ['All Time', ...years].forEach(y => {
      const item = document.createElement('div');
      item.className = 'div-dropdown-item' + ((y === 'All Time' && !selectedYear) || y === selectedYear ? ' selected' : '');
      item.textContent = y;
      item.onclick = (ev) => {
        ev.stopPropagation();
        selectedYear = y === 'All Time' ? null : y;
        dropdown.remove();
        renderAll();
      };
      dropdown.appendChild(item);
    });
    el.appendChild(dropdown);
    setTimeout(() => document.addEventListener('click', function close() {
      dropdown.remove();
      document.removeEventListener('click', close);
    }, { once: true }), 0);
  };
  el.appendChild(pill);
}

// ── Render charts + stats ─────────────────────────────────────────────────────
function setPlacementVisible(visible) {
  const el = document.getElementById('chartPlaceSection');
  if (visible) {
    el.style.display = '';
  } else if (el.style.display !== 'none') {
    const h = el.offsetHeight;
    el.style.display = 'none';
    window.scrollBy({ top: -h, behavior: 'instant' });
  }
}

function renderAll() {
  if (!allResults.length) return;

  // Level 2 filter: only chart USPSA/Hit Factor matches (excludes time-scored sports)
  // Also exclude matches the user has manually deselected
  const uspsaBase = allResults.filter(r =>
    isChartable(r) &&
    !deselectedMatches.has(r.match_id)
  );

  // 'ranked' = confirmed by member number, % score required
  // 'all'    = any scored match (% or HF), including HF-only results
  const chartable = currentView === 'ranked'
    ? uspsaBase.filter(r => r.found_by === 'member_number' && r.overall_pct != null)
    : uspsaBase.filter(r => r.overall_pct != null || r.hf != null);

  const sorted = [...chartable].sort((a, b) => {
    const da = parseDate(a.date), db = parseDate(b.date);
    return (da && db) ? da - db : 0;
  });

  const placeData = sorted.filter(r => r.place != null);

  summaryBar.classList.add('visible');
  chartsEl.classList.add('visible');
  sizeCanvases();
  document.getElementById('classifiersToggleWrap').style.display = currentView === 'ranked' ? 'flex' : 'none';

  if (sorted.length === 0) {
    const msg = currentView === 'ranked'
      ? 'No member-number confirmed scores.\nSwitch to "All Matches" to see name-matched results.'
      : 'No data.';
    drawMessage(document.getElementById('chartTime'),  msg);
    drawMessage(document.getElementById('chartPlace'), msg);
    document.getElementById('statMatches').textContent = '—';
    document.getElementById('statAvg').textContent     = '—';
    document.getElementById('statBest').textContent    = '—';
    document.getElementById('statDiv').textContent     = '—';
    return;
  }

  const divs = [...new Set(sorted.map(r => r.division).filter(Boolean))];

  // Validate selectedDiv / selectedYear against current data
  if (selectedDiv && !divs.includes(selectedDiv)) selectedDiv = null;
  const years = [...new Set(sorted.map(r => r.date?.slice(0, 4)).filter(Boolean))].sort();
  if (selectedYear && !years.includes(selectedYear)) selectedYear = null;

  // Filter to selected division + year for stats + charts
  const viewSorted = sorted.filter(r =>
    (!selectedDiv || (r.division || 'Unknown') === selectedDiv) &&
    (!selectedYear || r.date?.startsWith(selectedYear))
  );

  const avg  = viewSorted.reduce((s, r) => s + (r.overall_pct ?? 0), 0) / (viewSorted.length || 1);
  const best = viewSorted.length ? Math.max(...viewSorted.map(r => r.overall_pct ?? 0)) : 0;

  const avgBand  = CLASS_BANDS.find(b => avg  >= b.min && avg  < b.max);
  const bestBand = CLASS_BANDS.find(b => best >= b.min && best < b.max);

  document.getElementById('statMatches').textContent = viewSorted.length;
  document.getElementById('statAvg').textContent     = avg.toFixed(1) + '%';
  document.getElementById('statAvg').style.color     = avgBand?.text.replace('0.55','1') || '#4a9eff';
  document.getElementById('statBest').textContent    = best.toFixed(1) + '%';
  document.getElementById('statBest').style.color    = bestBand?.text.replace('0.55','1') || '#4a9eff';

  // Stat box tooltips — explain what each metric measures
  const divLabel = selectedDiv ? ` in ${selectedDiv}` : '';
  document.getElementById('statAvgBox').dataset.tip =
    `Your average match score${divLabel}.\n` +
    `Calculated as your points ÷ the match winner's points × 100,\n` +
    `averaged across all checked matches in the current view.`;
  document.getElementById('statBestBox').dataset.tip =
    `Your highest single-match score${divLabel}.\n` +
    `Match score = your points ÷ match winner's points × 100.\n` +
    `Color indicates the USPSA classification band for that score.`;

  // Division stat box — opens a dropdown
  const divStatBox = document.getElementById('statDiv').closest('.stat-box');
  const divStatVal = document.getElementById('statDiv');
  if (divs.length > 0) {
    divStatBox.classList.add('clickable');
    divStatBox.classList.toggle('active-filter', !!selectedDiv);
    divStatVal.textContent = selectedDiv || (divs.length === 1 ? divs[0] : 'All');
    divStatBox.onclick = (e) => {
      e.stopPropagation();
      const existing = divStatBox.querySelector('.div-dropdown');
      if (existing) { existing.remove(); return; }
      const dropdown = document.createElement('div');
      dropdown.className = 'div-dropdown';
      const options = divs.length > 1 ? ['All', ...divs] : divs;
      options.forEach(d => {
        const item = document.createElement('div');
        item.className = 'div-dropdown-item' + ((d === 'All' && !selectedDiv) || d === selectedDiv ? ' selected' : '');
        item.textContent = d;
        item.onclick = (ev) => {
          ev.stopPropagation();
          selectedDiv = d === 'All' ? null : d;
          dropdown.remove();
          renderAll();
        };
        dropdown.appendChild(item);
      });
      divStatBox.appendChild(dropdown);
      setTimeout(() => document.addEventListener('click', function close() {
        dropdown.remove();
        document.removeEventListener('click', close);
      }, { once: true }), 0);
    };
  } else {
    divStatBox.classList.remove('clickable', 'active-filter');
    divStatBox.onclick = null;
    divStatVal.textContent = '—';
  }

  // Year filter pills
  renderYearFilter(years);

  // Official classification stat box (D-GM class from USPSA.org)
  renderClassBox(selectedDiv || (divs.length === 1 ? divs[0] : null));

  const avgLbl = document.querySelector('#statMatches')?.closest('#stats')
    ?.querySelectorAll('.stat-box')[1]?.querySelector('.lbl');

  // ── Classifiers Only mode ────────────────────────────────────────────────────
  if (classifiersOnly) {
    // Collect all classifier stages from viewSorted matches.
    // Use clf_pct (official USPSA %, vs national reference HF) when available;
    // fall back to stage pct from PractiScore (vs match top HF — less accurate).
    const clfPoints = [];
    for (const r of viewSorted) {
      if (!r.stages) continue;
      for (const s of r.stages) {
        const clf = isClassifierStage(s);
        if (!clf) continue;
        const officialPct = s.clf_pct ?? null;
        const displayPct  = officialPct ?? s.pct;
        if (displayPct == null) continue;
        clfPoints.push({
          date: r.date,
          y: displayPct,
          isOfficial: officialPct != null,
          hf: s.hf,
          label: clf.number ? `CM ${clf.number}${clf.name ? ' · ' + clf.name : ''}` : 'Classifier',
          match_name: r.match_name,
          division: r.division || 'Unknown',
          code: clf.number,
          a: s.a, c: s.c, d: s.d, m: s.m, ns: s.ns, p: s.p,
        });
      }
    }

    // Sort chronologically
    clfPoints.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    if (clfPoints.length === 0) {
      document.getElementById('statMatches').textContent = '0';
      document.getElementById('statAvg').textContent  = '—';
      document.getElementById('statBest').textContent = '—';
      document.getElementById('chartTimeTitle').textContent = 'Classifier Scores Over Time';
      drawMessage(document.getElementById('chartTime'), 'No classifier stages found.\nRefresh matches to detect classifiers.');
      setPlacementVisible(false);
      return;
    }

    // Stats: use official pcts where available
    const officialPcts = clfPoints.filter(p => p.isOfficial).map(p => p.y);
    const statPcts     = officialPcts.length ? officialPcts : clfPoints.map(p => p.y);
    const clfAvg  = statPcts.reduce((s, v) => s + v, 0) / statPcts.length;
    const clfBest = Math.max(...statPcts);
    const avgBandC  = CLASS_BANDS.find(b => clfAvg  >= b.min && clfAvg  < b.max);
    const bestBandC = CLASS_BANDS.find(b => clfBest >= b.min && clfBest < b.max);

    document.getElementById('statMatches').textContent = clfPoints.length;
    document.getElementById('statAvg').textContent  = clfAvg.toFixed(1) + '%';
    document.getElementById('statAvg').style.color  = avgBandC?.text.replace('0.55','1') || '#4a9eff';
    document.getElementById('statBest').textContent = clfBest.toFixed(1) + '%';
    document.getElementById('statBest').style.color = bestBandC?.text.replace('0.55','1') || '#4a9eff';
    if (avgLbl) avgLbl.textContent = avgBandC ? `Avg % · ${avgBandC.label} Class` : 'Avg %';

    // Classifier-mode tooltips
    const clfSource = officialPcts.length ? 'official USPSA % vs national HHF' : 'match % vs match top HF';
    document.getElementById('statAvgBox').dataset.tip =
      `Your average classifier score (${clfSource}),\n` +
      `averaged across all classifier stages in the current view.\n` +
      `USPSA uses your best 6 classifiers to set your classification.`;
    document.getElementById('statBestBox').dataset.tip =
      `Your highest single classifier score (${clfSource}).\n` +
      `Color indicates the USPSA classification band for that score.\n` +
      `GM = 95%+, M = 85–95%, A = 75–85%, B = 60–75%, C = 40–60%.`;

    // Build series grouped by division — gives continuous lines over time
    const DIV_PALETTE = ['#4a9eff','#4caf50','#ff9800','#e91e63','#9c27b0','#00bcd4','#ffeb3b','#ff5722'];
    const divKeys = [...new Set(clfPoints.map(p => p.division))];
    const series = divKeys.map((div, i) => ({
      label: div,
      color: DIV_PALETTE[i % DIV_PALETTE.length],
      points: clfPoints
        .filter(p => p.division === div)
        .map(p => ({ date: p.date, y: p.y, label: p.label, match_name: p.match_name, hf: p.hf,
                     isOfficial: p.isOfficial, a: p.a, c: p.c, d: p.d, m: p.m, ns: p.ns, p_: p.p })),
    }));

    const allClfDates = [...new Set(clfPoints.map(p => p.date))].sort();

    document.getElementById('chartTimeTitle').textContent = 'Classifier Scores Over Time'
      + (officialPcts.length ? ' (official %)' : ' (match % — log in to USPSA.org for official %)');
    drawMultiSeriesChart(document.getElementById('chartTime'), series, allClfDates, {
      yLabel: 'Classifier %', yMin: 0, yMax: 100, invertY: false, trend: series.length === 1, valueUnit: '%',
      showClassBands: true,
    });
    setPlacementVisible(false);
    // Hide non-classifier trend in classifiers-only mode
    const nonClfSectionClf = document.getElementById('chartNonClfSection');
    if (nonClfSectionClf) nonClfSectionClf.style.display = 'none';
    return;
  }

  // ── Normal mode ──────────────────────────────────────────────────────────────
  document.getElementById('chartTimeTitle').textContent = 'Score Over Time';
  setPlacementVisible(true);
  if (avgLbl) avgLbl.textContent = avgBand ? `Avg % · ${avgBand.label} Class` : 'Avg %';

  const DIV_PALETTE = ['#4a9eff','#4caf50','#ff9800','#e91e63','#9c27b0','#00bcd4','#ffeb3b'];

  // Group viewSorted results by division
  const byDiv = {};
  viewSorted.forEach(r => {
    const key = r.division || 'Unknown';
    if (!byDiv[key]) byDiv[key] = [];
    byDiv[key].push(r);
  });

  // All unique dates for shared X axis
  const allDates = [...new Set(viewSorted.map(r => r.date))].sort();

  const scoreSeries = Object.entries(byDiv).map(([div, matches], i) => {
    const byDate = new Map();
    for (const r of matches) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }
    const points = [...byDate.entries()].map(([date, group]) => {
      const ys = group.map(r => r.div_pct ?? r.overall_pct).filter(v => v != null);
      const avgY = ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : null;
      if (group.length === 1) {
        const r = group[0];
        return { date, y: avgY, label: r.match_name, division: r.division, class_: r.class_,
          overall_pct: r.overall_pct, div_pct: r.div_pct,
          place: r.div_place ?? r.place, total: r.div_total ?? r.total,
          foundBy: r.found_by, stages: r.stages || null };
      }
      return { date, y: avgY, label: `${group.length} matches`, multiMatch: group.map(r => ({
        label: r.match_name, y: r.div_pct ?? r.overall_pct, overall_pct: r.overall_pct,
        division: r.division, class_: r.class_,
        place: r.div_place ?? r.place, total: r.div_total ?? r.total, foundBy: r.found_by,
      })), division: group[0].division, class_: group[0].class_, overall_pct: avgY };
    });
    return { label: div, color: DIV_PALETTE[i % DIV_PALETTE.length], points };
  });

  drawMultiSeriesChart(document.getElementById('chartTime'), scoreSeries, allDates, {
    yLabel: 'Division %', yMin: 0, yMax: 100, invertY: false, trend: true, valueUnit: '%',
    showClassBands: true,
  });

  const placeSeries = Object.entries(byDiv).map(([div, matches], i) => {
    const placeMatches = matches.filter(r => {
      const place = r.div_place ?? r.place;
      const total = r.div_total ?? r.total;
      return place != null && total != null && total > 0;
    });
    const byDate = new Map();
    for (const r of placeMatches) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }
    const points = [...byDate.entries()].map(([date, group]) => {
      const ys = group.map(r => {
        const place = r.div_place ?? r.place, total = r.div_total ?? r.total;
        return Math.round((1 - place / total) * 1000) / 10;
      });
      const avgY = ys.reduce((s, v) => s + v, 0) / ys.length;
      if (group.length === 1) {
        const r = group[0];
        return { date, y: avgY, rawPlace: r.div_place ?? r.place, label: r.match_name,
          division: r.division, class_: r.class_,
          overall_pct: r.div_pct ?? r.overall_pct, total: r.div_total ?? r.total, foundBy: r.found_by };
      }
      return { date, y: avgY, label: `${group.length} matches`, multiMatch: group.map((r, gi) => ({
        label: r.match_name, y: ys[gi], rawPlace: r.div_place ?? r.place,
        total: r.div_total ?? r.total, overall_pct: r.div_pct ?? r.overall_pct,
        division: r.division, class_: r.class_, foundBy: r.found_by,
      })), division: group[0].division, class_: group[0].class_ };
    });
    return { label: div, color: DIV_PALETTE[i % DIV_PALETTE.length], points };
  }).filter(s => s.points.length > 0);

  if (placeSeries.length > 0) {
    const allPlaceDates = [...new Set(placeSeries.flatMap(s => s.points.map(p => p.date)))].sort();
    drawMultiSeriesChart(document.getElementById('chartPlace'), placeSeries, allPlaceDates, {
      yLabel: 'Field beaten %', yMin: 0, yMax: 100, invertY: false, valueUnit: 'place%',
    });
  } else {
    drawMessage(document.getElementById('chartPlace'), 'No placement data.');
  }

  // ── Non-classifier stage trend ────────────────────────────────────────────
  // Shows avg HF% across non-classifier stages per match — a stable cross-match
  // progression signal since classifier stages are one-off courses.
  // Only shown when at least 2 matches have non-classifier stage data.
  const nonClfSection = document.getElementById('chartNonClfSection');
  const nonClfPoints = [];
  for (const r of viewSorted) {
    if (!r.stages?.length) continue;
    const nonClfStages = r.stages.filter(s => s.is_classifier === false || (s.is_classifier == null && !isClassifierStage(s)));
    if (!nonClfStages.length) continue;
    // Compute avg HF% for non-classifier stages (pct = stage % vs match top HF)
    const pcts = nonClfStages.map(s => s.pct).filter(v => v != null);
    if (!pcts.length) continue;
    const avgPct = pcts.reduce((a, v) => a + v, 0) / pcts.length;
    nonClfPoints.push({
      date: r.date,
      y: avgPct,
      label: r.match_name,
      division: r.division,
      class_: r.class_,
      stageCount: nonClfStages.length,
    });
  }
  nonClfPoints.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  if (nonClfPoints.length >= 2) {
    nonClfSection.style.display = '';
    const nonClfSeries = [{ label: 'Non-Clf Avg %', color: '#00bcd4', points: nonClfPoints }];
    const nonClfDates  = nonClfPoints.map(p => p.date);
    drawMultiSeriesChart(document.getElementById('chartNonClf'), nonClfSeries, nonClfDates, {
      yLabel: 'Avg Stage %', yMin: 0, yMax: 100, invertY: false, trend: true, valueUnit: '%',
      showClassBands: true,
    });
  } else {
    nonClfSection.style.display = 'none';
  }

}

// ── Match history list ────────────────────────────────────────────────────────
function renderMatchList() {
  if (!allResults.length) { matchHistory.classList.remove('visible'); return; }

  matchHistory.classList.add('visible');
  matchRowsEl.innerHTML = '';

  const sorted = [...allResults].sort((a, b) => {
    const da = parseDate(a.date), db = parseDate(b.date);
    return (da && db) ? db - da : 0;
  });

  sorted.forEach(match => {
    const hasStages  = !!(match.stages && match.stages.length > 0);
    const matchType  = match.match_type || 'Unknown';
    const isUSPSA    = isChartable(match);
    const isDeselected = deselectedMatches.has(match.match_id);
    const isExcluded = !isUSPSA || isDeselected;

    const dotClass = match.found_by === 'member_number' ? 'scored'
                   : match.found_by === 'name'          ? 'named'
                   : 'none';

    const scoreText = match.overall_pct != null
      ? fmtPct(match.overall_pct) + (match.division ? ' · ' + escHtml(match.division) : '') + (match.class_ ? '/' + escHtml(match.class_) : '')
      : null;

    const metaParts = [match.date];
    if (match.fetched_at) metaParts.push(formatAge(match.fetched_at));
    if (match.found_by === 'name') metaParts.push('matched by name');
    if (hasStages) metaParts.push(`${match.stages.length} stages`);
    if (!isUSPSA) metaParts.push('excluded from charts');

    const typeBadgeClass = !isChartable(match)                    ? 'type-other'    // red  — non-USPSA/non-HF sport
                         : match.found_by === 'member_number'    ? 'type-uspsa'    // green — confirmed by member #
                         : 'type-unknown';                                          // orange — name-only or not found

    const item = document.createElement('div');
    item.className = 'match-item' + (isExcluded ? ' excluded' : '');

    const row = document.createElement('div');
    row.className = 'match-row';
    row.dataset.matchId = match.match_id;
    // Build row using DOM methods for untrusted text (match_name, matchType) to prevent XSS (F1)
    row.innerHTML = `
      <input type="checkbox" class="match-include-cb" title="Include in charts"
        ${isDeselected ? '' : 'checked'}
        ${!isUSPSA ? 'disabled' : ''}>
      <div class="match-dot ${dotClass}"></div>
      <div class="match-info">
        <div class="match-name"></div>
        <div class="match-meta"></div>
      </div>
      <span class="match-type-badge ${typeBadgeClass}"></span>
      <div class="match-score ${scoreText ? '' : 'none'}">${scoreText || 'No score'}</div>
      ${hasStages ? '<button class="expand-btn" title="Show stage breakdown">▼</button>' : ''}
      <button class="refresh-btn" title="Re-fetch this match">↻</button>
      <button class="delete-btn" title="Delete from history">✕</button>
    `;
    // Set untrusted text via textContent to prevent XSS
    row.querySelector('.match-name').textContent = match.match_name;
    row.querySelector('.match-meta').textContent = metaParts.join(' · ');
    row.querySelector('.match-type-badge').textContent = matchType;

    if (hasStages) {
      const panel = document.createElement('div');
      panel.className = 'stage-panel';

      // Compute accuracy loss (seconds lost to non-A hits) per stage:
      // acc_loss = (C×1 + D×2 + M×5 + NS×5) / your_HF
      // This converts penalty points into "seconds you'd have saved with perfect accuracy".
      // Speed gap vs GM: how many seconds behind GM pace (gm_median_hf - your_hf) / gm_median_hf * time
      function stageAccLoss(s) {
        if (!s.hf || s.hf <= 0) return null;
        const penaltyPts = (s.c || 0) * 1 + (s.d || 0) * 2 + (s.m || 0) * 5 + (s.ns || 0) * 5;
        return penaltyPts / s.hf;
      }
      function stageGmPct(s) {
        if (!s.gm_median_hf || !s.hf) return null;
        return (s.hf / s.gm_median_hf) * 100;
      }

      const hasGM = match.stages.some(s => s.gm_median_hf != null);

      // Build table using DOM to avoid XSS on stage names (F1)
      const table = document.createElement('table');
      table.className = 'stage-table';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      const headers = ['Stage', 'Time', 'HF', '%'];
      if (hasGM) headers.push('GM%', 'Acc Loss');
      headers.push('A', 'C', 'D', 'M', 'NS', 'P');
      headers.forEach((h, i) => {
        const th = document.createElement('th');
        th.textContent = h;
        if (i > 0) th.style.textAlign = 'right';
        const colClass = { A: 'col-a', C: 'col-c', D: 'col-d', M: 'col-m', NS: 'col-ns', P: 'col-p' }[h];
        if (colClass) th.className = colClass;
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      match.stages.forEach(s => {
        const clf = isClassifierStage(s);
        const tr = document.createElement('tr');

        // Stage name cell — use DOM to prevent XSS
        const nameTd = document.createElement('td');
        if (clf) {
          const badge = document.createElement('a');
          badge.className = 'classifier-badge';
          badge.href = `https://uspsa.org/viewer/${encodeURIComponent(clf.number)}.pdf`;
          badge.target = '_blank';
          badge.title = `${clf.name ? clf.name + ' — ' : ''}CM ${clf.number} · View stage description`;
          badge.textContent = `CM ${clf.number}`;
          nameTd.appendChild(badge);
        }
        nameTd.appendChild(document.createTextNode(s.name));
        tr.appendChild(nameTd);

        // Numeric cells
        const cells = [
          s.time != null ? s.time.toFixed(2) + 's' : '—',
          s.hf   != null ? s.hf.toFixed(4)         : '—',
          null, // pct — uses fmtPct (HTML)
        ];
        cells.forEach((val, i) => {
          const td = document.createElement('td');
          td.textContent = val;
          tr.appendChild(td);
        });
        // % cell — fmtPct returns safe HTML with color spans
        const pctTd = tr.children[3];
        pctTd.innerHTML = fmtPct(s.pct);

        if (hasGM) {
          // GM% cell
          const gmPct = stageGmPct(s);
          const gmTd = document.createElement('td');
          if (gmPct != null) {
            const color = gmPct >= 95 ? '#ffd700' : gmPct >= 85 ? '#e040fb' : gmPct >= 75 ? '#4caf50' : gmPct >= 60 ? '#4a9eff' : '#ff9800';
            gmTd.innerHTML = `<span style="color:${color}">${gmPct.toFixed(1)}%</span>`;
            gmTd.title = `Your HF vs median GM HF (${s.gm_median_hf?.toFixed(4)})`;
          } else {
            gmTd.textContent = '—';
          }
          tr.appendChild(gmTd);

          // Accuracy loss cell
          const accLoss = stageAccLoss(s);
          const accTd = document.createElement('td');
          if (accLoss != null) {
            const color = accLoss < 0.5 ? '#4caf50' : accLoss < 1.5 ? '#fdd835' : '#f44336';
            accTd.innerHTML = `<span style="color:${color}" title="Seconds lost to non-A hits: (C×1 + D×2 + M×5 + NS×5) / HF">−${accLoss.toFixed(2)}s</span>`;
          } else {
            accTd.textContent = '—';
          }
          tr.appendChild(accTd);
        }

        // Hit columns
        const hitCols = [
          { val: s.a,  cls: 'col-a' },
          { val: s.c,  cls: 'col-c' },
          { val: s.d,  cls: 'col-d' },
          { val: s.m,  cls: 'col-m' },
          { val: s.ns, cls: 'col-ns' },
          { val: s.p,  cls: 'col-p' },
        ];
        hitCols.forEach(({ val, cls }) => {
          const td = document.createElement('td');
          td.className = cls;
          td.textContent = val || '—';
          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      panel.appendChild(table);

      const toggleExpand = () => {
        const isOpen = panel.classList.toggle('open');
        item.classList.toggle('open', isOpen);
        row.querySelector('.expand-btn').textContent = isOpen ? '▲' : '▼';
      };

      row.style.cursor = 'pointer';
      row.addEventListener('click', e => {
        if (e.target.closest('.refresh-btn, .delete-btn, .match-include-cb, .classifier-badge')) return;
        toggleExpand();
      });
      row.querySelector('.expand-btn').addEventListener('click', e => {
        e.stopPropagation();
        toggleExpand();
      });

      item.appendChild(row);
      item.appendChild(panel);
    } else {
      item.appendChild(row);
    }

    // Checkbox: toggle match inclusion in charts
    if (isUSPSA) {
      row.querySelector('.match-include-cb').addEventListener('change', e => {
        e.stopPropagation();
        if (e.target.checked) {
          deselectedMatches.delete(match.match_id);
        } else {
          deselectedMatches.add(match.match_id);
        }
        saveDeselected();
        item.classList.toggle('excluded', !e.target.checked);
        renderAll();
        updateStatusCounts();
      });
    }

    // Refresh button
    row.querySelector('.refresh-btn').addEventListener('click', e => {
      e.stopPropagation();
      refreshSingleMatch(match, row.querySelector('.refresh-btn'));
    });

    // Delete button
    row.querySelector('.delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteMatch(match);
    });

    matchRowsEl.appendChild(item);
  });
}

// ── Render official class badge in the stat box ────────────────────────────────
// Shows the USPSA.org classification for the currently selected (or most common) division.
function renderClassBox(viewSortedDivision) {
  const box = document.getElementById('statClassBox');
  const val = document.getElementById('statClass');
  if (!classificationData?.divisions) { box.style.display = 'none'; return; }

  const divs = classificationData.divisions;
  // Use the selected division key, or try to match by substring, or first available
  let info = null;
  if (viewSortedDivision) {
    const key = Object.keys(divs).find(k =>
      k.toLowerCase().includes(viewSortedDivision.toLowerCase().slice(0, 4)) ||
      viewSortedDivision.toLowerCase().includes(k.toLowerCase().slice(0, 4))
    );
    if (key) info = divs[key];
  }
  if (!info) info = Object.values(divs)[0];
  if (!info?.class_) { box.style.display = 'none'; return; }

  const c = info.class_.toUpperCase();
  const pctStr = info.pct != null ? `<span style="font-size:11px;color:#666">${info.pct.toFixed(1)}%</span>` : '';
  val.innerHTML = `<span class="class-badge class-${c.toLowerCase()}">${c}</span> ${pctStr}`;
  box.style.display = '';
}

// ── Delete a match from history/cache ────────────────────────────────────────
async function deleteMatch(match) {
  const ok = confirm(
    `Delete "${match.match_name}" from match history?\n\n` +
    `This removes it from your local cache. It will be re-fetched next time you click Fetch Scores.`
  );
  if (!ok) return;

  allResults = allResults.filter(r => r.match_id !== match.match_id);
  deselectedMatches.delete(match.match_id);

  const d = await chrome.storage.local.get(['matchCache', 'lastMatchList']);
  const cache     = d.matchCache     || {};
  const matchList = d.lastMatchList  || [];
  delete cache[match.match_id];
  const newList = matchList.filter(m => m.match_id !== match.match_id);

  await chrome.storage.local.set({
    matchCache:        cache,
    lastMatchList:     newList,
    deselectedMatches: [...deselectedMatches],
  });

  renderAll();
  renderMatchList();

  if (!allResults.length) {
    summaryBar.classList.remove('visible');
    chartsEl.classList.remove('visible');
    matchHistory.classList.remove('visible');
    setStatus('No matches. Click Fetch Scores to load.', '');
  } else {
    const scored = allResults.filter(r => r.overall_pct != null).length;
    setStatus(`${allResults.length} match(es) — ${scored} with scores.`, 'success');
  }
}

async function refreshSingleMatch(match, btn) {
  btn.disabled = true;
  btn.classList.add('spinning');

  const memberNumber = memberInput.value.trim().toUpperCase();
  const name         = nameInput.value.trim();

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'refreshMatch',
      match:  { match_id: match.match_id, match_name: match.match_name, date: match.date },
      memberNumber,
      name,
    });
    if (!response.ok) throw new Error(response.error);

    const { result } = response.data;
    const idx = allResults.findIndex(r => r.match_id === match.match_id);
    if (idx >= 0) allResults[idx] = { ...allResults[idx], ...result };

    renderAll();
    renderMatchList();

  } catch (err) {
    console.error('Refresh failed:', err);
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, type = '', loading = false) {
  statusEl.className = type;
  statusEl.innerHTML = loading ? `<div class="spinner"></div>${msg}` : msg;
}

// Recompute and display the status line from current allResults + deselectedMatches.
// verb = 'Loaded' on first fetch, omitted (defaults to 'Showing') on checkbox changes.
function updateStatusCounts(verb) {
  if (!allResults.length) return;
  const uspsa    = allResults.filter(r => isLikelyUSPSA(r.match_type || 'Unknown')).length;
  const nonUspsa = allResults.length - uspsa;
  const checked  = allResults.filter(r =>
    isLikelyUSPSA(r.match_type || 'Unknown') && !deselectedMatches.has(r.match_id)
  ).length;
  const scored   = allResults.filter(r => r.overall_pct != null).length;

  const prefix      = verb || 'Showing';
  const checkedNote = checked < uspsa ? ` · ${checked} checked` : '';
  const skippedNote = nonUspsa > 0   ? ` · ${nonUspsa} non-USPSA excluded` : '';
  setStatus(`${prefix} ${uspsa} USPSA match(es) — ${scored} with scores${checkedNote}.${skippedNote}`, 'success');
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

function formatAge(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60)    return 'just now';
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Chart primitives (Canvas 2D)
// ═════════════════════════════════════════════════════════════════════════════

const PAD        = { top: 24, right: 52, bottom: 44, left: 48 };
const GRID_COLOR = '#1e2130';
const AXIS_COLOR = '#2a2d3a';
const TEXT_COLOR = '#666';
const FONT       = '10px system-ui, sans-serif';

// USPSA classification bands (% thresholds)
const CLASS_BANDS = [
  { label: 'GM', min: 95,  max: 110, fill: 'rgba(255,215,0,0.07)',    text: 'rgba(255,215,0,0.55)' },
  { label: 'M',  min: 85,  max: 95,  fill: 'rgba(192,192,192,0.07)', text: 'rgba(192,192,192,0.55)' },
  { label: 'A',  min: 75,  max: 85,  fill: 'rgba(74,158,255,0.07)',  text: 'rgba(74,158,255,0.55)' },
  { label: 'B',  min: 60,  max: 75,  fill: 'rgba(76,175,80,0.07)',   text: 'rgba(76,175,80,0.55)' },
  { label: 'C',  min: 40,  max: 60,  fill: 'rgba(255,152,0,0.07)',   text: 'rgba(255,152,0,0.55)' },
  { label: 'D',  min: 0,   max: 40,  fill: 'rgba(120,120,120,0.07)', text: 'rgba(120,120,120,0.55)' },
];

function bandForPct(pct) {
  return CLASS_BANDS.find(b => pct >= b.min && pct < b.max) || null;
}

function fmtPct(pct) {
  if (pct == null) return '—';
  const b = bandForPct(pct);
  const color = b ? b.text.replace('0.55', '1') : '#8a9bb0';
  const label = b ? ` <small style="font-size:9px;opacity:0.75">${b.label}</small>` : '';
  return `<span style="color:${color}">${pct.toFixed(1)}%${label}</span>`;
}

function chartArea(canvas) {
  return {
    x0: PAD.left,
    y0: PAD.top,
    w:  canvas.width  - PAD.left - PAD.right,
    h:  canvas.height - PAD.top  - PAD.bottom,
  };
}

function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ── Multi-series line chart ───────────────────────────────────────────────────
function drawMultiSeriesChart(canvas, seriesArr, allDates, opts = {}) {
  const hasData = seriesArr.some(s => s.points.length > 0);
  if (!hasData) { drawMessage(canvas, 'No data.'); return; }

  const ctx  = canvas.getContext('2d');
  const area = chartArea(canvas);
  clearCanvas(ctx, canvas);

  const { yLabel = '', yMin, yMax, invertY = false, trend = false, valueUnit = '%', showClassBands = false } = opts;

  const allY   = seriesArr.flatMap(s => s.points.map(p => p.y)).filter(v => v != null);
  const rawMin = yMin != null ? yMin : Math.min(...allY);
  const rawMax = yMax != null ? yMax : Math.max(...allY);
  const yRange = rawMax - rawMin || 1;

  const dateToCanvasX = date => {
    const idx = allDates.indexOf(date);
    return area.x0 + (idx / Math.max(allDates.length - 1, 1)) * area.w;
  };
  const toY = v => {
    const norm = (v - rawMin) / yRange;
    return invertY ? area.y0 + norm * area.h : area.y0 + (1 - norm) * area.h;
  };

  // Classification bands (drawn before grid so grid lines appear on top)
  if (showClassBands) {
    CLASS_BANDS.forEach(band => {
      const visMin = Math.max(band.min, rawMin);
      const visMax = Math.min(band.max, rawMax);
      if (visMin >= visMax) return;

      const y1 = toY(visMax); // top of band (higher % = lower canvas Y)
      const y2 = toY(visMin); // bottom of band
      const bh = y2 - y1;
      if (bh < 1) return;

      // Filled band
      ctx.fillStyle = band.fill;
      ctx.fillRect(area.x0, y1, area.w, bh);

      // Dashed boundary line at the top of each band
      ctx.strokeStyle = band.text.replace('0.55', '0.25');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(area.x0, y1);
      ctx.lineTo(area.x0 + area.w, y1);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label to the right of the chart area
      const midY = y1 + bh / 2;
      ctx.fillStyle = band.text;
      ctx.font      = 'bold 9px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(band.label, area.x0 + area.w + 6, midY + 3);
    });
  }

  // Grid
  ctx.strokeStyle = GRID_COLOR; ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const v = rawMin + yRange * i / 5, cy = toY(v);
    ctx.beginPath(); ctx.moveTo(area.x0, cy); ctx.lineTo(area.x0 + area.w, cy); ctx.stroke();
    ctx.fillStyle = TEXT_COLOR; ctx.font = FONT; ctx.textAlign = 'right';
    ctx.fillText(v.toFixed(0), area.x0 - 5, cy + 3);
  }

  // Axes
  ctx.strokeStyle = AXIS_COLOR; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(area.x0, area.y0);
  ctx.lineTo(area.x0, area.y0 + area.h);
  ctx.lineTo(area.x0 + area.w, area.y0 + area.h); ctx.stroke();

  // Y label
  ctx.save(); ctx.translate(10, area.y0 + area.h / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = TEXT_COLOR; ctx.font = FONT; ctx.textAlign = 'center';
  ctx.fillText(yLabel, 0, 0); ctx.restore();

  // X date labels
  const step = Math.ceil(allDates.length / 8);
  ctx.fillStyle = TEXT_COLOR; ctx.font = FONT; ctx.textAlign = 'center';
  allDates.forEach((d, i) => {
    if (i % step !== 0 && i !== allDates.length - 1) return;
    ctx.fillText(d.substring(5), dateToCanvasX(d), area.y0 + area.h + 14); // MM-DD
  });

  // Legend (if multiple series)
  if (seriesArr.length > 1) {
    let lx = area.x0 + 8;
    const ly = area.y0 + area.h + 30;
    seriesArr.forEach(s => {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, ly - 7, 12, 8);
      ctx.fillStyle = TEXT_COLOR; ctx.font = FONT; ctx.textAlign = 'left';
      ctx.fillText(s.label, lx + 16, ly);
      lx += 16 + ctx.measureText(s.label).width + 16;
    });
  }

  // Trend lines (per series, single series only)
  if (trend && seriesArr.length === 1) {
    const pts = seriesArr[0].points;
    if (pts.length >= 3) {
      const xs  = pts.map((_, i) => i);
      const ys  = pts.map(p => p.y);
      const n   = pts.length;
      const sx  = xs.reduce((a, v) => a + v, 0), sy = ys.reduce((a, v) => a + v, 0);
      const sxy = xs.reduce((a, v, i) => a + v * ys[i], 0), sx2 = xs.reduce((a, v) => a + v * v, 0);
      const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
      const inter = (sy - slope * sx) / n;
      ctx.strokeStyle = 'rgba(255,152,0,0.45)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(dateToCanvasX(pts[0].date),          toY(inter));
      ctx.lineTo(dateToCanvasX(pts[n - 1].date),      toY(slope * (n - 1) + inter));
      ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // Lines + dots
  const hitMap = [];
  seriesArr.forEach(s => {
    const pts = s.points.filter(p => p.y != null);
    if (!pts.length) return;

    ctx.strokeStyle = s.color; ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const cx = dateToCanvasX(p.date), cy = toY(p.y);
      i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
    });
    ctx.stroke();

    pts.forEach(p => {
      const cx = dateToCanvasX(p.date), cy = toY(p.y);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
      hitMap.push({ cx, cy, color: s.color, seriesLabel: s.label, valueUnit, ...p });
    });
  });

  // Tooltip
  canvas._hitMap    = hitMap;
  canvas._valueUnit = valueUnit;
  if (!canvas._tooltipBound) {
    canvas._tooltipBound = true;
    canvas.addEventListener('mousemove', e => {
      const r  = canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) * (canvas.width  / r.width);
      const my = (e.clientY - r.top)  * (canvas.height / r.height);
      const h  = (canvas._hitMap || []).find(h => Math.hypot(h.cx - mx, h.cy - my) < 16);
      if (h) {
        const unit = h.valueUnit;
        // Use escHtml for untrusted strings (match names, stage names) in tooltip innerHTML (F1)
        const multiMatchRows = h.multiMatch ? h.multiMatch.map(m => {
          if (unit === '%') {
            const b = bandForPct(m.y);
            const c = b ? b.text.replace('0.55', '1') : '#8a9bb0';
            return `<div class="tt-stage-row"><span class="tt-stage-name">${escHtml(m.label)}</span>`
              + `<span style="color:${c}">${m.y != null ? m.y.toFixed(1) + '%' + (b ? ' ' + b.label : '') : '—'}</span></div>`;
          }
          return `<div class="tt-stage-row"><span class="tt-stage-name">${escHtml(m.label)}</span>`
            + `<span style="color:#8a9bb0">${m.rawPlace}/${m.total} (beat ${m.y.toFixed(1)}%)</span></div>`;
        }).join('') : '';

        if (h.multiMatch) {
          const classBand = unit === '%' ? bandForPct(h.y) : null;
          const classLabel = classBand ? ` <span style="color:${classBand.text};font-size:10px">${classBand.label}</span>` : '';
          const avgLine = unit === '%'
            ? `<div class="tt-score" style="color:${h.color}">${h.y.toFixed(1)}%${classLabel} <span style="font-size:11px;color:#666">avg (div)</span></div>`
            : `<div class="tt-score" style="color:${h.color}">${h.y.toFixed(1)}% <span style="font-size:11px;color:#666">avg beaten</span></div>`;
          tooltipEl.innerHTML = `
            <div class="tt-name">${escHtml(h.label)}</div>
            <div class="tt-date">${escHtml(h.date || '')}</div>
            ${avgLine}
            <div class="tt-stages">${multiMatchRows}</div>
          `;
        } else {
          const classBand = unit === '%' ? bandForPct(h.y) : null;
          const classLabel = classBand
            ? `<span style="color:${classBand.text};font-size:10px;margin-left:6px">${classBand.label}</span>` : '';
          const mainVal = unit === '%'
            ? `<div class="tt-score" style="color:${h.color}">${h.y.toFixed(1)}%${classLabel} <span style="font-size:11px;color:#666">(div)</span></div>`
            : unit === 'place%'
            ? `<div class="tt-score" style="color:${h.color}">Place ${h.rawPlace} / ${h.total} <span style="font-size:11px;color:#666">(beat ${h.y.toFixed(1)}% of field)</span></div>`
            : `<div class="tt-score" style="color:${h.color}">Place ${h.y}${h.total ? ' / ' + h.total : ''}</div>`;
          const divLine = (h.division || h.class_)
            ? `<div class="tt-meta">${escHtml([h.division, h.class_].filter(Boolean).join(' / '))}</div>` : '';
          const overallLine = (unit === '%' && h.overall_pct != null && Math.abs(h.overall_pct - h.y) > 0.1)
            ? `<div class="tt-meta">${h.overall_pct.toFixed(1)}% overall</div>` : '';
          const pctLine = (unit === '' && h.overall_pct != null)
            ? `<div class="tt-meta">${h.overall_pct.toFixed(1)}% score</div>` : '';
          const nameLine = h.foundBy === 'name'
            ? `<div class="tt-meta" style="color:#ff9800">matched by name</div>` : '';
          const seriesLine = (canvas._hitMap || []).some(x => x.seriesLabel !== h.seriesLabel)
            ? `<div class="tt-meta" style="color:${h.color}">${escHtml(h.seriesLabel)}</div>` : '';
          const matchNameLine = (h.match_name && h.match_name !== h.label)
            ? `<div class="tt-meta">${escHtml(h.match_name)}</div>` : '';
          const hfLine = (h.hf != null && !h.stages?.length)
            ? `<div class="tt-meta">HF ${h.hf.toFixed(4)}</div>` : '';
          const hitsLine = (!h.stages?.length && (h.a || h.c || h.d || h.m || h.ns || h.p_))
            ? `<div class="tt-meta">${[
                h.a  ? `<span style="color:#4caf50">${h.a}A</span>`                    : '',
                h.c  ? `<span style="color:#fdd835">${h.c}C</span>`                    : '',
                h.d  ? `<span style="color:#ff9800">${h.d}D</span>`                    : '',
                h.m  ? `<span style="color:#f44336;font-weight:600">${h.m}M</span>`   : '',
                h.ns ? `<span style="color:#f44336;font-weight:600">${h.ns}NS</span>` : '',
                h.p_ ? `<span style="color:#f44336">${h.p_}P</span>`                  : '',
              ].filter(Boolean).join(' ')}</div>` : '';
          const stagesHtml = (h.stages && h.stages.length > 0)
            ? `<div class="tt-stages">${h.stages.map(s => {
                const clf = isClassifierStage(s);
                const clfBadge = clf ? `<span class="classifier-badge" title="${escHtml(clf.name ? clf.name + ' — ' : '') + 'CM ' + escHtml(clf.number)}">CM ${escHtml(clf.number)}</span>` : '';
                return `
                <div class="tt-stage-row">
                  <span class="tt-stage-name">${clfBadge}${escHtml(s.name)}</span>
                  <span class="tt-stage-hf">${s.hf != null ? s.hf.toFixed(4) : '—'}</span>
                  <span class="tt-stage-hits">${s.a ? '<span style="color:#4caf50">' + s.a + 'A</span> ' : ''}${s.c ? '<span style="color:#fdd835">' + s.c + 'C</span> ' : ''}${s.d ? '<span style="color:#ff9800">' + s.d + 'D</span>' : ''}${s.m ? ' <span style="color:#f44336;font-weight:600">' + s.m + 'M</span>' : ''}${s.ns ? ' <span style="color:#f44336;font-weight:600">' + s.ns + 'NS</span>' : ''}${s.p ? ' <span style="color:#f44336">' + s.p + 'P</span>' : ''}</span>
                </div>`;
              }).join('')}</div>` : '';
          tooltipEl.innerHTML = `
            <div class="tt-name">${escHtml(h.label)}</div>
            <div class="tt-date">${escHtml(h.date || '')}</div>
            ${mainVal}${divLine}${overallLine}${pctLine}${seriesLine}${nameLine}${matchNameLine}${hfLine}${hitsLine}${stagesHtml}
          `;
        }
        const tw = 300, th = (h.multiMatch || h.stages?.length) ? 280 : 130;
        const tx = e.clientX + 14 + tw > window.innerWidth  ? e.clientX - tw - 8 : e.clientX + 14;
        const ty = e.clientY - 10 + th > window.innerHeight ? e.clientY - th      : e.clientY - 10;
        tooltipEl.style.left    = tx + 'px';
        tooltipEl.style.top     = ty + 'px';
        tooltipEl.style.display = 'block';
        canvas.style.cursor = 'crosshair';
      } else {
        tooltipEl.style.display = 'none';
        canvas.style.cursor = '';
      }
    });
    canvas.addEventListener('mouseleave', () => { tooltipEl.style.display = 'none'; });
  }
}

function drawLineChart(canvas, points, opts = {}) {
  if (!points.length) { drawMessage(canvas, 'No data.'); return; }

  const ctx  = canvas.getContext('2d');
  const area = chartArea(canvas);
  clearCanvas(ctx, canvas);

  const { yLabel = '', yMin, yMax, invertY = false, color = '#4a9eff', trend = false } = opts;

  const xs     = points.map((_, i) => i);
  const ys     = points.map(p => p.y);
  const rawMin = yMin != null ? yMin : Math.min(...ys);
  const rawMax = yMax != null ? yMax : Math.max(...ys);
  const yRange = rawMax - rawMin || 1;

  const toX = i => area.x0 + (i / Math.max(xs.length - 1, 1)) * area.w;
  const toY = v => {
    const norm = (v - rawMin) / yRange;
    return invertY ? area.y0 + norm * area.h : area.y0 + (1 - norm) * area.h;
  };

  // Grid
  ctx.strokeStyle = GRID_COLOR; ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const v = rawMin + yRange * i / 5, cy = toY(v);
    ctx.beginPath(); ctx.moveTo(area.x0, cy); ctx.lineTo(area.x0 + area.w, cy); ctx.stroke();
    ctx.fillStyle = TEXT_COLOR; ctx.font = FONT; ctx.textAlign = 'right';
    ctx.fillText(v.toFixed(0), area.x0 - 5, cy + 3);
  }

  // Axes
  ctx.strokeStyle = AXIS_COLOR; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(area.x0, area.y0);
  ctx.lineTo(area.x0, area.y0 + area.h);
  ctx.lineTo(area.x0 + area.w, area.y0 + area.h); ctx.stroke();

  // Y label
  ctx.save(); ctx.translate(10, area.y0 + area.h / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = TEXT_COLOR; ctx.font = FONT; ctx.textAlign = 'center';
  ctx.fillText(yLabel, 0, 0); ctx.restore();

  // Trend
  if (trend && points.length >= 3) {
    const n = points.length;
    const sx = xs.reduce((a, v) => a + v, 0), sy = ys.reduce((a, v) => a + v, 0);
    const sxy = xs.reduce((a, v, i) => a + v * ys[i], 0), sx2 = xs.reduce((a, v) => a + v * v, 0);
    const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
    const inter = (sy - slope * sx) / n;
    ctx.strokeStyle = 'rgba(255,152,0,0.45)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(toX(0), toY(inter)); ctx.lineTo(toX(n - 1), toY(slope * (n - 1) + inter));
    ctx.stroke(); ctx.setLineDash([]);
  }

  // Line
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => { i === 0 ? ctx.moveTo(toX(i), toY(p.y)) : ctx.lineTo(toX(i), toY(p.y)); });
  ctx.stroke();

  // Dots + hit map
  const hitMap = [];
  points.forEach((p, i) => {
    const cx = toX(i), cy = toY(p.y);
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    hitMap.push({ cx, cy, label: p.label, value: p.y, date: p.date });
  });

  // X labels (MM-DD)
  const step = Math.ceil(points.length / 8);
  ctx.fillStyle = TEXT_COLOR; ctx.font = FONT; ctx.textAlign = 'center';
  points.forEach((p, i) => {
    if (i % step !== 0 && i !== points.length - 1) return;
    const lbl = p.date ? p.date.substring(5) : `#${i+1}`;
    ctx.fillText(lbl, toX(i), area.y0 + area.h + 14);
  });

  // Interactive tooltip
  canvas._hitMap   = hitMap;
  canvas._valueUnit = opts.valueUnit ?? '%';
  if (!canvas._tooltipBound) {
    canvas._tooltipBound = true;
    canvas.addEventListener('mousemove', e => {
      const r  = canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) * (canvas.width  / r.width);
      const my = (e.clientY - r.top)  * (canvas.height / r.height);
      const h  = (canvas._hitMap || []).find(h => Math.hypot(h.cx - mx, h.cy - my) < 16);
      if (h) {
        const unit = canvas._valueUnit;
        const scoreLine = unit === '%'
          ? `<div class="tt-score">${h.value.toFixed(2)}%</div>`
          : `<div class="tt-score">Place ${h.value}${h.total ? ' / ' + h.total : ''}</div>`;
        const divLine = (h.division || h.class_)
          ? `<div class="tt-meta">${[h.division, h.class_].filter(Boolean).join(' / ')}</div>`
          : '';
        const pctLine = (unit === '' && h.overall_pct != null)
          ? `<div class="tt-meta">${h.overall_pct.toFixed(1)}% overall</div>`
          : '';
        const placeLine = (unit === '%' && h.place != null)
          ? `<div class="tt-meta">Place ${h.place}${h.total ? ' / ' + h.total : ''}</div>`
          : '';
        const nameLine = h.foundBy === 'name'
          ? `<div class="tt-meta" style="color:#ff9800">matched by name</div>` : '';

        tooltipEl.innerHTML = `
          <div class="tt-name">${h.label}</div>
          <div class="tt-date">${h.date || ''}</div>
          ${scoreLine}${divLine}${pctLine}${placeLine}${nameLine}
        `;
        // Keep tooltip on screen
        const tw = 260, th = 120;
        const tx = e.clientX + 14 + tw > window.innerWidth  ? e.clientX - tw - 8 : e.clientX + 14;
        const ty = e.clientY - 10 + th > window.innerHeight ? e.clientY - th      : e.clientY - 10;
        tooltipEl.style.left    = tx + 'px';
        tooltipEl.style.top     = ty + 'px';
        tooltipEl.style.display = 'block';
        canvas.style.cursor = 'crosshair';
      } else {
        tooltipEl.style.display = 'none';
        canvas.style.cursor = '';
      }
    });
    canvas.addEventListener('mouseleave', () => {
      tooltipEl.style.display = 'none';
    });
  }
}


function drawMessage(canvas, msg) {
  const ctx = canvas.getContext('2d');
  clearCanvas(ctx, canvas);
  ctx.fillStyle = '#444'; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
}
