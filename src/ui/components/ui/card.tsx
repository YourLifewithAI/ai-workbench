import * as React from 'react';
import { cn } from '../../lib/cn.js';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900', className)} {...props} />;
}

export function Badge({ className, tone = 'neutral', ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'good' | 'bad' | 'busy' }) {
  const tones = {
    neutral: 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100',
    good: 'bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100',
    bad: 'bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100',
    busy: 'bg-amber-200 text-amber-950 dark:bg-amber-800 dark:text-amber-50',
  };
  return <span className={cn('inline-flex items-center rounded px-2 py-0.5 text-xs font-medium', tones[tone], className)} {...props} />;
}
