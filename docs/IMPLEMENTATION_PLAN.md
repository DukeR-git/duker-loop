# duker-loop — Implementation Plan

Standalone pi extension that drives the step-by-step delivery loop described in
`workflow.md` and `Agent_Infrastructure.md` (this folder), built per `Create_Ext.md` (approach A, subprocess
children). This document records every decision made so far, the architecture, the file
layout, the contracts between agents, and the build/verification order.

---

## 0. Decision record

| # | Topic | Decision |
|---|---|---|
| 1 | Foundation | Standalone extension. `pi-subagents` stays installed but is not used. |
| 2 | Child runtime | Subprocess: `pi --mode json -p --no-session …` per child (approach A). |
| 3 | Orchestrator | Deterministic code loop. An LLM child (`orchestrator` agent) is used only to extract the next step from `Full_Plan.md` and check dependencies against `Current_State.md`. |
| 4 | Run scope | `/duker [n]` / `duker_loop({ steps })` runs N Full_Plan steps, default 1. |
| 5 | Tester/Reviewer | Sequential: Tester, then Reviewer (single llama.cpp backend). |
| 6 | Verdict | Reporter agent writes `CURRENT_REPORT.md`; first non-empty line must be `VERDICT: PASS` or `VERDICT: FAIL`. Missing/garbled ⇒ FAIL. |
| 7 | Loop bound | Max 3 corrective rounds per step (flag `--duker-max-rounds`). |
| 8 | On give-up | Halt. Keep artifacts and code changes. Notify. |
| 9 | Artifacts | Fixed names in project root: `Full_Plan.md`, `Current_State.md`, `CURRENT_PLAN.md`, `FIXING_PLAN.md`, `ISSUES.md`, `CURRENT_REPORT.md`. Extension-internal state/logs in `<cwd>/.duker/`. |
| 10 | Agent files | Bundled in the extension: `agents/*.md`. |
| 11 | Write guard | Child-side guard extension (`child/guard.ts`) loaded via `-e`; blocks `edit`/`write` outside a per-agent path allowlist passed through env. |
| 12 | Child resources | Per-agent frontmatter lists (`extensions`, `skills`, `contextFiles`). Default = nothing extra. Children run `--no-extensions --no-skills` plus explicit `-e` / `--skill` for what is listed. |
| 13 | Git | Auto-commit after a step passes (`duker(<id>): <title>`). Never push. |
| 14 | Supervision | Fully autonomous; status line + notifications; Esc / `/duker abort` aborts. |
| 15 | Resume | Resume from `.duker/state.json` + artifacts on disk. |
| 16 | Models | Per-agent `model` and `thinking` in frontmatter; unset ⇒ inherit parent session. |
| 17 | Cleaner | Code (deletes temp files). Orchestrator = small LLM child with strict output format. |
| 18 | Dev setup | Develop the package on the host; bind-mount it into the pi container; `pi install` for the final form, settings `extensions` path + `/reload` during development. |
| 19 | Naming | Extension `duker-loop`, command `/duker`, tool `duker_loop`, status key `duker`. |
| 20 | Implementer scope | Stays within the plan; logs out-of-scope findings to `ISSUES.md` as `[NOTE]`. |
| 21 | Tester | Runs tests/build/lint; may add tests for the step's scope (write allowlist: `ISSUES.md` + test paths). |
| 22 | Limits | Frontmatter `timeoutMinutes` (default 30) per agent; global `--duker-max-cost` (default unlimited). |
| 23 | Child logs | Ephemeral child sessions; raw JSONL event stream saved to `.duker/runs/<runId>/<n>-<agent>.jsonl`. |
| 24 | Full_Plan.md | Free-form markdown with numbered items (a phased roadmap); orchestrator agent interprets it. |
| 25 | ISSUES.md | Strict one-line entries: `- [OPEN\|FIXED\|NOTE] (tester\|reviewer\|implementer) <file:line> — <text>`; details indented below. |
| 26 | Tool mode | `duker_loop` blocks the parent turn; same code path as `/duker`; progress via `onUpdate`. |
| 27 | Bash guard | Guard regex-blocks `git commit\|push\|reset\|checkout\|clean\|stash\|rebase` and `rm -rf` in every child's `bash`. |
| 28 | Dirty tree | Refuse to start on a dirty git tree unless `--duker-allow-dirty`. Resuming an in-progress step is exempt. |
| 29 | Reviewer scope | The step's diff: `git diff <headAtStepStart>`; fallback to files named in the plan when not a git repo. |
| 30 | Blocked step | Orchestrator skips ahead within the same phase to an item whose dependencies are met; if none, returns `BLOCKED` and the loop halts. |
| 31 | Snapshot | `git rev-parse HEAD` recorded in state at SELECT. No `/duker revert` in v1. |
| 32 | Milestone line | `- [DONE] 1.3 — Deliverable Routing (2026-09-13)`; sha lives only in the commit message. |

No open decisions remain; §11 lists things that must be verified inside the container.

---

## 1. Architecture overview

```
 parent pi session (TUI, local model)
 │
 ├─ /duker [n]  ──┐
 └─ duker_loop{} ─┴─► runLoop(opts, sink)            extensions/duker-loop/loop.ts
                        │  for step in 1..n:
                        │    SELECT ─► PLAN ─► IMPLEMENT ─► TEST ─► REVIEW ─► REPORT
                        │                ▲                                     │
                        │                └──── FAIL, round < max  (FIXING_PLAN) ┘
                        │                                             PASS ▼
                        │                              PERSIST ─► CLEAN ─► COMMIT
                        │
                        └─► runChild(agent, task, env)  extensions/duker-loop/runtime.ts
                               spawn: pi --mode json -p --no-session
                                        --no-extensions -e child/guard.ts [-e …listed]
                                        --no-skills [--skill …listed] [--no-context-files]
                                        [--model …] [--thinking …] --tools …
                                        --append-system-prompt <tmpfile>
                                        "<task prompt>"
                               env: DUKER_AGENT, DUKER_WRITE_ALLOW, DUKER_WRITE_DENY,
                                    DUKER_DEPTH=1, DUKER_RUN_ID
```

Three layers, deliberately separate:

1. **Child runtime** (`runtime.ts`) — spawns one `pi` process, parses the JSONL stream, enforces timeout/abort, writes the raw log, returns a `ChildResult`.
2. **Loop** (`loop.ts`) — the state machine above. Pure orchestration: decides which agent to run next, builds the task prompt, checks output contracts, persists `.duker/state.json` after every phase.
3. **Surface** (`index.ts`, `render.ts`) — command, tool, flags, status line, rendering, session lifecycle (kill children on shutdown).

---

## 2. Package / file layout

```
duker-loop/                (pi package root)
├── package.json            keywords:["pi-package"], "pi": { "extensions": ["./extensions"] }
│                           peerDependencies: @earendil-works/pi-coding-agent, pi-ai,
│                           pi-agent-core, pi-tui, typebox (all "*")
├── tsconfig.json           portable type-check config (module esnext, moduleResolution bundler, strict)
├── tsconfig.container.json extends it with `paths` into a global pi install (/usr/local/lib/node_modules)
├── README.md               user-facing documentation
├── docs/
│   ├── IMPLEMENTATION_PLAN.md   this file
│   └── workflow.md / Agent_Infrastructure.md / Create_Ext.md   (design sources, unchanged)
│
├── extensions/
│   └── duker-loop/
│       ├── index.ts        default export: flags, entry renderer, /duker command, run registry
│       ├── tool.ts         duker_loop tool (execute + onUpdate + usage), same loop as the command
│       ├── types.ts        AgentConfig, LoopState, Phase, parsed-artifact shapes, constants
│       ├── agents.ts       load bundled agents/*.md, parseFrontmatter, validate schema
│       ├── artifacts.ts    fixed paths, read/write/delete helpers, ISSUES.md parser,
│       │                   VERDICT parser, orchestrator-output parser, milestones
│       ├── runtime.ts      getPiInvocation, spawn, JSONL parsing, timeout, abort, log writer
│       ├── prompts.ts      task-prompt builders per phase (what goes into the positional arg)
│       ├── loop.ts         runLoop(): state machine, resume, rounds, halt, cleaner, commit
│       ├── state.ts        .duker/state.json load/save/clear (atomic write)
│       ├── git.ts          isGitRepo, isDirty, ensureExcluded(".duker/"), commitAll
│       └── render.ts       formatters, renderCall / renderResult
│
├── child/
│   └── guard.ts            child-side extension (NOT under extensions/ → never auto-loaded
│                           in the parent). Loaded in children via -e.
│
├── test/
│   ├── unit/               parsers, state file, guard (no pi imports)
│   ├── integration/        runLoop scenarios and the tool/command surface, driven by a fake pi
│   └── support/            stub loader for the pi packages, fake-pi.mjs, project helpers
│
└── agents/
    ├── orchestrator.md
    ├── planner.md
    ├── implementer.md
    ├── tester.md
    ├── reviewer.md
    ├── reporter.md
    └── state-updater.md
```

Why `child/guard.ts` is outside `extensions/`: the package manifest points pi at `./extensions`
only, so the guard is never loaded into the parent session; children get it explicitly via
`-e <abs path>` (the extension computes its own directory from `import.meta.url`).

### Container wiring (docker compose)

```yaml
volumes:
  - ./workspace:/workspace
  - ./pi-data:/home/<user>/.pi/agent
  - ../duker-loop:/opt/duker-loop      # new
```

- Development: add `"extensions": ["/opt/duker-loop/extensions/duker-loop"]` to
  `pi-data/settings.json`; edit on the host, `/reload` in the container.
- Final form: `pi install /opt/duker-loop` inside the container (then remove the settings
  path to avoid double-loading). Verify whether `pi install <local path>` copies or links; if
  it copies, `pi update` after edits.
- Type-check inside the container (the host has no `@earendil-works/pi-coding-agent`):
  `cd /opt/duker-loop && npx tsc --noEmit` with `paths` mapping the peer packages to
  `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/...` (exact
  paths to be confirmed on first run).

---

## 3. Artifacts and their contracts

All in `<cwd>` (project root). Names are fixed.

| File | Owner (writes) | Lifetime | Contract |
|---|---|---|---|
| `Full_Plan.md` | human | permanent, read-only for the loop | free-form markdown, numbered items (e.g. `1.1`, `1.2`) |
| `Current_State.md` | state-updater | permanent, append-only | milestones section: `- [DONE] <step id> — <title> (<date>, commit <sha>)` + prose |
| `CURRENT_PLAN.md` | planner (initial) | per step | sections: `# Step <id> — <title>`, `## Goal`, `## Changes` (ordered, file paths), `## Verification` (commands to run, tests to add), `## Out of scope` |
| `FIXING_PLAN.md` | planner (fix round) | per round | `# Fix round <n> for step <id>`, `## Issues addressed` (copies the `[OPEN]` lines), `## Changes`, `## Verification` |
| `ISSUES.md` | implementer, tester, reviewer | per step | header `# Issues — step <id>`; entries `- [OPEN|FIXED|NOTE] (author) <file:line> — <text>` with optional indented detail lines. Created by code (empty with header) before the implementer runs so appends are uniform. |
| `CURRENT_REPORT.md` | reporter | per round | line 1: `VERDICT: PASS` or `VERDICT: FAIL`; then `## Summary`, `## Open issues` (verbatim OPEN lines), `## Notes` |
| `.duker/state.json` | code | per step | see §6 |
| `.duker/runs/<runId>/<n>-<agent>.jsonl` | code | permanent | raw JSON event stream of each child |
| `.duker/runs/<runId>/summary.json` | code | permanent | phases, durations, usage, outcome |

Parsers in `artifacts.ts`:

- `parseVerdict(text)` → `"PASS" | "FAIL"` — first non-empty line, case-insensitive, tolerant
  of `**VERDICT: PASS**`; anything else ⇒ `FAIL` with reason "no verdict line".
- `parseIssues(text)` → `{ open, fixed, notes }` counts + entries (used for status line, resume
  sanity checks, and as a cross-check: if Reporter says PASS but OPEN entries remain, treat as
  FAIL and log a warning — the Reporter is a 27B model).
- `parseOrchestratorOutput(text)` → `{ step: id | "NONE" | "BLOCKED", title, description, reason }`.

---

## 4. Agent definitions (`agents/*.md`)

### 4.1 Frontmatter schema (validated in `agents.ts`; one bad file must not break the others)

```yaml
name: implementer                 # required, must equal the file name
description: …                    # required
model: local/some-model              # optional; unset ⇒ parent model
thinking: medium                  # optional; unset ⇒ parent level (only when model also unset)
tools: read, bash, edit, write    # optional; comma string or YAML list; unset ⇒ pi defaults
timeoutMinutes: 30                # optional, default 30
contextFiles: true                # optional, default true (AGENTS.md); false ⇒ --no-context-files
extensions: [npm:pi-mcp-adapter]  # optional; each becomes -e <source>; default none
skills: []                        # optional; paths → --skill; "all" ⇒ omit --no-skills; default none
writeAllow: ["ISSUES.md", "tests/**"]   # optional; globs relative to cwd for edit/write; default = everything
writeDeny: ["Full_Plan.md", "Current_State.md", ".duker/**"]  # optional; always merged with global deny
```

Body = system prompt, appended to pi's default system prompt (`--append-system-prompt <tmpfile>`).

### 4.2 The seven agents

| Agent | Tools | thinking | writeAllow | Task prompt receives | Output contract |
|---|---|---|---|---|---|
| orchestrator | read, grep, find, ls | low | (none — read-only) | nothing extra; told to read `Full_Plan.md` + `Current_State.md`; rule: first undone item in plan order; if its dependencies are unmet, the next item *in the same phase* whose dependencies are met; else `BLOCKED` | `STEP: <id> \| NONE \| BLOCKED` / `TITLE:` / `DESCRIPTION:` (verbatim item text) / `REASON:` |
| planner | read, grep, find, ls, bash(read-only use) | high | `CURRENT_PLAN.md` or `FIXING_PLAN.md` (mode-dependent) | step id/title/description; mode `initial` or `fix` (+ told to read `CURRENT_REPORT.md`, `ISSUES.md`, previous plans) | writes the plan file; final text = one-paragraph summary |
| implementer | read, grep, find, ls, bash, edit, write | medium | everything except deny list | which plan file to execute; reminder of ISSUES.md format | modifies code; flips `[OPEN]→[FIXED]` in fix rounds; final text = changed files list |
| tester | read, grep, find, ls, bash, edit, write | low | `ISSUES.md`, test paths (`tests/**`, `test/**`, `**/*_test.*`, `**/*.test.*`, `**/*.spec.*`) | plan file name; verification section reminder | appends `[OPEN] (tester)` entries; final text = commands run + pass/fail counts |
| reviewer | read, grep, find, ls, bash | high | `ISSUES.md` | plan file name; `git diff <headAtStepStart>` as the review material (or the plan's file list when not a git repo) | appends `[OPEN] (reviewer)` entries; final text = `Verdict: BLOCK \| OK \| OK with notes` |
| reporter | read | high | `CURRENT_REPORT.md` | none | writes report with `VERDICT:` line 1 |
| state-updater | read, grep, find, ls | low | `Current_State.md` | step id, title, today's date | appends `- [DONE] <id> — <title> (<date>)` under `## Milestones` + updates prose sections describing the codebase |

`extensions`/`skills` per agent are left empty in the first version except where you decide
otherwise (e.g. `implementer: extensions: [npm:pi-mcp-adapter]` for documentation lookup).

### 4.3 Global write deny (applied to every child, cannot be overridden)

`Full_Plan.md`, `.duker/**`, `.git/**`, `.pi/**`, plus each agent's own restrictions.

---

## 5. The loop (`loop.ts`)

```
runLoop({ steps, cwd, signal, sink, flags }):
  preflight()                                   # §5.1
  for i in 1..steps:
    state = loadOrInitState()                   # §6 resume
    if state.phase == DONE_STEP: continue at SELECT
    switch-resume into the phase below

    SELECT:   headAtStepStart = git rev-parse HEAD (if repo)
              r = child(orchestrator)           # parse STEP
              NONE    → notify "Full_Plan complete", stop loop (success)
              BLOCKED → halt(reason)
              save state {stepId,title,description, headAtStepStart, round:0, phase:PLAN}
    PLAN:     ensure ISSUES.md header exists (code)
              child(planner, mode = round==0 ? initial : fix)
              assert plan file exists & non-empty, else halt("planner produced no plan")
    IMPLEMENT:child(implementer, planFile)
              warn if `git status --porcelain` shows no change (continue anyway)
    TEST:     child(tester)
    REVIEW:   child(reviewer)
    REPORT:   child(reporter)
              verdict = parseVerdict(CURRENT_REPORT.md)
              if verdict == PASS and parseIssues().open > 0 → verdict = FAIL (warn)
              FAIL: round++ ; round > maxRounds → halt("max rounds") ; else phase = PLAN
              PASS: phase = PERSIST
    PERSIST:  child(state-updater)
              assert Current_State.md changed (size/mtime), else warn
    CLEAN:    delete CURRENT_PLAN.md, FIXING_PLAN.md, ISSUES.md, CURRENT_REPORT.md
    COMMIT:   if git repo: git add -A && git commit -m "duker(<id>): <title>"
              (milestone line carries only the date; the sha is in the commit message)
    clearState(); write runs/<runId>/summary.json; sink.stepDone(...)
  return summary
```

Every phase transition: `saveState()`, `sink.progress(phase, round, agent, elapsed)`,
`ctx.ui.setStatus("duker", …)`.

Every `child(...)` call:

1. Check `signal.aborted` → throw `DukerAborted`.
2. Build env (`DUKER_*`), args, tmp prompt file (`withFileMutationQueue`, `0o600`, `finally` cleanup).
3. Run with per-agent timeout: on timeout `SIGTERM` → 5 s → `SIGKILL`, result marked `timeout`.
4. Failed child (exit ≠ 0, `stopReason` error/aborted, timeout) → `halt("<agent> failed: …")`.
   The loop does not retry a crashed child automatically (it is not a validation failure).
5. Aggregate usage into the run summary and into the tool's returned `usage`.
6. `--duker-max-cost` exceeded → halt.

### 5.1 Preflight

- `Full_Plan.md` exists, else error.
- `Current_State.md` missing → create with header `# Current State` (state-updater appends later).
- Git: if repo, ensure `.duker/` is in `.git/info/exclude`; if the tree is dirty and no step is
  in progress (no `.duker/state.json`) → error `duker: working tree is dirty; commit/stash first
  or pass --duker-allow-dirty`. Resuming a step skips this check.
- Validate all seven agent files load; error listing the broken ones otherwise.
- Resolve pi invocation (`getPiInvocation` logic from Create_Ext.md §5).
- Create `.duker/runs/<runId>/`.

### 5.2 Halt

`halt(reason)`: save state (so resume knows), write summary, `ctx.ui.notify(reason, "error")`,
and for the tool path **throw** (`isError` for the parent LLM); for the command path return
and print the reason. Artifacts and code are left untouched.

---

## 6. State & resume (`state.ts`)

`.duker/state.json`:

```json
{ "runId": "2026-09-13T10-22-05Z", "stepId": "1.3", "title": "…", "description": "…",
  "round": 1, "phase": "TEST", "startedAt": "…", "history": [ { "phase": "PLAN", "agent": "planner", "ms": 81234, "usage": {…} } ] }
```

On `/duker` start:

- No state file → fresh SELECT.
- State file present → resume at `state.phase`, after a sanity check against disk:
  - `phase ∈ {IMPLEMENT, TEST, REVIEW, REPORT}` but the plan file is missing → fall back to PLAN.
  - `phase == PERSIST/CLEAN/COMMIT` → just continue.
  - Print a one-line notice: `duker: resuming step 1.3 at TEST (round 1)`.
- `/duker clean` → delete the four temp files + state (logs untouched) — the only way to
  discard a half-done step.
- Written atomically (`tmp` + `rename`).

---

## 7. Child runtime (`runtime.ts`)

Straight from Create_Ext.md §5 with these specifics:

- Args: `--mode json -p --no-session --no-extensions -e <guard> [-e …] --no-skills [--skill …] [--no-context-files] [--model m] [--thinking t] --tools <list> --append-system-prompt <tmpfile> -- "<task>"`.
  Confirm in the container that `--no-extensions` still honours explicit `-e` (the official
  example relies on it) and that installed packages (pi-subagents, mcp-adapter) are indeed
  not loaded under `--no-extensions`. If packages still load, add `--exclude-tools subagent,…`
  as a fallback.
- Strict LF-split JSONL parsing with partial-line buffer; `message_end` for transcript/usage;
  `tool_execution_start` for the "currently running: `$ pytest`" status text.
- Every raw line is appended to `.duker/runs/<runId>/<n>-<agent>.jsonl` as it arrives.
- `ChildResult { agent, exitCode, timedOut, messages, stderr, usage, model, stopReason, errorMessage, finalText, durationMs }`.
- Registry of live processes in extension state → `session_shutdown` kills them all
  (idempotent). Also killed on abort via `signal`.
- Depth guard: children get `DUKER_DEPTH=1`; the guard extension blocks any `duker_loop`
  tool call inside a child (it should not exist there anyway since `--no-extensions`).

---

## 8. Guard extension (`child/guard.ts`)

Loaded only in children. Reads env:

- `DUKER_AGENT`, `DUKER_WRITE_ALLOW` (JSON array of globs), `DUKER_WRITE_DENY` (JSON array),
  `DUKER_CWD`.
- `pi.on("tool_call")`: for `edit`/`write` (and any tool whose args contain a `path`/`file_path`
  field), resolve the path against cwd, strip leading `@`, match with a small glob matcher
  (picomatch-style, implemented locally to avoid npm deps in the child), and
  `return { block: true, reason: "duker guard: <agent> may not write <path>. Allowed: …" }`.
  Deny wins over allow; empty allow = everything not denied.
- Paths outside cwd are always blocked.
- `bash` is not path-guarded (a shell can write anywhere), but the command string is
  regex-checked and blocked when it matches `\bgit\s+(commit|push|reset|checkout|clean|stash|rebase)\b`
  or `\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b`. The block reason tells the agent
  the loop owns git. `git diff/status/log/show` stay allowed (the reviewer needs them).
- Logs every block to stderr (surfaces in the parent's child log).

---

## 9. Surface (`index.ts`, `render.ts`)

- `pi.registerCommand("duker", …)` — args: `[n]` (steps, default 1), `status`, `clean`, `abort`, `agents`.
  Handler runs `runLoop` with an `AbortController` stored in extension state (`abort`
  subcommand triggers it). Verify in the container whether the editor stays responsive during
  a long command handler; if not, the command falls back to `pi.sendUserMessage("Run duker_loop …")`
  so Esc works via the tool path.
- `pi.registerTool({ name: "duker_loop", parameters: { steps?: number, cwd?: string } })` —
  same `runLoop`; `onUpdate` receives `{ content: <status text>, details: <LoopDetails> }` on
  every phase change and on every child `message_end`.
- Flags: `--duker-max-rounds` (3), `--duker-max-cost` (∞), `--duker-child-timeout` (30, overrides
  frontmatter when set), `--duker-allow-dirty` (false).
- `session_start`: reset state, nothing long-lived. `session_shutdown`: kill children.
- Status line: `duker · step 1.3 · round 2/3 · tester ⏳ 04:12 · $0.00`.
- `renderCall`: `duker_loop steps=1`. `renderResult` collapsed: one line per phase with ✓/✗/⏳;
  expanded: per child — agent, duration, tool calls (formatted like the official example),
  final text as Markdown, usage line; total line.
- `pi.appendEntry("duker-run", summary)` + `registerEntryRenderer` so command-initiated runs
  leave a card in the transcript (they have no tool row).
- `ctx.ui.notify` on halt / step done / plan complete. All `ctx.ui.*` guarded by `ctx.hasUI`.
- Optional `before_agent_start` one-liner telling the parent model the `duker_loop` tool exists
  and when to use it (cheap; keeps the tool description short).

---

## 10. Build order & verification

Each stage is testable inside the container before the next begins.

1. **Scaffold + load** — package.json, `index.ts` registering the command with a stub handler,
   compose mount, settings path. Verify: pi starts, extension listed, `/duker agents` prints
   the seven agents (tests `agents.ts` + frontmatter validation, incl. a deliberately broken file).
2. **Child runtime** — `runtime.ts` + guard. Verify with a throwaway agent: run it via
   `/duker` debug subcommand (temporary), see the JSONL log, see usage, see guard blocks
   (`write` to a denied path returns the block reason), timeout kills, Esc kills, quit leaves no
   orphan `pi` processes (`ps aux`).
3. **Artifacts + parsers** — unit-test-ish: run parsers on sample files (`node --test` inside
   the container against the TS files with `--experimental-strip-types`, mirroring how
   pi-subagents tests itself).
4. **Loop, single phase at a time** — SELECT only (orchestrator on an existing project's roadmap, after copying
   its roadmap to `Full_Plan.md` and its state notes to `Current_State.md`); then PLAN; then the
   full cycle on a tiny synthetic project (one function + one pytest) with a Full_Plan of two
   trivial steps. Verify: artifacts appear/disappear in the right order, `ISSUES.md` format
   holds, a forced failure (a step whose test is made to fail) triggers exactly the fix rounds
   and halts after 3, resume works after killing the container mid-TEST.
5. **Git** — commit created per passed step, `.duker/` excluded, nothing pushed.
6. **Tool path** — ask the parent model to run `duker_loop`; live tool row, expanded view,
   `usage` in the footer.
7. **Non-interactive** — `pi -p "run one duker step"` with the tool; no `ctx.ui` crashes.
8. **Type-check + `pi install`** — `npx tsc --noEmit` clean; `pi install /opt/duker-loop`,
   remove the settings path, restart, everything still works.
9. **Real run** — one real step of a real project's plan, reviewed by you.

---

## 10a. Build log

| Stage | Status | Notes |
|---|---|---|
| 1 scaffold + agents | done | `registerFlag` only supports string/boolean in pi 0.85 → numeric flags are strings. |
| 2 child runtime + guard | done | Fork-bomb fix in `getPiInvocation` (see §11.2). Live probe verified guard, system prompt, context files, no package leakage, timeout, abort. |
| 3 artifacts + parsers | done | 18 unit tests (`npm test`). Verdict parser scans first 5 lines (deviation, see chat). |
| 4 loop | done | Fake-`pi` harness (`DUKER_PI_BIN`) drives 11 scenarios / 49 checks: pass, 2 fix rounds, halt after max rounds + resume with a higher cap, crash + resume at the same phase, `stopReason: error`, milestone code-fallback, reporter-lies cross-check, missing verdict, dirty-tree refusal, non-git project, missing Full_Plan. Bugs found: preflight's own `Current_State.md` creation tripped the dirty check (now ignored); run ids needed ms resolution. `Current_State.md` is now the only dirty-check exemption; leftover temp artifacts still count (crashed run → `/duker clean`). |
| 5 git | done (folded into 4) | commit after CLEAN, `.duker/` via `.git/info/exclude`, identity fallback `duker-loop@localhost`. No index mutation before REVIEW: the reviewer reads `??` files from `git status` instead (an earlier intent-to-add made `__pycache__` visible and reviewable). |
| 4 e2e (live Qwen3.8-27B) | done | Synthetic calc project, step "add subtract()": passed after 1 fix round, committed, milestone recorded, tests green. 20.5 min, 73 turns. The FAIL round was entirely caused by loop artefacts (`Current_State.md`, `__pycache__`) showing up in the review → reviewer prompt + agent file now list loop-owned files and caches to ignore. Guard hardened: `git add/rm/mv` blocked; `rm -r -f` split-flag evasion blocked; bash `>`/`>>`/`tee` targets checked against the write policy. Remaining known gap: plain `rm <file>`, `sed -i`, `python -c` writes are not path-guarded. |

| 6 tool + rendering | done | `tool.ts` (`duker_loop {steps?, cwd?}`, blocking, `onUpdate` snapshots, `usage` mapped to pi's `Usage`, halt/abort → thrown error with the summary, shared run registry with the command) and `render.ts` (`renderCall`, collapsed/expanded/partial `renderResult`, transcript formatting). Mock-API tests: pass/halt/busy/abort/`@cwd`, renderers return real pi-tui components. Bug found: partial `details` shared arrays with later updates → snapshots now copied. |

| publish prep | done | Integration tests moved into the repo (`test/integration`, fake pi + stub loader → runs without pi, 43 tests on Windows and Linux), `.gitignore`, `docs/`, portable `tsconfig.json` + `tsconfig.container.json`, README rewritten for external readers. `DUKER_PI_BIN` may name a JS file (run via the current node). |
| 8 `pi install` | done | `pi install /opt/duker-loop` links the mounted package (`packages: ["/opt/duker-loop"]`); the `extensions` settings path was removed; the model lists `duker_loop` exactly once with no load errors. |
| 6/7 live parent (`pi --mode json -p`) | done | Asked the parent Qwen model to "advance the plan by one step"; it called `duker_loop {steps:1}` (with pi-subagents' `subagent` also available). Clean step, 0 fix rounds, 3m40s, commit + milestone, `onUpdate` partials visible as `tool_execution_update`, child usage (118k total tokens) recorded on the toolResult message, parent replied with step/verdict/commit. Non-interactive mode works (`ctx.hasUI=false`). |

## 11. Facts to verify in the container before relying on them

These are assumptions taken from `Create_Ext.md` / the pi README that the plan depends on.
Each is checked in build stage 1–2 and the plan adjusted if wrong.

1. ~~`--no-extensions` disables discovery but still honours explicit `-e <path>`~~ **Verified**
   (stage 2): `pi --help` says "(explicit -e paths still work)".
2. ~~Installed packages (`pi-subagents`, `pi-mcp-adapter`) are not loaded in a child under
   `--no-extensions`.~~ **Verified** (stage 2): the guard's `DUKER_DEBUG=1` listing shows only the
   agent's `--tools` allowlist (`read,bash,write`), no `subagent` tool.

   **Lesson from stage 2:** the official `getPiInvocation` re-executes `process.argv[1]` whenever it
   exists on disk. Driven from a test harness that is the harness script itself → fork bomb
   (50 processes before it was caught). `runtime.ts` now only trusts `argv[1]` when its realpath
   contains `/pi-coding-agent/` or is named `pi`, honours `DUKER_PI_BIN`, and refuses to spawn at
   all when `DUKER_DEPTH` is already set in its own environment.
3. ~~`--append-system-prompt` accepts a file path~~ **Verified**: "Append text or file contents".
4. ~~`--thinking <level>` exists~~ **Verified**.
5. ~~`pi install <local path>` copies vs. links the package~~ **Verified** (stage 8): links — `packages` gets the path itself; host edits are live after `/reload`.
6. The TUI editor stays usable while a slow `registerCommand` handler runs (needed for
   `/duker abort`). Fallback: the command re-routes through `pi.sendUserMessage` so the tool
   path and Esc apply.
7. ~~Exact `node_modules` paths inside the global pi install for the `tsconfig.json` `paths`
   mapping used by type-checking.~~ **Verified** (stage 1): `tsc --noEmit` runs clean against
   pi 0.85.1; `parseFrontmatter<T>() → { frontmatter, body }`, `EntryRenderer(entry, options, theme)`,
   `getArgumentCompletions → AutocompleteItem[]` all as assumed. Found: `registerFlag` supports
   only `"string" | "boolean"` — numeric flags are strings parsed by `numberFlag()`.
8. `ctx.model` / `ctx.thinkingLevel` values for a custom (models.json) provider produce a valid
   `--model <provider>/<id>` string for children.
