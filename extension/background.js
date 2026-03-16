// background.js — service worker

const PS_BASE = 'https://practiscore.com';
const USPSA_BASE = 'https://uspsa.org';

// ── Open dashboard tab (or focus if already open) ─────────────────────────────
chrome.action.onClicked.addListener(async () => {
  const dashUrl = chrome.runtime.getURL('dashboard.html');
  const existing = await chrome.tabs.query({ url: dashUrl });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: dashUrl });
  }
});

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'fetchScores') {
    fetchScores(msg.memberNumber, msg.name)
      .then(data  => sendResponse({ ok: true,  data }))
      .catch(err  => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.action === 'fetchClassification') {
    fetchUSPSAClassification(msg.memberNumber, m => console.log('[PScharts]', m))
      .then(async data => {
        if (data && !data._not_logged_in) {
          const stored = { ...data, member_number: msg.memberNumber, updated_at: Date.now() };
          await chrome.storage.local.set({ classificationData: stored });
        }
        sendResponse({ ok: true, data });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.action === 'refreshMatch') {
    refreshMatch(msg.match, msg.memberNumber, msg.name)
      .then(data  => sendResponse({ ok: true,  data }))
      .catch(err  => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ── Cache helpers ─────────────────────────────────────────────────────────────
async function getCache() {
  const d = await chrome.storage.local.get('matchCache');
  return d.matchCache || {};
}

async function updateMatchCache(matchId, scoreData) {
  const cache = await getCache();
  cache[matchId] = { ...scoreData, fetched_at: Date.now() };
  await chrome.storage.local.set({ matchCache: cache });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Match type detection ──────────────────────────────────────────────────────
function detectMatchType(name) {
  const n = (name || '').toUpperCase();
  if (/\bIDPA\b/.test(n)) return 'IDPA';
  if (/\bIPSC\b/.test(n)) return 'IPSC';
  if (/\bSTEEL[\s-]?CHALLENGE\b|\bSCSA\b/.test(n)) return 'Steel Challenge';
  if (/\b3[\s-]?GUN\b/.test(n)) return '3-Gun';
  if (/\bPCSL\b/.test(n)) return 'PCSL';
  if (/\bICORE\b/.test(n)) return 'ICORE';
  if (/\bUSPSA\b/.test(n)) return 'USPSA';
  // Common USPSA division keywords strongly imply USPSA
  if (/\b(CARRY[\s-]?OPTICS|CARRYOPTICS|SINGLE[\s-]?STACK|SINGLESTACK|LIMITED[\s-]?OPTICS|LIMITEDOPTICS)\b/.test(n)) return 'USPSA';
  return 'Unknown';
}

// Types confirmed as non-USPSA — skip score fetching for these
const NON_USPSA_TYPES = new Set(['IDPA', 'IPSC', 'Steel Challenge', '3-Gun', 'PCSL', 'ICORE', 'SCSA']);

function isLikelyUSPSA(matchType) {
  return !NON_USPSA_TYPES.has(matchType);
}

// Map the Div abbreviation shown in the results table to the PractiScore URL key.
// e.g. "CO" → "carryoptics", "L" → "limited"
function divisionToUrlKey(div) {
  const map = {
    CO:  'carryoptics',
    L:   'limited',
    LO:  'limitedoptics',
    O:   'open',
    PCC: 'pcc',
    REV: 'revolver',
    SS:  'singlestack',
    P:   'production',
  };
  const key = (div || '').trim().toUpperCase();
  return map[key] || key.toLowerCase().replace(/[\s\-]+/g, '');
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const h = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(h);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(h);
  });
}

async function runInTab(tabId, fn, args = []) {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
  return res[0].result;
}

function buildResult(match, score, memberNumber) {
  return {
    match_id:    match.match_id,
    match_name:  match.match_name,
    match_type:  match.match_type || 'Unknown',
    date:        match.date,
    division:    score.division    || '',
    class_:      score.class_      || '',
    overall_pct: score.overall_pct ?? null,
    div_pct:     score.div_pct     ?? null,
    hf:          score.hf          ?? null,
    place:       score.place       ?? null,
    div_place:   score.div_place   ?? null,
    div_total:   score.div_total   ?? null,
    total:       score.total       ?? null,
    found_by:    score.found_by    || null,
    stages:      score.stages      || null,
    cached_for:  (memberNumber || '').toUpperCase() || null,
    fetched_at:  Date.now(),
  };
}

// ── results/new/{matchId} scraper — injected into tab ─────────────────────────
// Reads the dynamically-rendered table in #mainResultsDiv plus the dropdown
// options for #resultLevel and #divisionLevel.
function getResultsNewState(mem, nm) {
  const isCF = /challenge|security|just a moment/i.test(document.title) ||
               !!document.querySelector('#cf-challenge-running, #challenge-form');
  if (isCF) return { _cf: true };

  // Spinner still visible → still loading
  const spinner = document.querySelector('#spinner');
  if (spinner && getComputedStyle(spinner).display !== 'none') {
    return { _loading: true, _debug: 'spinner visible' };
  }

  const mainDiv = document.querySelector('#mainResultsDiv');
  const tables  = mainDiv ? Array.from(mainDiv.querySelectorAll('table')) : [];
  if (!tables.length) {
    const txt = (mainDiv?.textContent || '').trim().substring(0, 80).replace(/\s+/g, ' ');
    return { _loading: true, _debug: 'no table — ' + txt };
  }

  // Read dropdown options (may still be empty on first paint)
  const readSelect = id => Array.from(document.getElementById(id)?.options || [])
    .map(o => ({ value: o.value, text: o.textContent.trim() }))
    .filter(o => o.text);

  const divisionOptions    = readSelect('divisionLevel');
  const resultLevelOptions = readSelect('resultLevel');

  // Extract confirmed sport type from page header:
  // <h4>Match Title <small>USPSA 2026-02-28</small></h4>
  let pageMatchType = null;
  const SPORT_TOKENS = ['USPSA', 'IDPA', 'IPSC', 'SCSA', 'PCSL', 'ICORE'];
  for (const h4 of document.querySelectorAll('h4')) {
    for (const small of h4.querySelectorAll('small')) {
      const txt   = small.textContent.trim();
      const words = txt.split(/\s+/);
      const first = words[0].toUpperCase();
      const firstTwo = words.slice(0, 2).join(' ').toUpperCase();
      if (firstTwo === 'HIT FACTOR')     { pageMatchType = 'Hit Factor'; break; }
      if (SPORT_TOKENS.includes(first))  { pageMatchType = first; break; }
      if (/^3[-\s]?GUN$/i.test(first))   { pageMatchType = '3-Gun'; break; }
    }
    if (pageMatchType) break;
  }

  // Largest table = results table
  const table = tables.sort(
    (a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length
  )[0];

  // Headers
  let thEls = Array.from(table.querySelectorAll('thead th, thead td'));
  if (!thEls.length) {
    const first = table.querySelector('tr');
    if (first) thEls = Array.from(first.querySelectorAll('th, td'));
  }
  const ths = thEls.map(th => th.textContent.trim().toLowerCase());

  const hi = {
    place: ths.findIndex(h => /^(place|#|rank|no\.?)$/.test(h)),
    mem:   ths.findIndex(h => /mem/.test(h)),
    div:   ths.findIndex(h => /^div/.test(h)),
    cls:   ths.findIndex(h => /^class$/.test(h)),
    pct:   ths.findIndex(h => /^(%|pct|percent|match\s*%|stage\s*%)$/.test(h)),
    hf:    ths.findIndex(h => /^(hf|hit\s*factor)$/.test(h)),
    time:  ths.findIndex(h => /^time$/.test(h)),
    a:     ths.findIndex(h => h === 'a'),
    c:     ths.findIndex(h => h === 'c'),
    d:     ths.findIndex(h => h === 'd'),
    m:     ths.findIndex(h => h === 'm'),
    ns:    ths.findIndex(h => h === 'ns' || h === 'n/s' || h === 'ns/m'),
    p:     ths.findIndex(h => h === 'p' || h === 'proc' || h === 'pen'),
  };

  let rows = Array.from(table.querySelectorAll('tbody tr'));
  if (!rows.length) rows = Array.from(table.querySelectorAll('tr')).slice(1);
  const total = rows.length;

  function parseRow(row) {
    const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
    const out   = { total };
    if (hi.div  >= 0) out.division = cells[hi.div] || '';
    if (hi.cls  >= 0) out.class_   = cells[hi.cls] || '';
    if (hi.hf   >= 0) out.hf       = parseFloat(cells[hi.hf])   || null;
    if (hi.time >= 0) out.time     = parseFloat(cells[hi.time])  || null;
    if (hi.a    >= 0) out.a        = parseInt(cells[hi.a])   || 0;
    if (hi.c    >= 0) out.c        = parseInt(cells[hi.c])   || 0;
    if (hi.d    >= 0) out.d        = parseInt(cells[hi.d])   || 0;
    if (hi.m    >= 0) out.m        = parseInt(cells[hi.m])   || 0;
    if (hi.ns   >= 0) out.ns       = parseInt(cells[hi.ns])  || 0;
    if (hi.p    >= 0) out.p        = parseInt(cells[hi.p])   || 0;

    if (hi.place >= 0) out.place = parseInt(cells[hi.place]) || null;
    if (!out.place && cells.length) {
      const pm = cells[0].match(/^(\d+)/);
      if (pm) out.place = parseInt(pm[1]);
    }
    if (hi.pct >= 0) out.overall_pct = parseFloat(cells[hi.pct]);
    if (out.overall_pct == null || isNaN(out.overall_pct)) {
      for (const c of cells) {
        const pm = c.match(/^(\d{1,3}\.\d{2,4})\s*%?$/);
        if (pm) { out.overall_pct = parseFloat(pm[1]); break; }
      }
    }
    return out;
  }

  // Build name variants for matching
  const memUp  = (mem || '').toUpperCase();
  const raw    = (nm || '').trim().toUpperCase();
  const parts  = raw.split(/[\s,]+/).filter(Boolean);
  const variants = new Set(raw ? [raw] : []);
  if (parts.length >= 2) {
    variants.add(`${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`);
    variants.add(`${parts[0]}, ${parts.slice(1).join(' ')}`);
    variants.add(parts.join(' '));
  }

  for (const row of rows) {
    const cells   = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
    const cellsUp = cells.map(c => c.toUpperCase());

    const memMatch  = memUp && (
      hi.mem >= 0
        ? (cells[hi.mem] || '').toUpperCase() === memUp
        : cells.some(c => c.toUpperCase() === memUp)
    );
    const nameMatch = variants.size && [...variants].some(v =>
      cellsUp.some(c => c === v || c.replace(/^\d+[.\-]\s*/, '') === v)
    );

    if (!memMatch && !nameMatch) continue;

    return {
      _ready: true, _found: true,
      found_by: memMatch ? 'member_number' : 'name',
      divisionOptions,
      resultLevelOptions,
      competitorData: parseRow(row),
      _rowCount: total,
      pageMatchType,
    };
  }

  return {
    _ready: true, _found: false,
    divisionOptions, resultLevelOptions,
    _rowCount: total, _headers: ths,
    pageMatchType,
  };
}

// Injected helper — sets a <select> value and fires a change event
function setSelectAndFire(selectId, value) {
  const el = document.getElementById(selectId);
  if (!el) return false;
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// ── HTML results page scraper — injected into tab, no external references ─────
// (kept as fallback for stage data on static pages)
function scrapeHTMLResultsPage(mem, nm) {
  const isCF = /challenge|security|just a moment/i.test(document.title) ||
               !!document.querySelector('#cf-challenge-running, #challenge-form');
  if (isCF) return { _cf: true };

  // Find largest table on the page
  const tables = Array.from(document.querySelectorAll('table'));
  const table = tables.sort((a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];
  if (!table) {
    const snippet = (document.body?.textContent || '').trim().substring(0, 120).replace(/\s+/g, ' ');
    return { _loading: true, _debug: 'no table — body: ' + snippet };
  }

  // Headers: prefer <thead>, fall back to first <tr>
  let thEls = Array.from(table.querySelectorAll('thead th, thead td'));
  if (!thEls.length) {
    const firstTr = table.querySelector('tr');
    if (firstTr) thEls = Array.from(firstTr.querySelectorAll('th, td'));
  }
  if (!thEls.length) return { _loading: true, _debug: 'no headers in table' };

  // Rows: prefer <tbody>, fall back to all <tr> after the first
  let rows = Array.from(table.querySelectorAll('tbody tr'));
  if (!rows.length) {
    const allTrs = Array.from(table.querySelectorAll('tr'));
    rows = allTrs.slice(1); // skip header row
  }
  if (!rows.length) {
    const hdrs = thEls.map(th => th.textContent.trim()).join(', ');
    return { _loading: true, _debug: `0 rows — headers: [${hdrs}]` };
  }

  const ths = thEls.map(th => th.textContent.trim().toLowerCase());
  const hi = {
    place: ths.findIndex(h => /^(place|#|rank|no\.?)$/.test(h)),
    mem:   ths.findIndex(h => /mem/.test(h)),
    div:   ths.findIndex(h => /^div/.test(h)),
    cls:   ths.findIndex(h => /^class$/.test(h)),
    pct:   ths.findIndex(h => /^(%|pct|percent|match\s*%)$/.test(h)),
    hf:    ths.findIndex(h => /^(hf|hit\s*factor)$/.test(h)),
    time:  ths.findIndex(h => /^time$/.test(h)),
    a:     ths.findIndex(h => h === 'a'),
    c:     ths.findIndex(h => h === 'c'),
    d:     ths.findIndex(h => h === 'd'),
    m:     ths.findIndex(h => h === 'm'),
    ns:    ths.findIndex(h => h === 'ns' || h === 'n/s' || h === 'ns/m'),
    p:     ths.findIndex(h => h === 'p' || h === 'proc' || h === 'pen'),
  };

  const total = rows.length;

  function parseRow(row) {
    const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
    const out = { total };
    if (hi.div  >= 0) out.division = cells[hi.div] || '';
    if (hi.cls  >= 0) out.class_   = cells[hi.cls] || '';
    if (hi.hf   >= 0) out.hf       = parseFloat(cells[hi.hf]) || null;
    if (hi.time >= 0) out.time     = parseFloat(cells[hi.time]) || null;
    if (hi.a    >= 0) out.a        = parseInt(cells[hi.a])  || 0;
    if (hi.c    >= 0) out.c        = parseInt(cells[hi.c])  || 0;
    if (hi.d    >= 0) out.d        = parseInt(cells[hi.d])  || 0;
    if (hi.m    >= 0) out.m        = parseInt(cells[hi.m])  || 0;
    if (hi.ns   >= 0) out.ns       = parseInt(cells[hi.ns]) || 0;
    if (hi.p    >= 0) out.p        = parseInt(cells[hi.p])  || 0;
    // Place: dedicated column or leading digits in first cell
    if (hi.place >= 0) out.place = parseInt(cells[hi.place]) || null;
    if (!out.place && cells.length) {
      const m = cells[0].match(/^(\d+)/);
      if (m) out.place = parseInt(m[1]);
    }
    // Match %: dedicated column or first cell matching "NN.NN"
    if (hi.pct >= 0) out.overall_pct = parseFloat(cells[hi.pct]);
    if (out.overall_pct == null || isNaN(out.overall_pct)) {
      for (const c of cells) {
        const m = c.match(/^(\d{1,3}\.\d{2,4})\s*%?$/);
        if (m) { out.overall_pct = parseFloat(m[1]); break; }
      }
    }
    return out;
  }

  // Stage navigation links on this page
  const stageLinks = [...document.querySelectorAll('a[href*="page=stage"]')]
    .reduce((acc, a) => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/page=stage(\d+)-(.+)$/);
      if (!m) return acc;
      const num = parseInt(m[1]);
      if (!acc.find(x => x.num === num)) acc.push({ num, href, text: a.textContent.trim() });
      return acc;
    }, []);

  const memUp  = (mem || '').toUpperCase();
  const raw    = (nm  || '').trim().toUpperCase();
  const parts  = raw.split(/[\s,]+/).filter(Boolean);
  const variants = new Set(raw ? [raw] : []);
  if (parts.length >= 2) {
    variants.add(`${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`);
    variants.add(`${parts[0]}, ${parts.slice(1).join(' ')}`);
    variants.add(parts.join(' '));
  }

  // Search by member number — exact cell match
  if (memUp) {
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
      const matched = hi.mem >= 0
        ? (cells[hi.mem] || '').toUpperCase() === memUp
        : cells.some(c => c.toUpperCase() === memUp);
      if (!matched) continue;
      return { _found: true, found_by: 'member_number', stageLinks, ...parseRow(row) };
    }
  }

  // Search by name — exact cell match, with/without leading "N." place prefix
  if (variants.size) {
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
      const cellsUp = cells.map(c => c.toUpperCase());
      const matched = [...variants].some(v =>
        cellsUp.some(c => c === v || c.replace(/^\d+[.\-]\s*/, '') === v)
      );
      if (!matched) continue;
      return { _found: true, found_by: 'name', stageLinks, ...parseRow(row) };
    }
  }

  return { _notFound: true, _rowCount: rows.length };
}

// ── Fetch match definition JSON from PractiScore S3 ──────────────────────────
// Returns a Map<stageNum (1-based), { is_classifier: bool, classifier_code: string|null }>
// or null if the fetch fails or the data is unusable.
async function fetchMatchDef(matchId, push) {
  const url = `https://s3.amazonaws.com/ps-scores/production/${matchId}/match_def.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) { if (res.status !== 403) push(`     match_def: HTTP ${res.status}`); return null; }
    const def = await res.json();
    const raw = def.match_stages || def.stages;
    if (!Array.isArray(raw) || !raw.length) { push('     match_def: no stages array'); return null; }

    // Log the first stage's full key set so we can identify the real field names
    console.log('[PScharts] match_def stage[0] keys:', Object.keys(raw[0]));
    console.log('[PScharts] match_def stage[0]:', JSON.stringify(raw[0]));

    const map = new Map();
    raw.forEach((s, idx) => {
      // Stage number: prefer explicit field, fall back to 1-based index
      const num = s.stage_number ?? s.stage_num ?? (idx + 1);

      // Classifier flag — PractiScore uses various field names; check all known variants
      const isClf = !!(s.stage_classifiers || s.stage_classifier || s.classifiers || s.classifier);

      // Classifier code (e.g. "99-11") — check known field name variants
      const code = s.stage_classifier_id ?? s.stage_classifiercode ?? s.classifier_id
                ?? s.classifiercode ?? s.classifier_code ?? null;

      map.set(num, { is_classifier: isClf || !!code, classifier_code: code || null });
    });
    push(`     match_def: ${raw.length} stage(s), ${[...map.values()].filter(v => v.is_classifier).length} classifier(s)`);
    return map;
  } catch (e) {
    push(`     match_def: ${e.message}`);
    return null;
  }
}

// ── Fetch stage stats via #resultLevel dropdown (tab already on results/new) ───
async function fetchStageData(tabId, matchId, memberNumber, name, divKey, stageOptions, push, classifierMap) {
  if (!stageOptions || !stageOptions.length) {
    push('     no stage options found');
    return null;
  }

  push(`     fetching ${stageOptions.length} stage(s)…`);
  const stages = [];

  for (const opt of stageOptions) {
    // Switch #resultLevel to this stage (division is already set from fetchMatchScore)
    await runInTab(tabId, setSelectAndFire, ['resultLevel', opt.href || opt.value || opt.text]);
    await sleep(900);

    // Wait for re-render
    let page = null;
    for (let i = 0; i < 6; i++) {
      page = await runInTab(tabId, getResultsNewState, [memberNumber || '', name || '']);
      if (page._loading) { await sleep(1000); continue; }
      break;
    }

    if (!page?._found) { push(`     ${opt.text}: not found`); continue; }

    const d = page.competitorData;
    const stageName = opt.text.replace(/^stage\s*\d+\s*[:\-–]\s*/i, '').trim() || opt.text;
    const stageNum  = parseInt(opt.text.match(/\d+/)?.[0]) || stages.length + 1;

    stages.push({
      name:            stageName,
      num:             stageNum,
      time:            d.time ?? null,
      hf:              d.hf   ?? null,
      pct:             d.overall_pct ?? null,
      a:               d.a  ?? 0,
      c:               d.c  ?? 0,
      d:               d.d  ?? 0,
      m:               d.m  ?? 0,
      ns:              d.ns ?? 0,
      p:               d.p  ?? 0,
      is_classifier:   null,
      classifier_code: null,
    });
    push(`     ${opt.text}: ${d.hf?.toFixed(4) ?? '?'} HF  ${d.overall_pct?.toFixed(1) ?? '?'}%`);
  }

  return stages.length ? stages : null;
}

// ── USPSA.org classification page scraper ─────────────────────────────────────
// Injected into uspsa.org/classification/[memberNumber]
function scrapeUSPSAClassificationPage() {
  const url = window.location.href;

  // Login detection
  if (/[/]login|[/]signin|[?]redirect/i.test(url) ||
      document.querySelector('input[name="password"], #loginForm, form[action*="login"]')) {
    return { _not_logged_in: true };
  }

  const divisions  = {};
  const classifiers = [];

  // ── Table: Classifications (table with "Classifications" th and division TH-in-row structure)
  // Structure: tbody rows each have a <th> (division name) + <td> cells like "Class: U", "Pct: 0.0000"
  for (const table of document.querySelectorAll('table')) {
    const allThs = [...table.querySelectorAll('th')].map(th => th.textContent.trim());
    if (!allThs.includes('Classifications')) continue;
    for (const row of table.querySelectorAll('tbody tr')) {
      const divTh = row.querySelector('th');
      if (!divTh) continue;
      const divName = divTh.textContent.trim();
      const cells   = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
      const classCell = cells.find(c => /^class:/i.test(c));
      const pctCell   = cells.find(c => /^pct:/i.test(c));
      if (!classCell && !pctCell) continue;
      divisions[divName] = {
        class_: classCell ? classCell.replace(/^class:\s*/i, '').trim() : null,
        pct:    pctCell   ? parseFloat(pctCell.replace(/^pct:\s*/i, '')) || null : null,
      };
    }
  }

  // ── Table: "[Division] Classifiers" — single <th> header, first tbody row is col headers
  // e.g. "Carry Optics Classifiers (Click to Expand)"
  for (const table of document.querySelectorAll('table')) {
    const thText  = table.querySelector('th')?.textContent?.trim() || '';
    const divMatch = thText.match(/^(.+?)\s+Classifiers\b/i);
    if (!divMatch) continue;
    const divName = divMatch[1].trim();
    const allRows = [...table.querySelectorAll('tbody tr')];
    if (allRows.length < 2) continue;

    // First tbody row contains column header labels as <td> elements
    const colHeaders = [...allRows[0].querySelectorAll('td')]
      .map(td => td.textContent.trim().toLowerCase());
    const iDate = colHeaders.indexOf('date');
    const iNum  = colHeaders.indexOf('number');
    const iPct  = colHeaders.indexOf('percent');
    const iHF   = colHeaders.indexOf('hf');
    const iFlag = colHeaders.indexOf('f');
    const iClub = colHeaders.indexOf('club');

    for (const row of allRows.slice(1)) {
      const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
      if (!cells.length) continue;
      classifiers.push({
        date:     iDate >= 0 ? cells[iDate] : null,
        code:     iNum  >= 0 ? cells[iNum]  : null,
        pct:      iPct  >= 0 ? parseFloat(cells[iPct])  || null : null,
        hf:       iHF   >= 0 ? parseFloat(cells[iHF])   || null : null,
        flag:     iFlag >= 0 ? cells[iFlag] : null,  // Y=counts, U=unpaid, P=pending
        club:     iClub >= 0 ? cells[iClub] : null,
        division: divName,
      });
    }
  }

  // Division select options — used by fetchUSPSAClassification for calculator loop
  const divSelect = (() => {
    const s = document.getElementById('calc_selDiv');
    return s ? [...s.options].map(o => ({ value: o.value, text: o.textContent.trim() })) : [];
  })();

  return { divisions, classifiers, divSelect };
}

// Injected: selects a division in the Classification Calculator and clicks Calculate.
function triggerClassificationCalculator(divValue) {
  const sel = document.getElementById('calc_selDiv');
  if (!sel) return false;
  sel.value = divValue;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const calcBtn = [...document.querySelectorAll('button, input[type="button"]')]
    .find(b => /^calculate$/i.test(b.textContent.trim()) || /^calculate$/i.test(b.value));
  if (calcBtn) { calcBtn.click(); return true; }
  return false;
}

// Injected: reads the Classification Calculator result after it renders.
// Captures whatever text/elements changed — we log it so we can refine the parser.
function readCalculatorResult() {
  // Capture the full result area — try several common selectors
  const selectors = [
    '#calcResult', '#calc_result', '.calc-result', '.classification-result',
    '#classificationResult', '[id*="result"]', '[class*="result"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) {
      return { selector: sel, html: el.innerHTML, text: el.textContent.replace(/\s+/g,' ').trim() };
    }
  }
  // Fallback: capture text near the Calculate button
  const calcBtn = [...document.querySelectorAll('button')]
    .find(b => /^calculate$/i.test(b.textContent.trim()));
  if (calcBtn) {
    const container = calcBtn.closest('div, section, form') || calcBtn.parentElement;
    return { selector: 'parent', html: container?.innerHTML, text: container?.textContent.replace(/\s+/g,' ').trim().slice(0, 400) };
  }
  return null;
}

// Fetches USPSA classification for the given member number.
// Returns { divisions, classifiers } or { _not_logged_in: true } or null on error.
async function fetchUSPSAClassification(memberNumber, push) {
  if (!memberNumber) return null;
  let tabId = null;
  try {
    push('Fetching USPSA classification…');
    const tab = await chrome.tabs.create({
      url: `${USPSA_BASE}/classification/${memberNumber}`,
      active: false,
    });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    await sleep(2000);

    const state = await runInTab(tabId, scrapeUSPSAClassificationPage);

    if (state?._not_logged_in) {
      push('  Not logged into USPSA.org — classification data unavailable');
      return { _not_logged_in: true };
    }

    // Log compact debug info — tables and division select only
    console.log('[PScharts] USPSA page debug:', JSON.stringify(state._debug, null, 2));
    // Log the actual parsed classifier records so we can verify dates/pcts/codes
    console.log('[PScharts] USPSA classifiers parsed:', JSON.stringify(state.classifiers, null, 2));

    const clf = state?.classifiers?.length ?? 0;
    push(`  Found ${clf} classifier record(s) for ${memberNumber}`);

    // ── Classification Calculator: iterate each division to get D-GM class ──────
    const divOptions = state._debug?.divSelect || [];
    const divClassifications = { ...state.divisions };

    for (const opt of divOptions) {
      const triggered = await runInTab(tabId, triggerClassificationCalculator, [opt.value]);
      if (!triggered) { push(`  Calculator not found — skipping division loop`); break; }
      await sleep(1200);
      const result = await runInTab(tabId, readCalculatorResult);
      console.log(`[PScharts] Calculator result for ${opt.text}:`, JSON.stringify(result));
      if (result?.text) push(`  ${opt.text}: ${result.text.slice(0, 80)}`);
    }

    return { classifiers: state.classifiers, divisions: divClassifications } ?? null;

  } catch (e) {
    push(`  USPSA classification error: ${e.message}`);
    return null;
  } finally {
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ── Fetch all match scores ────────────────────────────────────────────────────
async function fetchScores(memberNumber, name) {
  const log = [];
  const push = m => { log.push(m); console.log('[PScharts]', m); };
  let tabId = null;

  try {
    push('Loading match history…');
    const tab = await chrome.tabs.create({ url: `${PS_BASE}/associate/step2`, active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    await sleep(2500);

    // Check PractiScore login — if redirected away from associate page, not logged in
    const psTab = await chrome.tabs.get(tabId);
    if (psTab.url && !psTab.url.includes('practiscore.com/associate')) {
      push('Not logged into PractiScore — please log in at practiscore.com and try again.');
      return { results: [], log, _not_logged_in_ps: true };
    }

    const rawMatchList = await runInTab(tabId, extractMatchList);
    push(`Found ${rawMatchList.length} match(es).`);
    console.log('[PScharts] matchList:', JSON.stringify(rawMatchList, null, 2));

    if (rawMatchList.length === 0) {
      push('No matches found — are you logged into PractiScore?');
      return { results: [], log };
    }

    // Annotate every match with its detected type
    const matchList = rawMatchList.map(m => ({ ...m, match_type: detectMatchType(m.match_name) }));

    // Level 1: skip confirmed non-USPSA matches before fetching scores
    const uspsaMatches = matchList.filter(m => isLikelyUSPSA(m.match_type));
    const skipped = matchList.length - uspsaMatches.length;
    if (skipped > 0) {
      const names = matchList.filter(m => !isLikelyUSPSA(m.match_type)).map(m => `${m.match_name} (${m.match_type})`).join(', ');
      push(`Skipping ${skipped} non-USPSA match(es): ${names}`);
    }

    // Save ALL matches (with types) so users can see and manage their full history
    await chrome.storage.local.set({ lastMatchList: matchList });

    push('Fetching scores…');
    const cache = await getCache();
    const results = [];

    // Include non-USPSA matches in results (without scores) for history display
    for (const m of matchList.filter(m => !isLikelyUSPSA(m.match_type))) {
      results.push(buildResult(m, {}, memberNumber));
    }

    for (let i = 0; i < uspsaMatches.length; i++) {
      const match = uspsaMatches[i];
      push(`  → [${i + 1}/${uspsaMatches.length}] ${match.match_name} (${match.date})`);

      const cached = cache[match.match_id];
      // Only use cache if it was fetched for the same member number
      if (cached && cached.cached_for === (memberNumber || '').toUpperCase()) {
        push('     (cached)');
        results.push({ ...match, ...cached, _cached: true });
        continue;
      }

      const score  = await fetchMatchScore(tabId, match.match_id, memberNumber, name, push);

      // Override match type with the confirmed value read from the results page
      if (score._pageMatchType) match.match_type = score._pageMatchType;

      const classifierMap = score.overall_pct != null
        ? await fetchMatchDef(match.match_id, push)
        : null;
      const stages = score.overall_pct != null
        ? await fetchStageData(tabId, match.match_id, memberNumber, name, score._divKey, score._stageOptions, push, classifierMap)
        : null;
      const result = buildResult(match, { ...score, stages }, memberNumber);
      // Only cache when a score was actually found — prevents cache poisoning from wrong credentials
      if (result.overall_pct != null) {
        await updateMatchCache(match.match_id, result);
      }
      results.push({ ...result, _cached: false });

      push(`     score: ${score.overall_pct != null ? score.overall_pct + '%' : 'not found'} [${score.found_by || 'none'}]`);
    }

    // Re-save lastMatchList with any match_type values confirmed from the results pages
    await chrome.storage.local.set({ lastMatchList: matchList });

    const n = results.filter(r => r.overall_pct != null).length;
    push(`Done — ${n}/${uspsaMatches.length} matches with scores.`);

    // Fetch USPSA classification only if at least one scored match was found
    let classificationData = null;
    let _not_logged_in_uspsa = false;
    if (memberNumber && n > 0) {
      const clfResult = await fetchUSPSAClassification(memberNumber, push);
      if (clfResult?._not_logged_in) {
        _not_logged_in_uspsa = true;
      } else if (clfResult) {
        classificationData = { ...clfResult, member_number: memberNumber, updated_at: Date.now() };
        await chrome.storage.local.set({ classificationData });
      }
    }

    return { results, log, classificationData, _not_logged_in_uspsa };

  } finally {
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ── Refresh a single match ────────────────────────────────────────────────────
async function refreshMatch(match, memberNumber, name) {
  const log = [];
  const push = m => { log.push(m); console.log('[PScharts]', m); };
  let tabId = null;

  try {
    push(`Refreshing ${match.match_name}…`);
    const tab = await chrome.tabs.create({
      url: `${PS_BASE}/results/new/${match.match_id}`,
      active: false,
    });
    tabId = tab.id;
    await waitForTabLoad(tabId);

    const score  = await fetchMatchScore(tabId, match.match_id, memberNumber, name, push);
    if (score._pageMatchType) match.match_type = score._pageMatchType;
    const classifierMap = score.overall_pct != null
      ? await fetchMatchDef(match.match_id, push)
      : null;
    const stages = score.overall_pct != null
      ? await fetchStageData(tabId, match.match_id, memberNumber, name, score._divKey, score._stageOptions, push, classifierMap)
      : null;
    const result = buildResult(match, { ...score, stages }, memberNumber);
    if (result.overall_pct != null) {
      await updateMatchCache(match.match_id, result);
    }

    // Persist confirmed match type back to lastMatchList
    if (score._pageMatchType) {
      const stored = await chrome.storage.local.get('lastMatchList');
      const list = stored.lastMatchList || [];
      const idx = list.findIndex(m => m.match_id === match.match_id);
      if (idx >= 0) { list[idx].match_type = score._pageMatchType; await chrome.storage.local.set({ lastMatchList: list }); }
    }

    push(`Done — ${score.overall_pct != null ? score.overall_pct + '%' : 'not found'} [${score.found_by || 'none'}]`);
    return { result: { ...result, _cached: false }, log };

  } finally {
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ── Fetch score from results/new/{matchId} ────────────────────────────────────
async function fetchMatchScore(tabId, matchId, memberNumber, name, push) {
  const url = `${PS_BASE}/results/new/${matchId}`;

  await chrome.tabs.update(tabId, { url });
  await waitForTabLoad(tabId);
  await sleep(1500);

  // ── Step 1: wait for page to render, find competitor in default (combined) view ──
  let state = null;
  for (let i = 0; i < 10; i++) {
    state = await runInTab(tabId, getResultsNewState, [memberNumber || '', name || '']);
    if (state._cf)      { push(`     CF — waiting (${i + 1})`); await sleep(3000); continue; }
    if (state._loading) { await sleep(1500); continue; }
    break;
  }

  if (!state?._ready) {
    push(`     results/new did not load: ${state?._debug || 'unknown'}`);
    return {};
  }

  // Capture confirmed match type from the page (available regardless of whether competitor was found)
  const _pageMatchType = state.pageMatchType || null;
  if (_pageMatchType) push(`     page type: ${_pageMatchType}`);

  if (!state._found) {
    push(`     not found in combined view (${state._rowCount} rows, headers: [${state._headers?.join(', ')}])`);
    return { _pageMatchType };
  }

  const division = state.competitorData.division;
  push(`     found via ${state.found_by} — div: ${division}`);

  // ── Step 2: ensure #resultLevel = Overall ────────────────────────────────
  const overallOpt = state.resultLevelOptions.find(o =>
    /^(overall|match)$/i.test(o.text.trim())
  );
  if (overallOpt) {
    await runInTab(tabId, setSelectAndFire, ['resultLevel', overallOpt.value]);
    await sleep(600);
  }

  // ── Step 3: set #divisionLevel to the competitor's division ──────────────
  const divKey  = divisionToUrlKey(division);
  const divOpt  = state.divisionOptions.find(o => {
    const t = o.text.toLowerCase().replace(/\s+/g, '');
    const v = (o.value || '').toLowerCase().replace(/\s+/g, '');
    return t.includes(divKey) || v.includes(divKey) ||
           t === division.toLowerCase() || v === division.toLowerCase();
  });

  if (divOpt) {
    push(`     setting division: "${divOpt.text}" (value="${divOpt.value}")`);
    await runInTab(tabId, setSelectAndFire, ['divisionLevel', divOpt.value]);
    await sleep(1000);
  } else {
    push(`     no matching division option found for "${division}" — reading combined stats`);
  }

  // ── Step 4: read competitor's stats from the now-filtered division view ──
  let finalState = null;
  for (let i = 0; i < 6; i++) {
    finalState = await runInTab(tabId, getResultsNewState, [memberNumber || '', name || '']);
    if (finalState._loading) { await sleep(1200); continue; }
    break;
  }

  if (!finalState?._found) {
    push(`     not found after division filter — falling back to combined stats`);
    finalState = state;
  }

  const d = finalState.competitorData;
  push(`     overall_pct=${d.overall_pct}  place=${d.place}/${d.total}`);

  // Collect stage options (everything in #resultLevel that isn't Overall/Match)
  const stageOptions = (finalState.resultLevelOptions || state.resultLevelOptions)
    .filter(o => /stage\s*\d+/i.test(o.text));

  return {
    overall_pct: d.overall_pct,
    div_pct:     d.overall_pct,
    div_place:   d.place,
    div_total:   d.total,
    place:       d.place,
    total:       d.total,
    division,
    class_:      d.class_,
    hf:          d.hf,
    found_by:    state.found_by,
    _pageMatchType,
    _divOpt:     divOpt,
    _stageOptions: stageOptions,
    _divKey:     divKey,
    _stageLinks: stageOptions.map((o, i) => ({ num: i, href: o.value, text: o.text })),
  };
}

// ── Extract match list from /associate/step2 ─────────────────────────────────
function extractMatchList() {
  const DATE_FULL   = /^\d{4}-\d{2}-\d{2}$/;
  const UUID_FULL   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const UUID_SEARCH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  const uuidByDate = new Map();
  for (const script of document.querySelectorAll('script:not([src])')) {
    const text = script.textContent;
    if (!text.includes('-')) continue;
    for (const m of text.matchAll(/\{[^{}]{5,2000}\}/g)) {
      try {
        const obj  = JSON.parse(m[0]);
        const vals = Object.values(obj).filter(v => typeof v === 'string');
        const uuid = vals.find(v => UUID_FULL.test(v));
        const date = vals.find(v => DATE_FULL.test(v));
        if (uuid && date && !uuidByDate.has(date)) uuidByDate.set(date, uuid.toLowerCase());
      } catch (_) {}
    }
  }

  const nameByDate = new Map();
  for (const row of document.querySelectorAll('tr')) {
    const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
    const date  = cells.find(c => DATE_FULL.test(c));
    if (!date) continue;
    const name  = cells.find(c => c !== date && c.length > 3 && !UUID_FULL.test(c));
    if (name && !nameByDate.has(date)) nameByDate.set(date, name);
  }

  const results = [];
  for (const [date, uuid] of uuidByDate) {
    results.push({ match_id: uuid, match_name: nameByDate.get(date) || `Match ${uuid.substring(0, 8)}`, date });
  }

  if (results.length === 0 && nameByDate.size > 0) {
    const uuids = [...new Set([...document.body.innerHTML.matchAll(UUID_SEARCH)].map(m => m[0].toLowerCase()))];
    [...nameByDate.entries()].forEach(([date, name], i) => {
      if (uuids[i]) results.push({ match_id: uuids[i], match_name: name, date });
    });
  }

  return results;
}
