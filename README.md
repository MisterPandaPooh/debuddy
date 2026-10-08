# Explain Mode

Step through TypeScript/JavaScript like a debugger — nothing runs, a local LLM (Ollama,
`qwen2.5-coder:3b` by default) explains each statement in place.

## Use

1. `ollama pull qwen2.5-coder:3b` (Ollama must be running).
2. Open a `.ts`/`.js` file, cursor on a line, `Cmd+Alt+E` ("Explain Mode: Start Here").
3. Native debug controls: F10 step over (asks which branch on an `if`), F11 step into,
   Shift+F11 step out, F5 run to the next breakpoint, ◀ step back, `Cmd+Alt+A` / ▶▶ auto-walk
   (F6 pauses), hover a variable for an example value, type a question in the Debug Console.

Settings live under `explain.*` (provider, context window, definition depth, auto-walk dwell).

## Providers

`explain.provider` picks the model; everything (steps, summaries, values, console) goes through it.

| Provider | Needs | Per-step latency | Notes |
|---|---|---|---|
| `ollama` (default) | Ollama + `qwen2.5-coder:3b` | ~0.4 s | local, free; the prompts are tuned for it |
| `openai` | `explain.openai.baseUrl` + `Explain Mode: Set API key` | 1–3 s | OpenRouter, OpenAI, LM Studio, vLLM, Ollama's `/v1`; the key lives in VS Code secret storage |
| `vscode-lm` | GitHub Copilot (or any Language Model Chat Provider extension) | 1–3 s | one consent prompt; **not available in Cursor** |
| `claude-cli` | Claude Code CLI signed in (subscription or API key) | ~10 s | process start dominates; the next-step prefetch hides part of it |

Cursor runs the extension unchanged; use `ollama`, `openai` or `claude-cli` there, since Cursor
does not expose its own models to extensions.

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

Layout: `src/adapter.ts` (Debug Adapter: stepping, breakpoints, auto-walk, evaluate),
`src/navigator.ts` (TS AST → steps, calls, branches, throws; LSP lookups),
`src/context.ts` (what the model sees: callee summaries, types, tests, throws),
`src/explain.ts` (prompts + Ollama adapter), `src/tests.ts` (test titles as spec),
`src/ui.ts` (comment thread, highlight, status, branch picker).

## VS Code gotchas met here (all silent)

- `@vscode/debugadapter` dispatches `setBreakpoints` to `setBreak**P**ointsRequest`.
  A method named `setBreakpointsRequest` is never called.
- Manifest contributions (menus, keybindings, settings) load only when an Extension
  Development Host **window starts**. Rebuilding or Cmd+R is not enough: close the host
  window and launch a new one.
- The debug toolbar menu id is `debug/tool**B**ar`. An unknown menu key is ignored.
- Menus/keybindings use the extension's own `explain.active` context key (set via
  `setContext`), not `debugType`.
