// The shape kit every building is built from (D-71). One isometric projection, in the 128-unit box every piece
// of art is drawn in, so twelve buildings agree on their angles the way a set of model-railway houses do.
//
// The box: a 1×1 tile is a diamond 85 units wide and 43 tall whose front corner sits at (64, FEET). +x runs to
// the lower right, +y to the lower left, up is up. Faces are flat fills — that is what low-poly looks like —
// with one shared sheen on top faces and one shared shade at the foot of walls to give the light a direction.
// Nothing here has text, a role, a link or an id that is not a gradient: the DoD scans for all of those.
//
// Every colour is a complete class name from FILL, never assembled from parts: Tailwind only generates the
// classes it can read whole from the source, and the DoD reads them the same way.
import type { ReactNode, SVGProps } from 'react';

export const FEET = 118;
const HW = 128 / 3; // half a tile width in box units (a tile is 85.33 wide)
const HH = 128 / 6; // half a tile height (42.67 tall)

export const FILL = {
  ground: 'fill-village-ground',
  'ground-2': 'fill-village-ground-2',
  earth: 'fill-village-earth',
  'earth-shade': 'fill-village-earth-shade',
  road: 'fill-village-road',
  'road-edge': 'fill-village-road-edge',
  water: 'fill-village-water',
  'water-deep': 'fill-village-water-deep',
  rock: 'fill-village-rock',
  'rock-shade': 'fill-village-rock-shade',
  wall: 'fill-village-wall',
  'wall-light': 'fill-village-wall-light',
  'wall-shade': 'fill-village-wall-shade',
  stone: 'fill-village-stone',
  'stone-shade': 'fill-village-stone-shade',
  roof: 'fill-village-roof',
  'roof-2': 'fill-village-roof-2',
  'roof-shade': 'fill-village-roof-shade',
  wood: 'fill-village-wood',
  'wood-shade': 'fill-village-wood-shade',
  window: 'fill-village-window',
  glow: 'fill-village-glow',
  tree: 'fill-village-tree',
  'tree-light': 'fill-village-tree-light',
  'tree-shade': 'fill-village-tree-shade',
  shadow: 'fill-village-shadow',
  lamp: 'fill-village-lamp',
} as const;
export type Fill = keyof typeof FILL;

export interface P { x: number; y: number }
export const px = (p: P): string => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
export const poly = (...pts: P[]): string => pts.map(px).join(' ');
/** Move `dx` tiles along +x, `dy` tiles along +y, and `up` units upward. */
export const along = (from: P, dx: number, dy: number, up = 0): P => ({ x: from.x + dx * HW - dy * HW, y: from.y + dx * HH + dy * HH - up });

export interface Prism {
  F: P; R: P; L: P; B: P; Ft: P; Rt: P; Lt: P; Bt: P;
  left: string; right: string; top: string; base: string;
}

/**
 * A box standing on the ground with its front corner at `feet`, `w` tiles along +x, `d` tiles along +y, `h` units
 * tall. Returns the three visible faces and the corners a roof needs.
 */
export function prism(feet: P, w: number, d: number, h: number): Prism {
  const F = feet;
  const R = along(F, 0, -d);
  const L = along(F, -w, 0);
  const B = along(F, -w, -d);
  const lift = (p: P): P => ({ x: p.x, y: p.y - h });
  const [Ft, Rt, Lt, Bt] = [lift(F), lift(R), lift(L), lift(B)];
  return {
    F, R, L, B, Ft, Rt, Lt, Bt,
    left: poly(L, F, Ft, Lt),
    right: poly(F, R, Rt, Ft),
    top: poly(Ft, Rt, Bt, Lt),
    base: poly(F, R, B, L),
  };
}

export interface Gable { near: string; far: string; gableRight: string; P1: P; P2: P }

/** A gable roof over a prism's top, ridge along +x, `rh` units above the eaves, overhanging by `o` units. */
export function gable(p: Prism, rh: number, o = 4): Gable {
  const oy = o * 0.5;
  const Ft = { x: p.Ft.x + o, y: p.Ft.y + oy };
  const Rt = { x: p.Rt.x + o, y: p.Rt.y - oy };
  const Lt = { x: p.Lt.x - o, y: p.Lt.y + oy };
  const Bt = { x: p.Bt.x - o, y: p.Bt.y - oy };
  const P1 = { x: (Ft.x + Rt.x) / 2, y: (Ft.y + Rt.y) / 2 - rh };
  const P2 = { x: (Lt.x + Bt.x) / 2, y: (Lt.y + Bt.y) / 2 - rh };
  return {
    near: poly(Ft, Lt, P2, P1),
    far: poly(Rt, Bt, P2, P1),
    gableRight: poly(p.Ft, p.Rt, { x: (p.Ft.x + p.Rt.x) / 2, y: (p.Ft.y + p.Rt.y) / 2 - rh }),
    P1, P2,
  };
}

export interface Hip { left: string; right: string; backL: string; backR: string; apex: P }

/** A hip roof: four slopes to a point. */
export function hip(p: Prism, rh: number, o = 4): Hip {
  const oy = o * 0.5;
  const Ft = { x: p.Ft.x + o, y: p.Ft.y + oy };
  const Rt = { x: p.Rt.x + o, y: p.Rt.y - oy };
  const Lt = { x: p.Lt.x - o, y: p.Lt.y + oy };
  const Bt = { x: p.Bt.x - o, y: p.Bt.y - oy };
  const apex = { x: (Ft.x + Bt.x) / 2, y: (Ft.y + Bt.y) / 2 - rh };
  return { left: poly(Lt, Ft, apex), right: poly(Ft, Rt, apex), backL: poly(Bt, Lt, apex), backR: poly(Rt, Bt, apex), apex };
}

/** A rectangle on the left wall (the face from L to F): `u` tiles from the left corner, `v` units up, `uw` tiles wide, `vh` tall. */
export function onLeft(feet: P, w: number, u: number, v: number, uw: number, vh: number): string {
  const a = along(along(feet, -w, 0), u, 0, v);
  const b = along(a, uw, 0, 0);
  return poly(a, b, { x: b.x, y: b.y - vh }, { x: a.x, y: a.y - vh });
}

/** A rectangle on the right wall (from F back to R): `u` tiles back from the front corner, `v` units up. */
export function onRight(feet: P, u: number, v: number, uw: number, vh: number): string {
  const a = along(feet, 0, -u, v);
  const b = along(a, 0, -uw, 0);
  return poly(a, b, { x: b.x, y: b.y - vh }, { x: a.x, y: a.y - vh });
}

/** The shared lighting: a sheen on top faces, a shade at the foot of walls, a warm glow. Ids come from the caller. */
export function Defs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </linearGradient>
      <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#000000" stopOpacity="0" />
        <stop offset="1" stopColor="#000000" stopOpacity="0.28" />
      </linearGradient>
      <radialGradient id={`${id}-glow`}>
        <stop offset="0" stopColor="#ffd166" stopOpacity="0.6" />
        <stop offset="1" stopColor="#ffd166" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

/** The ground shadow a building casts: short in the afternoon, long in the evening, always to the lower right. */
export function Shadow({ feet, w, d }: { feet: P; w: number; d: number }) {
  const R = along(feet, 0, -d);
  const B = along(feet, -w, -d);
  const L = along(feet, -w, 0);
  const cast = (len: number): string => poly(feet, R, { x: R.x + len, y: R.y + len * 0.55 }, { x: feet.x + len, y: feet.y + len * 0.55 }, { x: L.x + len, y: L.y + len * 0.55 }, L);
  return (
    <>
      <polygon points={poly(feet, R, B, L)} className={`${FILL.shadow} opacity-15 dark:opacity-30`} />
      <polygon points={cast(10)} className={`${FILL.shadow} opacity-15 dark:hidden`} />
      <polygon points={cast(34)} className={`hidden ${FILL.shadow} opacity-35 dark:block`} />
    </>
  );
}

/** The three faces of a prism, coloured, with the shared light on them. */
export function Faces({ p, id, wall = 'wall', shade = 'wall-shade', top = 'wall-light' }: { p: Prism; id: string; wall?: Fill; shade?: Fill; top?: Fill }) {
  return (
    <>
      <polygon points={p.left} className={FILL[wall]} />
      <polygon points={p.right} className={FILL[shade]} />
      <polygon points={p.top} className={FILL[top]} />
      <polygon points={p.top} fill={`url(#${id}-sheen)`} />
      <polygon points={p.left} fill={`url(#${id}-shade)`} />
      <polygon points={p.right} fill={`url(#${id}-shade)`} />
    </>
  );
}

/** A window: sky by day, lamplight by night, with a glow outside it in the evening. */
export function Window({ points, glowAt }: { points: string; glowAt?: P }) {
  return (
    <>
      {glowAt ? <circle cx={glowAt.x} cy={glowAt.y} r={11} className={`hidden ${FILL.glow} opacity-30 dark:block`} /> : null}
      <polygon points={points} className={FILL.window} />
    </>
  );
}

export function Door({ points }: { points: string }) {
  return <polygon points={points} className={FILL['wood-shade']} />;
}

/** A gable roof's visible parts. */
export function GableRoof({ g, near = 'roof-2', far = 'roof-shade', id }: { g: Gable; near?: Fill; far?: Fill; id: string }) {
  return (
    <>
      <polygon points={g.far} className={FILL[far]} />
      <polygon points={g.gableRight} className={FILL['wall-shade']} />
      <polygon points={g.near} className={FILL[near]} />
      <polygon points={g.near} fill={`url(#${id}-sheen)`} />
    </>
  );
}

export function HipRoof({ h, id, lit = 'roof-2', dim = 'roof', dark = 'roof-shade' }: { h: Hip; id: string; lit?: Fill; dim?: Fill; dark?: Fill }) {
  return (
    <>
      <polygon points={h.backL} className={FILL[dark]} />
      <polygon points={h.backR} className={FILL[dark]} />
      <polygon points={h.left} className={FILL[lit]} />
      <polygon points={h.right} className={FILL[dim]} />
      <polygon points={h.left} fill={`url(#${id}-sheen)`} />
    </>
  );
}

/** A small box on a roof or the ground — a chimney, a crate, a step. */
export function Block({ feet, w, d, h, id, wall, shade, top }: { feet: P; w: number; d: number; h: number; id: string; wall?: Fill; shade?: Fill; top?: Fill }) {
  const p = prism(feet, w, d, h);
  return <Faces p={p} id={id} {...(wall ? { wall } : {})} {...(shade ? { shade } : {})} {...(top ? { top } : {})} />;
}

export type FrameProps = { id: string; active?: boolean; children: ReactNode } & Omit<SVGProps<SVGSVGElement>, 'children' | 'id'>;

/** The frame every piece of art shares. `active` lights the ground under it with the one accent colour. */
export function Frame({ id, active = false, children, ...rest }: FrameProps) {
  return (
    <svg viewBox="0 0 128 128" aria-hidden="true" focusable="false" {...rest}>
      <Defs id={id} />
      {active ? <ellipse cx={64} cy={112} rx={54} ry={17} className="fill-blue-700/25 dark:fill-sky-300/35" /> : null}
      {children}
    </svg>
  );
}
