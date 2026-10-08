# Explain Mode

Step through TypeScript/JavaScript like a debugger — nothing runs, a local LLM (Ollama,
`qwen2.5-coder:3b` by default) explains each statement in place.

## Use

1. Nothing to install: the first explanation downloads Qwen2.5-Coder 3B (2.1 GB) into the
   extension storage, with a progress bar. (Ollama, Copilot, Claude Code and Cursor are optional
   providers, see below.)
2. Open a `.ts`/`.js` file, cursor on a line, `Cmd+Alt+E` ("Explain Mode: Start Here").
3. Native debug controls: F10 step over (asks which branch on an `if`), F11 step into,
   Shift+F11 step out, F5 run to the next breakpoint, ◀ step back, `Cmd+Alt+A` / ▶▶ auto-walk
   (F6 pauses), hover a variable for an example value, type a question in the Debug Console.

Settings live under `explain.*` (provider, context window, definition depth, auto-walk dwell).

## Providers

`explain.provider` picks the model; everything (steps, summaries, values, console) goes through it.

| Provider | Needs | Per-step latency | Notes |
|---|---|---|---|
| `embedded` (default) | nothing: llama.cpp (`node-llama-cpp`) runs inside the extension host; Qwen2.5-Coder 3B is downloaded once into the extension storage with a progress bar | ~0.7 s | one model only, the measured sweet spot; +55 MB of extension (native binary per platform) |
| `ollama` | Ollama + any model (`explain.model`) | ~0.4 s | local, free; the prompts are tuned for it. Tiers measured in [bench/RESULTS.md](bench/RESULTS.md): `qwen2.5-coder:0.5b` (0.4 GB, 0.2 s) → `qwen2.5-coder:3b` (1.9 GB, default) → `qwen2.5-coder:7b` (4.7 GB) → `qwen2.5:14b` (9 GB); above 2 GB latency grows faster than accuracy |
| `openai` | `explain.openai.baseUrl` + `Explain Mode: Set API key` | 1–3 s | OpenRouter, OpenAI, LM Studio, vLLM, Ollama's `/v1`; the key lives in VS Code secret storage |
| `vscode-lm` | GitHub Copilot (or any Language Model Chat Provider extension) | 1–3 s | one consent prompt; **not available in Cursor** |
| `claude-cli` | Claude Code CLI signed in (subscription or API key) | ~4 s | one persistent `stream-json` session (`explain.claude.persistentSession`); the CLI is an agent harness, so it never gets as fast as a chat API |
| `cursor-cli` | Cursor Agent CLI, `agent login` once | ? | reuses the Cursor subscription; no system-prompt flag, instructions are folded into the prompt |

On seconds-per-call providers (`claude-cli`, `cursor-cli`) the extension makes **one call per
function** (`explain.batchPerFunction: auto`): the function, its resolved callees, types, tests
and throw sites are sent once, and every statement, the summary and the example values are
cached from that single answer. Fast local models keep one call per statement.

Cursor runs the extension unchanged. Cursor does not expose its models to extensions, but its
Agent CLI does: `cursor-cli` is the way to use the Cursor subscription. On slow providers set
`explain.exampleValues: false` to save one call per statement.

## Develop

```
npm install
npm run build          # bundle to dist/ (esbuild)
npm run typecheck
npm run test:dap       # headless DAP harness: initialize → launch → breakpoint → continue
npm run test:dap:auto  # same, through the auto-walk
npm run bench          # prompt bench against the local model (bench/*.mjs)
code --extensionDevelopmentPath="$PWD" "$PWD/sample"   # Extension Development Host
```

Layout:

- `src/adapter.ts` — Debug Adapter: stepping, breakpoints, auto-walk, throw flow, evaluate.
- `src/lang/` — languages: `types.ts` (Step/Frame), `lsp.ts` (definition/hover/references through
  VS Code), `typescript.ts` (the TS/JS AST walker), `index.ts` (registry; add a language there).
- `src/providers/` — one file per model backend (`embedded`, `ollama`, `openai`, `vscodeLm`,
  `claude`, `cursor`), `cli.ts` (shared process runner), `registry.ts` (settings → provider).
- `src/context.ts` — what the model sees; `src/explain.ts` — prompts and parsing;
  `src/tests.ts` — test titles as spec; `src/ui.ts` — comment thread, hover, highlight, pickers;
  `src/settingsUi.ts` — status bar and provider/model QuickPicks.

## VS Code gotchas met here (all silent)

- `@vscode/debugadapter` dispatches `setBreakpoints` to `setBreak**P**ointsRequest`.
  A method named `setBreakpointsRequest` is never called.
- Manifest contributions (menus, keybindings, settings) load only when an Extension
  Development Host **window starts**. Rebuilding or Cmd+R is not enough: close the host
  window and launch a new one.
- The debug toolbar menu id is `debug/tool**B**ar`. An unknown menu key is ignored.
- Menus/keybindings use the extension's own `explain.active` context key (set via
  `setContext`), not `debugType`.
