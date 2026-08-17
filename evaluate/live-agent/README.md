# Live-agent A/B — does the graph beat file tools for a real agent?

This is the comparison `evaluate/README.md` says the rest of the harness cannot make:

> The current harness does **not** compare an agent with the graph against the same agent using
> only Read/Grep/Glob. Therefore these results do not support an end-to-end graph-vs-no-graph
> token-savings claim.

Two arms, one subject repository, one model, identical prompts. Everything else is held fixed.

| arm | tools offered |
|---|---|
| `files` | `Read`, `Grep`, `Glob` |
| `graph` | `Read`, `Grep`, `Glob` **+** `Bash`, confined to the graph CLI |

**`graph` keeps the file tools on purpose.** An arm with the graph and nothing else cannot
measure fallback: a zero there is zero by construction. Offering both is the only configuration
in which "did it reach for Grep?" is a real question.

## Running it

```bash
npm run build                       # the harness runs against dist/cli.js

node evaluate/live-agent/runner.mjs \
  --label pm-mex-1 --arms files,graph --repeats 3 \
  --model claude-opus-5 --effort high \
  --index-snapshot <path>/graph.db

node evaluate/live-agent/report.mjs --label pm-mex-1
```

`--dry-run` prints the exact agent invocation per arm and exits without spending anything.
`--resume` skips run ids already on disk. `--only <taskId>` runs one task.

Test the whole pipeline with no model and no cost:

```bash
FAKE_MODE=correct-graph node evaluate/live-agent/runner.mjs --label smoke \
  --claude evaluate/live-agent/test/fake-claude.mjs --repeats 1 \
  --only pm2-nl-1-loginratelimiter --index-snapshot <path>/graph.db
```

`FAKE_MODE` also takes `correct-files`, `wrong`, `blocked-shell`, `violate-shell`,
`violate-sqlite`. `blocked-shell` must stay **valid** (one counted attempt); the two `violate-`
modes must come back **INVALID**. That is how the policy check is itself tested.

## The five decisions this harness makes, and why

**1. The graph arm gets a tool preamble; the file arm does not need one.** `Read`/`Grep`/`Glob`
are built in and self-describing. A CLI is not: an agent handed `Bash` with no idea what to run
has not been offered the graph at all. So the preamble lists the commands and their syntax — the
CLI's equivalent of a built-in tool's own description — and nothing more. It does **not** mandate
an order, does not say when to fall back, and does not describe what the graph is good at.
Anything past capability and syntax is prompt engineering and belongs in a separate arm.

**2. Bash is confined to a wrapper — and three different things are kept apart.** The
`--allowedTools` prefix rule stops the agent shelling out to `grep`; `policy.mjs` re-derives the
same check from the transcript. But a refused command and an executed one mean opposite things,
so they are never merged:

| behaviour | verdict | why |
|---|---|---|
| falls back to the `Read`/`Grep`/`Glob` **tools** | permitted, counted | this is ordinary fallback and the headline number |
| tries a **shell** command, is refused | **valid**, counted as `shellEscapeAttempts` | the guard worked. The attempt is real agent behaviour and is exactly what happens in the wild — it is reported, with the commands it tried |
| a non-graph shell command actually **executes** | **INVALID** | the allowlist leaked, and this arm just got a search tool the control arm never had |

Without the third rule the graph arm has a shell the control arm does not, and every efficiency
number is meaningless. Without the second, a genuine behavioural signal gets thrown away as if
it were an error.

**3. The agent's shell sits in a neutral directory.** The subject repository ships its own
`CLAUDE.md`, `AGENTS.md` and marketplace plugins; letting those load is both contamination and a
network dependency. `--safe-mode`, `--setting-sources ""` and `--disable-slash-commands` handle
the rest. The cost is that the graph CLI can no longer find `.mex/graph.db` by walking up from
the cwd — which is what `mexg.mjs` exists to fix. It chdirs to the subject root and forwards argv
unchanged: no added flags, no filtered output.

*The known asymmetry, recorded rather than hidden:* a neutral cwd means `Grep`/`Glob` do not
default to the subject repo, so the prompt states the root explicitly. Both arms carry the same
sentence.

**4. The index is swapped for a pinned snapshot and restored afterwards.** Opening an older
index migrates it in place. An unguarded run would silently mutate the thing every earlier
measurement was taken against. The guard checksums before and after, and restores in a `finally`.

**5. Grading is arm-neutral.** NL answers on `(filePath, symbolName)`, multi-hop on bare
neighbour names — never on a graph node id, which only one arm is ever handed.

## What gets recorded, per session

Correctness (file / symbol / both), turns, wall time, cost, tool-call census by name, graph
calls split by subcommand, file-tool calls, the fallback pattern
(`graph-only` / `graph-then-files` / `files-only` / `neither`), blocked shell-escape attempts
with the commands attempted, token usage split into input /
output / cache-read / cache-write, **per-tool payload characters** (how much text each tool
pushed into the context window), the rank of the expected symbol in the first `graph scope`
result, plus policy violations, permission denials, timeouts and API errors.

The payload census is the one a simpler harness omits. Turns and call counts both flatter a tool
that returns a lot per call; only the returned bytes show what a call actually costs, because
every tool result is a cache write on arrival and is re-read on every turn that follows.

## Reading the output honestly

- **A null needs its resolution.** §7 of the report gives the rank of the target in the first
  retrieval, so "the agent got it wrong" can be separated from "the graph never surfaced it".
- **Correctness may not discriminate.** If both arms answer everything, the run has measured
  efficiency only — say that, rather than reporting a tie as a win.
- **There is no blind arm here.** Contamination — a model naming the symbol with no repository
  access — was measured separately on this fixture and came back 0/10. If the fixture, corpus or
  model changes, that control has to be re-run before correctness means anything.
