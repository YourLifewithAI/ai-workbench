/**
 * A cron expression is a fine thing to store and a poor thing to read on a phone at breakfast.
 * The shapes below cover every preset the workbench offers and the ones people hand-write around them;
 * anything else falls back to the expression itself, which is still true, just less kind.
 */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const at = (h: string, m: string): string => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;

export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (mon !== '*' || (dom !== '*' && dow !== '*')) return cron;

  const when = /^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour) ? `at ${at(hour, min)}` : null;

  if (dom === '*' && dow === '*') {
    if (when) return `Every day ${when}`;
    if (min === '0' && hour === '*') return 'Every hour';
    const everyN = min === '0' ? /^\*\/(\d+)$/.exec(hour) : null;
    if (everyN) return `Every ${everyN[1]} hours`;
    return cron;
  }
  if (dow === '1-5' && when) return `Weekdays ${when}`;
  if (dow === '0,6' && when) return `Weekends ${when}`;
  if (/^[0-6]$/.test(dow) && when) return `Every ${DAYS[Number(dow)]} ${when}`;
  if (dom !== '*' && dow === '*' && /^\d{1,2}$/.test(dom) && when) return `Day ${dom} of the month ${when}`;
  return cron;
}
