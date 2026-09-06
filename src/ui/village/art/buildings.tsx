// The twelve buildings (D-71), one per screen, each drawn from the shape kit with its feet at the front corner
// of its tile. Their names say what they are for; their shapes say it without a word, which is the point —
// the name and the sentence live in the hover box, never on the house.
import { FEET, FILL, Block, Door, Faces, Frame, GableRoof, HipRoof, Shadow, Window, along, gable, hip, onLeft, onRight, poly, prism, type FrameProps, type P } from './shapes.js';

type Props = Omit<FrameProps, 'children'>;
const feet: P = { x: 64, y: FEET };

/** Welcome — the village gate: two stone pillars, a beam, a lamp, the bench from the mark under it. */
export function Gate(p: Props) {
  const a = along(feet, -0.15, -0.72);
  const b = along(feet, -0.72, -0.15);
  const pa = prism(a, 0.16, 0.16, 36);
  const pb = prism(b, 0.16, 0.16, 36);
  const beam = poly({ x: pa.Lt.x, y: pa.Lt.y - 2 }, { x: pb.Rt.x, y: pb.Rt.y - 2 }, { x: pb.Rt.x, y: pb.Rt.y - 9 }, { x: pa.Lt.x, y: pa.Lt.y - 9 });
  const bench = along(feet, -0.4, -0.55);
  return (
    <Frame {...p}>
      <Shadow feet={a} w={0.16} d={0.16} />
      <Shadow feet={b} w={0.16} d={0.16} />
      <Faces p={pb} id={p.id} wall="stone" shade="stone-shade" top="stone" />
      <Faces p={pa} id={p.id} wall="stone" shade="stone-shade" top="stone" />
      <polygon points={beam} className={FILL.wood} />
      <circle cx={pa.Lt.x + 6} cy={pa.Lt.y - 16} r={20} fill={`url(#${p.id}-glow)`} className="hidden dark:block" />
      <rect x={pa.Lt.x + 3} y={pa.Lt.y - 24} width={6} height={9} className={FILL.lamp} />
      <Block feet={bench} w={0.36} d={0.12} h={6} id={p.id} wall="wood" shade="wood-shade" top="wood" />
    </Frame>
  );
}

/** Dashboard — the town hall: the tallest roof, a clock tower, steps, and the notice board out front. */
export function TownHall(p: Props) {
  const body = prism(along(feet, -0.02, -0.02), 0.92, 0.92, 40);
  const roof = hip(body, 20, 5);
  const towerFeet = { x: roof.apex.x, y: roof.apex.y + 2 };
  const tower = prism(towerFeet, 0.26, 0.26, 24);
  const cap = hip(tower, 12, 2);
  const board = along(feet, 0.1, -0.35);
  return (
    <Frame {...p}>
      <Shadow feet={feet} w={0.94} d={0.94} />
      <Faces p={body} id={p.id} />
      <Door points={onLeft(feet, 0.94, 0.36, 0, 0.2, 18)} />
      <Window points={onLeft(feet, 0.94, 0.08, 16, 0.16, 12)} glowAt={along(along(feet, -0.94, 0), 0.16, 0, 22)} />
      <Window points={onLeft(feet, 0.94, 0.68, 16, 0.16, 12)} glowAt={along(along(feet, -0.94, 0), 0.76, 0, 22)} />
      <Window points={onRight(feet, 0.2, 16, 0.16, 12)} />
      <Window points={onRight(feet, 0.6, 16, 0.16, 12)} />
      <HipRoof h={roof} id={p.id} />
      <Faces p={tower} id={p.id} wall="stone" shade="stone-shade" top="stone" />
      <circle cx={(tower.L.x + tower.F.x) / 2} cy={(tower.L.y + tower.F.y) / 2 - 13} r={5} className={FILL.window} />
      <HipRoof h={cap} id={p.id} lit="roof-2" dim="roof" dark="roof-shade" />
      <Block feet={board} w={0.3} d={0.06} h={20} id={p.id} wall="wood" shade="wood-shade" top="wood" />
      <polygon points={onLeft(board, 0.3, 0.03, 8, 0.24, 10)} className={FILL['wall-light']} />
    </Frame>
  );
}

/** Library — a long house with tall windows and a reading lamp in one of them. */
export function Library(p: Props) {
  const w = 0.96; const d = 0.62;
  const body = prism(feet, w, d, 34);
  const roof = gable(body, 18, 5);
  const chimney = along(along(feet, -0.75, -0.3), 0, 0, 34);
  return (
    <Frame {...p}>
      <Shadow feet={feet} w={w} d={d} />
      <Faces p={body} id={p.id} />
      <Window points={onLeft(feet, w, 0.08, 6, 0.14, 22)} />
      <Window points={onLeft(feet, w, 0.3, 6, 0.14, 22)} glowAt={along(along(feet, -w, 0), 0.37, 0, 17)} />
      <Door points={onLeft(feet, w, 0.54, 0, 0.18, 20)} />
      <Window points={onLeft(feet, w, 0.78, 6, 0.14, 22)} />
      <Window points={onRight(feet, 0.2, 8, 0.2, 16)} />
      <GableRoof g={roof} id={p.id} />
      <Block feet={chimney} w={0.12} d={0.12} h={14} id={p.id} wall="stone" shade="stone-shade" top="stone-shade" />
    </Frame>
  );
}

/** Workflows — the workshop: a barn with a wide door, a waterwheel on one side and a gear on the wall. */
export function Workshop(p: Props) {
  const w = 0.9; const d = 0.8;
  const body = prism(feet, w, d, 32);
  const roof = gable(body, 26, 5);
  const wheelC = along(feet, 0, -0.42, 20);
  return (
    <Frame {...p}>
      <Shadow feet={feet} w={w} d={d} />
      <Faces p={body} id={p.id} wall="wood" shade="wood-shade" top="wall-shade" />
      <Door points={onLeft(feet, w, 0.25, 0, 0.42, 24)} />
      <polygon points={onLeft(feet, w, 0.25, 0, 0.42, 24)} fill={`url(#${p.id}-shade)`} />
      <Window points={onLeft(feet, w, 0.74, 14, 0.12, 10)} glowAt={along(along(feet, -w, 0), 0.8, 0, 19)} />
      <GableRoof g={roof} near="roof" far="roof-shade" id={p.id} />
      <circle cx={wheelC.x + 6} cy={wheelC.y} r={15} className={`${FILL['wood-shade']}`} />
      <circle cx={wheelC.x + 6} cy={wheelC.y} r={10} className={FILL['wall-shade']} />
      <circle cx={wheelC.x + 6} cy={wheelC.y} r={3} className={FILL['wood-shade']} />
      <path d={`M${wheelC.x - 9},${wheelC.y} h30 M${wheelC.x + 6},${wheelC.y - 15} v30 M${wheelC.x - 4},${wheelC.y - 10} l20,20 M${wheelC.x + 16},${wheelC.y - 10} l-20,20`} className="stroke-village-wood-shade" strokeWidth={2} fill="none" />
      <circle cx={along(feet, -0.15, 0, 22).x} cy={along(feet, -0.15, 0, 22).y} r={6} className={FILL['rock-shade']} />
    </Frame>
  );
}

/** Agents — the lodge: a long house with a door for every villager. */
export function Lodge(p: Props) {
  const w = 0.96; const d = 0.68;
  const body = prism(feet, w, d, 30);
  const roof = gable(body, 16, 5);
  return (
    <Frame {...p}>
      <Shadow feet={feet} w={w} d={d} />
      <Faces p={body} id={p.id} wall="wall" shade="wall-shade" top="wall-light" />
      {[0.06, 0.4, 0.74].map((u) => <Door key={u} points={onLeft(feet, w, u, 0, 0.16, 18)} />)}
      {[0.25, 0.59].map((u, i) => <Window key={u} points={onLeft(feet, w, u, 12, 0.11, 10)} {...(i === 0 ? { glowAt: along(along(feet, -w, 0), 0.3, 0, 17) } : {})} />)}
      <Window points={onRight(feet, 0.16, 12, 0.16, 10)} />
      <Window points={onRight(feet, 0.42, 12, 0.16, 10)} />
      <GableRoof g={roof} near="roof-2" far="roof-shade" id={p.id} />
      <rect x={body.Lt.x + 6} y={body.Lt.y - 6} width={3} height={10} className={FILL['wood-shade']} />
    </Frame>
  );
}

/** Runs — the records office: a square house, ledgers stacked by the door, a clock over it. */
export function Records(p: Props) {
  const w = 0.8; const d = 0.8;
  const body = prism(along(feet, -0.06, -0.06), w, d, 38);
  const roof = hip(body, 16, 5);
  const stack = along(feet, -0.02, -0.3);
  return (
    <Frame {...p}>
      <Shadow feet={feet} w={0.86} d={0.86} />
      <Faces p={body} id={p.id} wall="wall-light" shade="wall-shade" top="wall" />
      <Door points={onLeft(body.F, w, 0.3, 0, 0.2, 20)} />
      <circle cx={along(along(body.F, -w, 0), 0.4, 0, 28).x} cy={along(along(body.F, -w, 0), 0.4, 0, 28).y} r={5} className={FILL.window} />
      <Window points={onRight(body.F, 0.18, 14, 0.18, 12)} glowAt={along(body.F, 0, -0.27, 20)} />
      <Window points={onRight(body.F, 0.5, 14, 0.18, 12)} />
      <HipRoof h={roof} id={p.id} lit="roof-2" dim="roof" dark="roof-shade" />
      <Block feet={stack} w={0.16} d={0.24} h={5} id={p.id} wall="wood" shade="wood-shade" top="wall-light" />
      <Block feet={along(stack, 0, 0, 5)} w={0.14} d={0.22} h={5} id={p.id} wall="roof" shade="roof-shade" top="wall-light" />
      <Block feet={along(stack, 0, 0, 10)} w={0.12} d={0.2} h={5} id={p.id} wall="tree" shade="tree-shade" top="wall-light" />
    </Frame>
  );
}

/** Review — the post office: a counter awning, a bell under it, a red postbox by the road. */
export function PostOffice(p: Props) {
  const w = 0.84; const d = 0.7;
  const body = prism(feet, w, d, 32);
  const roof = gable(body, 15, 5);
  const awningA = along(along(feet, -w, 0), 0.2, 0, 22);
  const awningB = along(awningA, 0.5, 0, 0);
  const awning = poly(awningA, awningB, { x: awningB.x + 8, y: awningB.y - 6 }, { x: awningA.x + 8, y: awningA.y - 6 });
  const bell = { x: (awningA.x + awningB.x) / 2 + 4, y: (awningA.y + awningB.y) / 2 + 6 };
  const box = along(feet, 0.05, -0.15);
  return (
    <Frame {...p}>
      <Shadow feet={feet} w={w} d={d} />
      <Faces p={body} id={p.id} />
      <Door points={onLeft(feet, w, 0.32, 0, 0.22, 20)} />
      <Window points={onLeft(feet, w, 0.06, 10, 0.16, 12)} glowAt={along(along(feet, -w, 0), 0.14, 0, 16)} />
      <Window points={onLeft(feet, w, 0.64, 10, 0.16, 12)} />
      <Window points={onRight(feet, 0.2, 12, 0.2, 12)} />
      <polygon points={awning} className={FILL['roof-2']} />
      <circle cx={bell.x} cy={bell.y} r={3.5} className={FILL.lamp} />
      <GableRoof g={roof} near="roof" far="roof-shade" id={p.id} />
      <Block feet={box} w={0.1} d={0.1} h={14} id={p.id} wall="roof-2" shade="roof-shade" top="roof" />
    </Frame>
  );
}

/** Models — the stables: low and long, half-doors along the front, a rail out front. */
export function Stables(p: Props) {
  const w = 0.96; const d = 0.72;
  const body = prism(feet, w, d, 24);
  const roof = gable(body, 14, 7);
  const railA = along(feet, -0.9, 0.16);
  const railB = along(railA, 0.75, 0, 0);
  return (
    <Frame {...p}>
      <Shadow feet={feet} w={w} d={d} />
      <Faces p={body} id={p.id} wall="wood" shade="wood-shade" top="wall-shade" />
      {[0.08, 0.4, 0.72].map((u) => (
        <g key={u}>
          <Door points={onLeft(feet, w, u, 0, 0.2, 18)} />
          <polygon points={onLeft(feet, w, u, 10, 0.2, 8)} className={FILL['wall-shade']} />
        </g>
      ))}
      <Window points={onRight(feet, 0.3, 10, 0.16, 8)} glowAt={along(feet, 0, -0.38, 14)} />
      <GableRoof g={roof} near="roof-2" far="roof-shade" id={p.id} />
      {[railA, along(railA, 0.375, 0), railB].map((post, i) => <rect key={i} x={post.x - 1.5} y={post.y - 14} width={3} height={14} className={FILL['wood-shade']} />)}
      <polygon points={poly(along(railA, 0, 0, 11), along(railB, 0, 0, 11), along(railB, 0, 0, 8), along(railA, 0, 0, 8))} className={FILL.wood} />
    </Frame>
  );
}

/** Memory — the well: a stone ring, two posts, a little roof, a bucket on the rope. */
export function Well(p: Props) {
  const f = along(feet, -0.27, -0.27);
  const ring = prism(f, 0.46, 0.46, 12);
  const postA = prism(along(f, -0.05, -0.05), 0.06, 0.06, 34);
  const postB = prism(along(f, -0.35, -0.35), 0.06, 0.06, 34);
  const roofBase = prism(along(f, 0.02, 0.02, 30), 0.52, 0.52, 2);
  const roof = gable(roofBase, 12, 3);
  return (
    <Frame {...p}>
      <Shadow feet={f} w={0.46} d={0.46} />
      <Faces p={ring} id={p.id} wall="stone" shade="stone-shade" top="stone" />
      <polygon points={prism(along(f, -0.08, -0.08), 0.3, 0.3, 12).top} className={FILL['water-deep']} />
      <Faces p={postB} id={p.id} wall="wood" shade="wood-shade" top="wood" />
      <Faces p={postA} id={p.id} wall="wood" shade="wood-shade" top="wood" />
      <rect x={(postA.Ft.x + postB.Ft.x) / 2 - 1} y={ring.Ft.y - 33} width={2} height={16} className={FILL['wood-shade']} />
      <Block feet={{ x: (postA.Ft.x + postB.Ft.x) / 2 + 3, y: ring.Ft.y - 14 }} w={0.08} d={0.08} h={7} id={p.id} wall="wood" shade="wood-shade" top="wood" />
      <GableRoof g={roof} near="roof-2" far="roof-shade" id={p.id} />
    </Frame>
  );
}

/** Tools — the smithy: a wide open front, a big chimney with a glow in it, an anvil out front. */
export function Smithy(p: Props) {
  const w = 0.9; const d = 0.74;
  const body = prism(feet, w, d, 30);
  const roof = gable(body, 14, 5);
  const chimneyFeet = along(along(feet, -0.2, -0.55), 0, 0, 30);
  const chimney = prism(chimneyFeet, 0.2, 0.2, 26);
  const anvil = along(feet, 0.04, -0.22);
  return (
    <Frame {...p}>
      <Shadow feet={feet} w={w} d={d} />
      <Faces p={body} id={p.id} wall="stone" shade="stone-shade" top="stone" />
      <Door points={onLeft(feet, w, 0.12, 0, 0.5, 22)} />
      <polygon points={onLeft(feet, w, 0.2, 2, 0.34, 12)} className={`${FILL.glow} opacity-70`} />
      <Window points={onRight(feet, 0.25, 12, 0.18, 10)} glowAt={along(feet, 0, -0.34, 16)} />
      <GableRoof g={roof} near="roof-shade" far="roof-shade" id={p.id} />
      <Faces p={chimney} id={p.id} wall="stone-shade" shade="rock-shade" top="stone-shade" />
      <circle cx={chimney.Ft.x - 6} cy={chimney.Ft.y - 6} r={12} fill={`url(#${p.id}-glow)`} />
      <Block feet={anvil} w={0.16} d={0.1} h={5} id={p.id} wall="wood" shade="wood-shade" top="wood" />
      <Block feet={along(anvil, 0.02, 0, 5)} w={0.14} d={0.08} h={4} id={p.id} wall="rock-shade" shade="rock-shade" top="rock" />
    </Frame>
  );
}

/** Evaluate — the observatory: a stone tower with a dome and a telescope looking out of it. */
export function Observatory(p: Props) {
  const base = prism(along(feet, -0.04, -0.04), 0.84, 0.84, 10);
  const towerFeet = along(feet, -0.16, -0.16, 10);
  const tower = prism(towerFeet, 0.6, 0.6, 38);
  const domeC = { x: tower.Ft.x + (tower.Bt.x - tower.Ft.x) / 2, y: tower.Ft.y + (tower.Bt.y - tower.Ft.y) / 2 };
  return (
    <Frame {...p}>
      <Shadow feet={feet} w={0.88} d={0.88} />
      <Faces p={base} id={p.id} wall="stone" shade="stone-shade" top="stone" />
      <Faces p={tower} id={p.id} wall="stone" shade="stone-shade" top="stone" />
      <Door points={onLeft(towerFeet, 0.6, 0.2, 0, 0.18, 16)} />
      <Window points={onRight(towerFeet, 0.2, 20, 0.14, 8)} glowAt={along(towerFeet, 0, -0.27, 24)} />
      <circle cx={domeC.x} cy={domeC.y - 2} r={22} className={FILL['roof-2']} />
      <path d={`M${domeC.x - 22},${domeC.y - 2} a22,22 0 0 1 44,0 z`} className={FILL['roof-2']} />
      <path d={`M${domeC.x - 4},${domeC.y - 24} l8,0 l-2,22 l-4,0 z`} className={FILL['roof-shade']} />
      <polygon points={`${domeC.x - 2},${domeC.y - 6} ${domeC.x + 20},${domeC.y - 30} ${domeC.x + 24},${domeC.y - 27} ${domeC.x + 2},${domeC.y - 2}`} className={FILL['wood-shade']} />
      <polygon points={`${domeC.x - 24},${domeC.y - 2} ${domeC.x + 24},${domeC.y - 2} ${domeC.x + 24},${domeC.y + 4} ${domeC.x - 24},${domeC.y + 4}`} className={FILL['roof-shade']} />
    </Frame>
  );
}

/** Settings — the windmill: a tall tower, a cap, and four sails. */
export function Windmill(p: Props) {
  const f = along(feet, -0.2, -0.2);
  const tower = prism(f, 0.56, 0.56, 50);
  const cap = hip(tower, 12, 3);
  const hub = { x: tower.Lt.x + (tower.Ft.x - tower.Lt.x) * 0.5, y: tower.Lt.y + (tower.Ft.y - tower.Lt.y) * 0.5 - 4 };
  const sail = (angle: number): string => {
    const r = (angle * Math.PI) / 180;
    const c = Math.cos(r); const s = Math.sin(r);
    const L = 30; const W = 5;
    const pts: P[] = [
      { x: hub.x + c * 4 - s * W, y: hub.y + s * 4 + c * W },
      { x: hub.x + c * L - s * W, y: hub.y + s * L + c * W },
      { x: hub.x + c * L + s * W, y: hub.y + s * L - c * W },
      { x: hub.x + c * 4 + s * W, y: hub.y + s * 4 - c * W },
    ];
    return poly(...pts);
  };
  return (
    <Frame {...p}>
      <Shadow feet={f} w={0.56} d={0.56} />
      <Faces p={tower} id={p.id} wall="wall-light" shade="wall-shade" top="wall" />
      <Door points={onLeft(f, 0.56, 0.2, 0, 0.16, 16)} />
      <Window points={onLeft(f, 0.56, 0.22, 28, 0.12, 10)} glowAt={along(along(f, -0.56, 0), 0.28, 0, 33)} />
      <HipRoof h={cap} id={p.id} lit="roof-2" dim="roof" dark="roof-shade" />
      {[20, 110, 200, 290].map((a) => <polygon key={a} points={sail(a)} className={FILL['wall-shade']} />)}
      {[20, 110, 200, 290].map((a) => <polygon key={`f${a}`} points={sail(a)} fill={`url(#${p.id}-shade)`} />)}
      <circle cx={hub.x} cy={hub.y} r={4} className={FILL['wood-shade']} />
    </Frame>
  );
}
