// The exfiltration rule's memory of a run (D-29). A run is *private-tainted* once private content has entered
// it, and it keeps every URL it was shown. Neither fact depends on what the model says about itself.
import type { Db } from '../db/index.js';

/** URLs, loosely. Over-collecting here is safe: `seenUrls` only ever widens what a run may follow. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gi;

/** Tools whose output is private content. Fetched web content is not private and does not taint (D-29). */
export const PRIVATE_TOOLS = new Set(['artifact.read', 'fs.read', 'memory.search', 'knowledge.search']);

/**
 * Tools whose output is *external* content: something from outside the workspace, or something imported into it
 * from outside. A run that has consumed any of it writes `untrusted` memory (artifacts-and-memory.md §Memory).
 * `knowledge.search` is in both sets — imported files are private to this workspace and foreign to it at once —
 * and `calc`, `datetime` and `artifact.read` are in neither.
 */
export const EXTERNAL_TOOLS = new Set(['http.fetch', 'web.search', 'knowledge.search']);

export class RunTaint {
  private tainted = false;
  private external = false;
  readonly seenUrls = new Set<string>();

  constructor(private readonly db: Db, private readonly runId: string) {}

  get privateTainted(): boolean {
    return this.tainted;
  }

  /** True once anything from outside the workspace has entered this run. What it remembers is untrusted. */
  get externalTainted(): boolean {
    return this.external;
  }

  /** A prompt that carried a knowledge or memory section has already put private content in front of a model. */
  markPrivate(why: string): void {
    if (this.tainted) return;
    this.tainted = true;
    this.db.prepare('UPDATE runs SET private_tainted = 1 WHERE id = ?').run(this.runId);
    void why;
  }

  /** External content has entered the run: from here on, what it remembers is `untrusted` (D-17). */
  markExternal(why: string): void {
    if (this.external) return;
    this.external = true;
    this.db.prepare('UPDATE runs SET external_tainted = 1 WHERE id = ?').run(this.runId);
    void why;
  }

  /** Everything a step was given or got back, so a URL the run was shown can be told from one it invented. */
  observe(text: string): void {
    for (const match of text.matchAll(URL_PATTERN)) {
      // Trailing punctuation is part of the sentence, not the URL.
      this.seenUrls.add(match[0].replace(/[.,;:!?]+$/, ''));
    }
  }

  /** A child inherits its parent's taint: what the parent read, the child could quote to it. */
  inherit(parent: RunTaint): void {
    if (parent.privateTainted) this.markPrivate('inherited from the parent run');
    if (parent.externalTainted) this.markExternal('inherited from the parent run');
    for (const url of parent.seenUrls) this.seenUrls.add(url);
  }

  static load(db: Db, runId: string): RunTaint {
    const taint = new RunTaint(db, runId);
    const row = db.prepare('SELECT private_tainted, external_tainted FROM runs WHERE id = ?').get(runId) as { private_tainted: number; external_tainted: number } | undefined;
    if (row?.private_tainted === 1) taint.tainted = true;
    if (row?.external_tainted === 1) taint.external = true;
    return taint;
  }
}
