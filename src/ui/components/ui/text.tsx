// The type scale (L1): four heading sizes and two text tones, named by role so a screen never picks a size by
// mood. A screen has one ScreenTitle; its sections are SectionTitles (the first `mt-6` under the title, `mt-8`
// after); a card or block inside a section is a CardTitle; a group inside a card or form is a Subheading.
//
//   ScreenTitle   h1   text-2xl font-semibold
//   SectionTitle  h2   text-lg  font-medium
//   CardTitle     h2   font-medium               (the base size)
//   Subheading    h3   text-sm  font-medium
//   Prose         p    text-sm  gray-700 / 300   what the person reads
//   Hint          p    text-xs  gray-600 / 400   a note under a control, or a line of meta
import * as React from 'react';
import { cn } from '../../lib/cn.js';

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4';
type HeadingProps = React.HTMLAttributes<HTMLHeadingElement> & { as?: HeadingTag };

/** The tones, for text that is not a paragraph (a table cell, a caption, a span). */
export const TONE = {
  prose: 'text-gray-700 dark:text-gray-300',
  hint: 'text-gray-600 dark:text-gray-400',
} as const;

/** The vertical rhythm, named so screens agree on it. */
export const RHYTHM = {
  /** The first section under the screen title. */
  first: 'mt-6',
  /** Every section after the first. */
  section: 'mt-8',
  /** A block inside a section. */
  block: 'mt-4',
  /** A control or a line inside a block. */
  line: 'mt-2',
  /** A note under the thing it annotates. */
  note: 'mt-1',
} as const;

export function ScreenTitle({ className, as: Tag = 'h1', id = 'screen-title', ...props }: HeadingProps) {
  return <Tag id={id} className={cn('text-2xl font-semibold', className)} {...props} />;
}

export function SectionTitle({ className, as: Tag = 'h2', ...props }: HeadingProps) {
  return <Tag className={cn('text-lg font-medium', className)} {...props} />;
}

export function CardTitle({ className, as: Tag = 'h2', ...props }: HeadingProps) {
  return <Tag className={cn('font-medium', className)} {...props} />;
}

export function Subheading({ className, as: Tag = 'h3', ...props }: HeadingProps) {
  return <Tag className={cn('text-sm font-medium', className)} {...props} />;
}

export function Prose({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm', TONE.prose, className)} {...props} />;
}

export function Hint({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs', TONE.hint, className)} {...props} />;
}
