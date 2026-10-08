# Explain Mode

Step through TypeScript/JavaScript like a debugger — nothing runs, a local LLM (Ollama,
`qwen2.5-coder:3b` by default) explains each statement in place.

## Use

1. `ollama pull qwen2.5-coder:3b` (Ollama must be running).
2. Open a `.ts`/`.js` file, cursor on a line, `Cmd+Alt+E` ("Explain Mode: Start Here").
3. Native debug controls: F10 step over (asks which branch on an `if`), F11 step into,
   Shift+F11 step out, F5 run to the next breakpoint, ◀ step back, `Cmd+Alt+A` / ▶▶ auto-walk
   (F6 pauses), hover a variable for an example value, type a question in the Debug Console.

Settings live under `explain.*` (model, context window, definition depth, auto-walk dwell).

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
