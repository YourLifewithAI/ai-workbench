// The village's furniture: trees, a pine, a bush, a rock, a lamp, a run of fence. Each stands with its feet at
// the front corner of its tile, like a building, so village.json places them by the same rule.
import { FEET, FILL, Frame, along, poly, type FrameProps } from './shapes.js';

type Props = Omit<FrameProps, 'children'>;
const feet = { x: 64, y: FEET };

export function Tree(p: Props) {
  return (
    <Frame {...p}>
      <ellipse cx={70} cy={116} rx={22} ry={8} className={`${FILL.shadow} opacity-15 dark:opacity-30`} />
      <rect x={60} y={86} width={8} height={32} className={FILL.wood} />
      <circle cx={64} cy={70} r={26} className={FILL.tree} />
      <circle cx={50} cy={82} r={17} className={FILL['tree-shade']} />
      <circle cx={76} cy={62} r={19} className={FILL['tree-light']} />
      <circle cx={70} cy={56} r={7} className="fill-white/25" />
    </Frame>
  );
}

export function Pine(p: Props) {
  return (
    <Frame {...p}>
      <ellipse cx={70} cy={116} rx={20} ry={7} className={`${FILL.shadow} opacity-15 dark:opacity-30`} />
      <rect x={60} y={100} width={8} height={18} className={FILL['wood-shade']} />
      <polygon points="64,86 36,106 92,106" className={FILL['tree-shade']} />
      <polygon points="64,64 40,90 88,90" className={FILL.tree} />
      <polygon points="64,42 46,72 82,72" className={FILL['tree-light']} />
      <polygon points="64,42 58,56 64,58" className="fill-white/20" />
    </Frame>
  );
}

export function Bush(p: Props) {
  return (
    <Frame {...p}>
      <ellipse cx={68} cy={116} rx={22} ry={7} className={`${FILL.shadow} opacity-15 dark:opacity-30`} />
      <ellipse cx={58} cy={104} rx={20} ry={14} className={FILL['tree-shade']} />
      <ellipse cx={72} cy={100} rx={22} ry={16} className={FILL.tree} />
      <ellipse cx={78} cy={94} rx={12} ry={9} className={FILL['tree-light']} />
    </Frame>
  );
}

export function Rock(p: Props) {
  return (
    <Frame {...p}>
      <ellipse cx={70} cy={116} rx={24} ry={7} className={`${FILL.shadow} opacity-15 dark:opacity-30`} />
      <polygon points="38,110 52,90 74,84 96,98 90,114 50,116" className={FILL.rock} />
      <polygon points="74,84 96,98 90,114 70,112 66,96" className={FILL['rock-shade']} />
      <polygon points="52,90 74,84 66,96 56,100" className="fill-white/25" />
    </Frame>
  );
}

export function Lamp(p: Props) {
  return (
    <Frame {...p}>
      <ellipse cx={68} cy={116} rx={12} ry={4} className={`${FILL.shadow} opacity-15 dark:opacity-30`} />
      <circle cx={64} cy={52} r={26} fill={`url(#${p.id}-glow)`} className="hidden dark:block" />
      <rect x={62} y={62} width={4} height={56} className={FILL['wood-shade']} />
      <polygon points="56,66 72,66 70,48 58,48" className={FILL['rock-shade']} />
      <polygon points="58,50 70,50 69,60 59,60" className={FILL.lamp} />
      <polygon points="54,48 74,48 64,42" className={FILL['rock-shade']} />
    </Frame>
  );
}

export function Fence(p: Props) {
  // Three posts and two rails along +x, so a run of fences in a row reads as one line.
  const posts = [along(feet, -0.9, 0), along(feet, -0.45, 0), feet];
  const rail = (up: number): string => poly(along(posts[0]!, 0, 0, up), along(posts[2]!, 0, 0, up), along(posts[2]!, 0, 0, up - 3), along(posts[0]!, 0, 0, up - 3));
  return (
    <Frame {...p}>
      {posts.map((post, i) => <rect key={i} x={post.x - 2} y={post.y - 20} width={4} height={20} className={FILL.wood} />)}
      <polygon points={rail(16)} className={FILL['wood-shade']} />
      <polygon points={rail(9)} className={FILL['wood-shade']} />
    </Frame>
  );
}
