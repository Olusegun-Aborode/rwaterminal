// Chart primitives — tiny SVG components, no external deps.
// Usage: pass series, width, height. Interactivity via inline handlers.

const { useState, useRef, useMemo, useEffect, useCallback } = React;

// ── Helpers ──────────────────────────────────────────────
const fmtUSD = (v, digits = 2) => {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(digits)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(digits)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(digits)}K`;
  return `$${v.toFixed(digits)}`;
};
const fmtNum = (v, d = 2) => {
  if (v >= 1e9) return `${(v / 1e9).toFixed(d)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(d)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(d)}K`;
  return v.toFixed(d);
};
const fmtPct = (v, d = 2) => `${v.toFixed(d)}%`;
const daysAgoLabel = (offsetFromNow, totalDays) => {
  const ago = totalDays - 1 - offsetFromNow;
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  return `${ago}d ago`;
};
window.fmtUSD = fmtUSD; window.fmtNum = fmtNum; window.fmtPct = fmtPct;

// ── AreaChart ────────────────────────────────────────────
// ── Chart watermark ─────────────────────────────────────
function ChartWatermark({ x, y }) {
  return (
    <text x={x} y={y} textAnchor="end" fontFamily="var(--font-mono)"
      fontSize="11" fill="var(--fg-muted)" opacity="0.14" style={{ pointerEvents: 'none', letterSpacing: '0.12em' }}>
      DATUM LABS · DEMO
    </text>
  );
}

// series: [{ name, color, values: number[] }, ...]
// stacked: boolean
function AreaChart({ series, stacked = false, width = 800, height = 280, formatter = fmtUSD, valueSuffix = '', overlayCompare = null }) {
  const padL = 54, padR = 18, padT = 12, padB = 28;
  const w = width, h = height;
  const iw = w - padL - padR, ih = h - padT - padB;
  const [hover, setHover] = useState(null); // { x, i }

  const len = series[0]?.values.length || 0;
  if (!len) return null;

  // Stack if needed
  const stacked_vals = useMemo(() => {
    if (!stacked) return series.map(s => s.values);
    const stacks = series.map(() => new Array(len).fill(0));
    for (let i = 0; i < len; i++) {
      let acc = 0;
      for (let s = 0; s < series.length; s++) {
        acc += series[s].values[i];
        stacks[s][i] = acc;
      }
    }
    return stacks;
  }, [series, stacked, len]);

  const maxY = useMemo(() => {
    let m = 0;
    if (stacked) {
      for (let i = 0; i < len; i++) m = Math.max(m, stacked_vals[stacked_vals.length - 1][i]);
    } else {
      series.forEach(s => s.values.forEach(v => m = Math.max(m, v)));
      if (overlayCompare) overlayCompare.forEach(s => s.values.forEach(v => m = Math.max(m, v)));
    }
    return m * 1.1;
  }, [series, stacked, len, overlayCompare]);

  const x = (i) => padL + (i / (len - 1)) * iw;
  const y = (v) => padT + ih - (v / maxY) * ih;

  // Build paths
  const paths = series.map((s, si) => {
    const vals = stacked ? stacked_vals[si] : s.values;
    const prev = stacked && si > 0 ? stacked_vals[si - 1] : null;
    let d = `M ${x(0)} ${y(vals[0])}`;
    for (let i = 1; i < len; i++) d += ` L ${x(i)} ${y(vals[i])}`;
    let area = d;
    if (prev) {
      for (let i = len - 1; i >= 0; i--) area += ` L ${x(i)} ${y(prev[i])}`;
      area += ' Z';
    } else {
      area += ` L ${x(len - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
    }
    return { d, area, color: s.color };
  });

  const overlayPaths = (overlayCompare || []).map(s => {
    let d = `M ${x(0)} ${y(s.values[0])}`;
    for (let i = 1; i < s.values.length; i++) d += ` L ${x(i)} ${y(s.values[i])}`;
    return { d, color: s.color, name: s.name, values: s.values };
  });

  // Y ticks
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => maxY * t);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const rel = (mx - padL) / iw;
    if (rel < -0.02 || rel > 1.02) { setHover(null); return; }
    const i = Math.max(0, Math.min(len - 1, Math.round(rel * (len - 1))));
    setHover({ i, x: x(i) });
  };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        style={{ display: 'block', cursor: 'crosshair' }}
      >
        {/* grid */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray="2 3" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fontFamily="var(--font-mono)" fill="var(--fg-muted)">
              {formatter(t, t >= 1000 ? 1 : 2)}{valueSuffix}
            </text>
          </g>
        ))}
        {/* x labels */}
        {[0, Math.floor(len/4), Math.floor(len/2), Math.floor(3*len/4), len-1].map(i => (
          <text key={i} x={x(i)} y={h - 8} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="var(--fg-muted)">
            {daysAgoLabel(i, len)}
          </text>
        ))}
        {/* areas and lines */}
        {paths.map((p, i) => (
          <g key={i}>
            <path d={p.area} fill={p.color} opacity={stacked ? 0.85 : 0.12} />
            <path d={p.d} fill="none" stroke={p.color} strokeWidth={stacked ? 0 : 2} strokeLinejoin="round" />
          </g>
        ))}
        {/* overlay compare */}
        {overlayPaths.map((p, i) => (
          <path key={i} d={p.d} fill="none" stroke={p.color} strokeWidth="2" strokeDasharray="4 3" />
        ))}
        {/* Hover */}
        {hover && (
          <g>
            <line x1={hover.x} x2={hover.x} y1={padT} y2={padT + ih} stroke="var(--orange)" strokeWidth="1" opacity="0.7" />
            {series.map((s, si) => {
              const vals = stacked ? stacked_vals[si] : s.values;
              return <circle key={si} cx={hover.x} cy={y(vals[hover.i])} r="3.5" fill={s.color} stroke="var(--surface)" strokeWidth="1.5" />;
            })}
            {overlayPaths.map((p, i) => (
              <circle key={i} cx={hover.x} cy={y(p.values[hover.i])} r="3.5" fill={p.color} stroke="var(--surface)" strokeWidth="1.5" />
            ))}
          </g>
        )}
        <ChartWatermark x={w - 20} y={padT + 16} />
      </svg>
      {hover && (
        <div className="chart-tooltip" style={{
          left: Math.min(hover.x + 12, w - 180),
          top: 10,
        }}>
          <div className="t-date">{daysAgoLabel(hover.i, len)}</div>
          {series.map(s => (
            <div key={s.name} className="t-row">
              <span className="t-label"><span className="legend-swatch" style={{ background: s.color, marginRight: 6 }} />{s.name}</span>
              <span>{formatter(s.values[hover.i], 2)}{valueSuffix}</span>
            </div>
          ))}
          {overlayPaths.map(p => (
            <div key={p.name} className="t-row">
              <span className="t-label"><span className="legend-swatch" style={{ background: p.color, marginRight: 6, borderStyle: 'dashed' }} />{p.name}</span>
              <span>{formatter(p.values[hover.i], 2)}{valueSuffix}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── StackedBarChart ──────────────────────────────────────
function StackedBarChart({ data, keys, colors, width = 800, height = 220, formatter = fmtUSD }) {
  const padL = 54, padR = 18, padT = 12, padB = 26;
  const iw = width - padL - padR, ih = height - padT - padB;
  const [hover, setHover] = useState(null);

  const totals = data.map(d => keys.reduce((a, k) => a + d[k], 0));
  const maxY = Math.max(...totals) * 1.1;
  const n = data.length;
  const bw = iw / n * 0.7;
  const gap = iw / n * 0.3;
  const x = (i) => padL + i * (iw / n) + gap / 2;
  const y = (v) => padT + ih - (v / maxY) * ih;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => maxY * t);

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ display: 'block' }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray="2 3" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fontFamily="var(--font-mono)" fill="var(--fg-muted)">
              {formatter(t, 0)}
            </text>
          </g>
        ))}
        {[0, Math.floor(n/4), Math.floor(n/2), Math.floor(3*n/4), n-1].map(i => (
          <text key={i} x={x(i) + bw / 2} y={height - 8} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="var(--fg-muted)">
            {daysAgoLabel(i, n)}
          </text>
        ))}
        {data.map((d, i) => {
          let acc = 0;
          return (
            <g key={i} onMouseEnter={() => setHover({ i, x: x(i) + bw / 2 })}>
              {keys.map((k, ki) => {
                const v = d[k];
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                return (
                  <rect key={k}
                    x={x(i)} y={y1}
                    width={bw} height={Math.max(0.5, y0 - y1)}
                    fill={colors[ki]}
                    opacity={hover && hover.i !== i ? 0.35 : 0.92}
                  />
                );
              })}
              <rect x={x(i) - 2} y={padT} width={bw + 4} height={ih} fill="transparent" />
            </g>
          );
        })}
        <ChartWatermark x={width - 20} y={padT + 16} />
      </svg>
      {hover && (
        <div className="chart-tooltip" style={{
          left: Math.min(hover.x + 12, width - 180),
          top: 10,
        }}>
          <div className="t-date">{daysAgoLabel(hover.i, n)}</div>
          {keys.map((k, ki) => (
            <div key={k} className="t-row">
              <span className="t-label"><span className="legend-swatch" style={{ background: colors[ki], marginRight: 6 }} />{k}</span>
              <span>{formatter(data[hover.i][k], 1)}</span>
            </div>
          ))}
          <div className="t-row" style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.2)' }}>
            <span className="t-label">TOTAL</span>
            <span>{formatter(totals[hover.i], 1)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Treemap ──────────────────────────────────────────────
// Simple squarified treemap
function Treemap({ items, width = 400, height = 280, onSelect, selectedId }) {
  // items: [{id, name, value, color}]
  const total = items.reduce((a, b) => a + b.value, 0);

  function squarify(items, x, y, w, h) {
    if (!items.length) return [];
    if (items.length === 1) return [{ ...items[0], x, y, w, h }];
    const totalV = items.reduce((a, b) => a + b.value, 0);
    // Take items one at a time, decide row when aspect starts getting worse
    const shortSide = Math.min(w, h);
    let row = [];
    let rest = items.slice();
    let best = Infinity;
    while (rest.length) {
      const candidate = [...row, rest[0]];
      const sum = candidate.reduce((a, b) => a + b.value, 0);
      const scale = (shortSide * shortSide) / (sum * sum / totalV * w * h);
      const worst = candidate.reduce((m, it) => {
        const area = it.value / totalV * w * h;
        const s = scale;
        return Math.max(m, Math.max(s * area, 1 / (s * area)));
      }, 0);
      if (worst > best && row.length) break;
      row.push(rest.shift());
      best = worst;
    }
    const sumRow = row.reduce((a, b) => a + b.value, 0);
    const rects = [];
    if (w < h) {
      const rowH = (sumRow / totalV) * h * (w * h) / (w * h);
      const rh = sumRow / totalV * h;
      let cx = x;
      row.forEach(it => {
        const rw = it.value / sumRow * w;
        rects.push({ ...it, x: cx, y, w: rw, h: rh });
        cx += rw;
      });
      rects.push(...squarify(rest, x, y + rh, w, h - rh));
    } else {
      const rw = sumRow / totalV * w;
      let cy = y;
      row.forEach(it => {
        const rh = it.value / sumRow * h;
        rects.push({ ...it, x, y: cy, w: rw, h: rh });
        cy += rh;
      });
      rects.push(...squarify(rest, x + rw, y, w - rw, h));
    }
    return rects;
  }

  const sorted = [...items].sort((a, b) => b.value - a.value);
  const rects = squarify(sorted, 0, 0, width, height);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ display: 'block' }}>
      {rects.map(r => {
        const pct = (r.value / total * 100).toFixed(1);
        const big = r.w > 70 && r.h > 40;
        const sel = selectedId === r.id;
        return (
          <g key={r.id} style={{ cursor: 'pointer' }} onClick={() => onSelect && onSelect(r.id)}>
            <rect x={r.x + 1} y={r.y + 1} width={Math.max(0, r.w - 2)} height={Math.max(0, r.h - 2)}
              fill={r.color} opacity={sel ? 0.95 : 0.82} stroke={sel ? 'var(--fg)' : 'transparent'} strokeWidth={sel ? 2 : 0} rx="3" />
            {big && (
              <>
                <text x={r.x + 10} y={r.y + 20} fontSize="12" fontWeight="600" fill="white" fontFamily="var(--font-mono)">{r.name}</text>
                <text x={r.x + 10} y={r.y + 36} fontSize="11" fill="white" opacity="0.85" fontFamily="var(--font-mono)">{fmtUSD(r.value * 1e6, 1)}</text>
                <text x={r.x + 10} y={r.y + 50} fontSize="10" fill="white" opacity="0.7" fontFamily="var(--font-mono)">{pct}%</text>
              </>
            )}
            {!big && r.w > 40 && r.h > 20 && (
              <text x={r.x + 6} y={r.y + 16} fontSize="10" fontWeight="600" fill="white" fontFamily="var(--font-mono)">{r.name}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Sparkline ────────────────────────────────────────────
function Sparkline({ values, color = 'var(--orange)', width = 90, height = 32, filled = true }) {
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const d = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {filled && <path d={`${d} L ${width} ${height} L 0 ${height} Z`} fill={color} opacity="0.14" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

// ── Horizontal bar leaderboard ───────────────────────────
function Leaderboard({ items, color = 'var(--orange)', format = fmtUSD }) {
  const max = Math.max(...items.map(i => i.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, idx) => (
        <div key={it.id || it.name}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-dim)', fontSize: 11, width: 16 }}>{String(idx + 1).padStart(2, '0')}</span>
              {it.dot && <span className="legend-swatch" style={{ background: it.dot }} />}
              <span style={{ fontWeight: 500 }}>{it.name}</span>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', fontSize: 12 }}>{format(it.value)}</span>
          </div>
          <div style={{ height: 6, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${it.value / max * 100}%`, background: it.dot || color, borderRadius: 3, transition: 'width 0.4s' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Heatmap ──────────────────────────────────────────────
function Heatmap({ data }) {
  // data: 7 rows x 24 cols, values 0..1
  const days = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '36px repeat(24, 1fr)', gap: 2, alignItems: 'center' }}>
        <div />
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={h} style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-dim)', textAlign: 'center', opacity: h % 4 === 0 ? 1 : 0 }}>
            {String(h).padStart(2, '0')}
          </div>
        ))}
        {data.map((row, d) => (
          <React.Fragment key={d}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-muted)' }}>{days[d]}</div>
            {row.map((v, h) => (
              <div key={h} title={`${days[d]} ${h}:00 — ${Math.round(v*100)}% activity`}
                style={{
                  aspectRatio: '1 / 1',
                  background: `rgba(255,107,53,${0.08 + v * 0.9})`,
                  borderRadius: 2,
                  cursor: 'pointer',
                  transition: 'transform 0.1s',
                }}
                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.4)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
              />
            ))}
          </React.Fragment>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>
        <span>LOW</span>
        {[0.1, 0.3, 0.5, 0.7, 0.9].map(v => (
          <span key={v} style={{ width: 14, height: 10, background: `rgba(255,107,53,${0.08 + v * 0.9})`, borderRadius: 2, display: 'inline-block' }} />
        ))}
        <span>HIGH</span>
      </div>
    </div>
  );
}

// ── Candlestick ──────────────────────────────────────────
function Candlestick({ data, width = 400, height = 180 }) {
  const padL = 40, padR = 10, padT = 8, padB = 20;
  const iw = width - padL - padR, ih = height - padT - padB;
  const [hover, setHover] = useState(null);

  const hi = Math.max(...data.map(d => d.h));
  const lo = Math.min(...data.map(d => d.l));
  const range = hi - lo;
  const y = (v) => padT + ih - ((v - lo) / range) * ih;
  const bw = iw / data.length * 0.7;
  const gap = iw / data.length * 0.3;
  const x = (i) => padL + i * (iw / data.length) + gap / 2;

  const ticks = [lo, lo + range * 0.5, hi];

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ display: 'block' }} onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray="2 3" />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fontFamily="var(--font-mono)" fill="var(--fg-muted)">${t.toFixed(2)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const up = d.c >= d.o;
          const color = up ? 'var(--green)' : 'var(--red)';
          const bodyY = y(Math.max(d.o, d.c));
          const bodyH = Math.max(1, Math.abs(y(d.o) - y(d.c)));
          return (
            <g key={i} onMouseEnter={() => setHover({ i, x: x(i) + bw / 2 })}>
              <line x1={x(i) + bw / 2} x2={x(i) + bw / 2} y1={y(d.h)} y2={y(d.l)} stroke={color} strokeWidth="1" />
              <rect x={x(i)} y={bodyY} width={bw} height={bodyH} fill={color} opacity={hover && hover.i !== i ? 0.4 : 0.9} />
              <rect x={x(i) - 1} y={padT} width={bw + 2} height={ih} fill="transparent" />
            </g>
          );
        })}
        <ChartWatermark x={width - 12} y={padT + 14} />
      </svg>
      {hover && (
        <div className="chart-tooltip" style={{ left: Math.min(hover.x + 10, width - 140), top: 4 }}>
          <div className="t-date">Day -{data.length - 1 - hover.i}</div>
          <div className="t-row"><span className="t-label">Open</span><span>${data[hover.i].o.toFixed(3)}</span></div>
          <div className="t-row"><span className="t-label">High</span><span>${data[hover.i].h.toFixed(3)}</span></div>
          <div className="t-row"><span className="t-label">Low</span><span>${data[hover.i].l.toFixed(3)}</span></div>
          <div className="t-row"><span className="t-label">Close</span><span>${data[hover.i].c.toFixed(3)}</span></div>
        </div>
      )}
    </div>
  );
}

// ── Histogram ────────────────────────────────────────────
// Distribution primitive. Accepts raw `values` (component bins them) or
// pre-computed `bins`. Bars can be value-weighted via `weight` so height
// reflects summed weight (e.g. USD) instead of raw count.
const fmtEdge = (n) => {
  if (!isFinite(n)) return '∞';
  if (Math.abs(n) >= 1000) return fmtNum(n, 1);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

function Histogram({
  values, bins: preBins, weight, binCount = 20, binWidth,
  width = 480, height = 220, color = 'var(--chart-1)',
  xLabel, yLabel, valueFormat = fmtUSD, clampRange, markers = [], colorBands = [],
}) {
  const padL = 50, padR = 18, padT = 16, padB = 34;
  const iw = width - padL - padR, ih = height - padT - padB;
  const [hover, setHover] = useState(null); // bin index

  const weighted = !!(weight && weight.length) || !!(preBins && preBins.some(b => b.weight != null));

  const { bins, total } = useMemo(() => {
    let bins;
    if (preBins && preBins.length) {
      bins = preBins.map(b => ({ x0: b.x0, x1: b.x1, count: b.count ?? 0, weight: b.weight ?? b.count ?? 0 }));
    } else {
      const vals = values || [];
      let lo, hi;
      if (clampRange) { lo = clampRange[0]; hi = clampRange[1]; }
      else {
        lo = vals.length ? Math.min(...vals) : 0;
        hi = vals.length ? Math.max(...vals) : 1;
      }
      if (!isFinite(lo) || !isFinite(hi) || lo === hi) { lo = lo || 0; hi = lo + 1; }
      let nBins, bw;
      if (binWidth) { bw = binWidth; nBins = Math.max(1, Math.ceil((hi - lo) / bw)); }
      else { nBins = Math.max(1, Math.round(binCount)); bw = (hi - lo) / nBins; }
      bins = Array.from({ length: nBins }, (_, i) => ({ x0: lo + i * bw, x1: lo + (i + 1) * bw, count: 0, weight: 0 }));
      vals.forEach((v, idx) => {
        const w = weighted ? (weight[idx] ?? 0) : 1;
        // Fold outliers into the end bins when a clampRange is given.
        const cv = clampRange ? Math.max(lo, Math.min(hi - 1e-9, v)) : v;
        let bi = Math.floor((cv - lo) / bw);
        if (bi < 0) bi = 0;
        if (bi >= nBins) bi = nBins - 1;
        bins[bi].count += 1;
        bins[bi].weight += w;
      });
    }
    const total = bins.reduce((a, b) => a + (weighted ? b.weight : b.count), 0) || 1;
    return { bins, total };
  }, [values, preBins, weight, binCount, binWidth, clampRange, weighted]);

  if (!bins.length) return null;

  const metric = (b) => (weighted ? b.weight : b.count);
  const maxY = (Math.max(...bins.map(metric)) || 1) * 1.1;
  const x0v = bins[0].x0, x1v = bins[bins.length - 1].x1;
  const span = (x1v - x0v) || 1;
  const xPx = (v) => padL + ((v - x0v) / span) * iw;
  const y = (v) => padT + ih - (v / maxY) * ih;

  const bandColor = (b) => {
    if (!colorBands.length) return color;
    const c = (b.x0 + b.x1) / 2;
    const band = colorBands.find(bd => c >= bd.from && c < bd.to);
    return band ? band.color : color;
  };

  // y gridlines
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => maxY * t);

  // x edge ticks, thinned so they stay legible with many bins
  const edgeStep = Math.max(1, Math.ceil(bins.length / 8));
  const edges = bins.filter((_, i) => i % edgeStep === 0).map(b => b.x0).concat([x1v]);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ display: 'block', cursor: 'crosshair' }}
        onMouseLeave={() => setHover(null)}>
        {/* y grid */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray="2 3" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fontFamily="var(--font-mono)" fill="var(--fg-muted)">
              {weighted ? valueFormat(t, t >= 1000 ? 1 : 0) : fmtNum(t, 0)}
            </text>
          </g>
        ))}
        {/* x edge ticks */}
        {edges.map((e, i) => (
          <text key={i} x={xPx(e)} y={height - 12} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="var(--fg-muted)">
            {fmtEdge(e)}
          </text>
        ))}
        {/* axis titles */}
        {xLabel && (
          <text x={padL + iw / 2} y={height - 1} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="var(--fg-dim)" style={{ letterSpacing: '0.06em' }}>{xLabel}</text>
        )}
        {yLabel && (
          <text x={12} y={padT + ih / 2} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="var(--fg-dim)"
            transform={`rotate(-90 12 ${padT + ih / 2})`} style={{ letterSpacing: '0.06em' }}>{yLabel}</text>
        )}
        {/* color bands (faint backdrop) */}
        {colorBands.map((bd, i) => {
          const from = Math.max(x0v, bd.from);
          const to = Math.min(x1v, isFinite(bd.to) ? bd.to : x1v);
          if (to <= from) return null;
          return <rect key={i} x={xPx(from)} y={padT} width={Math.max(0, xPx(to) - xPx(from))} height={ih} fill={bd.color} opacity="0.05" />;
        })}
        {/* bars */}
        {bins.map((b, i) => {
          const bx0 = xPx(b.x0), bx1 = xPx(b.x1);
          const bw = Math.max(0, bx1 - bx0 - 1);
          const top = y(metric(b));
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={bx0 + 0.5} y={top} width={bw} height={Math.max(0, padT + ih - top)}
                fill={bandColor(b)} opacity={hover != null && hover !== i ? 0.4 : 0.85} />
              {/* full-height hit target */}
              <rect x={bx0} y={padT} width={Math.max(1, bx1 - bx0)} height={ih} fill="transparent" />
            </g>
          );
        })}
        {/* markers (vertical reference lines) */}
        {markers.filter(m => m.value >= x0v && m.value <= x1v).map((m, i) => (
          <g key={i}>
            <line x1={xPx(m.value)} x2={xPx(m.value)} y1={padT} y2={padT + ih}
              stroke={m.color || 'var(--fg-muted)'} strokeWidth="1.5" strokeDasharray="4 3" opacity="0.9" />
            {m.label && (
              <text x={xPx(m.value)} y={padT - 4} textAnchor="middle" fontSize="9" fontFamily="var(--font-mono)"
                fill={m.color || 'var(--fg-muted)'} style={{ letterSpacing: '0.04em' }}>{m.label}</text>
            )}
          </g>
        ))}
        {/* hover crosshair */}
        {hover != null && (
          <line x1={(xPx(bins[hover].x0) + xPx(bins[hover].x1)) / 2} x2={(xPx(bins[hover].x0) + xPx(bins[hover].x1)) / 2}
            y1={padT} y2={padT + ih} stroke="var(--orange)" strokeWidth="1" opacity="0.7" />
        )}
        <ChartWatermark x={width - 20} y={padT + 16} />
      </svg>
      {hover != null && (() => {
        const b = bins[hover];
        const cx = (xPx(b.x0) + xPx(b.x1)) / 2;
        const share = (metric(b) / total) * 100;
        return (
          <div className="chart-tooltip" style={{ left: Math.min(cx + 12, width - 180), top: 10 }}>
            <div className="t-date">{fmtEdge(b.x0)} – {fmtEdge(b.x1)}</div>
            <div className="t-row"><span className="t-label">Count</span><span>{b.count}</span></div>
            {weighted && (
              <div className="t-row"><span className="t-label">{yLabel || 'Value'}</span><span>{valueFormat(b.weight, 2)}</span></div>
            )}
            <div className="t-row"><span className="t-label">Share</span><span>{share.toFixed(1)}%</span></div>
          </div>
        );
      })()}
    </div>
  );
}

// ── HealthFactorHistogram ────────────────────────────────
// Preset wrapper over Histogram for health-factor distributions.
// mode 'usd' weights bars by debtUsd (dollars at risk); 'count' counts positions.
function HealthFactorHistogram({
  positions = [], mode = 'usd', width = 480, height = 220, binCount = 24,
  clampRange = [0, 3], showThreshold = true, markers, colorBands,
}) {
  const weighted = mode === 'usd';
  const values = positions.map(p => p.hf);
  const weight = weighted ? positions.map(p => p.debtUsd ?? 0) : undefined;

  const defaultMarkers = [{ value: 1.0, label: 'Liquidation', color: 'var(--red)' }];
  if (showThreshold) defaultMarkers.push({ value: 1.5, label: '1.5', color: 'var(--yellow)' });

  const defaultBands = [
    { from: 0, to: 1.0, color: 'var(--red)' },
    { from: 1.0, to: 1.5, color: 'var(--yellow)' },
    { from: 1.5, to: Infinity, color: 'var(--green)' },
  ];

  return (
    <Histogram
      values={values}
      weight={weight}
      binCount={binCount}
      clampRange={clampRange}
      width={width}
      height={height}
      color="var(--chart-1)"
      valueFormat={weighted ? fmtUSD : ((n) => fmtNum(n, 0))}
      markers={markers || defaultMarkers}
      colorBands={colorBands || defaultBands}
      xLabel="Health Factor"
      yLabel={weighted ? 'Debt at risk' : 'Positions'}
    />
  );
}

Object.assign(window, { AreaChart, StackedBarChart, Treemap, Sparkline, Leaderboard, Heatmap, Candlestick, Histogram, HealthFactorHistogram });
