import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PersonaMeta } from "../types";
import { DISTRICTS, VSTYLE, districtOf, skinFor, splitName, type Stage, type V } from "./model";
import { H, PATCHES, ROADS, TREES, W, computeGatherSpots, computeHomes, computeZoneSpots } from "./layout";

export interface VillageProps {
  personas: PersonaMeta[];
  stage: Stage;
  /** Persona ids in the order their verdict (or failure) arrived. */
  arrival: string[];
  verdictOf: (id: string) => V | undefined;
  selectedId: string | null;
  onPick: (id: string) => void;
  /** Preview bubble for the selected character (rendered next to them, unscaled for readability). */
  bubble?: ReactNode;
  banner?: { word: string; score: number | string; color: string } | null;
  ideaLabel: string;
}

/**
 * Scale the fixed 1280×736 village to the width it's given. Below MIN_SCALE characters get too
 * small to read or tap, so on phones the village keeps MIN_SCALE and pans sideways instead,
 * starting centred on the council square.
 */
const MIN_SCALE = 0.62;
function useFitScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.75);
  const centred = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const s = Math.max(MIN_SCALE, Math.min(1, el.clientWidth / W));
      setScale(s);
      if (!centred.current && W * s > el.clientWidth) {
        el.scrollLeft = (W * s - el.clientWidth) / 2;
        centred.current = true;
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, scale };
}

export function Village({ personas, stage, arrival, verdictOf, selectedId, onPick, bubble, banner, ideaLabel }: VillageProps) {
  const { ref, scale } = useFitScale();
  const homes = useMemo(() => computeHomes(personas), [personas]);
  const gather = useMemo(() => computeGatherSpots(homes), [homes]);
  const arrivalRank = useMemo(() => new Map(arrival.map((id, k) => [id, k])), [arrival]);
  const { spots, counts } = useMemo(() => computeZoneSpots(arrival, verdictOf), [arrival, verdictOf]);
  const showSides = stage === "deciding" || stage === "result" || stage === "failed";
  const out = stage !== "idle";

  const chars = personas.map((p, i) => {
    const home = homes.get(p.id)!;
    const v = verdictOf(p.id);
    const rank = arrivalRank.get(p.id);
    const decided = showSides && rank !== undefined;
    let pos = { x: home.x, y: home.y };
    let thinking = false;
    let sleeping = false;
    if (stage === "assembly" || stage === "thinking") {
      pos = gather.get(p.id)!;
      thinking = stage === "thinking" && i % 3 === 0;
    } else if (showSides) {
      if (decided && v === "f") {
        sleeping = true;
      } else if (decided && spots.has(p.id)) {
        pos = spots.get(p.id)!;
      } else {
        pos = gather.get(p.id)!;
        thinking = stage === "deciding" && i % 4 === 0;
      }
    }
    const d = districtOf(p.category);
    const { short, role } = splitName(p.name);
    return {
      p, i, home, pos, thinking, sleeping, d, short, role,
      walking: stage === "assembly",
      delay: stage === "assembly" ? (i * 37) % 900 : 0,
      burst: stage === "deciding" && rank !== undefined && rank >= arrival.length - 2 && v !== undefined,
      v,
      selected: p.id === selectedId,
    };
  });

  const sel = chars.find((c) => c.selected);
  // Bubble anchor in screen pixels (outside the scaled layer so text stays readable).
  const bubblePos = sel
    ? (() => {
        const bw = 330;
        const cx = (sel.pos.x) * scale;
        const top = (sel.pos.y - 36) * scale;
        const x = Math.max(8, Math.min(W * scale - bw - 8, cx - bw / 2));
        const above = top - 12;
        return { x, y: above, flip: above < 230 };
      })()
    : null;

  const tint = { idle: "rgba(255,255,255,0)", assembly: "rgba(255,170,80,0.08)", thinking: "rgba(255,150,60,0.13)", deciding: "rgba(255,130,50,0.16)", result: "rgba(90,60,160,0.12)", failed: "rgba(60,60,90,0.18)" }[stage];

  return (
    <div className="village-frame">
      <div ref={ref} className="village-scroll">
      <div className="village-fit" style={{ width: W * scale, height: H * scale }}>
        <div className="village" style={{ transform: `scale(${scale})` }}>
          {PATCHES.map((g, k) => (
            <div key={k} aria-hidden="true" className="v-abs" style={{ left: g.x, top: g.y, width: g.w, height: g.h, borderRadius: "50%", background: g.c }} />
          ))}
          {ROADS.map((r, k) => (
            <div key={k} aria-hidden="true" className="v-road" style={{ left: r.x, top: r.y, width: r.len, transform: `rotate(${r.deg}deg)` }} />
          ))}
          <div aria-hidden="true" className="v-abs v-plaza-rim" />
          <div aria-hidden="true" className="v-abs v-plaza" />

          {showSides && (
            <>
              <div aria-hidden="true" className="v-abs v-zone v-zone-b" />
              <div aria-hidden="true" className="v-abs v-zone v-zone-d" />
              <div aria-hidden="true" className="v-abs v-zone v-zone-m" />
              <div aria-hidden="true" className="v-abs v-pole" style={{ left: 398 }} />
              <div className="v-abs v-flag v-flag-b">BUILD · {counts.b}</div>
              <div aria-hidden="true" className="v-abs v-pole" style={{ left: 878 }} />
              <div className="v-abs v-flag v-flag-d">DON'T BUILD · {counts.d}</div>
              <div className="v-abs v-maybe-sign">MAYBE · {counts.m}</div>
            </>
          )}

          <div aria-hidden="true" className="v-abs v-table" />
          {out && (
            <>
              <div aria-hidden="true" className={`v-abs v-scroll ${stage === "thinking" || stage === "deciding" ? "live" : ""}`} />
              <div className="v-abs v-idea-label">“{ideaLabel}”</div>
            </>
          )}
          {!out && (
            <>
              <div className="v-abs v-idle-title">The council is home.</div>
              <div className="v-abs v-idle-sub">Write a proposal to call them to the square.</div>
            </>
          )}

          {TREES.map((t, k) => (
            <div key={k} aria-hidden="true" className="v-abs" style={{ left: t.x, top: t.y, width: t.s, height: t.s }}>
              <div className="v-trunk" />
              <div className="v-crown" />
            </div>
          ))}

          {DISTRICTS.map((d) => (
            <div key={d.category} className="v-abs v-district" style={{ left: d.x, top: d.y }}>
              <span aria-hidden="true" className="v-district-dot" style={{ background: d.color }} />
              <span>{d.label}</span>
            </div>
          ))}

          {chars.map((c) => {
            const isOut = out && !c.sleeping;
            return (
              <div key={`h-${c.p.id}`}>
                <svg aria-hidden="true" width="64" height="56" viewBox="0 0 64 56" className="v-abs" style={{ left: c.home.hx, top: c.home.hy, overflow: "visible" }}>
                  <ellipse cx="32" cy="54" rx="30" ry="5" fill="rgba(50,80,30,0.22)" />
                  <rect x="44" y="9" width="7" height="12" fill="#8C6A55" />
                  <rect x="10" y="26" width="44" height="28" rx="3" fill="#FFF8EE" />
                  <rect x="40" y="26" width="14" height="28" fill="#EFE2CC" />
                  <polygon points="5,28 32,5 32,28" fill={c.d.color} />
                  <polygon points="32,5 59,28 32,28" fill={c.d.dark} />
                  <rect x="15" y="33" width="8" height="8" rx="1.5" fill={isOut ? "#BFD6EA" : "#FFE7A3"} />
                  <rect x="43" y="33" width="7" height="8" rx="1.5" fill={isOut ? "#BFD6EA" : "#FFE7A3"} />
                  <path d="M27 54 V43 a5 5 0 0 1 10 0 V54 Z" fill={isOut ? "#3B2F25" : "#B98552"} />
                </svg>
                <div className="v-abs v-nameplate" style={{ left: c.home.hx + 32, top: c.home.hy + 56 }}>{c.short}</div>
                {c.sleeping && <div aria-hidden="true" className="v-abs v-alert" style={{ left: c.home.hx + 46, top: c.home.hy - 4 }}>!</div>}
              </div>
            );
          })}

          <div aria-hidden="true" className="v-abs v-tint" style={{ inset: 0, background: tint }} />

          {chars.map((c) => (
            <button
              key={c.p.id}
              type="button"
              className={`v-char ${c.walking ? "walking" : ""}`}
              onClick={() => onPick(c.p.id)}
              aria-label={`${c.p.name}${c.v ? `: ${VSTYLE[c.v].label.toLowerCase()}` : ""}`}
              aria-pressed={c.selected}
              style={{ left: Math.round(c.pos.x - 12), top: Math.round(c.pos.y - 32), zIndex: Math.round(c.pos.y) + (c.selected ? 1000 : 0), transitionDelay: `${c.delay}ms` }}
            >
              <span aria-hidden="true" className="v-shadow" />
              {c.burst && c.v && <span aria-hidden="true" className="v-pop" style={{ borderColor: VSTYLE[c.v].solid }} />}
              <span aria-hidden="true" className="v-fig">
                <span className="v-head" style={{ background: skinFor(c.i) }} />
                <span className="v-body" style={{ background: c.d.color }}>{c.short[0]}</span>
              </span>
              {c.thinking && <span aria-hidden="true" className="v-think">···</span>}
              {c.sleeping && <span aria-hidden="true" className="v-zz">z<small>z</small></span>}
              {c.selected && <span aria-hidden="true" className="v-ring" />}
              <span className={`v-tag ${c.selected ? "on" : ""}`}>
                <strong>{c.short}</strong>
                {c.role && <span>{c.role}</span>}
              </span>
            </button>
          ))}

          {banner && (stage === "result" || stage === "failed") && (
            <div className="v-banner" role="status">
              <span style={{ color: banner.color }}>{banner.word}</span>
              <span className="v-banner-score">
                {banner.score}
                <small> / 100</small>
              </span>
            </div>
          )}
        </div>

        {bubble && bubblePos && (
          <div className={`v-bubble ${bubblePos.flip ? "below" : ""}`} style={{ left: bubblePos.x, top: bubblePos.flip ? (sel!.pos.y + 6) * scale : bubblePos.y }}>
            {bubble}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
