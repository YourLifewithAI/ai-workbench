// pino → data/logs/runtime.log (+ stderr when not quiet), every line through the redactor (D-33).
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import type { Redactor } from '../security/redaction.js';

export type { Logger };

export function createLogger(logFile: string, redactor: Redactor, opts: { stderr: boolean; level?: string } = { stderr: true }): Logger {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const file = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  const sink = new Writable({
    write(chunk, _enc, cb) {
      const line = redactor.redactString(chunk.toString());
      file.write(line);
      if (opts.stderr) process.stderr.write(line);
      cb();
    },
  });
  return pino({ level: opts.level ?? 'info', base: null }, sink);
}
