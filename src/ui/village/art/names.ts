// The names the village file may use for art. Plain TypeScript with no JSX so tests can import it, and a
// `const` tuple so the registry can be checked to cover every name at compile time.
export const BUILDING_ART = [
  'gate',
  'townHall',
  'library',
  'workshop',
  'lodge',
  'records',
  'postOffice',
  'stables',
  'well',
  'smithy',
  'observatory',
  'windmill',
] as const;

export const PROP_ART = ['tree', 'pine', 'bush', 'rock', 'lamp', 'fence'] as const;

export const ART_NAMES = [...BUILDING_ART, ...PROP_ART] as const;
export type ArtName = (typeof ART_NAMES)[number];
export type BuildingArt = (typeof BUILDING_ART)[number];
export type PropArt = (typeof PROP_ART)[number];
