import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome } from '../../src/runtime/cli/context.js';

describe('expandHome', () => {
  it('expands a leading ~ so the same command means the same thing on every platform', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/wb')).toBe(path.join(os.homedir(), 'wb'));
    // PowerShell and cmd.exe never expand it, which is how `init ~/wb` made a directory named "~".
    expect(expandHome('~\\wb')).toBe(path.join(os.homedir(), 'wb'));
  });

  it('leaves everything else alone, including a ~ that is not the first character', () => {
    for (const p of ['/srv/wb', './wb', 'wb', '/tmp/~/wb', '~user/wb', 'C:\\Users\\x\\wb']) {
      expect(expandHome(p)).toBe(p);
    }
  });
});
