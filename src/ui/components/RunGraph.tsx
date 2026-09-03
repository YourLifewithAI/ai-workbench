// The workflow's shape, with each step's live state on it (ui.md §Workflows). Laid out in columns by depth and
// drawn as SVG rather than pulled in as a graph library: the graphs here are small, and a dependency that
// renders a canvas would take the steps out of the accessibility tree.
import type { StepSummary, WorkflowSummary } from '../../shared/api/index.js';
import { cn } from '../lib/cn.js';

export interface GraphStep { id: string; kind: string; agent: string | null; dependsOn: string[]; review?: 'none' | 'blocking' }

const NODE_W = 168;
const NODE_H = 52;
const GAP_X = 56;
const GAP_Y = 16;

const TONES: Record<string, string> = {
  completed: 'fill-green-100 stroke-green-700 dark:fill-green-900 dark:stroke-green-300',
  failed: 'fill-red-100 stroke-red-700 dark:fill-red-900 dark:stroke-red-300',
  cancelled: 'fill-red-50 stroke-red-600 dark:fill-red-950 dark:stroke-red-400',
  running: 'fill-amber-100 stroke-amber-700 dark:fill-amber-900 dark:stroke-amber-300',
  skipped: 'fill-gray-50 stroke-gray-400 dark:fill-gray-900 dark:stroke-gray-600',
  pending: 'fill-white stroke-gray-300 dark:fill-gray-950 dark:stroke-gray-700',
};

/** Longest path from a root, so a step always sits to the right of everything it waits on. */
function columns(steps: GraphStep[]): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // the validator rejects cycles; this only keeps a bad definition from hanging
    seen.add(id);
    const parents = (byId.get(id)?.dependsOn ?? []).filter((p) => byId.has(p));
    const value = parents.length ? Math.max(...parents.map((p) => visit(p, seen))) + 1 : 0;
    depth.set(id, value);
    return value;
  };
  for (const step of steps) visit(step.id, new Set());
  return depth;
}

export function RunGraph({ workflow, steps, states, className }: {
  workflow?: WorkflowSummary | undefined;
  steps?: GraphStep[] | undefined;
  states?: StepSummary[] | undefined;
  className?: string;
}) {
  const nodes = steps ?? workflow?.steps ?? [];
  if (!nodes.length) return null;

  const depth = columns(nodes);
  const perColumn = new Map<number, GraphStep[]>();
  for (const node of nodes) {
    const column = depth.get(node.id) ?? 0;
    perColumn.set(column, [...(perColumn.get(column) ?? []), node]);
  }
  const position = new Map<string, { x: number; y: number }>();
  for (const [column, items] of perColumn) {
    items.forEach((item, row) => position.set(item.id, { x: column * (NODE_W + GAP_X), y: row * (NODE_H + GAP_Y) }));
  }
  const width = (Math.max(...depth.values()) + 1) * (NODE_W + GAP_X) - GAP_X;
  const height = Math.max(...[...perColumn.values()].map((c) => c.length)) * (NODE_H + GAP_Y) - GAP_Y;
  // Outside a run there is no state to show: a definition is not a graph of pending steps, it is a shape.
  const stateOf = (id: string): string | null => (states ? states.find((s) => s.stepId === id)?.state ?? 'pending' : null);

  return (
    <div className={cn('overflow-x-auto', className)} tabIndex={0}>
      <svg viewBox={`-2 -2 ${width + 4} ${height + 4}`} width={width} height={height} role="img" aria-label={`Workflow graph: ${nodes.length} steps`} className="max-w-none">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" className="fill-gray-400 dark:fill-gray-600" />
          </marker>
        </defs>
        {nodes.flatMap((node) =>
          node.dependsOn.filter((from) => position.has(from)).map((from) => {
            const a = position.get(from)!;
            const b = position.get(node.id)!;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            return (
              <path key={`${from}->${node.id}`} d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none" strokeWidth={1.5} markerEnd="url(#arrow)" className="stroke-gray-400 dark:stroke-gray-600" />
            );
          }),
        )}
        {nodes.map((node) => {
          const at = position.get(node.id)!;
          const state = stateOf(node.id);
          return (
            <g key={node.id} transform={`translate(${at.x}, ${at.y})`}>
              <rect width={NODE_W} height={NODE_H} rx={8} strokeWidth={1.5} className={(state ? TONES[state] : undefined) ?? TONES['pending']} />
              <text x={10} y={20} className="fill-gray-900 text-[12px] font-medium dark:fill-gray-100">{node.id}</text>
              <text x={10} y={38} className="fill-gray-700 text-[11px] dark:fill-gray-300">
                {node.kind === 'map' ? 'map' : node.agent ?? node.kind}{state ? ` · ${state}` : ''}
              </text>
              {node.review === 'blocking' ? (
                <text x={NODE_W - 10} y={20} textAnchor="end" className="fill-amber-800 text-[10px] font-medium dark:fill-amber-300">waits for you</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {/* The same information as a list, because an SVG diagram is not a structure a screen reader can walk. */}
      <ul className="sr-only">
        {nodes.map((node) => (
          <li key={node.id}>
            {node.id} ({node.kind === 'map' ? 'map' : node.agent ?? node.kind}){stateOf(node.id) ? ` is ${stateOf(node.id)}` : ''}
            {node.dependsOn.length ? `, after ${node.dependsOn.join(' and ')}` : ', with nothing before it'}
            {node.review === 'blocking' ? ', and waits for your review before anything downstream runs' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
