// The village (D-71): a data file says where each building stands, an art registry says what it looks like, and
// tokens say what colour it is. This module is the first of the three — the schema, the isometric projection,
// and the checks that make the file safe for a person or an agent to edit. Pure: no DOM, no React, so the UI,
// the tests and the CLI all read the same rules.
import { z } from 'zod';

const Int = z.number().int();
const Coord = z.tuple([Int, Int]);

export const Tile = z.strictObject({ w: Int.positive(), h: Int.positive() });
export type Tile = z.infer<typeof Tile>;

export const VillageBuilding = z.strictObject({
  /** The screen this building is the door to: a path from SCREENS, e.g. `/library`. */
  screen: z.string().regex(/^\/[a-z-]+$/),
  /** A name in the art registry. */
  art: z.string().min(1),
  x: Int.nonnegative(),
  y: Int.nonnegative(),
  /** Tiles covered, from (x, y) towards +x and +y. */
  footprint: z.strictObject({ w: Int.positive(), h: Int.positive() }).default({ w: 1, h: 1 }),
  /** The tile a figure stands on to be "at the door" (RUN-20). Defaults to the tile in front of the footprint. */
  door: Coord.optional(),
});
export type VillageBuilding = z.infer<typeof VillageBuilding>;

export const VillageProp = z.strictObject({ art: z.string().min(1), x: Int.nonnegative(), y: Int.nonnegative() });
export type VillageProp = z.infer<typeof VillageProp>;

/** A polyline over tile coordinates: a road, or water. */
export const VillagePath = z.array(Coord).min(2);
export type VillagePath = z.infer<typeof VillagePath>;

export const Village = z.strictObject({
  schemaVersion: z.literal(1),
  grid: z.strictObject({ w: Int.positive(), h: Int.positive() }),
  tile: Tile,
  buildings: z.array(VillageBuilding),
  props: z.array(VillageProp).default([]),
  paths: z.array(VillagePath).default([]),
  water: z.array(VillagePath).default([]),
  places: z.strictObject({ square: Coord, board: Coord }),
});
export type Village = z.infer<typeof Village>;

/** A building's picture is this many tiles wide and tall, anchored with its feet on its tile's front corner. */
export const ART_TILES = 1.7;
/** The smallest unobscured pointer target WCAG 2.2 asks for (target-size, AA). */
export const TARGET_PX = 24;

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/** Isometric projection of a tile coordinate to its centre, before the map's offset. 2:1 tiles: right is +x, left is +y. */
export function project(gx: number, gy: number, tile: Tile): Point {
  return { x: ((gx - gy) * tile.w) / 2, y: ((gx + gy) * tile.h) / 2 };
}

/** The map's pixel size and the offset that makes every projected point non-negative. */
export function mapBounds(v: Village): { W: number; H: number; offsetX: number; offsetY: number } {
  const artH = v.tile.w * ART_TILES;
  return {
    offsetX: (v.grid.h * v.tile.w) / 2,
    offsetY: artH,
    W: ((v.grid.w + v.grid.h) * v.tile.w) / 2,
    H: ((v.grid.w + v.grid.h) * v.tile.h) / 2 + artH + v.tile.h,
  };
}

/** The tile a building's feet stand on: the front corner of its footprint. */
export function feetOf(b: VillageBuilding): Point {
  return { x: b.x + b.footprint.w - 1, y: b.y + b.footprint.h - 1 };
}

/** The picture's box in map pixels (offset applied): ART_TILES wide, feet on the front corner of the footprint. */
export function buildingBox(v: Village, b: VillageBuilding): Box {
  const { offsetX, offsetY } = mapBounds(v);
  const feet = feetOf(b);
  const p = project(feet.x, feet.y, v.tile);
  const w = v.tile.w * ART_TILES;
  const h = w;
  return { x: p.x + offsetX - w / 2, y: p.y + offsetY + v.tile.h / 2 - h, w, h };
}

/** A prop's box: one tile wide, one tile tall, feet on its tile. */
export function propBox(v: Village, p: VillageProp): Box {
  const { offsetX, offsetY } = mapBounds(v);
  const at = project(p.x, p.y, v.tile);
  const w = v.tile.w;
  return { x: at.x + offsetX - w / 2, y: at.y + offsetY + v.tile.h / 2 - w, w, h: w };
}

/** Painter's order: what stands further front (larger x + y) is drawn later. */
export function zOf(b: { x: number; y: number }): number {
  return b.x + b.y;
}

export function doorOf(b: VillageBuilding): [number, number] {
  return b.door ?? [b.x + b.footprint.w, b.y + b.footprint.h];
}

/** The buildings in the screens' order — the shell's order, which is the tab order; unknown screens are dropped. */
export function orderBuildings(v: Village, screens: string[]): VillageBuilding[] {
  return screens.flatMap((s) => v.buildings.filter((b) => b.screen === s));
}

const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const centreTarget = (box: Box): Box => ({ x: box.x + box.w / 2 - TARGET_PX / 2, y: box.y + box.h / 2 - TARGET_PX / 2, w: TARGET_PX, h: TARGET_PX });
const tilesOf = (b: VillageBuilding): string[] => {
  const out: string[] = [];
  for (let dx = 0; dx < b.footprint.w; dx++) for (let dy = 0; dy < b.footprint.h; dy++) out.push(`${b.x + dx},${b.y + dy}`);
  return out;
};

/**
 * Every way the file can be wrong, named. Empty means the village is sound: one building per screen and one
 * screen per building, every art name known, everything on the grid, no two buildings on one tile, no
 * building's picture covering the middle of another's (that middle is the pointer target, and WCAG 2.2 asks for
 * a clear 24×24 of it), and no prop standing in a doorway.
 */
export function checkVillage(v: Village, screens: string[], artNames: readonly string[]): string[] {
  const problems: string[] = [];
  const onGrid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < v.grid.w && y < v.grid.h;
  const known = new Set(artNames);
  const name = (b: VillageBuilding): string => `${b.art} (${b.screen})`;

  for (const s of screens) {
    const n = v.buildings.filter((b) => b.screen === s).length;
    if (n === 0) problems.push(`no building for ${s}`);
    if (n > 1) problems.push(`${n} buildings for ${s}; a screen has one door`);
  }
  for (const b of v.buildings) {
    if (!screens.includes(b.screen)) problems.push(`${name(b)}: ${b.screen} is not a screen`);
    if (!known.has(b.art)) problems.push(`${name(b)}: no art named ${b.art}`);
    const feet = feetOf(b);
    if (!onGrid(b.x, b.y) || !onGrid(feet.x, feet.y)) problems.push(`${name(b)}: off the grid at (${b.x}, ${b.y})`);
  }
  for (const p of v.props) {
    if (!known.has(p.art)) problems.push(`prop ${p.art} at (${p.x}, ${p.y}): no art named ${p.art}`);
    if (!onGrid(p.x, p.y)) problems.push(`prop ${p.art}: off the grid at (${p.x}, ${p.y})`);
  }
  for (const [label, lines] of [['path', v.paths], ['water', v.water]] as const) {
    lines.forEach((line, i) => line.forEach(([x, y]) => { if (!onGrid(x, y)) problems.push(`${label} ${i}: off the grid at (${x}, ${y})`); }));
  }
  for (const [px, py] of [v.places.square, v.places.board]) if (!onGrid(px, py)) problems.push(`place off the grid at (${px}, ${py})`);

  const occupied = new Map<string, VillageBuilding>();
  for (const b of v.buildings) {
    for (const t of tilesOf(b)) {
      const other = occupied.get(t);
      if (other) problems.push(`${name(other)} and ${name(b)} share tile (${t})`);
      else occupied.set(t, b);
    }
  }
  for (const p of v.props) {
    const here = occupied.get(`${p.x},${p.y}`);
    if (here) problems.push(`prop ${p.art} stands on ${name(here)} at (${p.x}, ${p.y})`);
    const inDoorway = v.buildings.find((b) => { const [dx, dy] = doorOf(b); return dx === p.x && dy === p.y; });
    if (inDoorway) problems.push(`prop ${p.art} stands in the doorway of ${name(inDoorway)} at (${p.x}, ${p.y})`);
  }

  const boxes = v.buildings.map((b) => ({ b, box: buildingBox(v, b) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = 0; j < boxes.length; j++) {
      if (i === j) continue;
      const a = boxes[i]!;
      const o = boxes[j]!;
      if (intersects(o.box, centreTarget(a.box))) problems.push(`${name(o.b)} covers the middle of ${name(a.b)} on screen`);
    }
  }
  return problems;
}
