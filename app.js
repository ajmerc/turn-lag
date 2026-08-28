/* Turn Lag — turn-taking timing visualizer. No build step, no dependencies. */
(function () {
  'use strict';

  // ============================================================
  // Core logic: parsing + turn-taking metrics
  // ============================================================

  function parseTimeToMs(str) {
    str = String(str).trim().replace(',', '.'); // SRT uses a comma decimal separator
    if (/^-?\d+(\.\d+)?$/.test(str)) return parseFloat(str) * 1000;
    const parts = str.split(':');
    let sec = 0;
    for (const p of parts) sec = sec * 60 + parseFloat(p);
    return sec * 1000;
  }

  function msToClock(ms) {
    const sign = ms < 0 ? '-' : '';
    ms = Math.abs(ms);
    const totalSec = ms / 1000;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n, w) => String(n).padStart(w, '0');
    if (h > 0) return `${sign}${pad(h, 2)}:${pad(m, 2)}:${pad(Math.floor(s), 2)}`;
    return `${sign}${pad(m, 2)}:${pad(Math.floor(s), 2)}.${pad(Math.round((s % 1) * 10), 1)}`;
  }

  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '—';
    const sign = ms < 0 ? '−' : '';
    return `${sign}${Math.round(Math.abs(ms))} ms`;
  }

  // Parses both WebVTT (.vtt) and SubRip (.srt) cue blocks — the two formats
  // share the same "block of lines, blank line, block of lines" shape and
  // only really differ in the header line and the timestamp's decimal mark
  // (. for VTT, , for SRT), both handled below.
  function parseSubtitleCues(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let cur = [];
    for (const line of lines) {
      if (line.trim() === '') {
        if (cur.length) blocks.push(cur);
        cur = [];
      } else {
        cur.push(line);
      }
    }
    if (cur.length) blocks.push(cur);

    const entries = [];
    const timeRe = /(\S+)\s*-->\s*(\S+)/;
    for (const block of blocks) {
      if (block[0] && block[0].trim().toUpperCase().startsWith('WEBVTT')) continue;
      if (block[0] && block[0].trim().toUpperCase().startsWith('NOTE')) continue;
      const timeLineIdx = block.findIndex((l) => timeRe.test(l));
      if (timeLineIdx === -1) continue;
      const m = block[timeLineIdx].match(timeRe);
      const start = parseTimeToMs(m[1]);
      const end = parseTimeToMs(m[2]);
      const textLines = block.slice(timeLineIdx + 1);
      const raw = textLines.join(' ').trim();
      let speaker = null;
      let text = raw;
      const vMatch = raw.match(/^<v\s+([^>]+)>\s*(.*)$/i);
      const bracketMatch = raw.match(/^\[([^\]]{1,40})\]:?\s*(.*)$/);
      const colonMatch = raw.match(/^([A-Za-z0-9 ._'()-]{1,40}):\s*(.*)$/);
      if (vMatch) {
        speaker = vMatch[1].trim();
        text = vMatch[2].replace(/<\/v>/gi, '').trim();
      } else if (bracketMatch) {
        speaker = bracketMatch[1].trim();
        text = bracketMatch[2].trim();
      } else if (colonMatch) {
        speaker = colonMatch[1].trim();
        text = colonMatch[2].trim();
      }
      text = text.replace(/<[^>]*>/g, '').trim();
      if (!speaker) speaker = 'Unknown';
      if (start == null || end == null || isNaN(start) || isNaN(end)) continue;
      entries.push({ speaker, start, end, text });
    }
    return entries;
  }

  function parseCSVLine(line) {
    const out = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(field); field = ''; }
      else field += c;
    }
    out.push(field);
    return out;
  }

  function parseCSV(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return [];
    const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
    const idx = {
      speaker: header.indexOf('speaker'),
      start: header.indexOf('start'),
      end: header.indexOf('end'),
      text: header.indexOf('text'),
    };
    if (idx.start === -1 || idx.end === -1) {
      throw new Error('CSV must have start and end columns (speaker and text are both optional).');
    }
    const entries = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 2) continue;
      const speaker = idx.speaker !== -1 ? (cols[idx.speaker] || 'Unknown').trim() : 'Unknown';
      const start = parseTimeToMs(cols[idx.start]);
      const end = parseTimeToMs(cols[idx.end]);
      const text = idx.text !== -1 ? (cols[idx.text] || '').trim() : '';
      if (isNaN(start) || isNaN(end)) continue;
      entries.push({ speaker, start, end, text });
    }
    return entries;
  }

  function mergeTurns(entries, mergeGapMs) {
    const sorted = [...entries].sort((a, b) => a.start - b.start);
    const turns = [];
    for (const e of sorted) {
      const last = turns[turns.length - 1];
      if (last && last.speaker === e.speaker && (e.start - last.end) <= mergeGapMs) {
        last.end = Math.max(last.end, e.end);
        last.text = (last.text + ' ' + e.text).trim();
      } else {
        turns.push({ ...e });
      }
    }
    return turns;
  }

  // Some transcription tools bundle several quick, short answers spoken in
  // rapid succession (e.g. a run of "True"/"False" judgments with barely
  // any pause between them) into a single long cue instead of one cue per
  // word. Runs after mergeTurns: any turn whose *entire* text is just a
  // whitespace-separated run of the given tokens (2 or more) gets split
  // into one turn per token, with its time span divided evenly. A turn
  // that doesn't match is left untouched. No tokens configured = no-op.
  function splitAnswerTurns(turns, tokens) {
    const tokenSet = new Set(tokens.map((t) => t.trim().toLowerCase()).filter(Boolean));
    if (!tokenSet.size) return turns;
    const out = [];
    for (const t of turns) {
      const words = t.text.trim().split(/\s+/).filter(Boolean);
      const normWords = words.map((w) => w.replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase());
      const allMatch = words.length >= 2 && normWords.every((w) => tokenSet.has(w));
      if (!allMatch) { out.push(t); continue; }
      const span = (t.end - t.start) / words.length;
      words.forEach((w, i) => {
        out.push({ speaker: t.speaker, start: t.start + i * span, end: t.start + (i + 1) * span, text: w });
      });
    }
    return out;
  }

  function computeSpeakerStats(turns) {
    const bySpeaker = {};
    for (const t of turns) {
      if (!bySpeaker[t.speaker]) bySpeaker[t.speaker] = { speaker: t.speaker, count: 0, totalMs: 0 };
      bySpeaker[t.speaker].count++;
      bySpeaker[t.speaker].totalMs += (t.end - t.start);
    }
    const totalTalkMs = Object.values(bySpeaker).reduce((s, x) => s + x.totalMs, 0);
    return Object.values(bySpeaker)
      .map((s) => ({ ...s, avgMs: s.totalMs / s.count, pct: totalTalkMs ? (s.totalMs / totalTalkMs) * 100 : 0 }))
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  // Floor-transfer-offset (FTO) methodology: compare each turn to the one
  // immediately before it. A speaker switch yields an FTO (gap>=0 pause,
  // gap<0 overlap). Same-speaker adjacency yields a self-pause instead.
  function computeTransitions(turns) {
    const transitions = [];
    const selfPauses = [];
    for (let i = 1; i < turns.length; i++) {
      const prev = turns[i - 1];
      const cur = turns[i];
      const gap = cur.start - prev.end;
      if (cur.speaker === prev.speaker) selfPauses.push(gap);
      else transitions.push({ fromSpeaker: prev.speaker, toSpeaker: cur.speaker, start: cur.start, end: cur.end, gap, isOverlap: gap < 0 });
    }
    return { transitions, selfPauses };
  }

  function summarizeTransitions(transitions) {
    if (!transitions.length) {
      return { count: 0, overlapCount: 0, overlapRate: 0, meanFTO: null, medianFTO: null, meanOverlapMs: null, longestPauseMs: null, longestOverlapMs: null };
    }
    const overlaps = transitions.filter((t) => t.isOverlap);
    const pauses = transitions.filter((t) => !t.isOverlap).map((t) => t.gap).sort((a, b) => a - b);
    const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
    const median = (arr) => {
      if (!arr.length) return null;
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    };
    return {
      count: transitions.length,
      overlapCount: overlaps.length,
      overlapRate: (overlaps.length / transitions.length) * 100,
      meanFTO: mean(pauses),
      medianFTO: median(pauses),
      meanOverlapMs: overlaps.length ? mean(overlaps.map((t) => -t.gap)) : null,
      longestPauseMs: pauses.length ? pauses[pauses.length - 1] : null,
      longestOverlapMs: overlaps.length ? Math.max(...overlaps.map((t) => -t.gap)) : null,
    };
  }

  const HIST_BINS = [
    { lo: -Infinity, hi: -1000, label: '< −1000' },
    { lo: -1000, hi: -500, label: '−1000' },
    { lo: -500, hi: -200, label: '−500' },
    { lo: -200, hi: 0, label: '−200' },
    { lo: 0, hi: 200, label: '0' },
    { lo: 200, hi: 500, label: '200' },
    { lo: 500, hi: 1000, label: '500' },
    { lo: 1000, hi: 2000, label: '1000' },
    { lo: 2000, hi: Infinity, label: '> 2000' },
  ];

  function histogram(transitions) {
    const counts = HIST_BINS.map(() => 0);
    for (const t of transitions) {
      const idx = HIST_BINS.findIndex((b) => t.gap >= b.lo && t.gap < b.hi);
      if (idx !== -1) counts[idx]++;
    }
    return HIST_BINS.map((b, i) => ({ ...b, count: counts[i] }));
  }

  function simulateDelay(turns, speaker, delayMs) {
    if (!speaker || !delayMs) return turns;
    return turns.map((t) => (t.speaker === speaker ? { ...t, start: t.start + delayMs, end: t.end + delayMs } : { ...t }));
  }

  // ============================================================
  // Sample data
  // ============================================================

  const SAMPLE_VTT = `WEBVTT

1
00:00:00.200 --> 00:00:03.800
Priya: Okay so I finally got through the pilot data from last week's calls.

2
00:00:04.000 --> 00:00:06.200
Sam: Oh nice, how's it looking?

3
00:00:06.900 --> 00:00:11.400
Priya: Better than I expected honestly, but there's this one weird pattern in the Zoom condition.

4
00:00:11.600 --> 00:00:15.900
Sam: The delay condition specifically, or across the board?

5
00:00:16.700 --> 00:00:17.100
Priya: Mm.

6
00:00:16.850 --> 00:00:20.200
Sam: Because if it's across the board that changes how we write it up.

7
00:00:21.900 --> 00:00:26.500
Priya: No no, just delay. People's turn gaps basically double once we add the two hundred milliseconds.

8
00:00:27.300 --> 00:00:29.000
Sam: Right, that tracks with Torreira.

9
00:00:29.750 --> 00:00:34.600
Priya: Yeah exactly, and the overlap rate drops too, which is the part I didn't expect.

10
00:00:35.400 --> 00:00:37.100
Sam: Wait, it drops?

11
00:00:37.200 --> 00:00:41.900
Sam: I would've guessed more overlap, not less, if people can't hear the turn-final cues in time.

12
00:00:42.600 --> 00:00:47.800
Priya: That's what I thought too. My best guess is people are being more cautious, so they're waiting longer to jump in.

13
00:00:48.500 --> 00:00:49.900
Jordan: Sorry, can I jump in here?

14
00:00:50.100 --> 00:00:54.700
Jordan: Isn't that basically the audience-design story though, just applied to timing instead of word choice?

15
00:00:55.500 --> 00:00:56.900
Priya: Kind of, yeah.

16
00:00:57.600 --> 00:01:02.400
Priya: It's like people are adjusting their whole turn-taking strategy once they've picked up on the lag, not just reacting turn by turn.

17
00:01:03.900 --> 00:01:07.600
Sam: Okay so what does that mean for how we frame the discussion section?

18
00:01:11.200 --> 00:01:12.400
Priya: Give me a second, I'm pulling up the numbers.

19
00:01:16.800 --> 00:01:21.900
Priya: Median FTO in the no-delay condition is one ninety, in the delay condition it's four ten.

20
00:01:22.600 --> 00:01:23.400
Sam: Huge.

21
00:01:23.500 --> 00:01:27.800
Sam: That's a great headline number honestly, that alone is worth leading with.

22
00:01:27.750 --> 00:01:29.200
Jordan: Agreed, that's clean.

23
00:01:30.500 --> 00:01:35.900
Priya: Okay, I'll draft the results section tonight and send it over before the meeting tomorrow.

24
00:01:36.600 --> 00:01:38.000
Sam: Sounds good, talk then.
`;

  // ============================================================
  // App state & DOM wiring
  // ============================================================

  const SPEAKER_VARS = ['--speaker-1', '--speaker-2', '--speaker-3', '--speaker-4', '--speaker-5', '--speaker-6', '--speaker-7', '--speaker-8'];
  const css = getComputedStyle(document.documentElement);

  const state = { turns: [], transitions: [], selfPauses: [], summary: null, speakerStats: [], colorMap: {}, order: [] };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function colorVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function assignColors(turns) {
    const order = [];
    for (const t of turns) if (!order.includes(t.speaker)) order.push(t.speaker);
    const map = {};
    order.forEach((sp, i) => { map[sp] = colorVar(SPEAKER_VARS[i % SPEAKER_VARS.length]); });
    return { order, map };
  }

  // ---------- Tooltip ----------
  const tooltipEl = $('#tooltip');
  function showTooltip(x, y, html) {
    tooltipEl.innerHTML = html;
    tooltipEl.style.left = x + 'px';
    tooltipEl.style.top = (y - 10) + 'px';
    tooltipEl.classList.add('show');
  }
  function hideTooltip() { tooltipEl.classList.remove('show'); }

  // ---------- Tabs ----------
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach((b) => b.setAttribute('aria-selected', 'false'));
      btn.setAttribute('aria-selected', 'true');
      $$('.tab-panel').forEach((p) => p.classList.remove('active'));
      $(`.tab-panel[data-panel="${btn.dataset.tab}"]`).classList.add('active');
    });
  });

  // ---------- File upload ----------
  let uploadedText = null, uploadedIsCSV = false;
  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    uploadedIsCSV = /\.csv$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      uploadedText = reader.result;
      $('#fileStatus').textContent = `Loaded "${file.name}" (${(file.size / 1024).toFixed(1)} KB) — click Analyze.`;
      analyze();
    };
    reader.readAsText(file);
  });

  // ---------- Sample ----------
  $('#loadSampleBtn').addEventListener('click', () => {
    $('#pasteArea').value = SAMPLE_VTT;
    $$('.tab-btn')[0].click();
    analyze();
  });

  // ---------- Analyze ----------
  $('#analyzeBtn').addEventListener('click', analyze);
  $('#resetBtn').addEventListener('click', () => {
    $('#results').classList.remove('show');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  function showError(msg) {
    const box = $('#errorBox');
    if (!msg) { box.classList.remove('show'); box.textContent = ''; return; }
    box.textContent = msg;
    box.classList.add('show');
  }

  // Auto-detects and parses a transcript in whichever format it looks like
  // (WebVTT/SRT cues, or CSV rows). Throws with a user-facing message on
  // failure rather than returning an empty result silently.
  function parseEntriesFromText(text, forceCSV) {
    const looksLikeSubtitles = /-->/.test(text) || /^\s*WEBVTT/i.test(text);
    let entries = [];
    if (forceCSV) entries = parseCSV(text);
    else if (looksLikeSubtitles) entries = parseSubtitleCues(text);
    else entries = parseCSV(text);

    if (!entries.length && !looksLikeSubtitles && !forceCSV) entries = parseSubtitleCues(text); // last-ditch fallback
    if (!entries.length) throw new Error('Could not find any valid cues/rows. Check the format against the guide below.');
    return entries;
  }

  function analyze() {
    showError(null);
    const activeTab = $('.tab-btn[aria-selected="true"]').dataset.tab;
    let text, forceCSV = false;
    if (activeTab === 'upload') {
      if (!uploadedText) { showError('Choose a file first.'); return; }
      text = uploadedText;
      forceCSV = uploadedIsCSV;
    } else {
      text = $('#pasteArea').value;
    }
    if (!text || !text.trim()) { showError('Paste a transcript or load the sample conversation.'); return; }

    let entries;
    try {
      entries = parseEntriesFromText(text, forceCSV);
    } catch (err) {
      showError(err.message || String(err));
      return;
    }

    finishAnalyze(entries);
  }

  // ---------- Two speaker tracks ----------
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
      reader.readAsText(file);
    });
  }

  // Parses one speaker's own file and stamps every cue with that speaker's
  // label, overriding whatever (if anything) the file itself says — a
  // single-speaker track file doesn't need, and shouldn't need, its own
  // speaker tags.
  function parseTrackFile(text, filename, label) {
    if (!text || !text.trim()) throw new Error(`${label}'s file is empty.`);
    const forceCSV = /\.csv$/i.test(filename);
    let entries;
    try {
      entries = parseEntriesFromText(text, forceCSV);
    } catch (err) {
      throw new Error(`${label}: ${err.message || err}`);
    }
    return entries.map((e) => ({ ...e, speaker: label }));
  }

  $('#trackAFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    $('#trackAStatus').textContent = f ? `${f.name} (${(f.size / 1024).toFixed(1)} KB)` : 'No file chosen';
  });
  $('#trackBFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    $('#trackBStatus').textContent = f ? `${f.name} (${(f.size / 1024).toFixed(1)} KB)` : 'No file chosen';
  });

  $('#analyzeTracksBtn').addEventListener('click', async () => {
    showError(null);
    const fileA = $('#trackAFile').files[0];
    const fileB = $('#trackBFile').files[0];
    if (!fileA || !fileB) { showError('Choose a file for both Track A and Track B.'); return; }

    const labelA = ($('#trackALabel').value || '').trim() || 'Speaker A';
    const labelB = ($('#trackBLabel').value || '').trim() || 'Speaker B';
    if (labelA === labelB) { showError('Give the two tracks different speaker names.'); return; }

    let entries;
    try {
      const [textA, textB] = await Promise.all([readFileAsText(fileA), readFileAsText(fileB)]);
      const entriesA = parseTrackFile(textA, fileA.name, labelA);
      const entriesB = parseTrackFile(textB, fileB.name, labelB);
      entries = [...entriesA, ...entriesB];
    } catch (err) {
      showError(err.message || String(err));
      return;
    }

    finishAnalyze(entries);
  });

  // ---------- Shared tail: merge cues into turns, compute metrics, render ----------
  function finishAnalyze(entries) {
    const mergeGapMs = Math.max(0, parseInt($('#mergeGap').value, 10) || 0);
    let turns = mergeTurns(entries, mergeGapMs);
    const splitTokens = ($('#splitTokens').value || '').split(',').map((s) => s.trim()).filter(Boolean);
    turns = splitAnswerTurns(turns, splitTokens);
    if (turns.length < 2) { showError('Found fewer than two turns — need at least two to analyze timing.'); return; }

    const { transitions, selfPauses } = computeTransitions(turns);
    const summary = summarizeTransitions(transitions);
    const speakerStats = computeSpeakerStats(turns);
    const { order, map } = assignColors(turns);

    Object.assign(state, { turns, transitions, selfPauses, summary, speakerStats, colorMap: map, order });

    renderAll();
    $('#results').classList.add('show');
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ============================================================
  // Rendering
  // ============================================================

  function renderAll() {
    renderStats();
    renderSpeakers();
    renderTimeline();
    renderHistogram();
    renderSimulator();
    renderTable();
  }

  function renderStats() {
    const { turns, summary, speakerStats } = state;
    const duration = turns[turns.length - 1].end - Math.min(...turns.map((t) => t.start));
    const tiles = [
      { label: 'Speakers', value: speakerStats.length },
      { label: 'Turns', value: turns.length, sub: `${state.selfPauses.length} self-continuations` },
      { label: 'Duration', value: msToClock(duration) },
      { label: 'Turn switches', value: summary.count },
      { label: 'Overlap rate', value: summary.count ? summary.overlapRate.toFixed(0) + '%' : '—', sub: summary.overlapCount + ' overlaps' },
      { label: 'Mean FTO (pause)', value: fmtMs(summary.meanFTO) },
      { label: 'Median FTO', value: fmtMs(summary.medianFTO) },
      { label: 'Longest overlap', value: fmtMs(summary.longestOverlapMs) },
    ];
    $('#statGrid').innerHTML = tiles.map((t) => `
      <div class="stat-tile">
        <span class="stat-label">${t.label}</span>
        <span class="stat-value">${t.value}</span>
        ${t.sub ? `<span class="stat-sub">${t.sub}</span>` : ''}
      </div>`).join('');
  }

  function renderSpeakers() {
    const { speakerStats, colorMap } = state;
    $('#speakerList').innerHTML = speakerStats.map((s) => `
      <div class="speaker-row">
        <span class="speaker-name"><span class="swatch" style="background:${colorMap[s.speaker]}"></span>${escapeHtml(s.speaker)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${s.pct.toFixed(1)}%; background:${colorMap[s.speaker]}"></span></span>
        <span class="speaker-meta">${s.pct.toFixed(0)}% · ${s.count} turns</span>
      </div>`).join('');
  }

  function niceStep(rough) {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    for (const s of steps) if (s >= rough) return s;
    return steps[steps.length - 1];
  }

  function renderTimeline() {
    const { turns, order, colorMap } = state;
    const minStart = Math.min(...turns.map((t) => t.start));
    const maxEnd = Math.max(...turns.map((t) => t.end));
    const durationSec = (maxEnd - minStart) / 1000;
    const pxPerSec = Math.max(40, Math.min(140, 700 / Math.max(durationSec, 1)));

    const laneH = 44;
    const topPad = 10;
    const axisH = 28;
    const leftPad = 16;
    const svgW = leftPad * 2 + durationSec * pxPerSec + 20;
    const svgH = topPad + order.length * laneH + axisH;

    const x = (t) => leftPad + ((t - minStart) / 1000) * pxPerSec;
    const laneY = (i) => topPad + i * laneH;

    const gridStepSec = niceStep(durationSec / 9);
    let grid = '';
    for (let s = 0; s <= durationSec + 0.001; s += gridStepSec) {
      const gx = x(minStart + s * 1000);
      grid += `<line class="grid-line" x1="${gx}" y1="${topPad - 4}" x2="${gx}" y2="${topPad + order.length * laneH}" />`;
      grid += `<text x="${gx}" y="${topPad + order.length * laneH + 18}" font-size="10" text-anchor="middle">${msToClock(s * 1000)}</text>`;
    }

    let bars = '';
    let connectors = '';
    const laneIndex = {};
    order.forEach((sp, i) => (laneIndex[sp] = i));

    turns.forEach((t, i) => {
      const li = laneIndex[t.speaker];
      const bx = x(t.start);
      const bw = Math.max(3, x(t.end) - x(t.start));
      const by = laneY(li) + (laneH - 24) / 2;
      const dur = t.end - t.start;
      const tip = `${escapeHtml(t.speaker)} · ${msToClock(t.start)}–${msToClock(t.end)} (${Math.round(dur)}ms)`;
      bars += `<rect class="turn-bar" data-tip="${escAttr(tip)}" x="${bx}" y="${by}" width="${bw}" height="24" rx="4" fill="${colorMap[t.speaker]}" />`;
    });

    for (let i = 1; i < turns.length; i++) {
      const prev = turns[i - 1], cur = turns[i];
      if (prev.speaker === cur.speaker) continue;
      const li1 = laneIndex[prev.speaker], li2 = laneIndex[cur.speaker];
      const yA = laneY(li1) + laneH / 2, yB = laneY(li2) + laneH / 2;
      const gap = cur.start - prev.end;
      if (gap < 0) {
        const xa = x(cur.start), xb = x(prev.end);
        const yTop = Math.min(laneY(li1), laneY(li2));
        const yBot = Math.max(laneY(li1), laneY(li2)) + laneH;
        const tip = `overlap · ${Math.round(-gap)}ms`;
        connectors += `<rect class="gap-mark" data-tip="${escAttr(tip)}" x="${xa}" y="${yTop}" width="${Math.max(1, xb - xa)}" height="${yBot - yTop}" fill="var(--diverge-overlap)" opacity="0.16" />`;
      } else {
        const xa = x(prev.end), xb = x(cur.start);
        const tip = `pause · ${Math.round(gap)}ms`;
        connectors += `<line class="gap-mark" data-tip="${escAttr(tip)}" x1="${xa}" y1="${(yA + yB) / 2}" x2="${xb}" y2="${(yA + yB) / 2}" stroke="var(--diverge-pause)" stroke-width="2" stroke-dasharray="1,4" stroke-linecap="round" />`;
        connectors += `<circle class="gap-mark" data-tip="${escAttr(tip)}" cx="${xb}" cy="${(yA + yB) / 2}" r="5" fill="none" stroke="var(--diverge-pause)" stroke-width="1.5" />`;
      }
    }

    const svg = `<svg viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" role="img" aria-label="Turn-taking timeline">
      ${grid}
      ${connectors}
      ${bars}
    </svg>`;

    const labels = order.map((sp, i) => `
      <div class="timeline-label-row" style="height:${laneH}px;">
        <span class="swatch" style="background:${colorMap[sp]}"></span>${escapeHtml(sp)}
      </div>`).join('');

    $('#timelineWrap').innerHTML = `
      <div class="timeline-flex">
        <div class="timeline-labels" style="padding-top:${topPad}px;">${labels}</div>
        <div class="timeline-scroll">${svg}</div>
      </div>`;

    $('#timelineLegend').innerHTML = `
      <div class="legend-item"><span class="legend-swatch" style="background: var(--diverge-overlap); opacity:.5;"></span>overlap region</div>
      <div class="legend-item"><span class="legend-line"></span>pause before next turn</div>`;

    attachTooltips($('#timelineWrap'), '.turn-bar, .gap-mark');
  }

  function attachTooltips(root, selector) {
    $$(selector, root).forEach((el) => {
      el.addEventListener('mousemove', (e) => showTooltip(e.clientX, e.clientY, el.dataset.tip));
      el.addEventListener('mouseleave', hideTooltip);
    });
  }

  function renderHistogram() {
    const bins = histogram(state.transitions);
    const maxCount = Math.max(1, ...bins.map((b) => b.count));
    const niceMax = Math.max(1, Math.ceil(maxCount));

    const w = 460, h = 190, padL = 26, padB = 34, padT = 10, padR = 8;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const barGap = 6;
    const barW = (plotW - barGap * (bins.length - 1)) / bins.length;

    let bars = '', ticks = '';
    bins.forEach((b, i) => {
      const bh = (b.count / niceMax) * plotH;
      const bx = padL + i * (barW + barGap);
      const by = padT + plotH - bh;
      const isNeg = b.hi <= 0;
      const magnitude = Math.min(1, Math.abs((b.lo === -Infinity ? -2000 : b.lo) + (b.hi === Infinity ? 2000 : b.hi)) / 2 / 2000);
      const opacity = (0.45 + 0.55 * magnitude).toFixed(2);
      const color = isNeg ? 'var(--diverge-overlap)' : 'var(--diverge-pause)';
      const tip = `${b.label}${i < bins.length - 1 ? '–' + bins[i + 1].label : ''} ms · ${b.count} transition${b.count === 1 ? '' : 's'}`;
      bars += `<rect class="hist-bar" data-tip="${escAttr(tip)}" x="${bx}" y="${by}" width="${Math.max(1, barW)}" height="${Math.max(0, bh)}" rx="3" fill="${color}" opacity="${b.count ? opacity : 0.12}" />`;
      if (b.count > 0) bars += `<text x="${bx + barW / 2}" y="${by - 4}" font-size="10" text-anchor="middle">${b.count}</text>`;
      ticks += `<text x="${bx}" y="${h - padB + 13}" font-size="8.5" text-anchor="middle" transform="rotate(0 ${bx} ${h - padB + 13})">${b.label}</text>`;
    });

    const zeroX = padL + 4 * (barW + barGap);
    const svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Distribution of turn-transition gaps">
      <line class="axis-line" x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" />
      <line class="grid-line" x1="${zeroX}" y1="${padT}" x2="${zeroX}" y2="${padT + plotH}" stroke-dasharray="2,3" />
      ${bars}
      ${ticks}
      <text x="${padL}" y="${h - 4}" font-size="9" fill="var(--ink-muted)">ms</text>
    </svg>`;
    $('#histWrap').innerHTML = svg;
    attachTooltips($('#histWrap'), '.hist-bar');
  }

  function renderSimulator() {
    const sel = $('#simSpeaker');
    sel.innerHTML = state.order.map((sp) => `<option value="${escAttr(sp)}">${escapeHtml(sp)}</option>`).join('');
    const slider = $('#simDelay');
    slider.value = 0;
    $('#simDelayVal').textContent = '0 ms';
    updateSimulator();

    slider.oninput = updateSimulator;
    sel.onchange = updateSimulator;
  }

  function updateSimulator() {
    const speaker = $('#simSpeaker').value;
    const delay = parseInt($('#simDelay').value, 10) || 0;
    $('#simDelayVal').textContent = delay + ' ms';

    const delayedTurns = simulateDelay(state.turns, speaker, delay);
    const { transitions } = computeTransitions(delayedTurns);
    const simSummary = summarizeTransitions(transitions);
    const base = state.summary;

    const rows = [
      { label: 'Overlap rate', before: base.overlapRate, after: simSummary.overlapRate, fmt: (v) => v.toFixed(0) + '%', higherIsBad: true },
      { label: 'Mean FTO (pause)', before: base.meanFTO, after: simSummary.meanFTO, fmt: (v) => fmtMs(v), higherIsBad: null },
      { label: 'Overlap count', before: base.overlapCount, after: simSummary.overlapCount, fmt: (v) => String(v), higherIsBad: true },
      { label: 'Longest overlap', before: base.longestOverlapMs, after: simSummary.longestOverlapMs, fmt: (v) => fmtMs(v), higherIsBad: true },
    ];

    $('#deltaGrid').innerHTML = rows.map((r) => {
      const b = r.before == null ? 0 : r.before, a = r.after == null ? 0 : r.after;
      const diff = a - b;
      let cls = '', arrow = '';
      if (Math.abs(diff) > 0.5 && r.higherIsBad != null) {
        const bad = diff > 0 ? r.higherIsBad : !r.higherIsBad;
        cls = bad ? 'up' : 'down';
        arrow = diff > 0 ? '↑' : '↓';
      }
      return `<div class="delta-tile">
        <span class="stat-label">${r.label}</span>
        <span class="delta-val ${cls}">${r.fmt(r.after)} ${arrow ? `<span style="font-size:12px;">${arrow}</span>` : ''}</span>
        <span class="stat-sub">baseline ${r.fmt(r.before)}</span>
      </div>`;
    }).join('');
  }

  function renderTable() {
    const { turns } = state;
    const rows = turns.map((t, i) => {
      const prev = turns[i - 1];
      const gap = prev ? t.start - prev.end : null;
      const isSwitch = prev ? prev.speaker !== t.speaker : false;
      let flag = '—', flagSort = 0;
      if (prev) {
        if (isSwitch && gap < 0) { flag = `<span class="chip chip-overlap">overlap ${Math.round(-gap)}ms</span>`; flagSort = 2; }
        else if (isSwitch && gap >= 1000) { flag = `<span class="chip chip-pause">long pause ${Math.round(gap)}ms</span>`; flagSort = 1; }
        else if (isSwitch) { flag = `<span class="chip chip-normal">switch, ${Math.round(gap)}ms</span>`; }
        else { flag = `<span class="chip chip-normal">self, ${Math.round(gap)}ms</span>`; }
      }
      return { index: i + 1, speaker: t.speaker, start: t.start, end: t.end, duration: t.end - t.start, gap, flag, flagSort, text: t.text };
    });

    let sortKey = 'index', sortDir = 1;

    function draw() {
      const sorted = [...rows].sort((a, b) => {
        let av = a[sortKey], bv = b[sortKey];
        if (sortKey === 'gap') { av = av == null ? -Infinity : av; bv = bv == null ? -Infinity : bv; }
        if (sortKey === 'flag') { av = a.flagSort; bv = b.flagSort; }
        if (typeof av === 'string') return sortDir * av.localeCompare(bv);
        return sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
      });
      $('#turnsBody').innerHTML = sorted.map((r) => `
        <tr>
          <td class="mono">${r.index}</td>
          <td><span class="swatch" style="display:inline-block;background:${state.colorMap[r.speaker]};width:8px;height:8px;border-radius:2px;margin-right:6px;"></span>${escapeHtml(r.speaker)}</td>
          <td class="mono">${msToClock(r.start)}</td>
          <td class="mono">${msToClock(r.end)}</td>
          <td class="mono">${Math.round(r.duration)}ms</td>
          <td class="mono">${r.gap == null ? '—' : Math.round(r.gap) + 'ms'}</td>
          <td>${r.flag}</td>
          <td class="text-cell">${escapeHtml(r.text || '')}</td>
        </tr>`).join('');
    }

    $$('#turnsTable th[data-key]').forEach((th) => {
      th.onclick = () => {
        const key = th.dataset.key;
        sortDir = (sortKey === key) ? -sortDir : 1;
        sortKey = key;
        draw();
      };
    });

    draw();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escAttr(s) { return escapeHtml(s); }
})();
