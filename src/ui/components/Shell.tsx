import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '../lib/cn.js';
import { SCREENS } from '../lib/screens.js';
import { readTheme, saveTheme, type Theme } from '../lib/theme.js';
import { NetworkBanner } from './NetworkBanner.js';
import { Mark } from './ui/mark.js';

export { SCREENS } from '../lib/screens.js';

/**
 * What a phone gets on the tab bar. The rest is still reachable — the full list is one tap away under "More" —
 * but these four are what someone catching up on their phone actually opens (D-61).
 */
const PHONE_TABS = ['/dashboard', '/review', '/runs', '/library'];

export function Shell() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { saveTheme(theme); }, [theme]);

  // In tab-bar order, not navigation order: on a phone the queue you came to clear comes before the archive.
  const tabs = PHONE_TABS.map((path) => SCREENS.find((s) => s.path === path)).filter((s): s is (typeof SCREENS)[number] => s !== undefined);

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="border-b border-gray-200 md:w-56 md:border-b-0 md:border-r dark:border-gray-800">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="flex items-center gap-2 text-base font-semibold"><Mark />AI Workbench</span>
          <label className="text-xs text-gray-600 dark:text-gray-400">
            <span className="sr-only">Theme</span>
            <select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)} className="min-h-11 rounded border border-gray-300 bg-white px-1 dark:border-gray-700 dark:bg-gray-950 md:min-h-0 md:py-0.5 md:text-xs">
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
        {/* The full list is the desktop navigation, and on a phone it is what "More" opens. */}
        <nav aria-label="Primary" className={cn('px-2 pb-3 md:block', moreOpen ? 'block' : 'hidden')}>
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {SCREENS.map((s) => (
              <li key={s.path}>
                <NavLink
                  to={s.path}
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) => cn('block rounded-md px-3 py-2.5 text-sm hover:bg-gray-100 md:py-1.5 dark:hover:bg-gray-800', isActive && 'bg-gray-100 font-medium dark:bg-gray-800')}
                >
                  {s.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <div className="flex min-w-0 flex-1 flex-col">
        <NetworkBanner />
        {/* The bottom bar covers the last stretch of the page, so the content ends above it rather than under it. */}
        <main id="main" tabIndex={-1} className="flex-1 p-4 pb-24 md:p-6 md:pb-6">
          <Outlet />
        </main>

        <nav aria-label="Sections" className="fixed inset-x-0 bottom-0 z-10 border-t border-gray-200 bg-white md:hidden dark:border-gray-800 dark:bg-gray-950">
          <ul className="flex">
            {tabs.map((s) => (
              <li key={s.path} className="flex-1">
                <NavLink
                  to={s.path}
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) => cn('flex min-h-14 items-center justify-center px-1 text-center text-xs', isActive ? 'font-semibold text-blue-700 dark:text-sky-300' : 'text-gray-700 dark:text-gray-300')}
                >
                  {s.label}
                </NavLink>
              </li>
            ))}
            <li className="flex-1">
              <button
                type="button"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((open) => !open)}
                className="flex min-h-14 w-full items-center justify-center px-1 text-xs text-gray-700 dark:text-gray-300"
              >
                {moreOpen ? 'Close' : 'More'}
              </button>
            </li>
          </ul>
        </nav>
      </div>
    </div>
  );
}
