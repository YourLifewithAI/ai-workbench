// The diorama (D-71): a chunk of land floating on nothing, its earth showing at the sides, a road winding across
// it and a stream cutting through, every tile a soft diamond. Decorative and marked so: it is the picture the
// buildings stand on, and the buildings — the links — are its siblings, never its children.
import { mapBounds, project, type Village } from '../../shared/village.js';
import { FILL } from './art/shapes.js';

const EARTH = 34;

export function Ground({ village }: { village: Village }) {
  const { W, H, offsetX, offsetY } = mapBounds(village);
  const at = (gx: number, gy: number): { x: number; y: number } => {
    const p = project(gx, gy, village.tile);
    return { x: p.x + offsetX, y: p.y + offsetY };
  };
  const hw = village.tile.w / 2;
  const hh = village.tile.h / 2;
  // The land's four corners are the outer corners of the corner tiles.
  const top = at(-0.5, -0.5);
  const right = at(village.grid.w - 0.5, -0.5);
  const bottom = at(village.grid.w - 0.5, village.grid.h - 0.5);
  const left = at(-0.5, village.grid.h - 0.5);
  const pts = (...ps: { x: number; y: number }[]): string => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const line = (path: [number, number][]): string => path.map(([x, y]) => at(x, y)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const tiles: { gx: number; gy: number }[] = [];
  for (let gy = 0; gy < village.grid.h; gy++) for (let gx = 0; gx < village.grid.w; gx++) tiles.push({ gx, gy });

  return (
    <svg aria-hidden="true" focusable="false" viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full">
      {/* What the island floats over. */}
      <ellipse cx={bottom.x} cy={bottom.y + EARTH + 6} rx={W * 0.42} ry={12} className={`${FILL.shadow} opacity-10 dark:opacity-40`} />
      {/* The earth at the sides: the left face in light, the right face in shade. */}
      <polygon points={pts(left, bottom, { x: bottom.x, y: bottom.y + EARTH }, { x: left.x, y: left.y + EARTH })} className={FILL.earth} />
      <polygon points={pts(bottom, right, { x: right.x, y: right.y + EARTH }, { x: bottom.x, y: bottom.y + EARTH })} className={FILL['earth-shade']} />
      <polygon points={pts(left, bottom, { x: bottom.x, y: bottom.y + 6 }, { x: left.x, y: left.y + 6 })} className={FILL['tree-shade']} opacity={0.5} />
      <polygon points={pts(bottom, right, { x: right.x, y: right.y + 6 }, { x: bottom.x, y: bottom.y + 6 })} className={FILL['tree-shade']} opacity={0.6} />
      {/* The ground, one soft diamond per tile. */}
      <polygon points={pts(top, right, bottom, left)} className={FILL.ground} />
      {tiles.map(({ gx, gy }) => {
        if ((gx + gy) % 2 === 0) return null;
        const c = at(gx, gy);
        return <polygon key={`${gx},${gy}`} points={pts({ x: c.x, y: c.y - hh }, { x: c.x + hw, y: c.y }, { x: c.x, y: c.y + hh }, { x: c.x - hw, y: c.y })} className={FILL['ground-2']} />;
      })}
      {/* Water first, then the road over it: where they cross is a bridge. */}
      {village.water.map((w, i) => (
        <g key={`w${i}`} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <polyline points={line(w)} className="stroke-village-water-deep" strokeWidth={22} />
          <polyline points={line(w)} className="stroke-village-water" strokeWidth={14} />
          <polyline points={line(w)} className="stroke-white/40" strokeWidth={3} strokeDasharray="6 14" />
        </g>
      ))}
      {village.paths.map((p, i) => (
        <g key={`p${i}`} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <polyline points={line(p)} className="stroke-village-road-edge" strokeWidth={20} />
          <polyline points={line(p)} className="stroke-village-road" strokeWidth={14} />
        </g>
      ))}
    </svg>
  );
}
