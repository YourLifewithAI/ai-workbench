// The village as the primary navigation (D-71). Twelve links, one per screen, in the shell's order — the same
// twelve the phone lists by name. Full size it is the square: buildings standing on the diorama at their
// tile, the props between them, painter's order from the back. Compact it is the street: the same buildings in
// a column beside whatever room you are in. In both, a building is a link whose only text is its name, read
// out but never shown; its name and what it is for appear in a box on hover or focus.
import { useId, useState } from 'react';
import type { CSSProperties } from 'react';
import { NavLink } from 'react-router-dom';
import { Village, buildingBox, mapBounds, orderBuildings, propBox, zOf, type Village as VillageT, type VillageBuilding } from '../../shared/village.js';
import { cn } from '../lib/cn.js';
import { SCREENS, type Screen } from '../lib/screens.js';
import { Art } from './art/index.js';
import type { ArtName } from './art/names.js';
import { Ground } from './Ground.js';
import raw from './village.json';

export const DEFAULT_VILLAGE: VillageT = Village.parse(raw);

export type VillageSize = 'full' | 'compact';

export function VillageMap({ size, village = DEFAULT_VILLAGE }: { size: VillageSize; village?: VillageT }) {
  const ordered = orderBuildings(village, SCREENS.map((s) => s.path));
  const screenOf = (b: VillageBuilding): Screen => SCREENS.find((s) => s.path === b.screen)!;

  if (size === 'compact') {
    return (
      <ul data-village="compact" className="m-0 flex list-none flex-col gap-1 px-2 pb-3">
        {ordered.map((b) => <Building key={b.screen} b={b} screen={screenOf(b)} size="compact" />)}
      </ul>
    );
  }

  const { W, H } = mapBounds(village);
  const pct = (n: number, of: number): string => `${((n / of) * 100).toFixed(3)}%`;
  return (
    <div data-village="full" className="relative isolate mx-auto w-full min-w-[720px] max-w-[1040px] select-none" style={{ aspectRatio: `${W} / ${H}` }}>
      <Ground village={village} />
      <div aria-hidden="true" className="absolute inset-0">
        {village.props.map((p, i) => {
          const box = propBox(village, p);
          return (
            <div key={i} className="absolute" style={{ left: pct(box.x, W), top: pct(box.y, H), width: pct(box.w, W), height: pct(box.h, H), zIndex: zOf(p) + 1 }}>
              <Art name={p.art as ArtName} className="h-full w-full" />
            </div>
          );
        })}
      </div>
      <ul className="absolute inset-0 m-0 list-none p-0">
        {ordered.map((b) => {
          const box = buildingBox(village, b);
          return (
            <Building
              key={b.screen}
              b={b}
              screen={screenOf(b)}
              size="full"
              style={{ left: pct(box.x, W), top: pct(box.y, H), width: pct(box.w, W), height: pct(box.h, H), zIndex: zOf(b) + 1 }}
            />
          );
        })}
      </ul>
    </div>
  );
}

function Building({ b, screen, size, style }: { b: VillageBuilding; screen: Screen; size: VillageSize; style?: CSSProperties }) {
  const tipId = `tip${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  // Esc hides the box until the pointer or focus leaves (WCAG 1.4.13: dismissable). The handler sits on the link,
  // never on the document, so the screens' own keys still reach them.
  const [dismissed, setDismissed] = useState(false);
  const full = size === 'full';

  return (
    <li
      className={cn('group', full ? 'absolute hover:z-[100] focus-within:z-[100]' : 'relative')}
      style={style}
      onMouseLeave={() => setDismissed(false)}
    >
      <NavLink
        to={screen.path}
        aria-describedby={tipId}
        onBlur={() => setDismissed(false)}
        onKeyDown={(e) => { if (e.key === 'Escape' && !dismissed) { setDismissed(true); e.stopPropagation(); } }}
        className={({ isActive }) => cn(
          'block rounded-md',
          full ? 'h-full w-full' : 'flex min-h-12 min-w-12 items-center gap-2 px-1 hover:bg-gray-100 dark:hover:bg-gray-800',
          !full && isActive && 'bg-gray-100 dark:bg-gray-800',
        )}
      >
        {({ isActive }) => (
          <>
            <Art name={b.art as ArtName} active={isActive} className={full ? 'h-full w-full' : 'h-12 w-12 shrink-0'} />
            {/* On the square the name is read out and never shown — the houses carry no text (D-71). In the
                street there is room for it, and twelve unlabelled sprites in a column are a guessing game, so
                the same span becomes visible. It is a *swap*, never a second copy: this stays the link's only
                text node, so `textContent` is exactly the screen's name and the twelve-link contract that
                shell.spec and village.spec read holds in both sizes. */}
            <span className={full ? 'sr-only' : 'truncate text-sm font-medium'}>{screen.label}</span>
          </>
        )}
      </NavLink>
      <div
        role="tooltip"
        id={tipId}
        className={cn(
          'absolute z-[110] w-max max-w-56 rounded-md border border-gray-200 bg-village-tip px-3 py-2 text-sm text-village-tip-text opacity-0 shadow-lg transition-opacity dark:border-gray-700',
          dismissed ? 'invisible' : 'invisible group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100',
          full ? 'bottom-full left-1/2 mb-1 -translate-x-1/2' : 'left-full top-1/2 ml-2 -translate-y-1/2',
        )}
      >
        <p className="font-medium">{screen.label}</p>
        <p className="mt-0.5 text-xs opacity-80">{screen.summary}</p>
      </div>
    </li>
  );
}
