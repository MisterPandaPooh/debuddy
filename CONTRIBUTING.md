# Contributing to Explain Mode

Thanks for helping. This file is short on purpose: the codebase is small and the README's
"Develop" section already says how to build and test.

## Ground rules

- **Nothing runs the user's code.** Explain Mode is a static walkthrough. Any feature that
  executes the program belongs to a real debugger, not here.
- **Deterministic first, model second.** If a fact can come from the AST or the language
  server (callees, types, throw sites, tests), get it there and hand it to the model. Prompts
  change only with a bench run (`npm run bench`, `node bench/compare.mjs`) proving they still
  work on the default 3B model.
- **No code leaves the machine unless the user picked a provider that sends it.** The
  embedded and Ollama providers are local; CLI providers reuse the user's own login; the
  OpenAI-compatible one needs a key the user typed in. Never add a network call outside a provider.
- **Comments are one or two lines** and explain *why*, not what.

## Setup

```bash
npm install
npm run build          # esbuild bundle + grammars → dist/
npm run typecheck
npm run test:dap       # headless Debug Adapter harness (also test:dap:auto / :throw / :batch)
npm run test:lang      # steps every language walker produces on the samples
```

Open the repo in VS Code and press **F5** ("Run Extension") to get an Extension Development
Host on `sample/`. After any change to `package.json` contributions (menus, settings,
keybindings), **close the host window and start a new one** — a reload is not enough.

## Adding a language

1. Exact: write a tree-sitter profile in `src/lang/profiles/<lang>.ts` (node types and field
   names from the grammar's `node-types.json`), add the grammar package to `package.json` and
   `scripts/copy-grammars.js`, register it in `src/lang/index.ts`.
2. Good enough: add a keyword profile in `src/lang/keywords.ts` — the LSP-generic walker does
   the rest when a language server is installed.
3. Add a sample under `sample/` and a case in `test/lang.js`; the output must show statements,
   branches, handlers and throws that make sense.

## Adding a provider

One file in `src/providers/` implementing `ChatProvider` (`chat(system, user, maxTokens)`),
a case in `src/providers/registry.ts`, settings in `package.json`, a row in the README table.
Set `slow = true` when a call takes seconds: the adapter then batches one call per function.

## Pull requests

- One topic per PR, with the harness and `typecheck` green.
- If you touched prompts, paste the bench output in the PR.
- If you touched the manifest, say that you re-launched the host window and what you saw.

## Reporting bugs

Open **View → Output → "Explain Mode"**: every DAP request, stop, batch and throw-follow is
logged there. Paste the relevant lines with the file/line you were on; it usually tells the
whole story.
