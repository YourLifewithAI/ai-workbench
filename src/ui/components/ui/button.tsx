// shadcn-style button (Radix-free until a screen needs a primitive); focus ring comes from styles.css.
// One family for every button-like control (L2): variants by role, not by mood —
//   default    the one action that moves the screen forward (Run, Save, Apply)
//   secondary  an alternative next to it, or a quieter action on a card (Edit, New, Reload, Cancel)
//   ghost      a toolbar or list action that should not compete (Close, Remove)
//   link       an action written into a sentence
// `asChild` puts the same classes on a <Link> or <a>, so a navigation that looks like a button is one.
import * as React from 'react';
import { cn } from '../../lib/cn.js';

type Variant = 'default' | 'secondary' | 'ghost' | 'link';
type Size = 'default' | 'sm' | 'inline';

const variants: Record<Variant, string> = {
  default: 'bg-blue-700 text-white hover:bg-blue-800 dark:bg-sky-500 dark:text-gray-950 dark:hover:bg-sky-400',
  secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700',
  ghost: 'text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800',
  link: 'text-blue-700 underline-offset-4 hover:underline dark:text-sky-300',
};
// A thumb needs 44px; a mouse does not. Both sizes meet that on a phone and shrink on a wider screen. `inline`
// is for a link-variant button inside a sentence: it takes the sentence's size and no box of its own.
const sizes: Record<Size, string> = {
  default: 'min-h-11 px-4 py-2',
  sm: 'min-h-11 px-3 text-sm md:min-h-8',
  inline: 'min-h-0 p-0 text-[length:inherit]',
};

const BASE = 'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50';

/** The classes alone, for the rare element that cannot be a child (a summary, a label). */
export function buttonClasses(variant: Variant = 'default', size: Size = 'default', className?: string): string {
  return cn(BASE, variants[variant], sizes[size], className);
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Render the single child (a <Link>, an <a>) with the button's classes instead of a <button>. */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'default', type = 'button', asChild = false, children, ...props },
  ref,
) {
  const classes = buttonClasses(variant, size, className);
  if (asChild) {
    const child = React.Children.only(children) as React.ReactElement<{ className?: string | undefined }>;
    return React.cloneElement(child, { ...props, className: cn(classes, child.props.className) } as Partial<typeof child.props>);
  }
  return (
    <button ref={ref} type={type} className={classes} {...props}>
      {children}
    </button>
  );
});
