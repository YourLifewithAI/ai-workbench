# RUN-nn handoff — <name>

**Branch:** `run/nn-<name>` · **Head:** `<sha>` · **Status:** awaiting verification

## Built
- `<path>` — what and why (one line each)

## Not built (deliberate)
- item — reason

## Deviations from the brief
- what changed and why (or "none")

## Verification transcript
```
$ npm run check
<first lines + final result>
$ npm run dod -- nn
<first lines + final result>
$ <each DoD command from the brief>
<first lines of output>
```

## SEC tests added
- SEC-nn → `tests/security/<file>.test.ts`

## Spec amendments made
- `spec/<doc>.md` §<section> — one line

## Known gaps
- `<file>:<line>` — what

## Notes for the next run
- where things live, gotchas, decisions taken that RUN-(nn+1) should know

## Human verification script
1. Open <screen>, do <thing>, expect <result>.
2. …
