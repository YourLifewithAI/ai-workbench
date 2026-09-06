// The village file is safe to edit because this runs on every `npm run check`: a building moved onto another's
// tile, off the grid, or over the middle of its neighbour is named here before it is ever drawn (D-71).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Village, checkVillage, orderBuildings, project } from '../../src/shared/village.js';
import { SCREENS } from '../../src/ui/lib/screens.js';
import { ART_NAMES } from '../../src/ui/village/art/names.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.join(root, 'src', 'ui', 'village', 'village.json');
const screens = SCREENS.map((s) => s.path);

describe('the village file', () => {
  it('is a village, and a sound one', () => {
    const v = Village.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(checkVillage(v, screens, ART_NAMES)).toEqual([]);
  });

  it('has one building per screen, in the shell\'s order, with Settings last', () => {
    const v = Village.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const ordered = orderBuildings(v, screens);
    expect(ordered.map((b) => b.screen)).toEqual(screens);
    expect(ordered.at(-1)?.screen).toBe('/settings');
  });

  it('projects 2:1 isometric tiles', () => {
    const tile = { w: 64, h: 32 };
    expect(project(0, 0, tile)).toEqual({ x: 0, y: 0 });
    expect(project(1, 0, tile)).toEqual({ x: 32, y: 16 });
    expect(project(0, 1, tile)).toEqual({ x: -32, y: 16 });
    expect(project(1, 1, tile)).toEqual({ x: 0, y: 32 });
  });
});
