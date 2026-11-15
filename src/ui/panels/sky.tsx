import { useEffect, useRef } from 'preact/hooks';
import type { SkyInfo } from '../../worker/protocol';
import { controller, ui } from '../controller';
import { Section, years } from '../widgets';

const MOON = ['新月', '三日月', '上弦', '十三夜', '満月', '十八夜', '下弦', '有明'];
const D = 180 / Math.PI;

export function SkyPanel() {
  const sky = ui.sky.value;
  if (!sky) {
    return (
      <p class="muted">
        空を計算しています… <button onClick={() => controller.loadSky()}>再計算</button>
      </p>
    );
  }
  const phase = MOON[Math.round(sky.moonPhase * 8) % 8];
  return (
    <>
      <p class="muted small">
        {years(sky.time)}、{ui.cell.value ? `選んだ地点（経度 ${ui.cell.value.lonDeg.toFixed(0)}°）` : '経度 0°'}から見た真夜中の空。月は{phase}。
        <button class="link" onClick={() => controller.loadSky()}>更新</button>
      </p>
      <SkyChart sky={sky} />
      <Section title="黄道の星座">
        <p class="chips">
          {sky.zodiac.map((z) => (
            <span key={z} class="chip">{z}</span>
          ))}
        </p>
      </Section>
      {sky.aspects.length > 0 && (
        <Section title="いまのアスペクト">
          <ul class="list compact">
            {sky.aspects.map((a, i) => (
              <li key={i}>
                {a.a} と {a.b}：<strong>{a.name}</strong>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {sky.chart && (
        <Section title="この時の星回り">
          <p class="prose">{sky.chart}</p>
          {sky.arcane !== 1 && <p class="muted small">天体配置によるマナの湧出倍率: ×{sky.arcane.toFixed(2)}</p>}
        </Section>
      )}
      <Section title="これからの天文現象">
        {sky.events.length === 0 ? (
          <p class="muted">近いうちの現象はありません。</p>
        ) : (
          <ul class="list compact">
            {sky.events.map((e, i) => (
              <li key={i}>
                <span class="muted">{years(e.time)}</span> {e.text}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="恒星系">
        <Orrery sky={sky} />
        <ul class="list compact">
          {sky.orrery.map((p) => (
            <li key={p.id}>
              <span class="swatch" style={{ background: p.color }} />
              <span class="grow">{p.name}</span>
              <span class="muted small">
                {p.kind} ・ {p.a.toFixed(2)} AU ・ {p.tempC.toFixed(0)}℃{p.habitability > 0.3 ? ` ・ 居住性 ${(p.habitability * 100).toFixed(0)}%` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/** Equirectangular chart of the night sky around the ecliptic (lon −180…180, lat −60…60). */
function SkyChart({ sky }: { sky: SkyInfo }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 320;
    const H = Math.round(W * 0.45);
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.height = `${H}px`;
    const g = cv.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    // Ecliptic longitude / latitude arrive in radians.
    const x = (lon: number) => ((((lon * D) % 360) + 360) % 360) / 360 * W;
    const y = (lat: number) => H / 2 - ((lat * D) / 60) * (H / 2);
    const far = (lat: number) => Math.abs(lat * D) > 60;
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#060a18');
    grad.addColorStop(1, '#0d1430');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // Ecliptic.
    g.strokeStyle = 'rgba(255,220,140,0.35)';
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(0, y(0));
    g.lineTo(W, y(0));
    g.stroke();
    g.setLineDash([]);
    for (const s of sky.stars) {
      if (far(s.lat)) continue;
      const r = Math.max(0.4, 2.2 - s.mag * 0.35);
      g.fillStyle = `rgba(235,240,255,${Math.max(0.25, 1 - s.mag * 0.13)})`;
      g.beginPath();
      g.arc(x(s.lon), y(s.lat), r, 0, Math.PI * 2);
      g.fill();
    }
    g.font = '10px system-ui, sans-serif';
    g.textAlign = 'center';
    for (const c of sky.constellations) {
      if (far(c.lat)) continue;
      g.strokeStyle = c.zodiac ? 'rgba(255,210,120,0.45)' : 'rgba(150,180,255,0.3)';
      g.lineWidth = 1;
      for (const [a, b] of c.lines) {
        const sa = sky.stars[a], sb = sky.stars[b];
        if (!sa || !sb || Math.abs(x(sa.lon) - x(sb.lon)) > W / 2) continue;
        g.beginPath();
        g.moveTo(x(sa.lon), y(sa.lat));
        g.lineTo(x(sb.lon), y(sb.lat));
        g.stroke();
      }
      g.fillStyle = c.zodiac ? 'rgba(255,220,150,0.8)' : 'rgba(170,190,255,0.6)';
      g.fillText(c.name, x(c.lon), y(c.lat) - 8);
    }
    for (const b of sky.bodies) {
      if (far(b.lat)) continue;
      const big = b.kind === 'star' ? 7 : b.kind === 'moon' ? 6 : 3.5;
      g.fillStyle = b.color;
      g.shadowColor = b.color;
      g.shadowBlur = b.kind === 'star' ? 14 : 6;
      g.beginPath();
      g.arc(x(b.lon), y(b.lat), big, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#fff';
      g.fillText(b.name, x(b.lon), y(b.lat) + big + 11);
    }
  }, [sky]);
  return <canvas ref={ref} class="sky-chart" aria-label="天球図" />;
}

/** Top view of the planetary system at this moment. */
function Orrery({ sky }: { sky: SkyInfo }) {
  const maxA = Math.max(1, ...sky.orrery.map((p) => p.a));
  const R = 95;
  const sc = (a: number) => (Math.sqrt(a) / Math.sqrt(maxA)) * R;
  return (
    <svg class="orrery" viewBox="-100 -100 200 200" aria-label="恒星系の配置">
      <circle cx="0" cy="0" r="5" fill="#ffd27a" />
      {sky.orrery.map((p) => {
        const r = sc(p.a);
        const ang = Math.atan2(p.y, p.x);
        return (
          <g key={p.id}>
            <circle cx="0" cy="0" r={r} fill="none" stroke="var(--line)" stroke-width="0.5" />
            <circle cx={r * Math.cos(ang)} cy={-r * Math.sin(ang)} r={p.habitability > 0.3 ? 3.5 : 2.5} fill={p.color} />
          </g>
        );
      })}
    </svg>
  );
}
