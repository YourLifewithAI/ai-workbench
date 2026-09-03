# Contributing

## The shape of a change

The specification in `spec/` is the source of truth, and the code follows it. If a change means the spec was
wrong, amend the spec in the same change — the amendment format is `> Amendment (RUN-nn, date): …`, and there
are plenty of examples. A change that quietly contradicts the spec is a bug in both.

Before anything is proposed:

```sh
npm run check      # typecheck, lint, unit, security, contract, secret scan
npm run e2e        # the browser suite, with an axe scan on every screen
npm run dod -- nn  # the definition-of-done suite for the run you are touching
```

The security tests in `tests/security/` are permanent. A change that makes one fail is a change to the security
floor, and needs to say so in words before it needs to say so in code.

## Adding a model provider

The on-ramp is the contract suite. An adapter is one file that implements `ModelAdapter` — `generate` and
`stream` — and the suite is what says whether it works:

```sh
npm run contract                    # every adapter, against recorded fixtures
npm run contract -- --live google   # against the real API, with a key present
```

The recorded fixtures are HTTP-level, so the suite exercises your adapter through the real SDK rather than
through a mock of it. `tests/contract/` has the cases: text, streaming, tool calls, structured output, refusals,
cancellation mid-stream, and the errors each provider actually returns. Record new fixtures with the recorder in
`tests/contract/recorder.ts`; request headers are never recorded, which is how credentials stay out of them.

An adapter that passes the suite works with everything else — fallbacks, budgets, the egress checker, the trace
— because none of those know which adapter they are talking to.

## Adding a tool

A tool is a `ToolDefinition`: an id, a description the model reads, Zod schemas in and out, a tier, and the most
it could ever be granted. It receives `ctx.fs` and `ctx.net` and uses nothing else — no `node:fs`, no `fetch` —
because those handles are where the policy lives. Lint enforces it.

Tiers are `read`, `write` and `execute`. `execute` exists only when the sandbox does.

## Plugins

A plugin is trusted code with the runtime's authority. If what you are building can be a tool, an MCP server, or
a script for `code.execute`, build that instead: all three are contained and a plugin is not. When a plugin is
genuinely the answer, `spec/tools-and-security.md` §Plugins is the contract, and the human who installs it will
be shown the words "this code runs with full access" before it loads.

## Style

The code is written to be read by someone who was not there. Comments explain why, not what — especially where
the obvious approach was wrong and this one is not. Error messages name what happened, what it means, and what
the person can do; a message a user cannot act on is a defect. Anything a person will read gets the same care as
anything a model will.
