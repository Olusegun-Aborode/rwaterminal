// Dropdown + chart toolbar + email gate + methodology + expand modal

const { useState: useStateW, useEffect: useEffectW, useRef: useRefW } = React;

// ── Dropdown ───────────────────────────────────────────────
function Dropdown({ label, value, items, multi = false, selected = [], onChange, alignLeft = false, icon = null, compact = false }) {
  const [open, setOpen] = useStateW(false);
  const ref = useRefW(null);
  useEffectW(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, []);

  const displayLabel = multi
    ? `${label} · ${selected.length}/${items.length}`
    : (value ? (items.find(i => i.id === value)?.short || items.find(i => i.id === value)?.label) || label : label);

  return (
    <div className="dropdown" ref={ref}>
      <button className={`dropdown-trigger ${open ? 'active' : ''}`} onClick={() => setOpen(v => !v)}>
        {icon}
        <span>{displayLabel}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className={`dropdown-menu ${alignLeft ? 'align-left' : ''}`}>
          {items.map((it, idx) => {
            const isSep = it.separator;
            if (isSep) return <div key={idx} className="dropdown-separator" />;
            if (it.groupLabel) return <div key={idx} className="dropdown-group-label">{it.groupLabel}</div>;
            const active = multi ? selected.includes(it.id) : value === it.id;
            return (
              <div key={it.id} className={`dropdown-item ${active ? 'on' : ''}`}
                onClick={() => {
                  if (multi) {
                    const next = selected.includes(it.id) ? selected.filter(x => x !== it.id) : [...selected, it.id];
                    if (next.length === 0) return;
                    onChange(next);
                  } else {
                    onChange(it.id);
                    setOpen(false);
                  }
                }}>
                {multi && <span className="check-box">{active ? '✓' : ''}</span>}
                {it.swatch && <span className="legend-swatch" style={{ background: it.swatch }} />}
                <span>{it.label}</span>
                {it.kbd && <span className="kbd">{it.kbd}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Chart toolbar (chain filter, metric, snap, expand) ──────
function ChartToolbar({ chains, activeChains, setActiveChains, metrics, metric, setMetric, range, setRange, onSnap, onExpand, onExport, onShare, extras = null }) {
  const rangeItems = [
    { id: '24H', label: '24 Hours', short: '24H' },
    { id: '7D',  label: '7 Days',   short: '7D' },
    { id: '30D', label: '30 Days',  short: '30D' },
    { id: '90D', label: '90 Days',  short: '90D' },
    { id: 'ALL', label: 'All time', short: 'ALL' },
  ];
  return (
    <div className="chart-tools">
      {extras}
      {setRange && (
        <Dropdown
          label="Range"
          value={range || '30D'}
          items={rangeItems}
          onChange={setRange}
        />
      )}
      {chains && (
        <Dropdown
          label="Chains"
          items={chains.map(c => ({ id: c.id, label: c.name, swatch: c.color }))}
          multi selected={activeChains}
          onChange={setActiveChains}
        />
      )}
      {metrics && (
        <Dropdown
          label="Metric"
          value={metric}
          items={metrics}
          onChange={setMetric}
        />
      )}
      <button className="icon-btn" title="Snapshot to PNG" onClick={onSnap}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg>
      </button>
      {onExport && (
        <button className="icon-btn" title="Export CSV" onClick={onExport}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"/></svg>
        </button>
      )}
      {onShare && (
        <button className="icon-btn" title="Copy shareable link" onClick={onShare}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 14a4 4 0 015.66 0l3-3a4 4 0 10-5.66-5.66l-1.5 1.5"/><path d="M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 105.66 5.66l1.5-1.5"/></svg>
        </button>
      )}
      <button className="icon-btn" title="Expand" onClick={onExpand}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 10V4h6M20 14v6h-6M20 10V4h-6M4 14v6h6"/></svg>
      </button>
    </div>
  );
}

// ── Snap helper: downloads a panel as PNG via canvas+SVG serialize ─
// ── snapshotPanel ──────────────────────────────────────────
//
// Capture a panel as a PNG download. Two implementations, picked at
// runtime:
//
//   - If `htmlToImage` is loaded on `window` (added via the CDN script
//     tag in starter.html / page templates), use its `toPng()`, handles
//     all DOM nodes, fonts, gradients, transforms reliably.
//   - Otherwise fall back to the original canvas + SVG-serialize
//     approach. Works for SVG-only charts but flakey for complex DOM.
//
// The `data-snapshot-skip` attribute on any descendant element skips it
// during capture, useful for keeping action buttons (Snap, Expand) out
// of the exported image.
async function snapshotPanel(panelEl, filename = 'chart.png') {
  // Background-color helper: read the active theme's --card so the
  // exported PNG matches whatever theme the user is viewing in. Avoids
  // shipping a white-bg snapshot from a dark-mode dashboard.
  const themeBg =
    getComputedStyle(document.body).getPropertyValue('--card').trim()
    || getComputedStyle(document.body).getPropertyValue('--surface').trim()
    || '#FFFFFF';

  // ── Preferred path: html-to-image ──
  if (typeof window !== 'undefined' && window.htmlToImage && window.htmlToImage.toPng) {
    try {
      const dataUrl = await window.htmlToImage.toPng(panelEl, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: themeBg,
        filter: (node) =>
          !(node && node.getAttribute && node.getAttribute('data-snapshot-skip')),
      });
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    } catch (e) {
      console.warn('[snapshotPanel] html-to-image failed, falling back to canvas:', e);
      // Fall through to the SVG-serialize path below.
    }
  }

  // ── Fallback: canvas + SVG-serialize ──
  // Same approach as before, works for inline-SVG charts only. Kept
  // so the SDK still has a usable snapshot if html-to-image isn't loaded.
  try {
    const rect = panelEl.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = themeBg;
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--fg').trim() || '#111';
    ctx.font = '600 14px "IBM Plex Sans", sans-serif';
    ctx.fillText('datumlabs, chart snapshot', 20, 26);
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--fg-muted').trim() || '#666';
    ctx.fillText(new Date().toISOString(), 20, 44);

    const svgs = panelEl.querySelectorAll('svg');
    for (const svg of svgs) {
      const svgRect = svg.getBoundingClientRect();
      const xml = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      await new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, svgRect.left - rect.left, svgRect.top - rect.top, svgRect.width, svgRect.height);
          URL.revokeObjectURL(url);
          res();
        };
        img.onerror = () => { URL.revokeObjectURL(url); res(); };
        img.src = url;
      });
    }

    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  } catch (e) {
    alert('Snapshot failed: ' + e.message);
  }
}

// ── CSV export ────────────────────────────────────────────
function exportCSV(rows, filename = 'chart.csv') {
  if (!rows || !rows.length) { alert('No data to export'); return; }
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Copy a deep link that reflects current chart state ────
function copyShareLink(chartId, params = {}) {
  const url = new URL(window.location.href);
  url.hash = '#chart=' + chartId + (Object.keys(params).length ? '&' + new URLSearchParams(params).toString() : '');
  navigator.clipboard?.writeText(url.toString()).then(() => {
    // toast
    const t = document.createElement('div');
    t.textContent = 'Link copied';
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      background: 'var(--fg)', color: 'var(--surface)', padding: '8px 16px',
      borderRadius: '6px', fontFamily: 'var(--font-mono)', fontSize: '11px',
      zIndex: 99999, letterSpacing: '0.05em'
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }).catch(() => alert('Could not copy to clipboard'));
}

// ── Expand modal ──────────────────────────────────────────
function ExpandModal({ open, title, onClose, children }) {
  useEffectW(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  return (
    <div className={`chart-modal-backdrop ${open ? 'open' : ''}`} onClick={onClose}>
      <div className="chart-modal" onClick={e => e.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-title"><span className="bullet">●</span> {title}</span>
          <div className="flex items-center gap-3">
            <span className="panel-badge">EXPANDED VIEW</span>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ── PanelSkeleton (loading placeholder for data-fetching panels) ──
//
// Backported from the centrifuge-rwa-dashboard. Renders a panel-shaped
// placeholder while data loads. The optional `description` prop lets
// the loading state explain WHAT'S happening, useful for slow operations
// where a generic skeleton undersells the work (e.g. an on-chain scan
// that takes 5-10 seconds).
//
// Usage:
//   <PanelSkeleton label="TVL by Chain" />
//   <PanelSkeleton label="Daily Swap Activity"
//                  description="Scanning Base eth_getLogs · ~5s on cold cache" />
function PanelSkeleton({ label = 'Loading', description, height = 280 }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{label}</span>
        <span className="panel-badge">FETCHING…</span>
      </div>
      <div style={{ padding: 16, height, position: 'relative' }}>
        <div className="skeleton" style={{ height: '100%', width: '100%', borderRadius: 4 }} />
        {description && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 11,
              padding: '6px 12px', borderRadius: 4,
              background: 'var(--card)',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              opacity: 0.92,
            }}>
              {description}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── DataQualityBadge (verified / degraded / broken) ───────────
//
// Backported from centrifuge. A small status pill that surfaces data
// reconciliation health. Three levels:
//   ok       → "VERIFIED" (green)
//   degraded → "DEGRADED" (yellow/orange), partial data, e.g. some chain
//              RPCs failed but the rest agreed
//   broken   → "BROKEN" (red)  , divergence beyond threshold
//
// Pass `tooltip` for detailed hover text. Pass `label` to override the
// default text per level.
function DataQualityBadge({ level = 'ok', label, tooltip }) {
  const styles = {
    ok:       { bg: 'var(--accent-green-soft)',  fg: 'var(--accent-green)',  defaultLabel: 'VERIFIED' },
    degraded: { bg: 'var(--accent-orange-soft)', fg: 'var(--accent-orange)', defaultLabel: 'DEGRADED' },
    broken:   { bg: 'var(--accent-red-soft)',    fg: 'var(--accent-red)',    defaultLabel: 'BROKEN' },
  };
  const s = styles[level] || styles.ok;
  return (
    <span
      title={tooltip || ''}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--font-mono)', fontSize: 10,
        letterSpacing: '0.08em', fontWeight: 600,
        padding: '3px 8px', borderRadius: 3,
        background: s.bg, color: s.fg,
        cursor: tooltip ? 'help' : 'default',
        textTransform: 'uppercase', whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{
        width: 6, height: 6, borderRadius: '50%',
        background: s.fg, boxShadow: `0 0 0 2px ${s.bg}`,
      }} />
      {label || s.defaultLabel}
    </span>
  );
}

// ── DataSourceBadge (where data came from + how fresh) ────────
//
// Backported from centrifuge. Shows the data source name and a relative
// freshness label (e.g. "Centrifuge · 3m ago"). Same dot-and-pill grammar
// as DataQualityBadge so they read as a matched pair when rendered side
// by side. Tooltip shows the absolute timestamp on hover.
//
// Usage:
//   <DataSourceBadge source="Centrifuge" lastUpdated={1714263000000} />
//
// Re-renders every minute via setInterval so the relative label stays
// fresh while the page is open. Reuses the file-level useStateW /
// useEffectW aliases declared at the top of widgets.jsx.
function DataSourceBadge({ source, lastUpdated, cached, tone = 'green' }) {
  const tones = {
    green:  { bg: 'var(--accent-green-soft)',  fg: 'var(--accent-green)' },
    yellow: { bg: 'var(--accent-orange-soft)', fg: 'var(--accent-orange)' },
    muted:  { bg: 'rgba(100,116,139,0.10)',    fg: 'var(--text-muted)' },
  };
  const s = tones[tone] || tones.green;
  const [, setTick] = useStateW(0);
  useEffectW(() => {
    if (!lastUpdated) return;
    const id = setInterval(() => setTick(t => (t || 0) + 1), 60_000);
    return () => clearInterval(id);
  }, [lastUpdated]);
  const ageLabel = (() => {
    if (!lastUpdated) return 'n/a';
    const ageMin = Math.max(0, Math.round((Date.now() - lastUpdated) / 60000));
    if (ageMin < 1) return 'just now';
    if (ageMin < 60) return `${ageMin}m ago`;
    return `${Math.round(ageMin / 60)}h ago`;
  })();
  return (
    <span
      className="datasource-badge"
      title={
        lastUpdated
          ? `Source: ${source}\nLast updated: ${new Date(lastUpdated).toLocaleString()}` +
            (cached ? '\nServed from cache' : '\nFresh fetch')
          : `Source: ${source}`
      }
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--font-mono)', fontSize: 10,
        letterSpacing: '0.08em', fontWeight: 600,
        padding: '3px 8px', borderRadius: 3,
        background: s.bg, color: s.fg,
        cursor: 'help', textTransform: 'uppercase', whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{
        width: 6, height: 6, borderRadius: '50%',
        background: s.fg, boxShadow: `0 0 0 2px ${s.bg}`,
      }} />
      {source} · {ageLabel}
    </span>
  );
}

// ── Methodology panel ─────────────────────────────────────
function MethodologyPanel() {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title"><span className="bullet">●</span> Methodology</span>
        <span className="panel-badge">v2.1.0</span>
      </div>
      <div className="panel-body">
        <div className="methodology">
          <h4>Data sources</h4>
          <p>
            On-chain data is indexed via <span className="key">@datumlabs/data-connectors</span> from
            <span className="key"> Allium</span>, <span className="key">Dune</span>, <span className="key">The Graph</span>, and
            <span className="key"> Blockscout</span>. Price feeds are Chainlink oracles; fallback is CoinGecko (5-min delay).
          </p>

          <h4>Metric definitions</h4>
          <ul>
            <li><span className="key">TVL</span> = Σ (supplied − borrowed) × oracle price, per pool, per chain.</li>
            <li><span className="key">Volume</span> = daily sum of supply, borrow, and liquidation notional.</li>
            <li><span className="key">Utilization</span> = borrowed / supplied per pool.</li>
            <li><span className="key">APY</span> uses protocol-native rate models (kinked at 80% util).</li>
            <li><span className="key">Risk tier</span> is derived from oracle quality, depth, and volatility.</li>
          </ul>

          <h4>Refresh cadence</h4>
          <p>
            KPIs and charts refresh every <span className="key">30s</span>. Candlestick uses 24h close.
            Activity feed streams via WebSocket (fallback: 5s poll). Cache layer is Redis; misses hit the chain RPC.
          </p>

          <h4>Caveats</h4>
          <p>
            Cross-chain aggregation assumes USD-pegged stables are equivalent. Liquidation detection may lag 1–2 blocks
            on non-Ethereum chains. Historical data before 90 days is interpolated from hourly snapshots.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Email gate ────────────────────────────────────────────
function EmailGate({ dashboardName, features, onUnlock }) {
  const [email, setEmail] = useStateW('');
  const [err, setErr] = useStateW(null);
  const [loading, setLoading] = useStateW(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setErr('Please enter a valid email.');
      return;
    }
    setLoading(true);
    await new Promise(r => setTimeout(r, 700));
    try { localStorage.setItem('datumlabs_unlocked', 'true'); } catch {}
    setLoading(false);
    onUnlock();
  };

  // Faux sparkline path (static, pre-rendered for the preview card)
  const sparkD = "M 0 55 L 18 50 L 36 52 L 54 42 L 72 38 L 90 34 L 108 28 L 126 32 L 144 22 L 162 18 L 180 20 L 198 14 L 216 10 L 234 15 L 252 8 L 270 6";

  const avatars = [
    { i: 'AV', c: '#FF6B35' },
    { i: 'MK', c: '#3B5FE0' },
    { i: 'RS', c: '#2ECC71' },
    { i: 'JL', c: '#9B59B6' },
    { i: 'TN', c: '#E67E22' },
  ];

  return (
    <div className="gate-backdrop" role="dialog" aria-modal="true" aria-label="Unlock the terminal">
      <div className="gate-card">
        {/* Left preview pane */}
        <div className="gate-preview" aria-hidden="true">
          <div className="gate-preview-brand">
            <img src="assets/icon.png" alt="" />
            <span>datum<span style={{ color: 'var(--orange)' }}>labs</span></span>
          </div>
          <div className="gate-preview-terminal">❯ {dashboardName}</div>
          <div className="gate-preview-title">
            Institutional-grade<br/>
            on-chain <span className="accent">intelligence.</span>
          </div>

          <div className="gate-kpis">
            <div className="gate-kpi">
              <div className="gate-kpi-label">TVL</div>
              <div className="gate-kpi-value">$2.84B</div>
              <div className="gate-kpi-delta up">▲ 4.12%</div>
            </div>
            <div className="gate-kpi">
              <div className="gate-kpi-label">24H VOL</div>
              <div className="gate-kpi-value">$412M</div>
              <div className="gate-kpi-delta up">▲ 8.74%</div>
            </div>
            <div className="gate-kpi">
              <div className="gate-kpi-label">FEES 7D</div>
              <div className="gate-kpi-value">$1.92M</div>
              <div className="gate-kpi-delta down">▼ 1.08%</div>
            </div>
            <div className="gate-kpi">
              <div className="gate-kpi-label">USERS</div>
              <div className="gate-kpi-value">18.4K</div>
              <div className="gate-kpi-delta up">▲ 2.31%</div>
            </div>
          </div>

          <div className="gate-spark">
            <svg viewBox="0 0 270 64" preserveAspectRatio="none">
              <defs>
                <linearGradient id="gateSparkFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FF6B35" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#FF6B35" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${sparkD} L 270 64 L 0 64 Z`} fill="url(#gateSparkFill)" />
              <path d={sparkD} fill="none" stroke="#FF6B35" strokeWidth="1.5" />
            </svg>
          </div>

          <div className="gate-preview-foot">
            <span className="dot" />
            <span>LIVE · SYNCED 2s AGO</span>
          </div>
        </div>

        {/* Right form pane */}
        <div className="gate-form-side">
          <div className="gate-eyebrow">Free access</div>
          <h2 className="gate-title">Unlock the terminal.</h2>
          <p className="gate-sub">
            Join the weekly DatumLabs brief, we'll send you new dashboards, protocol research,
            and on-chain signals. No spam, unsubscribe in one click.
          </p>

          <ul className="gate-features">
            {features.map((f, i) => (
              <li key={i}><span className="tick">✓</span><span>{f}</span></li>
            ))}
          </ul>

          <form className="gate-field" onSubmit={submit} role="form">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M3 7l9 6 9-6" />
            </svg>
            <input
              type="email" className="gate-input" placeholder="you@yourdomain.xyz"
              value={email} onChange={e => setEmail(e.target.value)}
              autoFocus required
            />
            <button type="submit" className="gate-submit" disabled={loading}>
              {loading ? 'Unlocking…' : <>Unlock <span aria-hidden="true">→</span></>}
            </button>
          </form>

          {err && (
            <div className="gate-err">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              {err}
            </div>
          )}

          <div className="gate-fine">
            By continuing you agree to our <a href="#">Terms</a> and <a href="#">Privacy Policy</a>. Delivered via Beehiiv.
          </div>

          <div className="gate-social">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="gate-avatars">
                {avatars.map(a => (
                  <span key={a.i} className="av" style={{ background: a.c }}>{a.i}</span>
                ))}
              </span>
              <span>Joined by <span className="count">12,400+</span> analysts</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} aria-label="5 star rating">
              {[0,1,2,3,4].map(i => (
                <svg key={i} width="11" height="11" viewBox="0 0 24 24" fill="#FF6B35">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                </svg>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  Dropdown, ChartToolbar, snapshotPanel, exportCSV, copyShareLink,
  ExpandModal, MethodologyPanel, EmailGate, showNavSplash,
  // Newer widgets backported from centrifuge dashboard
  PanelSkeleton, DataQualityBadge, DataSourceBadge,
});

// Branded navigation splash, the single canonical transition state.
// Injects the same centered looping Datum mark that the static .boot-splash
// paints on cold boot, so cold-boot and click-to-navigate look identical.
// Called before window.location.href = ... ; it lives until the next page paints
// its own .boot-splash, so there is no flash of blank scaffold between routes.
function showNavSplash() {
  if (document.querySelector('.boot-splash')) return; // never stack two splashes
  const splash = document.createElement('div');
  splash.className = 'boot-splash';
  const mark = document.createElement('img');
  mark.className = 'boot-splash-mark';
  mark.src = 'assets/brand/datum-loop.webp';
  mark.alt = 'Datum Labs';
  splash.appendChild(mark);
  document.body.appendChild(splash);
}
