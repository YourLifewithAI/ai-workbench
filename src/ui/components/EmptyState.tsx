import type { ReactNode } from 'react';

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
      <p className="text-base text-gray-700 dark:text-gray-300">{title}</p>
      {children ? <div className="mt-4 flex justify-center gap-3">{children}</div> : null}
    </div>
  );
}
