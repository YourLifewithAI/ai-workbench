// RUN-19 — the village. The picture is data three ways (D-71): where (village.json), what (the art registry),
// colour (tokens per theme). Items 1–3 prove the data; 4 proves the picture ships inside the bundle; 5 that a
// person or an agent can find out how to change it. The browser half is `@run-19` in tests/e2e/village.spec.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Village, buildingBox, checkVillage, mapBounds, orderBuildings, project, zOf, type Village as VillageT } from '../../src/shared/village.js';
import { SCREENS } from '../../src/ui/lib/screens.js';
import { ART_NAMES } from '../../src/ui/village/art/names.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const villageDir = path.join(root, 'src', 'ui', 'village');
const screens = SCREENS.map((s) => s.path);
const load = (): VillageT => Village.parse(JSON.parse(fs.readFileSync(path.join(villageDir, 'village.json'), 'utf8')));
const clone = (v: VillageT): VillageT => JSON.parse(JSON.stringify(v)) as VillageT;
const problems = (v: VillageT): string[] => checkVillage(v, screens, ART_NAMES);
const artFiles = (): string[] => {
  const dir = path.join(villageDir, 'art');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => path.join(dir, f));
};
const readAll = (dir: string, ext: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(ext)) out.push(fs.readFileSync(p, 'utf8')); } };
  walk(dir);
  return out;
};

describe('RUN-19 DoD 1: the file is a village, and every way it could be wrong is named', () => {
  it('the shipped file is sound', () => {
    expect(problems(load())).toEqual([]);
  });

  it('a second door to one screen is refused by the screen\'s name', () => {
    const v = clone(load());
    v.buildings.push({ screen: '/library', art: 'well', x: 9, y: 9, footprint: { w: 1, h: 1 } });
    expect(problems(v).join('\n')).toMatch(/2 buildings for \/library/);
  });

  it('a building off the grid is named with its coordinates', () => {
    const v = clone(load());
    const b = v.buildings.find((x) => x.screen === '/models')!;
    b.x = 99; b.y = 99;
    expect(problems(v).join('\n')).toMatch(/stables \(\/models\): off the grid at \(99, 99\)/);
  });

  it('two buildings on one tile are named as a pair', () => {
    const v = clone(load());
    const smithy = v.buildings.find((x) => x.art === 'smithy')!;
    const well = v.buildings.find((x) => x.art === 'well')!;
    well.x = smithy.x; well.y = smithy.y;
    expect(problems(v).join('\n')).toMatch(/(smithy \(\/tools\) and well \(\/memory\)|well \(\/memory\) and smithy \(\/tools\)) share tile/);
  });

  it('a building that covers the middle of another on screen is named, even from a different tile', () => {
    const v = clone(load());
    const smithy = v.buildings.find((x) => x.art === 'smithy')!;
    const well = v.buildings.find((x) => x.art === 'well')!;
    // The tile in front and to the right: 32px across and 16px down, so its 96px picture lands on the smithy's middle.
    well.x = smithy.x + 1; well.y = smithy.y;
    expect(problems(v).join('\n')).toMatch(/covers the middle of/);
  });

  it('an unknown art name is named', () => {
    const v = clone(load());
    v.buildings.find((x) => x.art === 'stables')!.art = 'castle';
    expect(problems(v).join('\n')).toMatch(/no art named castle/);
  });

  it('a prop in a doorway is named', () => {
    const v = clone(load());
    const library = v.buildings.find((x) => x.art === 'library')!;
    v.props.push({ art: 'rock', x: library.x + 1, y: library.y + 1 });
    expect(problems(v).join('\n')).toMatch(/rock stands in the doorway of library/);
  });
});

describe('RUN-19 DoD 2: order and geometry', () => {
  it('the buildings come in the shell\'s order and Settings is last', () => {
    const ordered = orderBuildings(load(), screens).map((b) => b.screen);
    expect(ordered).toEqual(screens);
    expect(ordered.at(-1)).toBe('/settings');
  });

  it('the projection is 2:1 isometric and every picture lies inside the map', () => {
    const tile = { w: 64, h: 32 };
    expect(project(1, 0, tile)).toEqual({ x: 32, y: 16 });
    expect(project(0, 1, tile)).toEqual({ x: -32, y: 16 });
    const v = load();
    const { W, H } = mapBounds(v);
    for (const b of v.buildings) {
      const box = buildingBox(v, b);
      expect(box.x, b.art).toBeGreaterThanOrEqual(0);
      expect(box.y, b.art).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w, b.art).toBeLessThanOrEqual(W);
      expect(box.y + box.h, b.art).toBeLessThanOrEqual(H);
    }
  });

  it('the gate stands furthest front, so it is drawn last and never hidden', () => {
    const v = load();
    const gate = v.buildings.find((b) => b.screen === '/welcome')!;
    for (const b of v.buildings) if (b !== gate) expect(zOf(b), b.art).toBeLessThan(zOf(gate));
  });
});

describe('RUN-19 DoD 3: the art is text-free, complete, and coloured only by tokens', () => {
  it('no art file carries text, a role, a link, or anything the CSP or the shell test would notice', () => {
    for (const file of artFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      for (const bad of ['<title', '<text', '<desc', 'tabIndex', 'role=', 'href=', 'data:', '<a ', 'onClick']) {
        expect(src.includes(bad), `${path.basename(file)} contains ${bad}`).toBe(false);
      }
      // url() is allowed only as a reference to a gradient defined in the same file.
      for (const m of src.matchAll(/url\(([^)]*)\)/g)) expect(m[1], `${path.basename(file)}: ${m[0]}`).toMatch(/^['"]?#/);
    }
  });

  it('every village colour used in the UI is a token in both themes', () => {
    const css = fs.readFileSync(path.join(root, 'src', 'ui', 'styles.css'), 'utf8');
    const theme = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const dark = css.match(/\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const declared = (block: string): Set<string> => new Set([...block.matchAll(/--color-village-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    const light = declared(theme);
    const evening = declared(dark);
    const used = new Set<string>();
    for (const src of readAll(villageDir, '.tsx')) {
      for (const m of src.matchAll(/(?:fill|stroke|bg|text|border|from|to|via)-village-([a-z0-9-]+)/g)) used.add(m[1]!);
      for (const m of src.matchAll(/--color-village-([a-z0-9-]+)/g)) used.add(m[1]!);
    }
    for (const name of used) {
      expect(light.has(name), `--color-village-${name} in @theme`).toBe(true);
      expect(evening.has(name), `--color-village-${name} in .dark`).toBe(true);
    }
    for (const name of light) expect(evening.has(name), `--color-village-${name} has no evening value`).toBe(true);
  });

  it('every art name the file uses is a name the registry knows, and every description is one sentence', () => {
    const v = load();
    for (const b of v.buildings) expect(ART_NAMES, b.art).toContain(b.art);
    for (const p of v.props) expect(ART_NAMES, p.art).toContain(p.art);
    for (const s of SCREENS) {
      expect(s.summary.endsWith('.'), `${s.label}: "${s.summary}" ends with a full stop`).toBe(true);
      expect(s.summary.slice(0, -1).includes('. '), `${s.label}: one sentence`).toBe(false);
    }
  });
});

describe('RUN-19 DoD 4: the picture ships inside the bundle', () => {
  const dist = path.join(root, 'dist', 'ui');
  it('dist/ui holds what it held before, and the village is inside the JavaScript', () => {
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:ui'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
      expect(build.status).toBe(0);
    }
    expect(fs.readdirSync(dist).sort()).toEqual(['assets', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'index.html', 'manifest.webmanifest', 'sw.js']);
    const assets = fs.readdirSync(path.join(dist, 'assets'));
    expect(assets.filter((f) => !/\.(js|css)$/.test(f))).toEqual([]);
    const js = assets.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dist, 'assets', f), 'utf8')).join('\n');
    expect(js.includes('data-village'), 'the built JavaScript carries the village').toBe(true);
    // SEC-30's rule, re-applied: nothing in the built UI points at another origin.
    for (const text of [js, ...assets.filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(dist, 'assets', f), 'utf8'))]) {
      expect(text.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\/[^"'\s)]*\.(?:woff2?|ttf|css|js|png|svg)/gi) ?? []).toEqual([]);
    }
  });
});

describe('RUN-19 DoD 5: how to change it is written down', () => {
  it('docs/village.md names the three layers and the command that proves a change', () => {
    const doc = fs.readFileSync(path.join(root, 'docs', 'village.md'), 'utf8');
    for (const needle of ['village.json', 'art/index.tsx', '--color-village-', 'npm run dod -- 19']) expect(doc, needle).toContain(needle);
  });
});
