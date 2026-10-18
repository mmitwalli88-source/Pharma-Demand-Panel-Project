/* ===========================================================================
   Live Decision Dashboard - shared runtime.

   Every page loads this file, then calls LDD.start(render). The page supplies
   only its own render(data) function; polling, the live indicator, tooltips,
   theming, number formatting, the cross-filter engine and the chart primitives
   all live here so no page reimplements them.

   Nothing in here names a column of the dataset except through raw.fields,
   which the watcher publishes. No framework, no CDN, no build step.
   =========================================================================== */

const LDD = (() => {
  const POLL_MS = 500;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ------------------------------------------------------------ formatting */
  const nf = new Intl.NumberFormat('en-US');
  const fmt = {
    int: n => nf.format(Math.round(n)),
    egp: n => 'EGP ' + nf.format(Math.round(n)),
    compact: n => {
      const a = Math.abs(n), s = n < 0 ? '-' : '';
      if (a >= 1e6) return s + 'EGP ' + (a / 1e6).toFixed(2) + 'M';
      if (a >= 1e3) return s + 'EGP ' + Math.round(a / 1e3) + 'k';
      return s + 'EGP ' + Math.round(a);
    },
    packs: n => {
      const a = Math.abs(n);
      return a >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : nf.format(Math.round(n));
    },
    pct: (n, d = 1) => (n * 100).toFixed(d) + '%',
    spct: (n, d = 1) => (n >= 0 ? '+' : '') + (n * 100).toFixed(d) + '%',
    pts: (n, d = 1) => (n >= 0 ? '+' : '') + (n * 100).toFixed(d) + ' pts',
    month: s => { const [y, m] = s.split('-'); return MON[+m - 1] + ' ' + y.slice(2); },
    monthLong: s => { const [y, m] = s.split('-'); return MON[+m - 1] + ' ' + y; },
    clock: iso => { try { return new Date(iso).toLocaleTimeString(); } catch (e) { return iso; } },
    p: p => p == null ? '' : (p < 0.0001 ? 'p < 0.0001' : 'p = ' + (p < 0.01 ? p.toExponential(1) : p.toFixed(3)))
  };

  /* --------------------------------------------------------------- context */
  // Rebuilt from the feed on every snapshot. F maps field names to row positions.
  let ctx = null;
  function prep(d) {
    const raw = d.raw, F = {};
    raw.fields.forEach((f, i) => { F[f] = i; });
    ctx = {
      raw, F,
      famOf: raw.products.map(p => p.family),
      critOf: raw.products.map(p => p.criticality),
      yearOf: raw.months.map(m => m.slice(0, 4)),
      years: Array.from(new Set(raw.months.map(m => m.slice(0, 4)))),
    };
    return ctx;
  }

  /* --------------------------------------------------------------- colours */
  const slotVar = i => `var(--series-${(i % 5) + 1})`;
  const colorFor = (kind, name) => {
    if (!ctx) return slotVar(0);
    const list = kind === 'region' ? ctx.raw.regions : ctx.raw.families;
    const i = list.indexOf(name);
    return slotVar(i < 0 ? 0 : i);
  };
  const seqStep = t => {
    const steps = ['var(--seq-100)', 'var(--seq-250)', 'var(--seq-400)',
                   'var(--seq-500)', 'var(--seq-600)', 'var(--seq-700)'];
    return steps[Math.min(steps.length - 1, Math.max(0, Math.round(t * (steps.length - 1))))];
  };

  /* --------------------------------------------------------------- tooltip */
  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'viz-tooltip';
      tipEl.setAttribute('role', 'status');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(evt, html) {
    const t = tip();
    t.innerHTML = html;
    t.classList.add('show');
    const pad = 14, r = t.getBoundingClientRect();
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    t.style.left = Math.max(8, x) + 'px';
    t.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { if (tipEl) tipEl.classList.remove('show'); }
  function hoverable(el, htmlFn) {
    el.addEventListener('mousemove', e => showTip(e, htmlFn()));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('focus', () => {
      const r = el.getBoundingClientRect();
      showTip({ clientX: r.left + r.width / 2, clientY: r.top }, htmlFn());
    });
    el.addEventListener('blur', hideTip);
  }
  const tRow = (k, v) => `<div class="t-row"><span>${k}</span><span>${v}</span></div>`;
  const tTitle = t => `<div class="t-title">${t}</div>`;

  /* ----------------------------------------------------------------- theme */
  function isDark() {
    const cur = document.documentElement.getAttribute('data-theme');
    return cur === 'dark' || (!cur && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function initTheme() {
    const KEY = 'ldd-theme';
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    const btn = document.querySelector('.theme-btn');
    if (!btn) return;
    const paint = () => {
      btn.textContent = isDark() ? 'Light' : 'Dark';
      btn.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
    };
    btn.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
      paint();
      if (lastData && renderFn) renderFn(lastData);
    });
    paint();
  }

  /* ======================================================================
     AGGREGATION  (Playbook 20.4: every ratio is a sum over a sum)
     ====================================================================== */
  function agg(rows) {
    const F = ctx.F, a = { n: rows.length, demand: 0, fulfilled: 0, lost: 0, forecast: 0, abs: 0,
      err: 0, stockouts: 0, revenue: 0, gp: 0, lostrev: 0, holding: 0, expiry: 0 };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], dm = r[F.demand], fc = r[F.forecast];
      a.demand += dm; a.fulfilled += r[F.fulfilled]; a.lost += r[F.lost]; a.forecast += fc;
      a.abs += Math.abs(fc - dm); a.err += fc - dm; a.stockouts += r[F.stockout];
      a.revenue += r[F.revenue]; a.gp += r[F.gross_profit]; a.lostrev += r[F.lost_revenue];
      a.holding += r[F.holding]; a.expiry += r[F.expiry];
    }
    a.fill = a.demand ? a.fulfilled / a.demand : 0;
    a.so = a.n ? a.stockouts / a.n : 0;
    a.wape = a.demand ? a.abs / a.demand : 0;
    a.bias = a.demand ? a.err / a.demand : 0;
    a.margin = a.revenue ? a.gp / a.revenue : 0;
    a.contribution = a.gp - a.holding - a.expiry;
    return a;
  }

  /** Group rows by keyFn -> [{name, ...agg}] ; order = explicit list, else by `by` desc. */
  function groupAgg(rows, keyFn, order, by) {
    const m = new Map();
    rows.forEach(r => { const k = keyFn(r); let b = m.get(k); if (!b) m.set(k, b = []); b.push(r); });
    const out = [];
    m.forEach((rs, k) => { const a = agg(rs); a.name = k; out.push(a); });
    if (order) out.sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
    else out.sort((x, y) => y[by || 'demand'] - x[by || 'demand']);
    return out;
  }

  /** Stock figures are a snapshot of the latest month in the selection, never a sum over months. */
  function snapshotOf(rows) {
    const F = ctx.F;
    if (!rows.length) return { month: null, units: 0, value: 0, cover: 0 };
    let mx = -1;
    rows.forEach(r => { if (r[F.month] > mx) mx = r[F.month]; });
    let units = 0, value = 0, demand = 0;
    rows.forEach(r => {
      if (r[F.month] === mx) { units += r[F.closing_units]; value += r[F.closing_value]; demand += r[F.demand]; }
    });
    const days = ctx.raw.month_days[mx] || 30;
    return { month: ctx.raw.months[mx], units, value, cover: demand ? units / (demand / days) : 0 };
  }

  /* ======================================================================
     CROSS-FILTER ENGINE
     One filter set per dimension. An empty set means "no filter".
     ====================================================================== */
  const DIMS = ['region', 'family', 'channel', 'promo', 'crit', 'year', 'month'];
  function newFilters() {
    const f = {}; DIMS.forEach(k => { f[k] = new Set(); }); return f;
  }
  function filterRows(raw, f) {
    if (!raw || !raw.rows) return [];
    const F = ctx.F;
    return raw.rows.filter(r =>
      (!f.region.size  || f.region.has(raw.regions[r[F.region]])) &&
      (!f.family.size  || f.family.has(ctx.famOf[r[F.product]])) &&
      (!f.channel.size || f.channel.has(raw.channels[r[F.channel]])) &&
      (!f.promo.size   || f.promo.has(raw.promos[r[F.promo]])) &&
      (!f.crit.size    || f.crit.has(ctx.critOf[r[F.product]])) &&
      (!f.year.size    || f.year.has(ctx.yearOf[r[F.month]])) &&
      (!f.month.size   || f.month.has(raw.months[r[F.month]])));
  }
  const anyFilter = f => DIMS.some(k => f[k].size > 0);
  const key = {
    region: r => ctx.raw.regions[r[ctx.F.region]],
    family: r => ctx.famOf[r[ctx.F.product]],
    channel: r => ctx.raw.channels[r[ctx.F.channel]],
    promo: r => ctx.raw.promos[r[ctx.F.promo]],
    crit: r => ctx.critOf[r[ctx.F.product]],
    product: r => ctx.raw.products[r[ctx.F.product]].id,
    month: r => ctx.raw.months[r[ctx.F.month]],
    series: r => ctx.raw.products[r[ctx.F.product]].id + ' · ' + ctx.raw.regions[r[ctx.F.region]],
  };

  /* --------------------------------------------------- live text bindings */
  // Any prose that quotes a live figure carries one of these classes, so a
  // headline can never contradict the tiles beneath it after the data changes.
  function bindLiveText(d) {
    const set = (name, val) =>
      document.querySelectorAll('.js-' + name).forEach(n => { n.textContent = val; });
    const k = d.kpis, F = ctx.F;
    let underLost = 0, lostAll = 0;
    d.raw.rows.forEach(r => {
      lostAll += r[F.lost];
      if (r[F.forecast] < r[F.demand]) underLost += r[F.lost];
    });
    const promo = d.by_promo.find(x => x.name === 'Planned') || {};
    const other = d.by_promo.find(x => x.name !== 'Planned') || {};
    const reg = d.by_region.slice().sort((a, b) => b.stockout_share - a.stockout_share);
    set('rows', fmt.int(d.row_count));
    set('demand', fmt.int(k.demand));
    set('fill', fmt.pct(k.fill_rate, 2));
    set('stockout', fmt.pct(k.stockout_share, 2));
    set('stockouts', fmt.int(k.stockouts));
    set('wape', fmt.pct(k.wape, 2));
    set('bias', fmt.spct(k.bias, 2));
    set('lostrev', fmt.compact(k.lost_revenue));
    set('lostpacks', fmt.int(k.lost));
    set('revenue', fmt.compact(k.revenue));
    set('gp', fmt.compact(k.gross_profit));
    set('margin', fmt.pct(k.margin, 1));
    set('holding-expiry', fmt.compact(k.holding + k.expiry));
    set('series', fmt.int(k.series));
    set('months', fmt.int(k.months));
    set('period', fmt.monthLong(k.first_month) + ' to ' + fmt.monthLong(k.last_month));
    set('topk', fmt.int(d.concentration.top_k));
    set('topshare', fmt.pct(d.concentration.top_series_lost_revenue_share, 0));
    set('nostock', fmt.int(d.concentration.series_without_stockout));
    set('top5share', fmt.pct(d.concentration.top5_product_demand_share, 1));
    set('underlost', fmt.pct(lostAll ? underLost / lostAll : 0, 1));
    set('promo-so', fmt.pct(promo.stockout_share || 0, 1));
    set('other-so', fmt.pct(other.stockout_share || 0, 1));
    set('promo-bias', fmt.spct(promo.bias || 0, 1));
    set('other-bias', fmt.spct(other.bias || 0, 1));
    set('promo-wape', fmt.pct(promo.wape || 0, 2));
    set('other-wape', fmt.pct(other.wape || 0, 2));
    set('promo-share', fmt.pct(promo.demand_share || 0, 1));
    set('closing', fmt.compact(d.snapshot.closing_value));
    set('closing-units', fmt.int(d.snapshot.closing_units));
    set('cover', d.snapshot.cover_days.toFixed(1));
    set('snapmonth', fmt.monthLong(d.snapshot.month));
    set('worst-region', reg[0] ? reg[0].name : '');
    set('worst2-region', reg[1] ? reg[1].name : '');
    set('worst-region-so', reg[0] ? fmt.pct(reg[0].stockout_share, 1) : '');
    set('best-region', reg.length ? reg[reg.length - 1].name : '');
    set('best-region-so', reg.length ? fmt.pct(reg[reg.length - 1].stockout_share, 1) : '');
    set('source', d.source_file);
    const ms = d.study ? d.study.rows : null;
    set('study-rows', ms == null ? 'n/a' : fmt.int(ms));
    renderStale(d);
  }

  /* Study constants (Playbook 13.4): detect when the source has moved away. */
  function isStale(d) {
    return !!(d.study && (d.study.rows !== d.row_count || d.study.demand_total !== d.kpis.demand));
  }
  function renderStale(d) {
    document.querySelectorAll('.js-stale').forEach(n => {
      n.hidden = !isStale(d);
      if (!n.hidden) n.innerHTML = '<span class="ico">&#9888;</span><div><strong>The source has changed since the study ran.</strong> '
        + 'Figures marked <span class="tag study">study</span> were measured on ' + fmt.int(d.study.rows)
        + ' rows and ' + fmt.int(d.study.demand_total) + ' requested packs; the file now has '
        + fmt.int(d.row_count) + ' rows and ' + fmt.int(d.kpis.demand)
        + ' packs. Live figures update; study constants do not. Re-run <code>analyze_deep.py</code> to refresh them.</div>';
    });
  }

  /* -------------------------------------------------------------- polling */
  let lastData = null, renderFn = null, lastStamp = null, failures = 0;

  function setLive(state, text, title) {
    const el = document.querySelector('.live');
    if (!el) return;
    el.classList.toggle('is-live', state === 'live');
    el.classList.toggle('is-stale', state === 'stale');
    const label = el.querySelector('.live-text');
    if (label) label.textContent = text;
    if (title) el.title = title;
  }

  async function poll() {
    try {
      const res = await fetch('live_data.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      failures = 0;
      if (data.snapshot_id !== lastStamp) {
        lastStamp = data.snapshot_id;
        lastData = data;
        prep(data);
        bindLiveText(data);
        if (renderFn) renderFn(data);
        const sinceSave = data.source_mtime_ms ? (Date.now() - data.source_mtime_ms) : null;
        document.querySelectorAll('.js-latency').forEach(n => {
          n.textContent = sinceSave != null && sinceSave < 60000 ? sinceSave + ' ms' : 'n/a (no recent edit)';
        });
        document.title = document.title.replace(/ ·.*$/, '');
      }
      setLive('live', 'Live · ' + fmt.clock(data.last_updated),
        'Snapshot ' + data.last_updated + (data.latency_ms != null ? ' · save-to-snapshot ' + data.latency_ms + ' ms' : ''));
    } catch (e) {
      failures++;
      if (failures > 2) setLive('stale', 'Not connected — is watcher.py running?');
    }
  }

  function start(render) {
    renderFn = render;
    initTheme();
    markNav();
    poll();
    setInterval(poll, POLL_MS);
  }
  function markNav() {
    const here = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('nav.pages a').forEach(a => {
      if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page');
    });
  }

  /* ------------------------------------------------------- render helpers */
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };
  const byId = id => document.getElementById(id);

  /** KPI tile markup. tone: '' | 'good' | 'bad' colours only the sub line. */
  function tile(label, value, sub, extra, tone) {
    return '<div class="kpi"><div class="label">' + label + '</div>'
      + '<div class="value">' + value + '</div>'
      + (sub ? '<div class="sub ' + (tone || '') + '">' + sub + '</div>' : '')
      + (extra || '') + '</div>';
  }

  /**
   * Horizontal bar list with a direct value label on every row.
   * rows: [{label, value, valueText, color, tip, selected, onClick}]
   * Signed values are not supported here; use columns() for bias.
   */
  function barList(mount, rows, opts = {}) {
    const max = opts.max != null ? opts.max : Math.max(...rows.map(r => r.value), 1e-9);
    mount.innerHTML = '';
    const box = el('div', 'bars');
    rows.forEach((r, i) => {
      const row = el('div', 'bar-row' + (r.selected ? ' is-selected' : ''));
      row.appendChild(el('div', 'name', r.label));
      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.width = Math.max(0, r.value / max * 100).toFixed(2) + '%';
      fill.style.background = r.color || (opts.sequential
        ? seqStep(1 - i / Math.max(1, rows.length - 1)) : 'var(--series-1)');
      track.appendChild(fill);
      track.tabIndex = 0;
      track.setAttribute('role', 'img');
      track.setAttribute('aria-label', r.label + ': ' + (r.valueText || r.value));
      hoverable(track, () => r.tip || tTitle(r.label) + tRow('Value', r.valueText || r.value));
      if (r.onClick) { track.style.cursor = 'pointer'; track.addEventListener('click', r.onClick); }
      row.appendChild(track);
      row.appendChild(el('div', 'val', r.valueText || String(r.value)));
      box.appendChild(row);
    });
    mount.appendChild(box);
  }

  function dataTable(mount, head, rows, opts = {}) {
    const t = el('table', 'data');
    const thead = el('thead'), hr = el('tr');
    head.forEach(h => hr.appendChild(el('th', h.num ? 'num' : '', h.label)));
    thead.appendChild(hr); t.appendChild(thead);
    const tb = el('tbody');
    rows.forEach((r, ri) => {
      const tr = el('tr');
      if (opts.onRow) { tr.style.cursor = 'pointer'; tr.addEventListener('click', () => opts.onRow(ri)); }
      r.forEach((c, i) => tr.appendChild(el('td', head[i].num ? 'num' : '', c)));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    mount.innerHTML = '';
    mount.appendChild(t);
  }

  /* ======================================================================
     SLICERS
     ====================================================================== */
  function slicer(mount, o) {
    // o: {label, values, selected:Set, onChange, colorFn?, note?}
    mount.innerHTML = '';
    const wrap = el('div', 'slicer');
    const head = el('div', 'slicer-head');
    head.appendChild(el('span', 'slicer-label', o.label));
    const clear = el('button', 'slicer-clear', 'Clear');
    clear.type = 'button';
    clear.hidden = o.selected.size === 0;
    clear.addEventListener('click', () => { o.selected.clear(); o.onChange(); });
    head.appendChild(clear);
    wrap.appendChild(head);
    const box = el('div', 'slicer-items');
    o.values.forEach(v => {
      const on = o.selected.has(v);
      const b = el('button', 'slicer-item' + (on ? ' is-on' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (o.colorFn) { const sw = el('span', 'swatch'); sw.style.background = o.colorFn(v); b.appendChild(sw); }
      b.appendChild(document.createTextNode(v));
      b.addEventListener('click', () => {
        if (o.selected.has(v)) o.selected.delete(v); else o.selected.add(v);
        o.onChange();
      });
      box.appendChild(b);
    });
    wrap.appendChild(box);
    if (o.note) wrap.appendChild(el('div', 'slicer-note', o.note));
    mount.appendChild(wrap);
  }

  /* ======================================================================
     CHART PRIMITIVES - hand-written SVG
     ====================================================================== */
  const svgNS = 'http://www.w3.org/2000/svg';
  function svg(w, h, cls) {
    const s = document.createElementNS(svgNS, 'svg');
    s.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    s.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    s.setAttribute('class', cls || 'chart');
    s.setAttribute('role', 'img');
    return s;
  }
  function node(tag, attrs) {
    const n = document.createElementNS(svgNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  const niceMax = v => {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  };

  /** Donut. slices: [{name, value, color, tip?}] ; centre shows opts.centre / opts.centreLabel. */
  function donut(mount, slices, opts) {
    opts = opts || {};
    mount.innerHTML = '';
    const total = slices.reduce((s, x) => s + x.value, 0);
    const size = 260, cx = size / 2, cy = size / 2, rO = 104, rI = 66;
    const s = svg(size, size);
    if (total <= 0) { mount.appendChild(s); return; }
    let a0 = -Math.PI / 2;
    slices.forEach(sl => {
      const frac = sl.value / total, a1 = a0 + frac * Math.PI * 2, big = (a1 - a0) > Math.PI ? 1 : 0;
      const p = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const [x0, y0] = p(rO, a0), [x1, y1] = p(rO, a1), [x2, y2] = p(rI, a1), [x3, y3] = p(rI, a0);
      const dd = frac >= 0.9999
        ? 'M ' + (cx - rO) + ' ' + cy + ' a ' + rO + ' ' + rO + ' 0 1 0 ' + (rO * 2) + ' 0 a ' + rO + ' ' + rO + ' 0 1 0 ' + (-rO * 2) + ' 0 Z'
          + 'M ' + (cx - rI) + ' ' + cy + ' a ' + rI + ' ' + rI + ' 0 1 1 ' + (rI * 2) + ' 0 a ' + rI + ' ' + rI + ' 0 1 1 ' + (-rI * 2) + ' 0 Z'
        : ['M', x0, y0, 'A', rO, rO, 0, big, 1, x1, y1, 'L', x2, y2, 'A', rI, rI, 0, big, 0, x3, y3, 'Z'].join(' ');
      const path = node('path', { d: dd, fill: sl.color, stroke: 'var(--surface-1)', 'stroke-width': 2 });
      if (sl.selected) path.setAttribute('stroke', 'var(--text-primary)');
      path.style.cursor = opts.onClick ? 'pointer' : 'default';
      path.setAttribute('tabindex', '0');
      path.setAttribute('aria-label', sl.name + ': ' + fmt.pct(frac));
      hoverable(path, () => sl.tip || tTitle(sl.name) + tRow('Share', fmt.pct(frac)));
      if (opts.onClick) path.addEventListener('click', () => opts.onClick(sl.name));
      s.appendChild(path);
      a0 = a1;
    });
    const t1 = node('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', fill: 'var(--text-primary)', 'font-size': 22, 'font-weight': 700 });
    t1.textContent = opts.centre || '';
    const t2 = node('text', { x: cx, y: cy + 18, 'text-anchor': 'middle', fill: 'var(--text-muted)', 'font-size': 11.5 });
    t2.textContent = opts.centreLabel || '';
    s.appendChild(t1); s.appendChild(t2);
    mount.appendChild(s);
  }

  /**
   * Multi-series line. o: {labels:[], series:[{name,color,values,dash,fill}], yFmt, tipFmt, onClick(i), height, yMin}
   * A crosshair snaps to the nearest x and one tooltip lists every series.
   */
  function lineChart(mount, o) {
    mount.innerHTML = '';
    const W = 880, H = o.height || 270, L = 62, Rr = 860, T = 16, B = H - 38;
    const s = svg(W, H);
    const n = o.labels.length;
    if (!n) { mount.appendChild(s); return; }
    const all = [].concat.apply([], o.series.map(x => x.values));
    const lo0 = o.yMin != null ? o.yMin : Math.min(0, Math.min.apply(null, all));
    const hi = niceMax(Math.max.apply(null, all.concat([1e-9])));
    const lo = lo0 < 0 ? -niceMax(-lo0) : lo0;
    const X = i => L + (n === 1 ? 0.5 : i / (n - 1)) * (Rr - L);
    const Y = v => B - (v - lo) / (hi - lo || 1) * (B - T);
    for (let g = 0; g <= 4; g++) {
      const v = lo + (hi - lo) * g / 4, y = Y(v);
      s.appendChild(node('line', { class: 'gridline', x1: L, y1: y, x2: Rr, y2: y }));
      const lab = node('text', { class: 'axis-label', x: L - 10, y: y + 4, 'text-anchor': 'end' });
      lab.textContent = (o.yFmt || fmt.packs)(v);
      s.appendChild(lab);
    }
    const step = Math.ceil(n / 10);
    o.labels.forEach((lbl, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      const t = node('text', { class: 'axis-label', x: X(i), y: B + 18, 'text-anchor': 'middle' });
      t.textContent = o.labelFmt ? o.labelFmt(lbl) : lbl; s.appendChild(t);
    });
    o.series.forEach(se => {
      const pts = se.values.map((v, i) => X(i) + ',' + Y(v)).join(' ');
      if (se.fill) s.appendChild(node('path', { d: 'M ' + X(0) + ' ' + Y(Math.max(lo, 0)) + ' L ' + se.values.map((v, i) => X(i) + ' ' + Y(v)).join(' L ')
        + ' L ' + X(n - 1) + ' ' + Y(Math.max(lo, 0)) + ' Z', fill: se.color, opacity: 0.12 }));
      const pl = node('polyline', { points: pts, fill: 'none', stroke: se.color, 'stroke-width': 2.2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      if (se.dash) pl.setAttribute('stroke-dasharray', se.dash);
      s.appendChild(pl);
    });
    const cross = node('line', { class: 'crosshair', y1: T, y2: B, x1: -10, x2: -10 });
    s.appendChild(cross);
    const dots = o.series.map(se => { const c = node('circle', { r: 4.5, fill: se.color, stroke: 'var(--surface-1)', 'stroke-width': 2, cx: -10, cy: -10 }); s.appendChild(c); return c; });
    const hit = node('rect', { x: L, y: T, width: Rr - L, height: B - T, fill: 'transparent' });
    hit.style.cursor = o.onClick ? 'pointer' : 'crosshair';
    const near = e => {
      const r = s.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W;
      return Math.max(0, Math.min(n - 1, Math.round((px - L) / (Rr - L) * (n - 1))));
    };
    hit.addEventListener('mousemove', e => {
      const i = near(e);
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i));
      o.series.forEach((se, k) => { dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(se.values[i])); });
      showTip(e, tTitle(o.tipTitle ? o.tipTitle(o.labels[i]) : o.labels[i])
        + o.series.map(se => tRow(se.name, (o.tipFmt || o.yFmt || fmt.int)(se.values[i]))).join('')
        + (o.tipExtra ? o.tipExtra(i) : ''));
    });
    hit.addEventListener('mouseleave', () => { hideTip(); cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); dots.forEach(c => c.setAttribute('cx', -10)); });
    if (o.onClick) hit.addEventListener('click', e => o.onClick(near(e)));
    s.appendChild(hit);
    mount.appendChild(s);
  }

  /**
   * Vertical columns, signed values allowed (bars grow from the zero line).
   * rows: [{name, label, value, color, tip, selected}]  opts: {yFmt, mean, onClick, zeroLabel}
   */
  function columns(mount, rows, opts) {
    opts = opts || {};
    mount.innerHTML = '';
    const W = opts.width || 880, H = opts.height || 260, L = 66, Rr = W - 20, T = 18, B = H - 44;
    const s = svg(W, H);
    const vals = rows.map(r => r.value);
    const hi = niceMax(Math.max.apply(null, vals.concat([1e-9])));
    const loRaw = Math.min.apply(null, vals.concat([0]));
    const lo = loRaw < 0 ? -niceMax(-loRaw) : 0;
    const n = rows.length || 1, slot = (Rr - L) / n, bw = Math.max(5, Math.min(46, slot * 0.64));
    const Y = v => B - (v - lo) / (hi - lo || 1) * (B - T);
    for (let g = 0; g <= 4; g++) {
      const v = lo + (hi - lo) * g / 4, y = Y(v);
      s.appendChild(node('line', { class: v === 0 ? 'baseline' : 'gridline', x1: L, y1: y, x2: Rr, y2: y }));
      const lab = node('text', { class: 'axis-label', x: L - 10, y: y + 4, 'text-anchor': 'end' });
      lab.textContent = (opts.yFmt || fmt.packs)(v); s.appendChild(lab);
    }
    if (lo < 0) s.appendChild(node('line', { class: 'baseline', x1: L, y1: Y(0), x2: Rr, y2: Y(0) }));
    const step = Math.ceil(n / 14);
    rows.forEach((r, i) => {
      const x = L + slot * i + (slot - bw) / 2, y0 = Y(0), y1 = Y(r.value);
      const rect = node('rect', { x, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y1 - y0)), rx: 3,
        fill: r.color || (r.value < 0 && opts.negativeColor ? opts.negativeColor : 'var(--series-1)') });
      if (r.selected) { rect.setAttribute('stroke', 'var(--text-primary)'); rect.setAttribute('stroke-width', 2); }
      rect.style.cursor = opts.onClick ? 'pointer' : 'default';
      rect.setAttribute('tabindex', '0');
      rect.setAttribute('aria-label', r.name + ': ' + (opts.yFmt || fmt.int)(r.value));
      hoverable(rect, () => r.tip || tTitle(r.name) + tRow(opts.valueName || 'Value', (opts.yFmt || fmt.int)(r.value)));
      if (opts.onClick) rect.addEventListener('click', () => opts.onClick(r.name));
      s.appendChild(rect);
      if (i % step === 0 || i === n - 1) {
        const lab = node('text', { class: 'axis-label', x: x + bw / 2, y: B + 18, 'text-anchor': 'middle' });
        lab.textContent = r.label || r.name; s.appendChild(lab);
      }
    });
    if (opts.mean !== undefined) {
      const y = Y(opts.mean);
      s.appendChild(node('line', { class: 'crosshair', x1: L, y1: y, x2: Rr, y2: y, 'stroke-width': 1.5 }));
      const lab = node('text', { class: 'axis-label', x: Rr, y: y - 7, 'text-anchor': 'end', style: 'fill:var(--text-secondary)' });
      lab.textContent = (opts.meanLabel || 'average ') + (opts.yFmt || fmt.packs)(opts.mean); s.appendChild(lab);
    }
    mount.appendChild(s);
  }

  /** Heatmap. o: {rows:[], cols:[], values:[[]], valFmt, onClick(r,c), selected(r,c), title, reverse} */
  function heatmap(mount, o) {
    mount.innerHTML = '';
    const nr = o.rows.length, nc = o.cols.length;
    const W = 880, cellH = 46, L = 110, T = 30, H = T + nr * cellH + 8;
    const s = svg(W, H);
    const flat = [].concat.apply([], o.values).filter(v => v != null);
    const lo = Math.min.apply(null, flat), hi = Math.max.apply(null, flat), span = (hi - lo) || 1;
    const cw = (W - L - 4) / nc;
    o.cols.forEach((c, j) => {
      const t = node('text', { class: 'axis-label', x: L + cw * j + cw / 2, y: 18, 'text-anchor': 'middle' });
      t.textContent = c; s.appendChild(t);
    });
    o.rows.forEach((r, i) => {
      const t = node('text', { class: 'axis-label', x: L - 10, y: T + cellH * i + cellH / 2 + 4, 'text-anchor': 'end' });
      t.textContent = r; s.appendChild(t);
      o.cols.forEach((c, j) => {
        const v = o.values[i][j];
        const tt = v == null ? 0 : (v - lo) / span;
        const rect = node('rect', { class: 'heat-cell', x: L + cw * j, y: T + cellH * i, width: cw - 3, height: cellH - 3,
          rx: 5, fill: v == null ? 'var(--surface-2)' : seqStep(tt) });
        if (o.selected && o.selected(r, c)) { rect.setAttribute('stroke', 'var(--text-primary)'); rect.setAttribute('stroke-width', 2.5); }
        rect.setAttribute('tabindex', '0');
        hoverable(rect, () => tTitle(r + ' · ' + c) + tRow(o.title || 'Value', v == null ? 'n/a' : o.valFmt(v))
          + (o.tipExtra ? o.tipExtra(r, c) : '') + (o.onClick ? '<div class="t-note">Click to filter</div>' : ''));
        if (o.onClick) rect.addEventListener('click', () => o.onClick(r, c));
        s.appendChild(rect);
        const lab = node('text', { x: L + cw * j + (cw - 3) / 2, y: T + cellH * i + cellH / 2 + 4, 'text-anchor': 'middle',
          'font-size': 12.5, 'font-weight': 650, fill: tt > 0.5 ? '#fff' : 'var(--text-primary)', 'pointer-events': 'none' });
        lab.textContent = v == null ? '' : o.valFmt(v); s.appendChild(lab);
      });
    });
    mount.appendChild(s);
  }

  /** Scatter with fitted axes. points: [{x,y,name,color,tip}] opts: {xFmt,yFmt,xLabel,yLabel,onClick} */
  function scatter(mount, points, opts) {
    opts = opts || {};
    mount.innerHTML = '';
    const W = 880, H = 320, L = 66, Rr = 860, T = 18, B = 266;
    const s = svg(W, H);
    if (!points.length) { mount.appendChild(s); return; }
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const xl = Math.min.apply(null, xs), xh = Math.max.apply(null, xs), yl = Math.min.apply(null, ys), yh = Math.max.apply(null, ys);
    const xp = (xh - xl) * 0.08 || 1, yp = (yh - yl) * 0.08 || 1;
    const xLo = xl - xp, xHi = xh + xp, yLo = Math.max(0, yl - yp), yHi = yh + yp;
    const X = v => L + (v - xLo) / (xHi - xLo) * (Rr - L), Y = v => B - (v - yLo) / (yHi - yLo) * (B - T);
    for (let g = 0; g <= 4; g++) {
      const y = T + (B - T) * g / 4;
      s.appendChild(node('line', { class: 'gridline', x1: L, y1: y, x2: Rr, y2: y }));
      const lab = node('text', { class: 'axis-label', x: L - 10, y: y + 4, 'text-anchor': 'end' });
      lab.textContent = (opts.yFmt || fmt.int)(yLo + (yHi - yLo) * (1 - g / 4)); s.appendChild(lab);
      const xv = xLo + (xHi - xLo) * g / 4;
      const xl2 = node('text', { class: 'axis-label', x: X(xv), y: B + 18, 'text-anchor': 'middle' });
      xl2.textContent = (opts.xFmt || fmt.int)(xv); s.appendChild(xl2);
    }
    s.appendChild(node('line', { class: 'baseline', x1: L, y1: B, x2: Rr, y2: B }));
    if (xLo < 0 && xHi > 0) s.appendChild(node('line', { class: 'crosshair', x1: X(0), y1: T, x2: X(0), y2: B }));
    // least-squares fit line (a drawn hint, labelled by the page)
    if (opts.fit && points.length > 2) {
      const n = points.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let sxx = 0, sxy = 0; points.forEach(p => { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); });
      const b = sxy / (sxx || 1), a = my - b * mx;
      s.appendChild(node('line', { class: 'crosshair', x1: X(xl), y1: Y(a + b * xl), x2: X(xh), y2: Y(a + b * xh), 'stroke-width': 1.6 }));
    }
    points.forEach(p => {
      const c = node('circle', { cx: X(p.x), cy: Y(p.y), r: opts.r || 5, fill: p.color || 'var(--series-1)',
        'fill-opacity': 0.82, stroke: 'var(--surface-1)', 'stroke-width': 1.5 });
      c.setAttribute('tabindex', '0'); c.style.cursor = opts.onClick ? 'pointer' : 'default';
      hoverable(c, () => p.tip || tTitle(p.name) + tRow(opts.xLabel || 'x', (opts.xFmt || fmt.int)(p.x)) + tRow(opts.yLabel || 'y', (opts.yFmt || fmt.int)(p.y)));
      if (opts.onClick) c.addEventListener('click', () => opts.onClick(p.name));
      s.appendChild(c);
    });
    if (opts.xLabel) {
      const lx = node('text', { class: 'axis-label', x: (L + Rr) / 2, y: H - 6, 'text-anchor': 'middle' });
      lx.textContent = opts.xLabel; s.appendChild(lx);
    }
    mount.appendChild(s);
  }

  /** Paired bars (two measures per row on ONE shared axis, never dual-axis). rows: [{name, a, b}] */
  function pairedBars(mount, rows, o) {
    mount.innerHTML = '';
    const max = Math.max.apply(null, rows.map(r => Math.max(r.a, r.b)).concat([1e-9]));
    const box = el('div', 'pair-list');
    rows.forEach(r => {
      const line = el('div', 'pair-row');
      line.appendChild(el('div', 'name', r.name));
      const tr = el('div', 'pair-tracks');
      [['a', o.aColor, o.aName], ['b', o.bColor, o.bName]].forEach(([k, c, nm]) => {
        const t = el('div', 'pair-track'), f = el('div', 'pair-fill');
        f.style.width = (r[k] / max * 100).toFixed(2) + '%'; f.style.background = c;
        t.appendChild(f); t.appendChild(el('span', 'pair-val', o.fmt(r[k])));
        t.tabIndex = 0;
        hoverable(t, () => tTitle(r.name) + tRow(nm, o.fmt(r[k])));
        tr.appendChild(t);
      });
      line.appendChild(tr);
      box.appendChild(line);
    });
    mount.appendChild(box);
  }

  function sparkline(values, opts) {
    opts = opts || {};
    if (!values || values.length < 2) return '';
    const w = 108, h = 26, pad = 2, lo = Math.min.apply(null, values), hi = Math.max.apply(null, values), span = (hi - lo) || 1;
    const X = i => pad + i / (values.length - 1) * (w - pad * 2), Y = v => h - pad - (v - lo) / span * (h - pad * 2);
    const c = opts.color || 'var(--series-1)';
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<path d="M ' + X(0) + ' ' + h + ' L ' + values.map((v, i) => X(i) + ' ' + Y(v)).join(' L ') + ' L ' + X(values.length - 1) + ' ' + h + ' Z" fill="' + c + '" opacity="0.14"></path>'
      + '<polyline points="' + values.map((v, i) => X(i) + ',' + Y(v)).join(' ') + '" fill="none" stroke="' + c + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></polyline></svg>';
  }

  return { fmt, colorFor, seqStep, slotVar, showTip, hideTip, hoverable, tRow, tTitle,
           barList, dataTable, el, byId, tile, start, isStale, isDark,
           agg, groupAgg, snapshotOf, newFilters, filterRows, anyFilter, key, DIMS,
           slicer, donut, lineChart, columns, heatmap, scatter, pairedBars, sparkline,
           get ctx() { return ctx; }, get data() { return lastData; } };
})();

