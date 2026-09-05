// The child-environment allowlist is a snapshot of process.env taken once (D-33). On Windows the search path
// arrives as `Path` at least as often as `PATH`, and a snapshot that compared names exactly kept neither git
// nor Deno findable on a machine that had both.
import { describe, it, expect } from 'vitest';
import { childEnvAllowlistFrom } from '../../src/runtime/bootstrap.js';

describe('the child-environment allowlist', () => {
  it('keeps exactly the POSIX keys, by exact name, on POSIX', () => {
    const allow = childEnvAllowlistFrom({ PATH: '/bin', Path: '/other', HOME: '/h', TMPDIR: '/t', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', SECRET: 'x', WORKBENCH_CRED_X: 'k' }, 'linux');
    expect(Object.keys(allow).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ']);
    expect(allow['PATH']).toBe('/bin');
  });

  it('on Windows, finds the search path under either spelling and stores it as PATH', () => {
    const lower = childEnvAllowlistFrom({ Path: 'C:\\Git\\cmd', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATHEXT: '.COM;.EXE;.CMD', TEMP: 'C:\\T', SECRET: 'x', WORKBENCH_CRED_X: 'k' }, 'win32');
    expect(lower['PATH']).toBe('C:\\Git\\cmd');
    expect(lower['Path']).toBeUndefined();
    expect(Object.keys(lower).sort()).toEqual(['ComSpec', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP']);
    const upper = childEnvAllowlistFrom({ PATH: 'C:\\Git\\cmd', SystemRoot: 'C:\\Windows' }, 'win32');
    expect(upper['PATH']).toBe('C:\\Git\\cmd');
  });

  it('never carries a credential or an arbitrary variable, on either platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const allow = childEnvAllowlistFrom({ PATH: '/bin', WORKBENCH_CRED_GOOGLE: 'k', AWS_SECRET_ACCESS_KEY: 's', NODE_OPTIONS: '--inspect' }, platform);
      expect(Object.keys(allow)).toEqual(['PATH']);
    }
  });
});
