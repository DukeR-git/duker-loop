# duker-loop

A [pi](https://github.com/badlogic/pi-mono) extension that turns a project roadmap into
committed, tested code — one step at a time, with a fixed cast of single-purpose agents and a
deterministic control loop that you can stop, inspect, and resume at any point.

```
Full_Plan.md ─► orchestrator ─► planner ─► implementer ─► tester ─► reviewer ─► reporter
                                   ▲                                              │
                                   └──────── FAIL: FIXING_PLAN.md (≤ 3 rounds) ────┘
                                                                          PASS ▼
                                          state-updater ─► clean temp files ─► git commit
```

The loop itself is code, not a prompt. An LLM child is spawned for each box above, in its own
`pi` process with its own system prompt, tool allowlist, thinking level, and a guard that limits
which files it may write. Everything the agents exchange goes through six markdown files in the
project root, so you can read exactly what was planned, what broke, and why a step passed.

Built for and tested against a local model (Qwen3.8-27B via llama.cpp); the strict output
contracts and code-side cross-checks exist because small models drift.

## Requirements

- pi ≥ 0.85 with at least one working model.
- git on `PATH` (optional but recommended: per-step commits, diff-based review, dirty-tree protection).
- Linux/macOS. Windows-native is untested (the child runtime relies on POSIX signals).
- For `npm test`: Node ≥ 22.6 (uses `--experimental-strip-types`), no dependencies.

## Install

```bash
pi install git:github.com/DukeR-git/duker-loop      # or: pi install /path/to/duker-loop
```

A local-path install is a link, so edits are live after `/reload`. `pi list` shows it,
`pi remove <source>` uninstalls. Then `/duker agents` in pi should list the seven agents.

## Usage

Write a `Full_Plan.md` in the project root: free-form markdown with **numbered items** (e.g.
`1.1`, `1.2`) grouped into phases, each item saying what must exist when it is done. Commit it.
Then:

```
/duker            run one Full_Plan step
/duker 3          run up to three steps
/duker status     show the current step / phase / round and which artifacts exist
/duker clean      discard a half-finished step's temp files and state (code changes stay)
/duker abort      stop a running loop (the step resumes on the next run)
/duker agents     list the bundled agents and their settings
/duker run <agent> <task…>   run one agent by hand (prompt tuning, debugging)
```

The same loop is available to the model as the **`duker_loop`** tool (`{ steps?, cwd? }`):
"advance the plan by one step" makes it call the tool, block until the step passes / the plan
completes / the loop halts, and report back. Progress streams into the tool row; the children's
token usage is added to the session totals; a halt comes back as a tool error with the reason.

Flags (CLI or `settings.json`): `--duker-max-rounds 3`, `--duker-max-cost 0` (USD, 0 =
unlimited), `--duker-child-timeout 0` (minutes, 0 = per-agent frontmatter),
`--duker-allow-dirty` (start a step on a dirty tree).

### One step, in detail

| Phase | Agent | Reads | Writes |
|---|---|---|---|
| SELECT | orchestrator | `Full_Plan.md`, `Current_State.md` | — (answers `STEP:` / `TITLE:` / `DESCRIPTION:` / `REASON:`) |
| PLAN | planner | codebase, (`CURRENT_REPORT.md`, `ISSUES.md` in fix rounds) | `CURRENT_PLAN.md` or `FIXING_PLAN.md` |
| IMPLEMENT | implementer | the plan file | codebase; `[NOTE]`/`[FIXED]` entries in `ISSUES.md` |
| TEST | tester | the plan file, project test commands | tests; `[OPEN] (tester)` entries |
| REVIEW | reviewer | `git diff <head at step start>` | `[OPEN]`/`[NOTE] (reviewer)` entries |
| REPORT | reporter | `ISSUES.md` | `CURRENT_REPORT.md` with `VERDICT: PASS\|FAIL` on line 1 |
| PERSIST | state-updater | plan, report, code | `- [DONE] <id> — <title> (<date>)` in `Current_State.md` + prose |
| CLEAN, COMMIT | code | — | deletes the four temp files; `git commit -m "duker(<id>): <title>"` |

Code, not an LLM, decides what happens next: `VERDICT: FAIL` (or a missing verdict, or a `PASS`
while `[OPEN]` entries remain) starts a corrective round; after `--duker-max-rounds` the loop
halts and leaves every artifact and all code changes in place. A child that crashes, times out,
or ends with an error halts the loop at that phase. State lives in `.duker/state.json`, so the
next `/duker` resumes exactly where it stopped; `/duker clean` discards the step instead.

Raw JSONL event logs for every child run land in `.duker/runs/<run id>/`. `.duker/` is added to
`.git/info/exclude` automatically.

### What it does to your machine

- Spawns `pi --mode json -p --no-session …` child processes in the project directory, one per
  phase. Children run with `--no-extensions --no-skills` plus only what an agent file lists, so
  other installed packages do not leak into them.
- Modifies files in the project, runs its build/tests (via the tester), and commits after a step
  passes. It never pushes.
- Each child loads a **guard extension** that blocks `edit`/`write` outside the agent's path
  allowlist, blocks shell redirections/`tee` to disallowed paths, and blocks git commands that
  touch the index or history plus `rm -rf`. It is a seatbelt, not a sandbox: a child's `bash`
  can still run `rm file`, `sed -i`, or an interpreter that writes files. Run it on projects you
  have under version control.

## Agents

Defined in `agents/*.md` — YAML frontmatter plus the agent's system prompt (appended to pi's
default prompt). Edit them to fit your model; `/duker run <agent> <task>` is the quickest way to
try a change.

| field | meaning |
|---|---|
| `name`, `description` | required; `name` must equal the file name |
| `model` | `provider/id`; unset → inherit the session model |
| `thinking` | `off\|minimal\|low\|medium\|high\|xhigh\|max`; unset → inherit |
| `tools` | allowlist passed as `--tools`; unset → pi defaults |
| `timeoutMinutes` | child is killed after this (default 30) |
| `contextFiles` | `false` → `--no-context-files` (no `AGENTS.md`) |
| `extensions` | `-e` sources the child gets (default none) |
| `skills` | `--skill` paths, or `all` (default none) |
| `writeAllow` / `writeDeny` | globs (relative to the project) the child's `edit`/`write`/redirects may / may not touch; `Full_Plan.md`, `.duker/`, `.git/`, `.pi/` are always denied |

The bundled defaults: orchestrator, reporter, and state-updater are cheap and narrow; the planner
and reviewer think hard; the implementer may write anything except the loop's own files; the
tester may only write `ISSUES.md` and test paths.

### Artifact contracts

Agents are told these formats; code parses them (tolerantly, but a line that does not match is
ignored or, for the verdict, treated as FAIL):

```
ISSUES.md          - [OPEN|FIXED|NOTE] (author) <file:line> — <text>
                       optional detail lines indented by two spaces
CURRENT_REPORT.md  VERDICT: PASS | VERDICT: FAIL          ← first non-empty line
Current_State.md   - [DONE] 1.3 — <title> (2026-09-13)    ← under "## Milestones"
orchestrator       STEP: <id> | NONE | BLOCKED  /  TITLE:  /  DESCRIPTION:  /  REASON:
```

## Development

```bash
npm test                    # 43 tests: parsers, guard, state, and the whole loop driven by a fake pi
npm run test:unit           # just the parsers/guard/state tests
npm run typecheck           # needs the pi packages resolvable (e.g. a node_modules with them)
npm run typecheck:container # inside a container with pi installed globally and typescript/@types/node under ~/.npm-global
```

The integration tests never call an LLM: `test/support/fake-pi.mjs` stands in for the `pi`
binary (`DUKER_PI_BIN` may point at any `.mjs`/executable) and a loader hook stubs the pi
packages, so the suite runs on a machine without pi.

Design record and decision log: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
Original workflow sketches: [docs/workflow.md](docs/workflow.md),
[docs/Agent_Infrastructure.md](docs/Agent_Infrastructure.md).

## Known limitations

- The guard cannot see writes made by interpreters or `rm`/`sed -i` inside `bash`.
- Only one loop per pi session; steps within a run are sequential (the tester and reviewer run
  one after the other by design — a single local model gains nothing from parallelism).
- When the loop halts or is aborted, the tool must throw (pi's error contract), so that call's
  child token usage is not recorded on the tool result; it is still in `.duker/runs/*/summary.json`.
- Timing on a 27B local model: a clean step takes about 5 minutes, one with a fix round about 20.
