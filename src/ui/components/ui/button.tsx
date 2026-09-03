// shadcn-style button (Radix-free until a screen needs a primitive); focus ring comes from styles.css.
import * as React from 'react';
import { cn } from '../../lib/cn.js';

type Variant = 'default' | 'secondary' | 'ghost' | 'link';
type Size = 'default' | 'sm';

const variants: Record<Variant, string> = {
  default: 'bg-blue-700 text-white hover:bg-blue-800 dark:bg-sky-500 dark:text-gray-950 dark:hover:bg-sky-400',
  secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700',
  ghost: 'text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800',
  link: 'text-blue-700 underline-offset-4 hover:underline dark:text-sky-300',
};
const sizes: Record<Size, string> = { default: 'h-10 px-4 py-2', sm: 'h-8 px-3 text-sm' };

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: Size }

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant = 'default', size = 'default', type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50', variants[variant], sizes[size], className)}
      {...props}
    />
  );
});
