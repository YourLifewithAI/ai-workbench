// SEC-11, the Windows half. The deny list is a string comparison, and Windows opens a file under names that
// comparison does not produce: `credentials.json.` and `credentials.json ` both open `credentials.json`, and
// `notes.md::$DATA` opens `notes.md`. A checker that disagrees with the filesystem is a bypass, not a policy.
import { describe, expect, it } from 'vitest';
import { windowsName, windowsUnsafe } from '../../src/runtime/security/broker.js';

describe('SEC-11 Windows path semantics', () => {
  it('compares the name Windows will actually open, not the one it was handed', () => {
    // Every one of these opens credentials.json on Windows.
    for (const bypass of ['credentials.json.', 'credentials.json ', 'credentials.json...', 'credentials.json.  . ']) {
      expect(windowsName(bypass)).toBe('credentials.json');
    }
    // And the hard-denied directories, which the same trick would otherwise walk straight past.
    expect(windowsName('config.')).toBe('config');
    expect(windowsName('agents ')).toBe('agents');
  });

  it('leaves a legitimate name alone, including dots that are not trailing', () => {
    for (const ok of ['credentials.json', 'notes.md', 'my.file.txt', '.gitignore', 'a.b.c']) {
      expect(windowsName(ok)).toBe(ok);
    }
  });

  it('refuses a segment naming an alternate data stream', () => {
    for (const ads of ['notes.md::$DATA', 'notes.md:hidden', 'credentials.json:x']) {
      expect(windowsUnsafe(ads), ads).toMatch(/alternate data stream|drive/);
    }
  });

  it('refuses the reserved device names, with or without an extension', () => {
    for (const dev of ['NUL', 'nul', 'CON', 'con.txt', 'PRN', 'AUX', 'COM1', 'lpt9', 'NUL.'] ) {
      expect(windowsUnsafe(dev), dev).toMatch(/reserved Windows device name/);
    }
  });

  it('does not refuse a file that merely starts with a device name', () => {
    // `console.md` is not CON; a checker that rejected it would be unusable.
    for (const ok of ['console.md', 'connection.json', 'nullable.ts', 'com10.txt', 'auxiliary.md', 'lpt.md']) {
      expect(windowsUnsafe(ok), ok).toBeNull();
    }
  });
});
