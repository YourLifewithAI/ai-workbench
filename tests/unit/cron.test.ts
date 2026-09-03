import { describe, expect, it } from 'vitest';
import { describeCron } from '../../src/ui/lib/cron.js';

describe('describeCron', () => {
  it('says every preset the workbench offers in English', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour');
    expect(describeCron('0 7 * * *')).toBe('Every day at 07:00');
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(describeCron('0 8 * * 1')).toBe('Every Monday at 08:00');
  });

  it('handles the shapes people hand-write around them', () => {
    expect(describeCron('30 6 * * *')).toBe('Every day at 06:30');
    expect(describeCron('0 */4 * * *')).toBe('Every 4 hours');
    expect(describeCron('0 10 * * 0,6')).toBe('Weekends at 10:00');
    expect(describeCron('0 9 1 * *')).toBe('Day 1 of the month at 09:00');
  });

  it('falls back to the expression rather than guessing', () => {
    // Still true, just less kind — better than a confident wrong sentence.
    for (const odd of ['*/7 * * * *', '0 9 * 3 1', '0 9 15 * 1', 'nonsense', '0 9 * *']) {
      expect(describeCron(odd)).toBe(odd);
    }
  });
});
