// Fixture repositories and scripted conversations for the repository tools (RUN-16) and the coding run (RUN-17).
// Self-contained on purpose: the e2e global setup imports this too, and it must not pull the runtime in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('WORKBENCH_')) env[k] = v;
  return env;
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Whether a ref exists in a repository, without throwing. */
export function hasRef(cwd: string, ref: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, env: cleanEnv() }).status === 0;
}

export interface FixtureRepo { root: string; remote: string }

/**
 * A checkout on `main` with a gate that fails until src/app.js says "fixed", and a bare remote beside it. The
 * gate also reports how many credential variables it can see, so SEC-35 has something to read.
 */
export function fixtureRepo(prefix: string, opts: { gate?: boolean; files?: Record<string, string> } = {}): FixtureRepo {
  const dir = tempDir(prefix);
  const root = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n\nA repository for the Mechanic to work on.\n');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const state = "broken";\n');
  fs.writeFileSync(path.join(root, 'check.js'), [
    'const fs = require("node:fs");',
    'const creds = Object.keys(process.env).filter((k) => k.startsWith("WORKBENCH_CRED_"));',
    'console.log("credential variables seen: " + creds.length);',
    'const src = fs.readFileSync("src/app.js", "utf8");',
    'if (!src.includes("fixed")) { console.error("FAIL: app is not fixed"); process.exit(1); }',
    'console.log("PASS: app is fixed");',
  ].join('\n'));
  if (opts.gate !== false) {
    fs.mkdirSync(path.join(root, '.workbench'));
    fs.writeFileSync(path.join(root, '.workbench', 'repo.json'), JSON.stringify({ check: `"${process.execPath}" check.js`, timeoutMs: 60_000 }, null, 2));
  }
  for (const [file, content] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, '-c', 'user.name=owner', '-c', 'user.email=owner@example.test', 'add', '-A');
  git(root, '-c', 'user.name=owner', '-c', 'user.email=owner@example.test', 'commit', '-q', '-m', 'fixture');
  git(dir, 'init', '-q', '--bare', 'remote.git');
  git(root, 'remote', 'add', 'origin', remote);
  return { root, remote };
}

export function grant(ws: string, agentId: string, permissions: Record<string, unknown>): void {
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants?: Record<string, unknown> };
  config.grants = { ...(config.grants ?? {}), [agentId]: permissions };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

export const ALL_REPO_TOOLS: Record<string, 'allow'> = Object.fromEntries(
  ['repo.read', 'repo.list', 'repo.write', 'git.status', 'git.diff', 'git.log', 'git.branch', 'git.commit', 'git.push', 'check'].map((t) => [t, 'allow' as const]),
);

export interface Turn {
  /** The tool that must already have been called in this step for the turn to match. */
  after?: string;
  /** A phrase the last user message must contain, when `tag` alone is not enough. */
  when?: string;
  /** A phrase the system prompt must contain (the wrap-up turn announces itself there). */
  system?: string;
  calls?: { name: string; input: unknown }[];
  text: string;
}

/**
 * A scripted conversation for one agent and one run. The mock picks the first fixture whose conditions hold, so
 * later turns are written to sort first; `tag` keeps runs in one workspace apart, and the agent is part of the
 * file name so two scripts for one tag never overwrite each other.
 */
export function script(ws: string, agent: string, tag: string, turns: Turn[], prefix = ''): void {
  turns.forEach((turn, i) => {
    const slug = agent.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const name = `${prefix}${tag}-${slug}-${String(turns.length - i).padStart(2, '0')}.json`;
    fs.writeFileSync(path.join(ws, 'fixtures', name), JSON.stringify({
      match: {
        systemIncludes: turn.system ?? agent,
        ...(turn.system ? {} : { lastUserIncludes: turn.when ?? tag }),
        ...(turn.after ? { afterTool: turn.after } : {}),
      },
      respond: { text: turn.text, ...(turn.calls ? { toolCalls: turn.calls } : {}) },
    }, null, 2));
  });
}

// ---- the coding run (RUN-17) -------------------------------------------------------------------

/** A repository that carries the run protocol's files: the brief RUN-99, the template, AGENTS.md, STATUS.md. */
export function protocolRepo(prefix: string, gate?: string): FixtureRepo {
  return fixtureRepo(prefix, {
    files: {
      'AGENTS.md': '# AGENTS.md\n\nRead STATUS.md, then the brief. `check` is the gate. Write runlog/RUN-nn.md from the template when done.\n',
      'STATUS.md': '# STATUS\n\n**Current run:** RUN-98: verified\n',
      'spec/runs/RUN-99.md': '# RUN-99 — Fix the state\n\n**Reads.** README.md.\n\n**Definition of done.**\n1. `src/app.js` exports `state = "fixed"`.\n2. `check` passes.\n',
      'spec/runs/TEMPLATE-handoff.md': '# RUN-nn handoff — <name>\n\n## Built\n\n## Verification transcript\n\n## Known gaps\n',
      ...(gate ? { 'check.js': gate } : {}),
    },
  });
}

export const MECHANIC = 'The Mechanic';
export const PLAN = JSON.stringify({ run: '99', name: 'fixture', branch: 'run/99-fixture', items: ['1. src/app.js exports state = "fixed"', '2. check passes'], files: ['src/app.js'], plan: 'Fix the constant, run the gate, commit.' });
export const HANDOFF = '# RUN-99 handoff — fixture\n\n## Built\n- `src/app.js` — the state is fixed.\n\n## Verification transcript\n(quoted below by the workflow)\n\n## Known gaps\n- none\n';
export const HANDOFF_UNMET = '# RUN-99 handoff — fixture\n\n## Built\n- `src/app.js` — an attempt.\n\n## Verification transcript\n(quoted below by the workflow)\n\n## Known gaps\n- 1. the state is still not fixed\n- 2. check does not pass\n';

/** The Mechanic through every step of `coding-run` but implement, which each case scripts its own way. */
export function protocolScripts(ws: string, handoff = HANDOFF): void {
  script(ws, MECHANIC, 'READ', [
    { when: 'Answer with JSON only', text: 'Reading.', calls: [{ name: 'repo.read', input: { path: 'AGENTS.md' } }, { name: 'repo.read', input: { path: 'STATUS.md' } }, { name: 'repo.read', input: { path: 'spec/runs/RUN-99.md' } }] },
    { when: 'Answer with JSON only', after: 'repo.read', text: PLAN },
  ]);
  script(ws, MECHANIC, 'HANDOFF', [
    { when: 'Write the handoff for RUN-99', text: 'Reading the template.', calls: [{ name: 'repo.read', input: { path: 'spec/runs/TEMPLATE-handoff.md' } }, { name: 'git.log', input: { count: 1 } }] },
    { when: 'Write the handoff for RUN-99', after: 'git.log', text: 'Updating STATUS.', calls: [{ name: 'repo.write', input: { path: 'STATUS.md', content: '# STATUS\n\n**Current run:** RUN-99: awaiting verification @ (see git log)\n' } }] },
    { when: 'Write the handoff for RUN-99', after: 'repo.write', text: handoff },
  ]);
  script(ws, MECHANIC, 'NOTE', [
    { when: 'Write the note the person reads', text: 'Branch: run/99-fixture\nCheck: see above\nevery item met' },
  ]);
}

/** An implement step that branches, fixes the file, tries the brief (refused), checks, and commits. */
export const IMPLEMENT_GREEN: Turn[] = [
  { when: 'Implement the brief', text: 'Branching.', calls: [{ name: 'git.branch', input: { name: 'run/99-fixture' } }] },
  { when: 'Implement the brief', after: 'git.branch', text: 'Fixing.', calls: [
    { name: 'repo.write', input: { path: 'src/app.js', content: 'export const state = "fixed";\n' } },
    // The brief is the human's: this write is refused and the run carries on (RUN-17 DoD 4).
    { name: 'repo.write', input: { path: 'spec/runs/RUN-99.md', content: '# RUN-99 — made easier\n' } },
  ] },
  { when: 'Implement the brief', after: 'repo.write', text: 'Checking.', calls: [{ name: 'check', input: {} }] },
  { when: 'Implement the brief', after: 'check', text: 'Committing.', calls: [{ name: 'git.commit', input: { message: 'Fix the app state' } }] },
  { when: 'Implement the brief', after: 'git.commit', text: 'Changed src/app.js; check said ok. Every item met.' },
];
