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

// ── Module state ──────────────────────────────────────────────────────────────
let allResults       = [];
let currentView      = 'ranked'; // 'ranked' | 'all'
let deselectedMatches = new Set(); // match IDs manually excluded from charts

const NON_USPSA_TYPES = new Set(['IDPA', 'IPSC', 'Steel Challenge', '3-Gun', 'PCSL', 'ICORE']);
function isLikelyUSPSA(matchType) { return !NON_USPSA_TYPES.has(matchType); }

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
chrome.storage.local.get(['memberNumber', 'name', 'lastMatchList', 'matchCache', 'deselectedMatches'], d => {
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
      allResults = restored;
      renderAll();
      renderMatchList();
      const scored = restored.filter(r => r.overall_pct != null).length;
      const uspsa  = restored.filter(r => isLikelyUSPSA(r.match_type || 'Unknown')).length;
      setStatus(`Showing cached data — ${scored}/${uspsa} USPSA matches scored. Click Fetch Scores to check for new matches.`, 'success');
    }
  }
});

// ── View toggle ───────────────────────────────────────────────────────────────
document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    renderAll();
  });
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

    allResults = results;
    renderAll();
    renderMatchList();

    const uspsa  = results.filter(r => isLikelyUSPSA(r.match_type || 'Unknown')).length;
    const nonUspsa = results.length - uspsa;
    const scored = results.filter(r => r.overall_pct != null).length;
    const skippedNote = nonUspsa > 0 ? ` · ${nonUspsa} non-USPSA match(es) excluded from charts` : '';
    setStatus(`Loaded ${uspsa} USPSA match(es) — ${scored} with scores.${skippedNote}`, 'success');

  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    debugLogEl.textContent = err.stack || err.message;
    debugLogEl.style.display = 'block';
  } finally {
    fetchBtn.disabled = false;
  }
});

// ── Render charts + stats ─────────────────────────────────────────────────────
function renderAll() {
  if (!allResults.length) return;

  // Level 2 USPSA filter: only chart matches with likely-USPSA type
  // Also exclude matches the user has manually deselected
  const uspsaBase = allResults.filter(r =>
    isLikelyUSPSA(r.match_type || 'Unknown') &&
    !deselectedMatches.has(r.match_id)
  );

  // 'ranked' = confirmed by member number only
  // 'all'    = any match where a score was found (by member# or name)
  const chartable = currentView === 'ranked'
    ? uspsaBase.filter(r => r.found_by === 'member_number' && r.overall_pct != null)
    : uspsaBase.filter(r => r.overall_pct != null);

  const sorted = [...chartable].sort((a, b) => {
    const da = parseDate(a.date), db = parseDate(b.date);
    return (da && db) ? da - db : 0;
  });

  const placeData = sorted.filter(r => r.place != null);

  if (sorted.length > 0) {
    const avg  = sorted.reduce((s, r) => s + r.overall_pct, 0) / sorted.length;
    const best = Math.max(...sorted.map(r => r.overall_pct));
    const divs = [...new Set(sorted.map(r => r.division).filter(Boolean))];

    const avgBand  = CLASS_BANDS.find(b => avg  >= b.min && avg  < b.max);
    const bestBand = CLASS_BANDS.find(b => best >= b.min && best < b.max);

    document.getElementById('statMatches').textContent = sorted.length;
    document.getElementById('statAvg').textContent     = avg.toFixed(1) + '%';
    document.getElementById('statAvg').style.color     = avgBand?.text.replace('0.55','1') || '#4a9eff';
    document.getElementById('statBest').textContent    = best.toFixed(1) + '%';
    document.getElementById('statBest').style.color    = bestBand?.text.replace('0.55','1') || '#4a9eff';
    document.getElementById('statDiv').textContent     = divs[0] || '—';

    // Show current class in the Avg stat label
    const avgLbl = document.querySelector('#statMatches')?.closest('#stats')
      ?.querySelectorAll('.stat-box')[1]?.querySelector('.lbl');
    if (avgLbl) avgLbl.textContent = avgBand ? `Avg % · ${avgBand.label} Class` : 'Avg %';
    summaryBar.classList.add('visible');
    chartsEl.classList.add('visible');
  } else {
    summaryBar.classList.remove('visible');
    chartsEl.classList.remove('visible');
    return;
  }

  sizeCanvases();

  const DIV_PALETTE = ['#4a9eff','#4caf50','#ff9800','#e91e63','#9c27b0','#00bcd4','#ffeb3b'];

  // Group sorted results by division
  const byDiv = {};
  sorted.forEach(r => {
    const key = r.division || 'Unknown';
    if (!byDiv[key]) byDiv[key] = [];
    byDiv[key].push(r);
  });

  // All unique dates for shared X axis
  const allDates = [...new Set(sorted.map(r => r.date))].sort();

  const scoreSeries = Object.entries(byDiv).map(([div, matches], i) => ({
    label: div,
    color: DIV_PALETTE[i % DIV_PALETTE.length],
    points: matches.map(r => ({
      date:        r.date,
      y:           r.div_pct ?? r.overall_pct,
      label:       r.match_name,
      division:    r.division,
      class_:      r.class_,
      overall_pct: r.overall_pct,
      div_pct:     r.div_pct,
      place:       r.div_place ?? r.place,
      total:       r.div_total ?? r.total,
      foundBy:     r.found_by,
      stages:      r.stages || null,
    })),
  }));

  drawMultiSeriesChart(document.getElementById('chartTime'), scoreSeries, allDates, {
    yLabel: 'Division %', yMin: 0, yMax: 100, invertY: false, trend: true, valueUnit: '%',
    showClassBands: true,
  });

  const placeSeries = Object.entries(byDiv).map(([div, matches], i) => ({
    label: div,
    color: DIV_PALETTE[i % DIV_PALETTE.length],
    points: matches
      .filter(r => (r.div_place ?? r.place) != null)
      .map(r => ({
        date:       r.date,
        y:          r.div_place ?? r.place,
        label:      r.match_name,
        division:   r.division,
        class_:     r.class_,
        overall_pct: r.div_pct ?? r.overall_pct,
        total:      r.div_total ?? r.total,
        foundBy:    r.found_by,
      })),
  })).filter(s => s.points.length > 0);

  if (placeSeries.length > 0) {
    const allPlaceDates = [...new Set(placeSeries.flatMap(s => s.points.map(p => p.date)))].sort();
    drawMultiSeriesChart(document.getElementById('chartPlace'), placeSeries, allPlaceDates, {
      yLabel: 'Division Place', invertY: true, valueUnit: '',
    });
  } else {
    drawMessage(document.getElementById('chartPlace'), 'No placement data.');
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
    const isUSPSA    = isLikelyUSPSA(matchType);
    const isDeselected = deselectedMatches.has(match.match_id);
    const isExcluded = !isUSPSA || isDeselected;

    const dotClass = match.found_by === 'member_number' ? 'scored'
                   : match.found_by === 'name'          ? 'named'
                   : 'none';

    const scoreText = match.overall_pct != null
      ? `${match.overall_pct.toFixed(1)}%${match.division ? ' · ' + match.division : ''}${match.class_ ? '/' + match.class_ : ''}`
      : null;

    const metaParts = [match.date];
    if (match.fetched_at) metaParts.push(formatAge(match.fetched_at));
    if (match.found_by === 'name') metaParts.push('matched by name');
    if (hasStages) metaParts.push(`${match.stages.length} stages`);
    if (!isUSPSA) metaParts.push('excluded from charts');

    const typeBadgeClass = matchType === 'USPSA' ? 'type-uspsa'
                         : matchType === 'Unknown' ? 'type-unknown'
                         : 'type-other';

    const item = document.createElement('div');
    item.className = 'match-item' + (isExcluded ? ' excluded' : '');

    const row = document.createElement('div');
    row.className = 'match-row';
    row.dataset.matchId = match.match_id;
    row.innerHTML = `
      <input type="checkbox" class="match-include-cb" title="Include in charts"
        ${isDeselected ? '' : 'checked'}
        ${!isUSPSA ? 'disabled' : ''}>
      <div class="match-dot ${dotClass}"></div>
      <div class="match-info">
        <div class="match-name">${match.match_name}</div>
        <div class="match-meta">${metaParts.join(' · ')}</div>
      </div>
      <span class="match-type-badge ${typeBadgeClass}">${matchType}</span>
      <div class="match-score ${scoreText ? '' : 'none'}">${scoreText || 'No score'}</div>
      ${hasStages ? '<button class="expand-btn" title="Show stage breakdown">▼</button>' : ''}
      <button class="refresh-btn" title="Re-fetch this match">↻</button>
      <button class="delete-btn" title="Delete from history">✕</button>
    `;

    if (hasStages) {
      const panel = document.createElement('div');
      panel.className = 'stage-panel';
      panel.innerHTML = `
        <table class="stage-table">
          <thead><tr>
            <th>Stage</th>
            <th>Time</th>
            <th>HF</th>
            <th>%</th>
            <th class="col-a">A</th>
            <th class="col-c">C</th>
            <th class="col-d">D</th>
            <th class="col-m">M</th>
            <th class="col-ns">NS</th>
            <th class="col-p">P</th>
          </tr></thead>
          <tbody>
            ${match.stages.map(s => `<tr>
              <td>${s.name}</td>
              <td>${s.time != null ? s.time.toFixed(2) + 's' : '—'}</td>
              <td>${s.hf   != null ? s.hf.toFixed(4)         : '—'}</td>
              <td>${s.pct  != null ? s.pct.toFixed(1) + '%'  : '—'}</td>
              <td class="col-a">${s.a}</td>
              <td class="col-c">${s.c}</td>
              <td class="col-d">${s.d}</td>
              <td class="col-m">${s.m || '—'}</td>
              <td class="col-ns">${s.ns || '—'}</td>
              <td class="col-p">${s.p || '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      `;

      const toggleExpand = () => {
        const isOpen = panel.classList.toggle('open');
        item.classList.toggle('open', isOpen);
        row.querySelector('.expand-btn').textContent = isOpen ? '▲' : '▼';
      };

      row.style.cursor = 'pointer';
      row.addEventListener('click', e => {
        if (e.target.closest('.refresh-btn, .delete-btn, .match-include-cb')) return;
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
        const classBand = unit === '%'
          ? CLASS_BANDS.find(b => h.y >= b.min && h.y < b.max) : null;
        const classLabel = classBand
          ? `<span style="color:${classBand.text};font-size:10px;margin-left:6px">${classBand.label}</span>` : '';
        const mainVal = unit === '%'
          ? `<div class="tt-score" style="color:${h.color}">${h.y.toFixed(1)}%${classLabel} <span style="font-size:11px;color:#666">(div)</span></div>`
          : `<div class="tt-score" style="color:${h.color}">Place ${h.y}${h.total ? ' / ' + h.total : ''}</div>`;
        const divLine = (h.division || h.class_)
          ? `<div class="tt-meta">${[h.division, h.class_].filter(Boolean).join(' / ')}</div>` : '';
        const overallLine = (unit === '%' && h.overall_pct != null && Math.abs(h.overall_pct - h.y) > 0.1)
          ? `<div class="tt-meta">${h.overall_pct.toFixed(1)}% overall</div>` : '';
        const pctLine = (unit === '' && h.overall_pct != null)
          ? `<div class="tt-meta">${h.overall_pct.toFixed(1)}% score</div>` : '';
        const nameLine = h.foundBy === 'name'
          ? `<div class="tt-meta" style="color:#ff9800">matched by name</div>` : '';
        const seriesLine = (canvas._hitMap || []).some(x => x.seriesLabel !== h.seriesLabel)
          ? `<div class="tt-meta" style="color:${h.color}">${h.seriesLabel}</div>` : '';

        const stagesHtml = (h.stages && h.stages.length > 0)
          ? `<div class="tt-stages">${h.stages.map(s => `
              <div class="tt-stage-row">
                <span class="tt-stage-name">${s.name}</span>
                <span class="tt-stage-hf">${s.hf != null ? s.hf.toFixed(4) : '—'}</span>
                <span class="tt-stage-hits">${s.a}A ${s.c}C ${s.d}D${s.m ? ' <span style="color:#f44336">' + s.m + 'M</span>' : ''}${s.ns ? ' ' + s.ns + 'NS' : ''}${s.p ? ' ' + s.p + 'P' : ''}</span>
              </div>`).join('')}</div>` : '';

        tooltipEl.innerHTML = `
          <div class="tt-name">${h.label}</div>
          <div class="tt-date">${h.date || ''}</div>
          ${mainVal}${divLine}${overallLine}${pctLine}${seriesLine}${nameLine}${stagesHtml}
        `;
        const tw = 300, th = h.stages?.length ? 280 : 130;
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
