import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '../lib/cn.js';
import { readTheme, saveTheme, type Theme } from '../lib/theme.js';

export const SCREENS: { path: string; label: string; shipsIn: string; summary: string }[] = [
  { path: '/welcome', label: 'Welcome', shipsIn: 'RUN-00', summary: 'The first-run path.' },
  { path: '/dashboard', label: 'Dashboard', shipsIn: 'RUN-05', summary: 'What needs you, what is running, and what today cost.' },
  { path: '/library', label: 'Library', shipsIn: 'RUN-03', summary: 'Projects, documents, and every version your agents produce.' },
  { path: '/workflows', label: 'Workflows', shipsIn: 'RUN-04', summary: 'Multi-step workflows with a live graph and a run form built from their inputs.' },
  { path: '/agents', label: 'Agents', shipsIn: 'RUN-01', summary: 'Agent definitions, versions, model policies, and their run form.' },
  { path: '/runs', label: 'Runs', shipsIn: 'RUN-00', summary: 'Every run with what it cost and produced.' },
  { path: '/review', label: 'Review', shipsIn: 'RUN-05', summary: 'Outputs waiting for a rating and approvals waiting for a decision.' },
  { path: '/models', label: 'Models', shipsIn: 'RUN-02', summary: 'The model catalog with pricing, capabilities, and data policy.' },
  { path: '/memory', label: 'Memory', shipsIn: 'RUN-08', summary: 'What agents remember, with provenance and trust.' },
  { path: '/tools', label: 'Tools', shipsIn: 'RUN-06', summary: 'Built-in tools, MCP servers, the grant matrix, and denial history.' },
  { path: '/evaluate', label: 'Evaluate', shipsIn: 'RUN-10', summary: 'Compare models side by side; datasets and experiments.' },
  { path: '/settings', label: 'Settings', shipsIn: 'RUN-00', summary: 'Workspace, providers, network mode, budgets.' },
];

export function Shell() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  useEffect(() => { saveTheme(theme); }, [theme]);

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="border-b border-gray-200 md:w-56 md:border-b-0 md:border-r dark:border-gray-800">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-base font-semibold">AI Workbench</span>
          <label className="text-xs text-gray-600 dark:text-gray-400">
            <span className="sr-only">Theme</span>
            <select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)} className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-950">
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
        <nav aria-label="Primary" className="px-2 pb-3">
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {SCREENS.map((s) => (
              <li key={s.path}>
                <NavLink
                  to={s.path}
                  className={({ isActive }) => cn('block rounded-md px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800', isActive && 'bg-gray-100 font-medium dark:bg-gray-800')}
                >
                  {s.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
