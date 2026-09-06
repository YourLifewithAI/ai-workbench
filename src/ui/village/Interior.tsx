// Inside a building (D-71): a band over the screen naming where you are, with the way back to the square. Not a
// heading — the screen's own title stays the only h1 — and never on the welcome path, which is how you arrive.
import { Link, useLocation } from 'react-router-dom';
import type { VillageBuilding } from '../../shared/village.js';
import { SCREENS, type Screen } from '../lib/screens.js';
import { Hint } from '../components/ui/text.js';
import { Art } from './art/index.js';
import type { ArtName } from './art/names.js';
import { DEFAULT_VILLAGE } from './VillageMap.js';

/** The building a path is inside: the screen with the longest matching prefix, and its door. */
export function buildingFor(pathname: string): { screen: Screen; building: VillageBuilding } | null {
  const screen = [...SCREENS].sort((a, b) => b.path.length - a.path.length).find((s) => pathname === s.path || pathname.startsWith(`${s.path}/`));
  if (!screen) return null;
  const building = DEFAULT_VILLAGE.buildings.find((b) => b.screen === screen.path);
  return building ? { screen, building } : null;
}

export function Interior() {
  const { pathname } = useLocation();
  const hit = buildingFor(pathname);
  if (!hit || hit.screen.path === '/welcome') return null;
  return (
    <div data-interior className="mb-4 flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-900">
      <Art name={hit.building.art as ArtName} className="h-12 w-12 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{hit.screen.label}</p>
        <Hint>{hit.screen.summary}</Hint>
      </div>
      <Link to="/village" state={{ focus: 'title' }} className="shrink-0 text-sm text-blue-700 underline underline-offset-4 dark:text-sky-300">Back to the village</Link>
    </div>
  );
}
