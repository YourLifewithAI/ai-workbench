// The art registry (D-71): every name village.json may use, mapped to the component that draws it. `satisfies`
// makes tsc refuse a name with no drawing, and the DoD refuses a drawing with text in it.
import { useId } from 'react';
import type { JSX, SVGProps } from 'react';
import type { ArtName } from './names.js';
import type { FrameProps } from './shapes.js';
import { Gate, Library, Lodge, Observatory, PostOffice, Records, Smithy, Stables, TownHall, Well, Windmill, Workshop } from './buildings.js';
import { Bush, Fence, Lamp, Pine, Rock, Tree } from './props.js';

type ArtComponent = (props: Omit<FrameProps, 'children'>) => JSX.Element;

export const ART = {
  gate: Gate,
  townHall: TownHall,
  library: Library,
  workshop: Workshop,
  lodge: Lodge,
  records: Records,
  postOffice: PostOffice,
  stables: Stables,
  well: Well,
  smithy: Smithy,
  observatory: Observatory,
  windmill: Windmill,
  tree: Tree,
  pine: Pine,
  bush: Bush,
  rock: Rock,
  lamp: Lamp,
  fence: Fence,
} satisfies Record<ArtName, ArtComponent>;

export type ArtProps = { name: ArtName; active?: boolean } & Omit<SVGProps<SVGSVGElement>, 'id' | 'children'>;

/** One piece of art. Gradient ids come from React's useId, so any number of the same drawing can share a page. */
export function Art({ name, active = false, ...rest }: ArtProps) {
  const id = `v${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const Draw = ART[name];
  return <Draw id={id} active={active} {...rest} />;
}
