# What the first owner-run verification asked for

Findings from the weekend run of `docs/verification-weekend.md`, in the owner's words where they
were his. The bug it found is fixed (D-70). These are the rest: three build items and one open
question. None of them are defects — they are the difference between software that works and
software that can be lived in.

## N-1 — Agents are edited on a screen

> "I will not edit the agents on disk. Finding the folders and the files will end up being a hard
> pass for me. However, there should be a way to edit the agents from within the app. This part is
> important. I want to interface only with the app itself and not with files and code in the
> background."

Workflows became forms in RUN-13 (D-62) and project spaces in RUN-18 (D-69). Agents did not, and
they are the thing the owner touches most: instructions, model policy, documents, memory scopes,
budgets, output destination. Everything an agent file holds is already a typed schema, so the form
is derivable rather than invented.

The rules the other two established carry over unchanged: hash-pinned saves so a file that moved
underneath is refused with a diff rather than overwritten; the file stays the source of truth and
stays readable, for copying between machines and for the eye; and **`permissions.tools` is not
editable here** — a grant is given on Tools and nowhere else (D-26, D-34, SEC-08). An agent editor
that could grant its own permissions would undo the one rule the whole security floor rests on.

Scope: create, edit, duplicate, delete. Instructions in a plain text area, not a JSON blob. The
version hash and its change visible on save, because that is what makes a run reproducible.

## N-2 — The terminal is optional, then absent

> "The goal is to program this in such a way that I will no longer need to use terminal at all."

Four checklist items were terminal-only and every one of them has a screen it belongs on:
`export project` (Library), `approvals list` and `tools grants` (Tools), `projects show` /
`projects space` (already on Library, so only the export is missing), `spend` (Dashboard, which
shows the meters but not the by-model and by-subject breakdown), `doctor` (Settings — a *What is
wrong* panel that says what the CLI says).

The CLI does not go away: it is how a machine drives the workbench, and how this repository's own
gates run. What goes away is any *need* for a person to open a terminal to see or do something the
app already knows. The test is the one the owner set: a fresh install, a key pasted on a screen, and
every item in section 1 of the verification list reachable without a shell.

The exception, and it should be written down as one: `npm run contract -- --live` tests the app from
outside the app, so it cannot live inside it.

## N-3 — What the mock can and cannot say

Two checklist items misled because the mock's shape was not on the screen. Running an agent on the
mock returns the fixture's answer, not an answer to what you typed — correct, and surprising the
first time:

> "Pass but it didn't respond to my prompt, just the pre-suggested prompt. I'm assuming that's
> because I selected the mock agent."

The run form says *Use the mock provider (free, no key)*. It should also say what that means: the
reply comes from a fixture, so it will not answer your text. One sentence under the checkbox, and
the same sentence on the run page of any run that used the mock.

## Open question — an instruction inside the content

> "When I put in the prompt with two spaces between each word, the output came out slowly. However,
> I can see this getting confusing for agents on the output side to distinguish between a story
> prompt or action prompt vs. a 'type/method/quality' of an action. This is interesting, though, and
> I think it'll be worth exploring in more detail at some point."

The observation is sharper than the mock fixture that prompted it. A task carries two kinds of text
at once: **what to work on** and **how to work on it**. "Write a slow, sad scene" names a quality of
the output; "reply slowly" names a quality of the act. Today both arrive as one user message and the
model separates them by reading, which means it can get it wrong in either direction — treating
subject matter as an instruction, or an instruction as subject matter.

This is the benign face of the problem the security floor already takes seriously in its malicious
form: SEC-14 and D-69's goals rule exist because text that arrives as *content* must not be able to
act as *instruction*. The same boundary, drawn for safety, is the one that would make this legible
for craft.

Not a run yet, because the answer is not obvious and a wrong answer here is worse than none. Three
shapes worth thinking about, none of them chosen:

1. **Two fields.** The run form separates *the work* from *how to do it*, and they compile into
   different prompt sections. Honest, and it makes the distinction the owner noticed into structure.
   Costs a simple form its simplicity.
2. **One field, fenced.** The task stays one box; the harness fences it as content and any directive
   about the act lives in the agent's own instructions, where it is versioned and reviewable.
   Consistent with D-69's trust rule. Costs the ability to say "and be brief about it" in passing.
3. **Nothing.** Models are good at this and the ambiguity is the user's to resolve in their own
   words. Costs nothing until it is wrong, and when it is wrong it is confusing rather than harmful.

Worth exploring with real prompts on a real model before deciding — which is exactly what Evaluate
and Compare were built for, and would be a good first real use of them.
