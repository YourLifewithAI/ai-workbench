// Global controls stay visible (ui.md §Friendly by design 8): the mode is always on screen, and cutting the
// network is one click rather than a config edit and a restart.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';

const COPY: Record<string, { label: string; says: string; tone: string }> = {
  offline: { label: 'Offline', says: 'Nothing leaves this machine. Local models still run.', tone: 'bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100' },
  'local-only': { label: 'Local only', says: 'Only endpoints configured in this workspace, on this machine.', tone: 'bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100' },
  allowlist: { label: 'Allowlist', says: 'Models in your catalog, plus hosts you listed.', tone: 'bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100' },
  unrestricted: { label: 'Unrestricted', says: 'Any public host. Private addresses are still refused.', tone: 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100' },
};

export function NetworkBanner() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const setMode = useMutation({
    mutationFn: api.setNetworkMode,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['settings'] });
      void client.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const mode = settings.data?.networkMode ?? '';
  const copy = COPY[mode];
  if (!copy) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-2 text-sm dark:border-gray-800">
      <span className={cn('rounded px-2 py-0.5 text-xs font-medium', copy.tone)}>Network: {copy.label}</span>
      <span className="text-gray-600 dark:text-gray-400">{copy.says}</span>
      {mode === 'offline' ? (
        <button type="button" onClick={() => setMode.mutate('allowlist')} disabled={setMode.isPending} className="ml-auto min-h-11 rounded px-2 text-xs font-medium underline underline-offset-4 hover:bg-gray-100 md:min-h-0 md:py-1 dark:hover:bg-gray-800">
          Go back online (allowlist)
        </button>
      ) : (
        <button type="button" onClick={() => setMode.mutate('offline')} disabled={setMode.isPending} className="ml-auto min-h-11 rounded px-2 text-xs font-medium underline underline-offset-4 hover:bg-gray-100 md:min-h-0 md:py-1 dark:hover:bg-gray-800">
          Go offline
        </button>
      )}
    </div>
  );
}
