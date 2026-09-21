# Create_Ext.md — Building Your Own Subagent-Loop Extension for pi

> **Purpose of this document.** A complete, step-by-step blueprint for designing and building a
> **custom subagent loop** as a pi extension. It explains every piece you need: the extension model,
> the APIs you will use, the architecture of a subagent loop, two different ways to run the
> "child agents" (subprocess vs. in-process SDK), a concrete implementation plan with code
> skeletons, testing/verification, pitfalls, and distribution.
>
> This document does **not** implement anything. It tells you, in detail, what to do and why.
> Every API name and behavior below is taken from the pi docs shipped with your installation:
>
> - `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (extension API)
> - `.../docs/sdk.md` (programmatic agent sessions)
> - `.../docs/json.md` (JSON event stream mode)
> - `.../docs/tui.md` (TUI components for custom rendering)
> - `.../docs/packages.md` (sharing your extension as a pi package)
> - `.../examples/extensions/subagent/` (pi's official subagent example: `index.ts`, `agents.ts`, `agents/*.md`, `prompts/*.md`, `README.md`)
> - `.../examples/sdk/` (SDK usage examples `01-minimal.ts` … `13-session-runtime.ts`)
>
> Re-read the example in `examples/extensions/subagent/` while following this guide — it is the
> closest thing to a reference implementation of exactly what you want to build (and it is the
> one you will be *deliberately redesigning* in your own way).

---

## Table of Contents

1. [What you are building](#1-what-you-are-building)
2. [Prerequisites](#2-prerequisites)
3. [How pi extensions work](#3-how-pi-extensions-work)
4. [Design your loop (the architecture you own)](#4-design-your-loop-the-architecture-you-own)
5. [Choosing the child-agent runtime](#5-choosing-the-child-agent-runtime)
6. [Step-by-step implementation](#6-step-by-step-implementation)
   - [Step 1 — Scaffold and file layout](#step-1--scaffold-and-file-layout)
   - [Step 2 — Agent definitions (markdown "agent files")](#step-2--agent-definitions-markdown-agent-files)
   - [Step 3 — Agent discovery](#step-3--agent-discovery)
   - [Step 4 — Register the tool (the LLM-facing entry point)](#step-4--register-the-tool-the-llm-facing-entry-point)
   - [Step 5 — Child runtime, approach A: subprocess](#step-5--child-runtime-approach-a-subprocess)
   - [Step 5b — Child runtime, approach B: in-process SDK](#step-5b--child-runtime-approach-b-in-process-sdk)
   - [Step 6 — The orchestration loop](#step-6--the-orchestration-loop)
   - [Step 7 — Streaming progress back to the TUI](#step-7--streaming-progress-back-to-the-tui)
   - [Step 8 — Custom rendering (renderCall / renderResult)](#step-8--custom-rendering-rendercall--renderresult)
   - [Step 9 — UX, safety, and configuration extras](#step-9--ux-safety-and-configuration-extras)
   - [Step 10 — Persisting state (optional)](#step-10--persisting-state-optional)
7. [Verification plan (how to test each layer)](#7-verification-plan-how-to-test-each-layer)
8. [Pitfalls and gotchas (long checklist)](#8-pitfalls-and-gotchas-long-checklist)
9. [Distribution as a pi package](#9-distribution-as-a-pi-package)
10. [Reference index](#10-reference-index)

---

## 1. What you are building

A **subagent loop** is an orchestration mechanism where the *main* pi agent (the one talking to
you) can **delegate a task to one or more child agents**. Each child agent runs its **own agent
loop** — its own context window, its own system prompt, its own restricted tool set, its own model
— performs work (reads files, runs commands, writes code), and returns a **result** (final text,
usage/cost, diagnostics) back to the parent, which continues.

In pi, subagents are *not built in* (deliberate design decision, see the "Philosophy" section of
`README.md`: "No sub-agents… build your own with extensions"). You build it as a **pi extension**:

```
┌────────────────────────────── parent pi session ──────────────────────────────┐
│  you ⇄ main agent (LLM)                                                       │
│              │                                                                 │
│              │ calls your tool: subagent({ agent, task, ... })                 │
│              ▼                                                                 │
│   ┌──────────────────── YOUR EXTENSION: ORCHESTRATOR LOOP ─────────────────┐  │
│   │  1. resolve agent definition (prompt, tools, model)                    │  │
│   │  2. dispatch child runtime(s)  (single / parallel / chain / your own)  │  │
│   │  3. observe child event streams, stream progress via onUpdate()        │  │
│   │  4. enforce limits (concurrency, timeouts, budgets, depth)             │  │
│   │  5. aggregate results, handle failures per your policy                 │  │
│   │  6. return final result + details + usage to the parent LLM            │  │
│   └──────┬──────────────────────────────────────────────────────────────────┘  │
└──────────┼──────────────────────────────────────────────────────────────────────┘
           ▼
   child agent #1            child agent #2            child agent #N
   (own context window,      (own context window,      ...
    own system prompt,       own system prompt,
    own tool allowlist,      own tool allowlist,
    own model/thinking)      own model/thinking)
```

There are three distinct "loops" in this system, and it is important to keep them separate:

1. **The child agent loop** (LLM responds → calls tools → gets results → responds again …
   until done). This is pi's own agent loop; you do **not** write it. You get it for free
   either by spawning a `pi` process (approach A) or by creating an `AgentSession`
   via the SDK (approach B).
2. **The orchestration loop** (dispatch children → observe them → aggregate → decide whether
   to dispatch more → stop). This is *your* code — it is the "custom subagent loop designed by
   you". This document is mostly about designing this layer.
3. **The recursion loop** (a child agent can itself call your `subagent` tool, spawning
   grandchildren). Optional. If you allow it, you must add depth/loop guards.

**What the finished extension looks like to the user:**

- The main agent can call a tool (e.g. `subagent`) with parameters such as
  `{ agent: "scout", task: "find all auth code" }`, `{ tasks: [...] }` for parallel work, or
  `{ chain: [...] }` for sequential pipelines.
- The TUI shows live progress: which child is running, which tools it is calling, partial output.
- After completion, the parent LLM receives the child's final output (truncated to a cap) and can
  act on it; the expanded tool view (Ctrl+O) shows full transcript, per-child usage, tokens, and
  cost.
- You (the human) configure the available subagents as small markdown files with YAML
  frontmatter (name, description, tool allowlist, model).
- Optional: slash commands (`/agents`, `/run-agent …`), a status line, project-agent trust
  prompts, per-agent models, etc.

---

## 2. Prerequisites

1. **pi installed and authenticated.** You need a working `pi` binary and at least one
   authenticated provider (API key via environment, e.g. `ANTHROPIC_API_KEY`, or via `/login`).
   Verify with `pi --version` and a trivial `pi -p "say ok"`.

2. **Node.js.** Extensions are TypeScript loaded at runtime via [jiti](https://github.com/unjs/jiti)
   — **no compilation step**. Plain `node` built-ins (`node:fs`, `node:path`, `node:os`,
   `node:child_process`, …) are available. No `tsc`/`tsconfig` required for a working extension.
   (You *may* add a `tsconfig.json` purely for editor/type-checking convenience.)

3. **The importable packages** (available to every extension without installation; they are
   bundled with pi):
   | Package | What you use it for |
   |---|---|
   | `@earendil-works/pi-coding-agent` | Extension types (`ExtensionAPI`, `ExtensionContext`, event types), `Type` helpers, `parseFrontmatter`, `getAgentDir`, `CONFIG_DIR_NAME`, `getMarkdownTheme`, truncation utils, `withFileMutationQueue`, SDK entry points (`createAgentSession`, `ModelRuntime`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, `defineTool`, `resolveCliModel`), TUI helpers (`BorderedLoader`, `DynamicBorder`, `keyHint`) |
   | `typebox` | Tool parameter schemas (`Type.Object`, `Type.String`, …) |
   | `@earendil-works/pi-ai` | `StringEnum` (Google-compatible enums), `getModel` |
   | `@earendil-works/pi-agent-core` | Low-level types (`AgentToolResult`, `ThinkingLevel`, `AgentMessage`) |
   | `@earendil-works/pi-tui` | TUI components (`Text`, `Box`, `Container`, `Spacer`, `Markdown`, `SelectList`, `matchesKey`, `Key`, `truncateToWidth`, `visibleWidth`) |
   | npm dependencies (optional) | Any npm package if you add a `package.json` next to your extension and `npm install` |

4. **Know your config directory.** The global config dir is `~/.pi/agent`
   (overridable via `PI_CODING_AGENT_DIR`). Extensions live in
   `~/.pi/agent/extensions/`; your agent definition files will live in
   `~/.pi/agent/agents/` (see Step 2). In code, never hardcode `.pi` — import
   `CONFIG_DIR_NAME` and `getAgentDir()` from `@earendil-works/pi-coding-agent`
   (rebranded distributions use different names).

5. **A workspace** for development. Suggested layout (Step 1) is a plain folder
   `my-subagent-ext/` that you test with `pi -e ./my-subagent-ext/index.ts`.

---

## 3. How pi extensions work

Everything you code against. Details and the full API reference: `docs/extensions.md`.

### 3.1 Module shape

An extension is a TypeScript module with a **default-exported factory function** that receives
the `ExtensionAPI` (`pi`):

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 1) react to lifecycle events
  pi.on("session_start", async (_event, ctx) => { /* ... */ });

  // 2) register tools the LLM can call
  pi.registerTool({ name: "subagent", /* ... */ });

  // 3) register user-facing commands, shortcuts, flags
  pi.registerCommand("agents", { description: "List subagents", handler: async (args, ctx) => { /* ... */ } });
  pi.registerShortcut("ctrl+shift+a", { description: "Run agent", handler: async (ctx) => { /* ... */ } });
  pi.registerFlag("subagent-max-parallel", { description: "Max parallel children", type: "number", default: 4 });
}
```

Rules of the model:

- The factory may be **`async`**. If it returns a promise, pi awaits it before startup
  continues (useful for one-time init such as fetching config).
- Extensions are loaded via **jiti**, so TypeScript works without a build step.
- **Do not start long-lived resources (processes, sockets, file watchers, timers) in the
  factory.** The factory can run in invocations that never start a session (e.g. `pi --list-models`).
  Defer startup to `session_start` or to the command/tool that needs the resource, and register
  an idempotent `session_shutdown` handler to clean up.
- One extension can register **multiple tools, commands, shortcuts, flags, and event handlers**.
- A second extension can call `pi.setActiveTools([...])` to enable/disable tools at runtime;
  tools registered after startup appear immediately (no `/reload` needed).

### 3.2 Where pi discovers extensions

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | Global |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory form — use this for multi-file extensions) |
| `.pi/extensions/*.ts` | Project-local (loaded only after project trust) |
| `.pi/extensions/*/index.ts` | Project-local (subdirectory) |
| `settings.json` → `"extensions": ["/path/to/file.ts", "/path/to/dir"]` | Extra paths |
| `pi -e ./path.ts` | CLI one-off load (your main dev tool) |
| pi packages (`pi install npm:… / git:…`) | Bundled, shared packages |

During development you will almost always use **`pi -e ./my-subagent-ext/index.ts`**.
Once moved to `~/.pi/agent/extensions/my-subagent/`, it hot-reloads with `/reload`.

### 3.3 The `pi` API surface you will use

From `docs/extensions.md` → "ExtensionAPI Methods":

- **`pi.on(event, handler)`** — subscribe to lifecycle events. The ones relevant to a subagent
  extension:
  - `session_start` (`event.reason`: `"startup" | "reload" | "new" | "resume" | "fork"`) —
    (re)initialize per-session state.
  - `session_shutdown` (`event.reason`: `"quit" | "reload" | "new" | "resume" | "fork"`) —
    kill child processes, close resources, flush state.
  - `agent_start` / `agent_end` / `agent_settled` — parent-agent lifecycle (e.g. to show
    "subagents available" hints or to update a status line).
  - `tool_call` — fires before any tool executes; **can block** (return
    `{ block: true, reason, terminate? }`) and `event.input` is **mutable**. Useful to add
    your own guardrail (e.g. block recursive subagent calls beyond depth N).
  - `tool_result` — fires after your tool executed; can modify the result.
  - `before_agent_start` — inject a message or modify the system prompt for the next turn
    (e.g. tell the main agent which agents exist).
  - `model_select`, `thinking_level_select` — react to model changes (re-derive child defaults).
- **`pi.registerTool(definition)`** — the heart of your extension. Full shape in Step 4.
- **`pi.registerCommand(name, { description, handler, getArgumentCompletions? })** —
  `/mycommand` for humans. Command handlers receive `ExtensionCommandContext`, which extends
  `ExtensionContext` with session-control methods (`waitForIdle`, `newSession`, `fork`,
  `reload`, …).
- **`pi.registerShortcut(key, { description, handler })`**, **`pi.registerFlag(name, opts)`** +
  **`pi.getFlag(name)`** — keyboard shortcut and CLI flag (e.g. `--subagent-max-parallel 8`).
- **`pi.sendMessage(message, { triggerTurn?, deliverAs? })`** — inject a *custom* message into
  the session (participates in LLM context). `deliverAs`: `"steer"` (default; delivered after
  the current tool batch), `"followUp"` (after the agent fully finishes), `"nextTurn"` (queued
  for the next user prompt). `triggerTurn: true` makes an idle agent respond immediately.
- **`pi.sendUserMessage(text, { deliverAs? })`** — inject an actual *user* message (always
  triggers a turn). Use with care; it's how an extension can "queue follow-up work" for the
  parent agent (see `examples/extensions/send-user-message.ts` and `reload-runtime.ts`).
- **`pi.appendEntry(customType, data?)`** — persist extension data in the session file. Custom
  entries do **not** enter LLM context; pair with `pi.registerEntryRenderer(customType, renderer)`
  to render them in the TUI transcript. (Compare with `pi.sendMessage`/`pi.registerMessageRenderer`,
  which *do* enter LLM context.)
- **`pi.exec(command, args, { signal?, timeout? })`** — run a shell command from the extension
  (returns `{ stdout, stderr, code, killed }`).
- **`pi.setActiveTools(names)` / `pi.getActiveTools()` / `pi.getAllTools()`** — manage the active
  tool set at runtime.
- **`pi.setModel(model)` / `pi.setThinkingLevel(level)` / `pi.getThinkingLevel()`** — session
  model control (recorded in session history).
- **`pi.setSessionName(name)`** — rename the session.
- **`pi.events`** — a shared event bus for communication *between extensions*
  (`pi.events.on("my:event", …)` / `pi.events.emit("my:event", …)`).
- **`pi.registerProvider(name, config)` / `pi.unregisterProvider(name)`** — dynamic model
  providers (only if you want your subagents to use custom endpoints).

### 3.4 The `ctx` (ExtensionContext) you get in handlers and tools

Every event handler and tool `execute()` receives a `ctx` with (full list in
`docs/extensions.md` → "ExtensionContext"):

- `ctx.mode` — `"tui" | "rpc" | "json" | "print"`. Guard TUI-only features with
  `ctx.mode === "tui"`.
- `ctx.hasUI` — `true` in TUI and RPC modes, `false` in `-p`/JSON modes. Guard all
  `ctx.ui.*` calls with it so your extension works when the parent itself runs non-interactively.
- `ctx.cwd` — current working directory (use for resolving agent dirs, child cwds).
- `ctx.model` / `ctx.thinkingLevel` — the parent's active model and thinking level. **This is
  how your children inherit the parent's model** when an agent file doesn't pin one.
- `ctx.modelRegistry` — resolve arbitrary `provider/model` pairs
  (`ctx.modelRegistry.getProvider(id)`, `find(provider, model)`, `getAvailable()`).
- `ctx.scopedModels` — the session's Ctrl+P model scope (empty = all models).
- `ctx.signal` — the current agent **abort signal** (usually defined during active-turn events
  like `tool_call`/`tool_result`; `undefined` when idle). **Pass this to everything abortable**
  (child processes, `fetch`, nested model calls) so Esc in the parent kills the whole tree.
- `ctx.sessionManager` — read-only session state (`getEntries()`, `getBranch()`,
  `getSessionFile()`, `getSessionId()`, `getLeafId()`, `getLabel(id)`, …).
- `ctx.isProjectTrusted()` — whether project-local resources are trusted (use to gate
  project-local agents; see Step 9).
- `ctx.isIdle()`, `ctx.abort()`, `ctx.hasPendingMessages()` — control-flow helpers.
- `ctx.shutdown()` — request graceful shutdown.
- `ctx.getContextUsage()` — current context usage for the active model.
- `ctx.compact({ customInstructions?, onComplete?, onError? })` — trigger compaction.
- `ctx.getSystemPrompt()` — current system prompt string.
- `ctx.ui` — all user-interaction methods (see 3.5).

Command handlers get `ExtensionCommandContext`, which adds `ctx.waitForIdle()`,
`ctx.newSession()`, `ctx.fork()`, `ctx.navigateTree()`, `ctx.switchSession()`, `ctx.reload()`,
`ctx.getSystemPromptOptions()`. (These can deadlock if called from event handlers — that's why
they exist only on the command context.)

### 3.5 `ctx.ui` methods (user interaction & TUI)

- **Dialogs (blocking):** `ctx.ui.select(title, options)` → value or `undefined`;
  `ctx.ui.confirm(title, message)` → boolean; `ctx.ui.input(title, placeholder)` → string or
  `undefined`; `ctx.ui.editor(title, prefill)` → multi-line string. All support
  `{ timeout: ms }` (auto-dismiss with countdown) and `{ signal: AbortSignal }`.
- **Non-blocking:** `ctx.ui.notify(text, "info" | "warning" | "error")`.
- **Persistent UI:** `ctx.ui.setStatus("my-ext", textOrUndefined)` (footer status);
  `ctx.ui.setWidget("id", lines | componentFactory, { placement?: "belowEditor" })` (widget
  above/below editor); `ctx.ui.setFooter(factoryOrUndefined)`; `ctx.ui.setTitle(text)`;
  `ctx.ui.setWorkingMessage(...)` / `setWorkingIndicator(...)` (streaming indicator).
- **Editor:** `ctx.ui.setEditorText(text)`, `ctx.ui.getEditorText()`,
  `ctx.ui.pasteToEditor(text)`, `ctx.ui.addAutocompleteProvider(...)`.
- **Custom components:** `ctx.ui.custom<T>((tui, theme, keybindings, done) => component, { overlay? })`
  — temporarily replaces the editor with your TUI component until `done(value)` is called.
  With `{ overlay: true }` it floats above existing content (experimental). This is how you'd
  build e.g. an interactive "pick an agent + review the task" dialog. See `docs/tui.md` for the
  component system and copy-paste patterns (`SelectList`, `SettingsList`, `BorderedLoader`,
  `DynamicBorder`, theming rules, the `render/invalidate/handleInput` contract,
  `tui.requestRender()` after state changes).
- **Theme access:** `ctx.ui.theme.fg("accent", text)`, `theme.bg(...)`, `theme.bold(text)`, etc.

### 3.6 Tool definition — the exact contract

From `docs/extensions.md` → "Custom Tools":

```typescript
pi.registerTool({
  name: "subagent",                          // snake_case; the LLM calls this
  label: "Subagent",                         // display label
  description: "Delegate tasks to subagents…",// shown to the LLM; be precise about modes/params
  promptSnippet: "…",                        // optional one-liner in the "Available tools" section
  promptGuidelines: ["Use subagent when …"], // optional bullets in "Guidelines"; MUST name the tool
  parameters: Type.Object({ /* typebox schema */ }),
  prepareArguments(args) { return args; },   // optional compat shim, runs before validation
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // params: validated against `parameters`
    // signal: AbortSignal — check `signal.aborted`, propagate to children
    // onUpdate: (partial: AgentToolResult) => void — stream progress (Step 7)
    // ctx: ExtensionContext
    return {
      content: [{ type: "text", text: "Final output for the LLM" }], // what the parent LLM sees
      details: { /* structured data for rendering + state (Step 8) */ },
      usage: { /* optional: combined Usage of nested LLM calls → counted in footer/session totals */ },
      terminate: false, // optional: skip the automatic follow-up LLM call (only if ALL results in the batch terminate)
    };
  },
  renderCall(args, theme, context) { /* optional TUI: render the call (Step 8) */ },
  renderResult(result, { expanded, isPartial }, theme, context) { /* optional TUI: render result (Step 8) */ },
});
```

Hard rules:

- **Errors are signaled by throwing** inside `execute`. Returning an object never sets
  `isError`. (The official subagent example *returns* `isError: true` in some branches — the
  documented, correct way is to `throw new Error(...)`; the error is caught, reported to the LLM
  with `isError: true`, and execution continues.)
- **String enums must use `StringEnum` from `@earendil-works/pi-ai`** — `Type.Union`/
  `Type.Literal` break with the Google API.
- **Truncate all large output** before returning `content` (built-in limit: 50 KB / 2000 lines).
  Use `truncateHead` (keep the beginning — search results), `truncateTail` (keep the end — logs),
  `formatSize`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES` from `@earendil-works/pi-coding-agent`.
  Always tell the LLM where the full output went.
- If the tool **mutates files**, wrap the whole read-modify-write in
  `withFileMutationQueue(absolutePath, fn)` so it serializes with built-in `edit`/`write`
  (tool calls run in parallel by default). For a subagent tool this mainly matters for the temp
  prompt file you write (Step 5).
- Some models prepend `@` to path arguments — strip a leading `@` from any path params.
- **Usage accounting:** if your tool made nested LLM calls (your children did!), return their
  combined `Usage` as `usage`. Pi persists it on the tool result and includes it in the footer,
  `/session`, and RPC session totals. This is the difference between "cost of subagents is
  invisible" and "cost is accounted for". (The official example tracks per-child usage in
  `details` for display but does not return the aggregate `usage` — doing *both* is the better
  design; that's your improvement to make.)

---

## 4. Design your loop (the architecture you own)

This is the "designed by me" part. Before writing code, decide each of the following. For every
decision, this document states the official example's choice so you can consciously deviate.

### 4.1 Dispatch modes (what the tool's parameter space looks like)

The official example supports three mutually-exclusive modes:

| Mode | Parameter | Semantics |
|---|---|---|
| Single | `{ agent, task, cwd? }` | one agent, one task |
| Parallel | `{ tasks: [{ agent, task, cwd? }, …] }` | run concurrently; official caps: 8 tasks max, 4 concurrent |
| Chain | `{ chain: [{ agent, task, cwd? }, …] }` | sequential; task strings may contain a `{previous}` placeholder replaced by the previous step's final output; stops at first failing step |

**Design questions for your loop:**

- Which modes do you want? (All three? A `map/reduce` mode — fan out to N workers, then a
  "reducer" agent merges their outputs? A `debate` mode — two agents answer, a third judges?)
- What are your caps? (Official: `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4`,
  `PER_TASK_OUTPUT_CAP = 50 KB`, `COLLAPSED_ITEM_COUNT = 10`.) Make caps configurable via
  `pi.registerFlag` or a settings file if you want.
- Failure policy per mode? Official: chain → stop at first failure, return `isError`;
  parallel → keep going, report `k/n succeeded` with per-task status. Your options:
  fail-fast, best-effort, retry-once, retry-with-different-model, …
- **Recursion:** do children get the `subagent` tool themselves? If yes, design the guard:
  depth counter (e.g. max 2), a `pi.on("tool_call")` handler that inspects
  `event.input` of your own tool and blocks when depth ≥ max, and/or a flag like
  `allowNested: false` in the tool params. If you run children in **subprocess** mode
  (approach A), remember the child `pi` process loads your extension only if you pass
  `-e` for it or it's in an auto-discovered location — otherwise it simply doesn't have the
  tool (which is a clean way to *disable* recursion for free).
- **The loop itself:** the orchestration loop is the while/for you write in Step 6:
  `dispatch → observe (event stream) → aggregate → decide (done | dispatch more) → repeat`.
  "Dispatch more" is where custom designs live: e.g. *iterative refinement* (worker →
  reviewer; if reviewer finds issues, loop back to worker with the review, max 3 rounds),
  *until-converged* (re-run until two consecutive outputs are identical, with a max-iteration
  guard), *budgeted search* (keep dispatching variants until token/cost budget exhausted).
  Whatever you choose, always have: a maximum iteration count, a per-child timeout (your call;
  the official example has no per-child timeout — only parent-abort propagation), and
  abort propagation from the parent's `signal`.

### 4.2 Agent definitions

Decide *where* and *how* your subagents are defined. The official example: **markdown files with
YAML frontmatter**, one file per agent:

```markdown
---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
---

You are a scout. Quickly investigate a codebase and return structured findings …
(output format contract here …)
```

- `name`, `description` — required (used for discovery + to inform the parent LLM).
- `tools` — optional comma-separated string **or** YAML array; maps to the child's `--tools`
  allowlist (approach A) / `tools` option (approach B). Omitted → child gets pi's default tools
  (`read`, `bash`, `edit`, `write`).
- `model` — optional `provider/id` or bare model pattern; omitted → child **inherits the
  parent's active model and thinking level** (the example passes `--model <parent>` and
  `--thinking <parent level>` only when the agent didn't pin its own).
- Body — the agent's system prompt (appended, not replacing, in approach A; it can be either in
  approach B — your choice).

Locations (official):
- `~/.pi/agent/agents/*.md` — user-level, always loaded.
- `.pi/agents/*.md` — project-level, nearest ancestor of `cwd`, loaded only when the tool is
  called with `agentScope: "project" | "both"` **and** (in interactive mode, untrusted project)
  after an explicit `ctx.ui.confirm` — because these are repo-controlled prompts that can
  instruct the model to run arbitrary commands. Project agents **override** user agents with the
  same name when `agentScope: "both"`.

**Design questions:** where do your agents live (only `~/.pi/agent/agents`? a different dir?
inline in the extension? a `subagents:` section in a settings file?), which frontmatter fields do
you support (consider adding: `thinking: low`, `maxTurns`, `timeoutMs`, `cwd`, `env`,
`systemPromptMode: append|replace`, `outputContract: freeform|structured`), and what's your
security model for repo-controlled agents (default scope, trust gating, confirmation UX).

### 4.3 Context isolation and what children see

- Each child gets a **fresh, empty context** (its own session). It sees: its system prompt,
  the task text you pass, and (in approach A) whatever context files/skills the child `pi`
  process itself discovers for its cwd.
- Decide what to pass in the task: bare task text (official: `Task: ${task}`), or enriched
  context (parent's current goal, relevant file list from a prior scout step, constraints,
  "write your final answer in exactly this format"). The `{previous}` chain interpolation is the
  official way to pass context between steps; your design may do richer handoffs (e.g. pass the
  previous step's `details` — file list, diffs — not just its final text).
- Decide whether children should see `AGENTS.md`/skills: in approach A they do (they're real
  `pi` processes in the same cwd); you can suppress with `--no-context-files` / `--no-skills`.
  In approach B you control it precisely via `DefaultResourceLoader` overrides.

### 4.4 Observability

- **Live progress** while children run: streamed via `onUpdate()` (Step 7) — per-child status
  icons (⏳ running / ✓ done / ✗ failed), last few tool calls, partial text.
- **Final rendering**: collapsed (default) vs expanded (Ctrl+O) views via `renderResult` (Step 8):
  per-child task, tool-call list, final output rendered as **Markdown**
  (`getMarkdownTheme()` + `Markdown` component), and a usage line
  (`3 turns ↑12.3k ↓4.1k R50.0k W2.0k $0.0123 ctx:68k claude-sonnet-4-5`).
- **Accounting**: aggregate per-child `usage` (turns, input/output/cacheRead/cacheWrite tokens,
  cost, context tokens, model) into both `details` (for rendering) and the tool's returned
  `usage` (for pi's own totals).
- Optional: `ctx.ui.setStatus("subagent", "2/3 children running…")`, a widget listing running
  children, `pi.appendEntry("subagent-run", …)` so a run record survives in the session file.

### 4.5 Result contract (child → parent)

Define precisely what one child run produces. The official `SingleResult`:

```typescript
interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;              // -1 = still running (parallel placeholder)
  messages: Message[];           // full transcript from the child (approach A: parsed JSONL)
  stderr: string;
  usage: { input, output, cacheRead, cacheWrite, cost, contextTokens, turns };
  model?: string;
  stopReason?: string;           // "end" | "error" | "aborted" | …
  errorMessage?: string;
  step?: number;                 // index in a chain
}
```

- **Final output** = last assistant message's text part (scan messages backwards).
- **Failure** = `exitCode !== 0 || stopReason === "error" || stopReason === "aborted"`.
- On failure, surface `errorMessage || stderr || last assistant text || "(no output)"` to the
  parent LLM so it can react.
- Design question: freeform final text (official) or a **structured contract** — e.g. give the
  child a custom final tool `submit_result({ summary, files, confidence })` (via
  `customTools` in approach B, or an extension tool in approach A) that the child must call to
  finish, combined with `terminate: true` semantics (see `examples/extensions/structured-output.ts`).
  A structured contract makes your orchestration loop deterministic (you can parse fields instead
  of LLM prose) — this is probably the single biggest "make it yours" improvement.

---

## 5. Choosing the child-agent runtime

Two fully-supported mechanisms. The official example uses A. The SDK docs explicitly list
"Build custom tools that spawn sub-agents" as an SDK use case (approach B).

### Approach A — subprocess (spawn `pi` per child)

For each child, spawn the pi CLI in **JSON event-stream mode** and parse its stdout:

```
pi --mode json -p --no-session
   [--model provider/id] [--thinking level] [--tools read,grep,…]
   [--append-system-prompt /tmp/agent-system-prompt.md]   # file path OR literal text
   "Task: <task text>"                                    # positional prompt arg
```

- `--mode json`: every session event is emitted as one JSON object per line (strict LF framing —
  split on `\n` only, never a generic line reader that also splits on Unicode separators).
- `-p` (print mode): non-interactive, exits after the run.
- `--no-session`: ephemeral — the child writes no session file. (Drop it if you *want*
  inspectable child session files; they then land in the normal sessions dir.)
- `--model` accepts `provider/id` and optional `:<thinking>`; `--thinking <level>`;
  `--tools a,b,c` allowlists tools (built-in or extension); `--append-system-prompt <text-or-file>`
  appends text **or file contents** to the system prompt (repeatable).
- Child environment: the CLI sets `AI_AGENT=pi`, `PI_CODING_AGENT=true`; the bash tool inside the
  child also gets `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`,
  `PI_REASONING_LEVEL`.

**JSON stream anatomy** (docs/json.md):

1. First line: session header `{"type":"session","version":3,"id":"…","timestamp":"…","cwd":"…"}`.
2. Then events as they happen:
   - `{"type":"agent_start"}`, `{"type":"agent_end","messages":[…],"willRetry":bool}`
   - `{"type":"turn_start"}`, `{"type":"turn_end","message":{…},"toolResults":[…]}`
   - `{"type":"message_start","message":{…}}`
   - `{"type":"message_update","usage":{…},"assistantMessageEvent":{…}}` — **delta-only**
     (cumulative `partial` snapshots are stripped to keep the stream linear; assemble live text
     from `delta`/`contentIndex` if you want token-by-token rendering).
   - `{"type":"message_end","message":{…}}` — **final authoritative message**; fires for
     `user`, `assistant`, **and `toolResult`** messages.
   - `{"type":"tool_execution_start","toolCallId","toolName","args"}`,
     `{"type":"tool_execution_update","toolCallId","toolName","args","partialResult"}`,
     `{"type":"tool_execution_end","toolCallId","toolName","result","isError"}`.

   (The official example also checks for a `tool_result_end` event type — a legacy/defensive
   branch; in the current stream, tool results arrive as `message_end` with
   `message.role === "toolResult"` plus the `tool_execution_*` events. Handle `message_end`
   correctly and you're future-proof.)

**How to find the pi executable** (the official `getPiInvocation` logic, worth copying):

1. `process.argv[1]` is the running pi script; if it exists on disk and is not a Bun virtual
   script (`/$bunfs/root/…`), spawn `process.execPath [argv[1], …args]` — i.e. re-execute the
   *exact same* pi installation the extension is running in (correct under npm, standalone
   binary, and `tsx`-from-source).
2. Otherwise, if the current executable is a generic runtime (`node`, `bun`), fall back to
   `pi` on `PATH`.
3. Otherwise re-execute `process.execPath` directly (standalone pi binary).

**Pros:** hard isolation (separate process *and* separate context), crash of a child can't take
down the parent, full CLI surface available (`--tools`, `--model`, `--append-system-prompt`,
`--no-context-files`, …), trivially matches the official example, children automatically get the
right auth (env vars / `~/.pi/agent/auth.json`).
**Cons:** process spawn cost per child (~hundreds of ms), you must implement line-buffered
JSONL parsing yourself, child-side auth/config is whatever the CLI resolves, no direct object
access to the child session (you reconstruct `Message[]` from the stream).

### Approach B — in-process SDK (`createAgentSession`)

Create a child `AgentSession` inside your extension's own Node process
(docs/sdk.md, `examples/sdk/`):

```typescript
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";

// once (lazy! not in the factory — see 3.1):
const modelRuntime = await ModelRuntime.create();   // restores cached catalogs, no network by default

// per child:
const loader = new DefaultResourceLoader({
  cwd,                       // child working dir
  agentDir: getAgentDir(),   // ~/.pi/agent
  systemPromptOverride: (base) => base + "\n\n" + agent.systemPrompt, // or () => agent.systemPrompt to REPLACE
});
await loader.reload();

const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5"); // or resolveCliModel({ cliModel, modelRuntime })
const { session } = await createAgentSession({
  cwd,
  model,
  thinkingLevel: "low",
  modelRuntime,
  tools: agent.tools,                     // allowlist, same semantics as --tools
  customTools: [submitResultTool],        // optional: your structured-result tool (4.5)
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),   // no persistence; SessionManager.create(cwd) to persist
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), // optional overrides
});

session.subscribe((event) => {
  // same event types as the JSON stream (AgentSessionEvent):
  // message_update (streaming deltas), tool_execution_start/end, turn_end,
  // agent_end { messages }, agent_settled, queue_update, compaction_*, …
  // → feed your onUpdate() progress stream (Step 7)
});

await session.prompt(`Task: ${task}`);   // resolves when the full run (incl. retries) finishes

const messages = session.messages;       // AgentMessage[] — your transcript
const usage = /* sum assistant message usage */;
session.dispose();                       // ALWAYS dispose
```

Key SDK facts (docs/sdk.md):

- `session.prompt(text, { expandPromptTemplates?, images?, streamingBehavior?, source?, preflightResult? })`
  — while the child is *not* streaming: resolves after the whole run. While streaming: must pass
  `streamingBehavior: "steer" | "followUp"` (or use `session.steer()` / `session.followUp()`).
- `session.subscribe(listener)` returns an unsubscribe function; **subscriptions are bound to a
  specific session object** — if you ever use the runtime replacement APIs (`newSession`,
  `fork`, …), re-subscribe after replacement.
- `session.abort()` — abort the current operation (wire it to the parent's `signal`).
- `session.agent.state` — direct access to `messages`, `model`, `tools`, `systemPrompt`,
  `streamingMessage`, `errorMessage`; `await session.agent.waitForIdle()`.
- `ModelRuntime.create()` — auth resolution priority: runtime overrides → stored credentials
  (`~/.pi/agent/auth.json`) → env vars → fallback resolver. `PI_OFFLINE` disables model network
  access. `modelRuntime.getAvailable()` = models with valid auth.
- `SessionManager.inMemory(cwd?)` / `SessionManager.create(cwd)` / `open(path)` /
  `continueRecent(cwd)` / static `list(cwd)` / `listAll(cwd)`.
- `SettingsManager.inMemory(settings?)` — in-memory settings (e.g. disable compaction for short
  child runs).
- `DefaultResourceLoader` options let you *fully* control what the child sees:
  `systemPromptOverride`, `extensionFactories` (inline child-side extensions, e.g. to inject
  your structured-result tool via `pi.registerTool` instead of `customTools`),
  `skillsOverride`, `promptsOverride`, `agentsFilesOverride`, `additionalExtensionPaths`,
  `eventBus`.
- `defineTool({...})` from the main package for standalone tool definitions passed as
  `customTools`.

**Pros:** no spawn cost, direct typed object access to the child transcript/state, precise
resource control (you can give the child *no* skills/context files/extensions, or inject child-side
extensions), no JSONL parsing, easy to implement exotic loops (steer a running child mid-turn,
inspect `state.streamingMessage`), and you can give children `customTools` for structured result
contracts (4.5).
**Cons:** children share your process (a runaway child can exhaust memory; no crash isolation),
you must manage `dispose()` and concurrency yourself, no TUI for the child (it's headless by
construction), and auth/config is shared with the parent runtime (usually what you want).

### Recommendation

- **Start with approach A** if you want the shortest path to a working, robust, isolated
  subagent tool and are happy to mirror the official example's behavior.
- **Choose approach B** if your "custom loop" needs tight coupling to child state (mid-run
  steering, structured result tools, per-child extension injection, no per-child process
  overhead, deterministic iteration loops).
- Both can coexist (a `runtime: "process" | "sdk"` parameter or flag).

Either way, the orchestration layer (Step 6) is identical — that's the payoff of keeping
"child runtime" and "orchestration loop" as separate components.

---

## 6. Step-by-step implementation

### Step 1 — Scaffold and file layout

Single file (start here) or directory (grow into this — it's the form that enables
`/reload` hot-reload and keeps files readable):

```
my-subagent-ext/                 # → later: ~/.pi/agent/extensions/my-subagent/
├── index.ts                     # entry point: default export (pi) => { register everything }
├── agents.ts                    # agent discovery + frontmatter parsing (Step 3)
├── runtime-process.ts           # approach A: spawn pi, parse JSONL (Step 5)
├── runtime-sdk.ts               # approach B: createAgentSession child (Step 5b)
├── orchestrator.ts              # single / parallel / chain / your custom loop (Step 6)
├── render.ts                    # renderCall / renderResult helpers (Step 8)
├── types.ts                     # AgentConfig, SingleResult, SubagentDetails, UsageStats
├── package.json                 # only if you need npm deps or will ship as a pi package
└── agents/                      # sample agent definitions you ship
    ├── scout.md
    ├── planner.md
    ├── reviewer.md
    └── worker.md
```

`index.ts` minimal skeleton (everything else fills in per the steps below):

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";          // note: jiti allows explicit .ts imports
import { runSingleAgent } from "./runtime-process.ts";
import { SubagentParams, runOrchestrator } from "./orchestrator.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "…",                       // Step 4
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const discovery = discoverAgents(ctx.cwd, params.agentScope ?? "user");
      // trust gate for project agents: Step 9
      return runOrchestrator({               // Step 6
        mode: /* exactly one of single|parallel|chain */,
        agents: discovery.agents,
        defaultCwd: ctx.cwd,
        dispatchDefaults: {
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          thinkingLevel: ctx.thinkingLevel,
        },
        signal, onUpdate,
        runChild: runSingleAgent,            // Step 5
      });
    },
    renderCall: /* Step 8 */,
    renderResult: /* Step 8 */,
  });

  pi.registerCommand("agents", { description: "List available subagents",
    handler: async (_args, ctx) => { /* ui list */ } });
}
```

Test incrementally: `pi -e ./my-subagent-ext/index.ts` from your working directory.

### Step 2 — Agent definitions (markdown "agent files")

Create the agent files (your own designs, not copies). Minimum required frontmatter is
`name` and `description` (the official discovery logic *skips* files missing either).
Four sensible starter agents (mirror of the official set, each with an explicit **output
contract** in the prompt — this matters because the next agent in a chain has not seen the
files):

- **scout** — read-only recon. `tools: read, grep, find, ls, bash`, cheap/fast model.
  Output contract: `## Files Retrieved` (paths + line ranges), `## Key Code`, `## Architecture`,
  `## Start Here`.
- **planner** — read-only planning. `tools: read, grep, find, ls`. Output: ordered, testable
  implementation plan with file paths and risks.
- **reviewer** — review. `tools: read, grep, find, ls, bash`. Output: findings sorted by
  severity with file:line references and a verdict.
- **worker** — general executor (default full tools), implements/appplies.

Write each as a markdown file under `agents/` in your extension dir (for distribution) and
install/symlink them into `~/.pi/agent/agents/` (user scope). Keep the frontmatter schema
documented in your README.

### Step 3 — Agent discovery

Implement `agents.ts` (the official one is ~150 lines; reproduce its semantics or simplify):

1. `discoverAgents(cwd, scope: "user" | "project" | "both") → { agents: AgentConfig[], projectAgentsDir: string | null }`.
2. User dir: `path.join(getAgentDir(), "agents")` — read `*.md` files (files and symlinks only).
3. Project dir: walk up from `cwd` until you find `path.join(dir, CONFIG_DIR_NAME, "agents")`
   that exists (nearest wins); `null` if none.
4. Parse each file with **`parseFrontmatter`** (exported from `@earendil-works/pi-coding-agent`
   — it runs a real YAML parser, so frontmatter values are `unknown`; validate defensively:
   one bad file must not kill discovery of the others — the official code returns no tools /
   skips the agent on malformed values).
   - `tools`: accept **both** `tools: read, bash` (string, split on `,`) and `tools: [read, bash]`
     (array); trim, drop empties; anything else → `undefined`.
   - `model`: string or undefined.
   - body (after frontmatter) = `systemPrompt`.
5. Merge by name into a `Map` (project overrides user when scope is `"both"`); return
   `Array.from(map.values())`.
6. **Discover fresh on every tool invocation** (official behavior — lets you edit agent files
   mid-session without restart).

Also export a `formatAgentList(agents, maxItems)` helper for command/notify output.

### Step 4 — Register the tool (the LLM-facing entry point)

Schema (typebox; note the `StringEnum` rule from 3.6):

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child process" })),
});
const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task; may contain {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String()),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode: [{agent, task}, …]" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Chain mode: [{agent, task}, …]" })),
  agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, {
    description: 'Which agent dirs to use. Default "user".', default: "user",
  })),
  confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Confirm before running project-local agents. Default true.", default: true })),
  cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
});
```

`description` is the LLM's only manual — be exhaustive: list the modes, the mutually-exclusive
rule, the agent scope default, the caps, and the `{previous}` placeholder.

`execute()` top-level flow (official semantics):

1. Resolve `agentScope` (default `"user"`) and `dispatchDefaults` from `ctx.model` /
   `ctx.thinkingLevel` (inheritance; Step 5 decides how they're applied).
2. `discoverAgents(ctx.cwd, agentScope)` — fresh.
3. **Validate exactly one mode is present** (`agent+task`, `tasks[]`, `chain[]`); otherwise
   return an error-ish content listing available agents (or `throw` — your choice; the official
   example returns content with an explanatory message and empty `details`).
4. **Trust gate** for project-local agents (Step 9.1).
5. Dispatch to the right orchestrator branch (Step 6).
6. Return `{ content, details, usage? }` (Step 6/7/8).

### Step 5 — Child runtime, approach A: subprocess

Implement `runSingleAgent(...)` (official signature, condensed):

```typescript
interface DispatchDefaults { model?: string; thinkingLevel?: ThinkingLevel; }

async function runSingleAgent(
  defaultCwd: string,
  dispatchDefaults: DispatchDefaults,
  agents: AgentConfig[],
  agentName: string, task: string,
  cwd: string | undefined,
  step: number | undefined,          // chain step index (1-based) or undefined
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult>
```

Internal steps, in order:

1. **Resolve the agent.** `agents.find(a => a.name === agentName)`; unknown → return a
   `SingleResult` with `exitCode: 1`, `stderr: 'Unknown agent: "x". Available: …'` (do not
   throw — unknown-agent is a recoverable LLM mistake; the parent can retry with a valid name).
2. **Build the CLI args:**
   ```
   const args = ["--mode", "json", "-p", "--no-session"];
   const model = agent.model ?? dispatchDefaults.model;         // agent file wins
   if (model) args.push("--model", model);
   const inherits = !agent.model;
   if (inherits && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
   if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
   ```
   Design decision (yours): if the agent file pins a `model` but *no* thinking level, do you
   still pass the parent's thinking level? The official example passes it only when the model
   was inherited.
3. **System prompt delivery.** If `agent.systemPrompt` is non-empty: write it to a temp file and
   pass the **path** to `--append-system-prompt` (the CLI accepts "text or file contents").
   Do it safely:
   - `fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"))` per child;
   - file name sanitized from the agent name;
   - write with `withFileMutationQueue(filePath, async () => fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 }))`;
   - **always clean up** (unlink file + rmdir dir) in a `finally`.
   (Alternative: pass the prompt text directly if it's short enough for argv limits — but the
   file approach is the proven one and avoids quoting/size issues.)
4. **Append the task** as a positional prompt arg: `args.push(\`Task: ${task}\`)` (your own
   task framing is a free design knob — see 4.3).
5. **Resolve the executable** with the `getPiInvocation` logic (5, end).
6. **Spawn and parse the stream:**
   ```typescript
   const proc = spawn(invocation.command, invocation.args, {
     cwd: cwd ?? defaultCwd,
     shell: false,
     stdio: ["ignore", "pipe", "pipe"],
   });
   ```
   - stdout: accumulate in a string buffer; split on `"\n"`; **keep the trailing partial line**
     in the buffer (`buffer = lines.pop() || ""`); JSON.parse each complete line (skip lines
     that fail to parse).
   - For each parsed event:
     - `type === "session"` → capture `id`/`cwd` (optional debug).
     - `type === "message_end"` → push `event.message` into `currentResult.messages`.
       If `message.role === "assistant"`: `usage.turns++`; add `usage.input/output/cacheRead/
       cacheWrite`, `cost += usage.cost?.total`, `contextTokens = usage.totalTokens`; record
       `message.model` (first non-empty wins) and `message.stopReason` / `message.errorMessage`.
       → then `emitUpdate()` (Step 7).
     - `type === "tool_execution_end"` (and/or the official legacy `tool_result_end` guard) →
       you may also push the resulting toolResult message here if you want tool results in the
       transcript without waiting for the corresponding `message_end` (official pushes
       `event.message` for `tool_result_end`; with the current stream you get tool results via
       `message_end` with `role === "toolResult"` anyway).
     - (Optional, your design) `tool_execution_start` → update "currently running tool" line;
       `message_update` → live text deltas for a richer collapsed view.
   - stderr: append everything to `currentResult.stderr`.
   - `proc.on("close", code => { process the leftover buffer; resolve(code ?? 0) })`.
   - `proc.on("error", () => resolve(1))` (spawn failure).
7. **Abort propagation.** If `signal` is given: on `abort` (or already aborted) →
   `proc.kill("SIGTERM")`, then a 5-second timer → `proc.kill("SIGKILL")` if still alive; mark
   `wasAborted = true`. After the promise, if `wasAborted` → **throw** `Error("Subagent was
   aborted")` (so the parent sees an error, not a fake success).
8. **Return** the fully-populated `SingleResult` (`exitCode`, `messages`, `stderr`, `usage`,
   `model`, `stopReason`, `errorMessage`, `step`).

Result-extraction helpers (shared with the orchestrator):

```typescript
function getFinalOutput(messages: Message[]): string {
  // last assistant message's first text part, else ""
}
function isFailedResult(r: SingleResult): boolean {
  return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}
function getResultOutput(r: SingleResult): string {
  // failed: errorMessage || stderr || finalOutput || "(no output)"
  // ok:     finalOutput || "(no output)"
}
```

### Step 5b — Child runtime, approach B: in-process SDK

Same `SingleResult` contract, different engine. Implement
`runSingleAgentSdk(...)` with this shape:

1. **Shared, lazily created** `ModelRuntime` (create on first child run or in
   `session_start` — never in the factory): `const modelRuntime = await ModelRuntime.create();`
   (Optionally pass `authPath`/`modelsPath` or `credentials` for isolation; default shares
   `~/.pi/agent/auth.json` and `models.json` with the parent — usually desired.)
2. **Resolve the child model.**
   - Agent pinned a model → parse with `resolveCliModel({ cliModel: agent.model, modelRuntime })`
     (handles `provider/id`, `provider/id:thinking`, bare ids; check `.error`/`.warning`).
   - Otherwise inherit: the parent's `ctx.model` — but `ctx.model` from the extension context is
     already a `Model` object; you can pass it directly. For thinking level, inherit
     `ctx.thinkingLevel` under the same "agent file wins" rule as approach A.
3. **Build the resource loader** for the child (this is where approach B shines — you decide
   exactly what the child sees):
   ```typescript
   const loader = new DefaultResourceLoader({
     cwd: childCwd,
     agentDir: getAgentDir(),
     systemPromptOverride: (base) => `${base}\n\n${agent.systemPrompt}`,  // append
     // stricter isolation, your choice:
     // agentsFilesOverride: (c) => ({ agentsFiles: [], diagnostics: c.diagnostics }),
     // skillsOverride:      (c) => ({ skills: [],     diagnostics: c.diagnostics }),
     // promptsOverride:     (c) => ({ prompts: [],     diagnostics: c.diagnostics }),
   });
   await loader.reload();
   ```
4. **Create the session:**
   ```typescript
   const { session } = await createAgentSession({
     cwd: childCwd,
     model, thinkingLevel,
     modelRuntime,
     tools: agent.tools,                        // undefined → pi defaults
     customTools: [submitResultTool],           // optional structured contract (4.5)
     resourceLoader: loader,
     sessionManager: SessionManager.inMemory(childCwd),
     settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
   });
   ```
5. **Subscribe → progress.** Map SDK events onto the same `emitUpdate()` path as approach A:
   - `message_update` with `assistantMessageEvent.type === "text_delta"` → live text;
   - `tool_execution_start` / `tool_execution_end` → tool-call progress lines + partial results;
   - `message_end` → same assistant-usage aggregation as approach A (turns, tokens, cost,
     `stopReason`);
   - `agent_settled` → the run is truly done (no retry/compaction/follow-up left).
6. **Run and collect:**
   ```typescript
   const controller = new AbortController();
   if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener("abort", () => controller.abort(), { once: true }); }
   // (session.abort() also exists; wire whichever is cleaner to your loop)
   await session.prompt(`Task: ${task}`);
   const messages = session.messages;      // full transcript
   const finalText = /* last assistant text, or the structured submit_result payload */;
   ```
7. **Always dispose** in `finally`: `session.dispose();`
8. **Map failures** to the same `SingleResult` semantics: `agent.state.errorMessage`,
   non-zero-equivalent conditions (e.g. `stopReason === "error"`), abort → throw as in A.

Practical notes for B:

- Concurrency = N live in-memory sessions in one process. Keep your concurrency cap modest and
  always dispose, even on error paths.
- Child sessions have no TUI; `ctx.hasUI`-style guards don't apply inside the child — your
  progress surface is the parent's `onUpdate`/render.
- If you inject `customTools` (e.g. `submit_result`), design the "final answer" extraction:
  child must call it; if it finishes without calling it (stopReason `end`), fall back to the
  last assistant text. Consider `terminate: true` on the structured tool so the child stops
  right after submitting (see `examples/extensions/structured-output.ts`).
- Per-child `SettingsManager.inMemory({ ... })` lets you disable compaction/retry for short
  child runs — a real cost/behavior lever the subprocess approach doesn't expose as cleanly.

### Step 6 — The orchestration loop

This is your core IP. Implement `runOrchestrator(...)` returning the final
`{ content, details, usage? }` tool result.

**Single mode** (trivial):

```typescript
const result = await runChild(/* one agent + task */);
if (isFailedResult(result)) {
  // Design decision: throw (recommended, sets isError for the LLM) or return content+details
  throw new Error(`Agent ${result.agent} failed (${result.stopReason ?? "error"}): ${getResultOutput(result)}`);
}
return {
  content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
  details: makeDetails("single", [result]),
  usage: aggregateUsage([result]),   // your improvement: feed pi's totals (3.6)
};
```

**Chain mode** (sequential pipeline with `{previous}` interpolation — the official loop):

```typescript
const results: SingleResult[] = [];
let previousOutput = "";
for (let i = 0; i < chain.length; i++) {
  const step = chain[i];
  const taskWithContext = step.task.replace(/\{previous}/g, previousOutput);
  const result = await runChild(/* step, index i+1, taskWithContext */);
  results.push(result);
  if (isFailedResult(result)) {
    // fail-fast: report which step failed and why; return partial results in details
    throw new Error(`Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}`);
  }
  previousOutput = getFinalOutput(result.messages);
}
// return last step's output + all results in details (+ aggregate usage)
```

Design your own chain semantics on top: retry a failed step once (with the error appended to
its task), cap total chain cost, or replace `{previous}` with something richer than raw text
(e.g. `details` of the previous step).

**Parallel mode** (fan-out with a worker pool — the official loop):

1. Cap task count (`> MAX_PARALLEL_TASKS` → early error result).
2. Pre-allocate a results array of **placeholders** (`exitCode: -1` = "still running") so the
   renderer can show a stable list with live status.
3. Run with a concurrency limiter (copy the official `mapWithConcurrencyLimit`: N async
   workers pulling from a shared index; N = `MAX_CONCURRENCY`):
   ```typescript
   const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, i) => {
     const result = await runChild(/* t, per-index update callback */);
     allResults[i] = result;
     emitParallelUpdate();   // "k/n done, m running…"
     return result;
   });
   ```
4. Aggregate: per-task output truncated to `PER_TASK_OUTPUT_CAP` (50 KB, byte-accurate — the
   official `truncateParallelOutput` trims on UTF-8 byte length, not char length), status
   header per task (`completed` / `failed (stopReason)`), final text =
   `Parallel: k/n succeeded` + all task sections joined with `---`.
5. Return `{ content, details: makeDetails("parallel", results), usage: aggregateUsage(results) }`.
   (The official example returns `content` even on partial failure; decide whether partial
   failure should also set `isError` — you can `throw` with the summary text if you want the
   parent LLM to treat it as an error.)

**Your custom loop(s)** — same building blocks, different policy. Examples to consider
(implement any you want, each = one new "mode" in the schema):

- **Refine loop** (worker ⇄ reviewer): `for round in 1..maxRounds: worker(task, priorReview?) →
  reviewer(workerOutput) → if reviewer verdict === "approved" break; task += review`.
- **Map-reduce**: parallel workers produce fragments → a reducer agent merges them (this is
  parallel mode + one chain step; the interesting part is capping total input to the reducer —
  you may need your own summarization pass).
- **Until-converged**: repeat a task until two consecutive final outputs match (normalized),
  max K iterations.
- **Budgeted**: track `aggregateUsage` across iterations; stop when cost/token budget reached.

Every custom loop must implement, without exception: (a) a max-iteration/depth bound, (b) abort
propagation (one `signal` check + kill per child), (c) per-child failure isolation (one child's
failure must not lose the others' results in `details`), and (d) progress updates on every
state change (Step 7).

**`details` contract** (shared by all modes — the renderer in Step 8 depends on it):

```typescript
interface SubagentDetails {
  mode: "single" | "parallel" | "chain" /* | your modes */;
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}
```

### Step 7 — Streaming progress back to the TUI

The tool's `execute` receives `onUpdate: (partial: AgentToolResult) => void`. Calling it with
an interim `{ content, details }` makes the TUI **re-render the tool row live** while the
children run (the `isPartial` flag in `renderResult` tells you a row is mid-stream).

Rules and patterns (all from the official example):

- Every child has an `emitUpdate()` that calls `onUpdate({ content: [{ type: "text", text:
  getFinalOutput(currentMessages) || "(running…)" }], details: makeDetails(mode, [current]) })`.
  Call it on every `message_end` (and optionally on `tool_execution_*` for snappier updates).
- **Chain:** each step's update must show *completed* steps + the *current* step: wrap the
  per-child callback so it splices `partial.details.results[0]` into `[...results, current]`
  before emitting.
- **Parallel:** keep the shared `allResults` placeholder array; each child's update writes
  `allResults[index] = partial.details.results[0]`, then a single `emitParallelUpdate()` emits
  the whole array plus a summary line `Parallel: k/n done, m running…`.
- Throttle if needed: emitting on every `message_update` delta can be chatty; the official
  example emits per message boundary, which is the right default.
- Keep the **collapsed** content short (status line + last few items); put everything in
  `details` (Step 8 reads it). The model-visible `content` only matters at the *final* update —
  intermediates are for humans.
- Guard: `onUpdate` may be undefined (e.g. some embedding contexts) — always `onUpdate?.(...)`.

### Step 8 — Custom rendering (renderCall / renderResult)

Without `renderCall`/`renderResult` you get fallback rendering (tool name / raw text). With
them you get the polished experience. Components from `@earendil-works/pi-tui`: `Text`,
`Container`, `Spacer`, `Markdown`; `getMarkdownTheme()` from `@earendil-works/pi-coding-agent`.
Read `docs/tui.md` before writing renderers (theming rules, `truncateToWidth`, caching, the
`render/invalidate/handleInput` contract).

**`renderCall(args, theme, context)`** — show what's about to run, compactly:
- single: `subagent <agent> [scope]` + first line of task (truncate ~60 chars);
- chain: `subagent chain (N steps) [scope]` + up to 3 numbered steps (agent + 40-char task
  preview, strip `{previous}` for display) + `… +k more`;
- parallel: `subagent parallel (N tasks) [scope]` + up to 3 task previews.
- Colors: `theme.fg("toolTitle", theme.bold("subagent "))`, `theme.fg("accent", agent)`,
  `theme.fg("muted", "[scope]")`, `theme.fg("dim", preview)`. Return `new Text(text, 0, 0)`.

**`renderResult(result, { expanded, isPartial }, theme, context)`** — two views:
- **Collapsed (default):** status icon per result (`✓` success / `✗` failed / `⏳` running /
  `◐` partial failure), agent name, last ≤10 display items (text lines and formatted tool
  calls), a usage line, and `(Ctrl+O to expand)` hint. For parallel: `k/n done, m running`
  header.
- **Expanded (`expanded === true`):** a `Container` with, per child: header (icon + agent +
  source + `[stopReason]` on error), error message if any, `─── Task ───` + task text, tool-call
  lines (`→ $ command`, `→ read path:10-50`, `→ grep /pat/ in dir` — write a
  `formatToolCall(toolName, args, themeFg)` switch like the official example, with home-dir
  `~` shortening), then the final output as `new Markdown(finalOutput, 0, 0, getMarkdownTheme())`
  (proper markdown rendering with code highlighting), then per-child usage stats; plus an
  aggregate `Total: …` line for chain/parallel.
- **`isPartial === true`:** show a minimal "running" state (the live `content` text you emitted
  in Step 7 is enough).
- Display-item extraction: `getDisplayItems(messages)` walks assistant messages and emits
  `{ type: "text", text }` for text parts and `{ type: "toolCall", name, args }` for tool calls.
- Usage formatting: `formatUsageStats(usage, model)` →
  `3 turns ↑12.3k ↓4.1k R50.0k W2.0k $0.0123 ctx:68k claude-sonnet-4-5`
  (token formatting: raw <1k, `1.2k` <10k, `12k` <1M, `1.2M` above).
- Fallback: if `details` is missing/empty, render `result.content[0]`'s text.
- Best practices (tui.md): `Text` with padding `(0, 0)` (default Box handles padding);
  `context.state` only for cross-slot shared data; reuse `context.lastComponent` where possible;
  handle `expanded` for on-demand detail; keep the default view compact.

### Step 9 — UX, safety, and configuration extras

In rough order of value:

1. **Project-agent trust gate** (do this — repo-controlled agents are a real attack surface).
   When `agentScope` includes `"project"` **and** any requested agent has
   `source === "project"` **and** `ctx.hasUI` **and** `!ctx.isProjectTrusted()`:
   `await ctx.ui.confirm("Run project-local agents?", "Agents: …\nSource: <dir>\n\nProject
   agents are repo-controlled. Only continue for trusted repositories.")`; on `false` →
   return a cancelled result. Default `confirmProjectAgents: true`; allow the param to bypass
   (the model can set it after *you* the human have trusted the project).
2. **`/agents` command** (`pi.registerCommand`): list discovered agents
   (`formatAgentList`) with scope; optionally a `ctx.ui.select`-driven "run this agent now"
   flow (`ui.editor` for the task, then call the same orchestrator code path — reuse, don't
   duplicate).
3. **`/subagent <task>`-style command** or shortcut: a human-initiated single dispatch (same
   orchestrator code path).
4. **Flags** (`pi.registerFlag`): `--subagent-max-parallel`, `--subagent-user-scope`, etc.,
   read with `pi.getFlag(name)` at dispatch time (so `/reload`-less changes work per call).
5. **Status line / widget** (`ctx.ui.setStatus("subagent", …)`, `ctx.ui.setWidget(…)`):
   while children run, show `subagent: 2/3 running (scout ✓, worker ⏳)`; clear on completion.
   Optional; the tool-row updates already carry this.
6. **Model inheritance display:** in `renderCall`, show which model each child will use
   (pinned vs inherited) — useful when debugging cost.
7. **`before_agent_start` hint (optional):** append one line to the system prompt listing the
   available agent names + one-line descriptions, so the *parent* LLM knows what it can
   delegate without calling your tool first (compare `examples/extensions/prompt-customizer.ts`
   and `claude-rules.ts`). Cheap and effective; keep it short (it costs tokens every turn).
8. **Recursion guard (if you allow nested subagents):** `pi.on("tool_call", …)` checking
   `event.toolName === "subagent"` and a depth marker (e.g. env var you set for child
   processes — approach A: `env: { ...process.env, PI_SUBAGENT_DEPTH: String(d+1) }` in the
   spawn options; approach B: a module-level counter around the child run) → block with
   `{ block: true, reason: "Max subagent depth reached" }`.
9. **Session events:** on `session_shutdown`, track and kill any child processes still running
   (keep a `Set<ChildProcess>` in extension state; also kill on `tool_call` abort via the
   `signal` wiring from Step 5). This is the "long-lived resources" rule from 3.1 applied to
   your children.
10. **`pi.events`** (optional): emit `subagent:started` / `subagent:completed` on the shared
    event bus so *other* extensions can react (e.g. a cost-tracker extension).
11. **Notifications:** `ctx.ui.notify` on completion for long parallel runs (`"3/4 subagents
    finished, 1 failed"`) — human-visible even if they scroll past the tool row.

### Step 10 — Persisting state (optional)

- **Per-run records:** `pi.appendEntry("subagent-run", { mode, results: minimalSummary,
  usage, timestamp })` after each orchestrator run + `pi.registerEntryRenderer("subagent-run",
  (entry, { expanded }, theme) => …)` to render a compact card in the transcript. Custom
  entries don't enter LLM context (good: this is display/history, not prompt material).
- **State that must survive branching:** if your extension keeps mutable in-memory state
  (e.g. a todo of delegated tasks), store it in tool result `details` and reconstruct on
  `session_start` by replaying `ctx.sessionManager.getBranch()` for your tool's results
  (pattern in `docs/extensions.md` → "State Management", and `examples/extensions/todo.ts`).
- **Child session files:** approach A with `--no-session` dropped, or approach B with
  `SessionManager.create(cwd)`, gives you inspectable child sessions for free (findable via
  `/resume` / `SessionManager.list`). Decide if you want that by default or behind a flag.

---

## 7. Verification plan (how to test each layer)

Pi has no unit-test harness for extensions; you verify by running it. Order:

1. **Load check.** `pi -e ./my-subagent-ext/index.ts` → startup header lists your extension
   (name from the file), no load errors. Fix syntax/import errors here.
2. **Schema check.** `/help` or just observe the system prompt: your tool's description and
   `promptSnippet`/`promptGuidelines` appear. Ask the model "what tools do you have?" to
   confirm the schema is understood (watch for invalid enum usage — Google models will fail on
   `Type.Union`/`Type.Literal`, which is why you use `StringEnum`).
3. **Agent discovery.** `/agents` (your command) lists your four sample agents with correct
   scope; a deliberately broken agent file (missing `name`) is skipped without taking down the
   rest; project `.pi/agents` only appear with `agentScope: "both"` and trigger the trust
   prompt in an untrusted project.
4. **Single mode.** In a test repo, prompt the main agent: *"Use scout to find where auth is
   implemented."* Verify: child process appears (or in-process child starts), live updates in
   the tool row, final markdown-rendered output on expand, usage line present, cost appears in
   the footer/session totals (only if you return `usage`).
5. **Parallel mode.** *"Run 2 scouts in parallel: one for models, one for providers."* Verify
   concurrency (not all-at-once beyond your cap), per-task live status, `k/n succeeded`
   summary, 50 KB truncation on a deliberately chatty child.
6. **Chain mode.** Use the workflow prompt pattern (a `.pi/prompts/implement.md` telling the
   model to call the tool with `chain: [scout → planner → worker]`, `{previous}` wired).
   Verify interpolation and fail-fast: make a chain step reference a nonexistent agent and
   confirm the reported failure names the step.
7. **Abort.** Start a long child run; press Esc in the parent. Verify SIGTERM→SIGKILL cascade,
   the error surfaces ("Subagent was aborted"), no orphan `pi` processes remain
   (`ps aux | grep pi`), `session_shutdown` on quit kills stragglers.
8. **Failure paths.** Child with a model that has no auth (expect clean error text, not a
   hang), child task that errors (`stopReason: "error"`), unknown agent name (recoverable
   message listing available agents).
9. **Non-interactive parent.** `pi -e ./my-subagent-ext/index.ts -p "use scout to list files"`
   — verify nothing crashes on `ctx.hasUI === false` (no `ctx.ui.*` calls without the guard).
10. **Reload.** Move to `~/.pi/agent/extensions/my-subagent/index.ts`, edit, `/reload` —
    hot-reload works (this is why the directory form matters).
11. **Type-checking (optional but recommended).** `npx tsc --noEmit index.ts …` with a minimal
    `tsconfig.json` (`"module": "esnext"`, `"moduleResolution": "bundler"`, strict on) catches
    type errors jiti would swallow at runtime.
12. **Cost audit.** Compare footer cost before/after a run; confirm `usage` accounting matches
    the children's reported tokens (within rounding).

---

## 8. Pitfalls and gotchas (long checklist)

**Extension model**
- ❌ Starting background resources (processes/timers/watchers) in the factory — the factory
  can run in invocations that never start a session. Defer to `session_start` / first use;
  clean up in `session_shutdown` (idempotently — it fires on quit, reload, new, resume, fork).
- ❌ Hardcoding `.pi` — use `CONFIG_DIR_NAME` / `getAgentDir()`.
- ❌ Forgetting that project-local extensions only load after project trust; your user-level
  extension is fine, but *project agent files* need the trust gate (Step 9.1).
- ❌ Assuming the handler `ctx` is the command `ctx` — `ctx.reload()`, `ctx.newSession()`,
  `ctx.waitForIdle()` etc. exist **only** on command contexts (deadlock risk elsewhere).

**Tool contract**
- ❌ Returning `{ isError: true }` to signal failure — it must **throw**.
- ❌ `Type.Union` / `Type.Literal` for enums — use `StringEnum` (`@earendil-works/pi-ai`).
- ❌ Returning unbounded child output in `content` — always truncate (50 KB / 2000 lines;
  `truncateHead`/`truncateTail`), and say where the full output lives.
- ❌ Skipping `usage` on nested LLM calls — subagent cost becomes invisible in pi totals.
- ❌ Forgetting `onUpdate?.()` may be undefined.
- ❌ Writing files (e.g. the temp system-prompt file) without `withFileMutationQueue`.

**Subprocess runtime (approach A)**
- ❌ Using a generic line reader for the JSON stream — strict LF framing only (`\n` split with
  a partial-line buffer); JSON payloads may contain Unicode line separators.
- ❌ Forgetting the first stdout line is the **session header**, not an event.
- ❌ Treating `message_update` as cumulative — in JSON mode it is **delta-only**;
  `message_end` is the authoritative final message.
- ❌ Missing the trailing partial line in your buffer at `close`.
- ❌ Not handling `proc.on("error")` (spawn failure) — the promise would never resolve.
- ❌ Not escalating SIGTERM→SIGKILL — a wedged child hangs the parent tool call forever.
- ❌ Forgetting `shell: false` (you're passing an argv array; a shell adds quoting bugs).
- ❌ Assuming `pi` is on PATH in the child's environment — use the `getPiInvocation`
  re-exec logic so children run the *same* pi install the extension runs in.
- ❌ Leaking temp prompt files — `finally`-cleanup, and use `mode: 0o600`.
- ❌ Letting the task text collide with CLI flags — pass it as a positional after `--`-style
  separation (the official example just appends it as the final positional; if your task can
  start with `-`, prefix it or use `--`).

**SDK runtime (approach B)**
- ❌ Never calling `session.dispose()` (memory leak per child; always `finally`).
- ❌ Subscribing once and reusing after a session replacement — subscriptions bind to a
  specific `AgentSession`; re-subscribe after `runtime.newSession()` etc. (you likely won't
  replace child sessions, but if you use `AgentSessionRuntime`, this bites).
- ❌ Creating `ModelRuntime` in the factory or per-child without sharing — create once, lazily,
  share across children.
- ❌ Assuming network is available for model catalogs — `ModelRuntime.create()` restores cached
  catalogs by default; `PI_OFFLINE` kills model network access; bound refreshes with signals.
- ❌ Prompting a streaming child without `streamingBehavior` — `session.prompt()` throws;
  use `steer()`/`followUp()` or the option.
- ❌ Giving children the full default toolset by accident — `tools: undefined` means *pi
  defaults* (`read, bash, edit, write`); pass `[]`/`noTools` deliberately for read-only children.

**Orchestration**
- ❌ Unbounded parallelism — cap tasks (8) *and* concurrency (4) or you'll 429 your provider.
- ❌ Chain `{previous}` substitution of huge outputs into the next task — you may want to cap
  or summarize the interpolated text.
- ❌ Losing sibling results when one child throws in parallel mode — collect in the shared
  array *before* any error propagation; report partial results.
- ❌ No termination condition on any custom loop — max iterations, max depth, max cost,
  timeout. All of them.
- ❌ Assuming child `stopReason === "end"` means success — also check `exitCode` (A) /
  `errorMessage` (B); a run can end "normally" after an LLM error in the stream.

**Rendering / UI**
- ❌ `ctx.ui.*` without `ctx.hasUI` guard — print/JSON modes no-op some methods, `custom()`
  returns undefined; wrap everything.
- ❌ Pre-baking theme colors into cached strings without rebuilding on `invalidate()` (tui.md
  "Rebuild on Invalidate") — colors go stale on theme switch.
- ❌ Emitting lines longer than `width` from custom components — must use `truncateToWidth`.
- ❌ Not handling `isPartial` in `renderResult` (flicker/weird mid-stream views).
- ❌ Forgetting `tui.requestRender()` after state changes in `ctx.ui.custom()` components.

**Security**
- ❌ Auto-loading project `.pi/agents` in untrusted repos — default scope `"user"`; confirm on
  project agents; document it.
- ❌ Writing secrets into the temp prompt file or child env — keep `mode: 0o600`, delete after,
  never log prompt files.
- ❌ Trusting `event.input` from your own tool in `tool_call` handlers without type narrowing —
  use `isToolCallEventType("subagent", YourInputType)(event)` patterns for typed access.

---

## 9. Distribution as a pi package

When the extension is done and you want to share it (or install it properly):

1. **Package layout** (docs/packages.md):
   ```
   my-pi-subagent/
   ├── package.json          # "keywords": ["pi-package"], "pi": { "extensions": ["./extensions"], "prompts": ["./prompts"], "skills": ["./skills"] }
   ├── extensions/
   │   └── my-subagent/
   │       ├── index.ts
   │       └── …(modules from Step 1)
   ├── agents/               # ship your sample agents (install them yourself or document it)
   └── prompts/              # workflow prompts like implement.md (optional)
   ```
   Without a `pi` manifest, pi auto-discovers conventional `extensions/`, `skills/`,
   `prompts/`, `themes/` dirs.
2. **Dependencies rules:**
   - Pi-bundled packages you import (`@earendil-works/pi-coding-agent`,
     `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`,
     `typebox`) go in **`peerDependencies` with `"*"`** — never bundle them.
   - Anything else runtime → `dependencies` (installed via `npm install --omit=dev` on
     `pi install`, so *runtime* deps must be real dependencies, not devDependencies).
   - Other pi packages you depend on → `dependencies` **and** `bundledDependencies`.
3. **Install/test:** `pi install ./my-pi-subagent` (local path), or publish to npm / push to
   git and `pi install npm:@you/my-pi-subagent` / `pi install git:github.com/you/my-pi-subagent`.
   `pi list`, `pi update --all`, `pi config` (enable/disable resources) manage it.
   Try without installing: `pi -e npm:@you/my-pi-subagent` (temporary install for one run).
4. **Gallery metadata (optional):** `pi.video` / `pi.image` fields in the `pi` manifest.
5. **Security note for your README:** pi packages run with full system access — say clearly
   what your extension does (spawns `pi` child processes, reads agent files, optional
   project-agent trust prompt).

---

## 10. Reference index

Read these in this order while building (all relative to
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/`):

| What | Where |
|---|---|
| Extension API, events, `ctx`, tool contract, state mgmt | `docs/extensions.md` |
| SDK: `createAgentSession`, `ModelRuntime`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, events, run modes | `docs/sdk.md` |
| JSON stream events (approach A parsing) | `docs/json.md` |
| TUI components, theming, patterns (Step 8 renderers) | `docs/tui.md` |
| Packaging/distribution | `docs/packages.md` |
| **The official subagent extension (your reference implementation)** | `examples/extensions/subagent/` — `index.ts` (tool + orchestration + rendering), `agents.ts` (discovery), `agents/*.md` (agent files), `prompts/*.md` (workflow prompts), `README.md` (features, security model, limits) |
| SDK usage examples | `examples/sdk/01-minimal.ts` … `13-session-runtime.ts` + `examples/sdk/README.md` |
| Structured final-answer tool (for a deterministic result contract) | `examples/extensions/structured-output.ts` |
| Stateful tool + persistence pattern | `examples/extensions/todo.ts` |
| Truncation done right | `examples/extensions/truncated-tool.ts` |
| System-prompt injection from extension | `examples/extensions/pirate.ts`, `prompt-customizer.ts`, `claude-rules.ts` |
| Injecting user messages / follow-up work | `examples/extensions/send-user-message.ts`, `reload-runtime.ts` |
| Custom UI patterns (dialogs, loaders, settings lists) | `examples/extensions/questionnaire.ts`, `qna.ts`, `handoff.ts`, `preset.ts` |
| Plan-mode (large multi-feature extension as a structural example) | `examples/extensions/plan-mode/` |
| Extension with npm deps (package shape) | `examples/extensions/with-deps/` |
| Verified export surface of the installed package | `dist/index.d.ts` (what you can actually import from `@earendil-works/pi-coding-agent`) |
| CLI flags your children can use | `README.md` → "CLI Reference" |

**Definition of done** for your extension:
1. `pi -e …` loads it cleanly; `/reload` works from an auto-discovered location.
2. Single / parallel / chain (+ your custom modes) all verified per Section 7.
3. Live progress, collapsed/expanded rendering, usage accounting in footer totals.
4. Esc aborts the whole child tree; quit leaves no orphan processes; temp files cleaned up.
5. Works (without UI) in `-p` mode; project agents are trust-gated.
6. Packaged per Section 9 and installed via `pi install` in a clean environment.
