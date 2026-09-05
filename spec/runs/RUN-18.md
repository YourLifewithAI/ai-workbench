# RUN-18 — Project spaces

**Goal.** A project carries its own agents, tools, memory and goals, so switching projects switches the whole bench (D-69). The owner's vision, stated at the start: "a space for me — project, agent, memory scope, within budget."

**Reads.** `artifacts-and-memory.md` §Projects and §Memory, `agents-and-prompts.md` (the prompt's sections and their order), `tools-and-security.md` (grants, the broker, `maxPermissions`), `ui.md` (Library, the run forms, the F6 amendment), D-16, D-17, D-29, D-34, D-63, D-68, D-69, `runlog/RUN-14.md` (the review reads grants), `runlog/RUN-13.md` (forms over JSON, hash-pinned saves).

**Why now.** Every earlier run made a project a folder the Library shows and a target a run names. F6 made one project the owner's by convention: an agent that reads a page in it, a memory scope chosen in the agent's instructions. That convention is the shape of the feature; this run makes it a thing the workbench knows. Last on the finish list because it is the largest and the one most worth the owner's eye before it starts.

**Scope.**
- **`project.json`** in `projects/<slug>/`, optional, schema-versioned, read at start and on save:
  ```jsonc
  { "schemaVersion": 1, "name": "Anthology", "description": "…",
    "goals": "goals.md",                       // a document in this project, read into every prompt of a run here
    "agents": ["weaver", "cutter"],            // the project's agents: first on its run forms, listed on its page
    "tools": ["artifact.write", "memory.remember", "memory.search"],   // a ceiling: what any agent may use here
    "memory": ["agent", "project", "user"] }   // the scopes retrieved for a run here (default: all four)
  ```
  A project without the file is what it was: a folder, a row, a target. A file that does not parse is a load error the Library shows, like a broken agent, never a silent default.
- **Goals in every prompt.** When a run names a project with `goals`, the document is rendered as an instruction section named `goals` after the agent's own sections and before the harness (it is the owner's word, in the owner's workspace: trusted, like an agent's instructions). It is in the trace and covered by the compiled prompt, not by `promptVersion` (that hashes the agent). A missing goals document is a warning in the trace and the run goes on.
- **The tool ceiling.** The broker decides as today, then applies the project's `tools` list: a tool outside it is refused with `PermissionDenied` naming the project ("not allowed in project anthology"), and the refusal shows in the trace and on Tools → *Refused*. The ceiling can only narrow: it never grants, never lifts an approval, never widens `maxPermissions` (SEC-38). A project with no `tools` key has no ceiling.
- **Memory scopes per project.** `scopesFor(agent, project)` keeps its order and drops the scopes the project does not list; `memory.remember` into a scope the project does not list is refused by name. The `memory-retrieved` event already records the scopes, so the trace shows the narrowing.
- **The run forms.** With a project chosen, an agent run form's agent picker and a workflow's *Run it* list the project's agents first under a *This project's* group, the rest under *Others*; the estimate (F2) is unchanged. The Library's project page gets a **Space** card: goals (which document), agents, the tool ceiling, memory scopes — a form, not the JSON (D-62 applies here as it did to workflows: hash-pinned save, a conflict panel when the file changed underneath). `workbench projects show <slug>` prints the space; `workbench projects space <slug> --agents … --tools … --memory … --goals …` sets it.
- **The permissions review reads it.** `permissions.facts` gains a `projects` list (slug, agents, tool ceiling, memory scopes), and a new candidate kind `reach`: an agent granted a tool that no project it is an agent of allows — the grant is real but nowhere usable, which is either a stale grant or a missing ceiling entry. The auditor proposes as today; applying a `reach` proposal narrows the grant, never the ceiling (a ceiling is the owner's, edited on the Library).
- **Shipped examples.** `projects/anthology/project.json` (agents: architect, weaver, cutter; goals: `bible.md`; tools: the two memory tools and `artifact.write`), `projects/companion/project.json` (agents: companion; goals: `about.md`; memory: agent, user, project — no workspace), the others untouched. F6's companion loses nothing: `about.md` stays in `documents` for the agent and becomes the project's goals as well, which is the same text once in the prompt, not twice (a document named in both places is injected once, as goals).

**Do not.**
- Do not let a project grant anything: no `tools` entry may turn a `deny` or an unset into an `allow`, lift an approval, or add a path, host or credential (SEC-38).
- Do not make projects nest, inherit, or import from each other. One file, one folder.
- Do not add budgets to a project in this run. Per-agent caps exist (F6); per-project caps are a later amendment to D-20 if the owner wants them, and the spend view already reports by subject.
- Do not read goals as data. Fencing the owner's own goals as "content, not instructions" would make them advice; they are instructions.

**Definition of done** (`npm run dod -- 18`).
1. A run in `anthology` has a `goals` section in its compiled prompt with `bible.md`'s text, after the agent's sections; the same run in a project without goals has none; a project naming a goals document that does not exist warns in the trace and completes.
2. A tool the agent holds but the project's ceiling omits is refused by name in the trace, and the same call in a project with no ceiling succeeds; the refusal appears on Tools → *Refused*.
3. `memory.remember` to a scope the project does not list is refused; retrieval for a run in that project lists only the project's scopes in `memory-retrieved`.
4. `PUT /projects/:slug/space` with a stale hash is a 409 with the current version; a good save writes `project.json` and the next run sees it without a restart.
5. `permissions.facts` lists the projects, and a grant no project allows produces a `reach` candidate that the mock auditor raises and a person applies from Review.
6. e2e: the Library's project page shows and saves the Space form; the agent run form with `?project=anthology` lists the project's agents first; axe clean on both.

**SEC.** New row **SEC-38**: a project ceiling never widens — for every (agent, tool, project) the decision with the ceiling is at most as permissive as without it, checked by property over the shipped grants and a fuzzed set; a `tools` list containing a tool the agent has no grant for changes nothing. `tests/security/sec-38-project-ceiling.test.ts`.

**Human verification.** Give the companion project a goal ("ship RUN-19 by Friday") on its Library page, run the companion, and read the compiled prompt in the trace: the goal is there, after the companion's sections. Then take `memory.search` out of the companion project's ceiling, run it again, and watch the refusal name the project.
