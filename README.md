<p align="center">
  <img src="images/icon.png" width="96" alt="Explain Mode icon">
</p>

<h1 align="center">Explain Mode</h1>

<p align="center">
  <b>Step through code like a debugger. Nothing runs — a local model explains each statement in place.</b><br>
  F10 · F11 · breakpoints · call stack · branch choice · follow the exception — on code you have never read.
</p>

<p align="center">
  <a href="https://github.com/MisterPandaPooh/explain-mode/releases"><img alt="Download" src="https://img.shields.io/badge/download-VSIX-2ea44f"></a>
  <a href="https://github.com/MisterPandaPooh/explain-mode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MisterPandaPooh/explain-mode/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.95-blue">
  <img alt="Cursor" src="https://img.shields.io/badge/Cursor-supported-7c3aed">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-lightgrey">
</p>

<p align="center">
  <img src="images/walkthrough.png" width="760" alt="Explain Mode stopped on a line: Does / Why / Watch / Throws under the statement">
</p>

---

You open a function you did not write. Instead of reading it top to bottom and guessing, you
**start Explain Mode on a line and press F10**. The next statement lights up, and a short card
appears right under it:

> **Does** Fetches the user by id and attaches its roles.
> **Why** The order needs the user's email for the audit below.
> **Watch** ⚠️ Returns null when the id is unknown.
> **Throws** 🔥 NotFoundError (from getUser) — caught by `catch (err)` L23

Press **F11** on a call and you are inside the callee, with a one-line summary, where it is
called from, and the reason you came. **Shift+F11** brings you back. Reach an `if` and F10 asks
which branch to read. Reach a `throw` and F10 takes you to the `catch` that receives it — or
tells you it leaves the function. It feels like a debugger because it *is* one: a real VS Code
Debug Adapter, with the native toolbar, call stack, breakpoints and variables views.

Nothing is executed. The model never guesses what a function does: the extension resolves the
callees, the types, the throw sites and even the **test names that describe the function**, and
hands all of that to a small model that runs on your machine.

## Install

**Nothing to configure.** The first explanation downloads a 2.1 GB model (Qwen2.5-Coder 3B)
into the extension's storage, once, after asking you. Then it is all local, ~0.5 s per line.

- **VS Code Marketplace / Open VSX**: search for *Explain Mode* (when published).
- **VSIX**: grab the file for your platform from the [releases page](https://github.com/MisterPandaPooh/explain-mode/releases),
  then `Extensions → ⋯ → Install from VSIX…`. Works in **VS Code** and **Cursor**.

Prefer your own stack? Pick it from the status bar: Ollama (any model), GitHub Copilot models,
an OpenAI-compatible API, the Claude Code CLI or the Cursor CLI — see [Providers](#providers).

## 60-second tour

| Do this | You get |
|---|---|
| Put the cursor on a line, `Cmd/Ctrl+Alt+E` | the session starts there; the first card appears |
| `F10` | next statement, explained |
| `F11` on `getUser(id)` | inside `getUser`, with its summary and who calls it |
| `Shift+F11` | back to the call site, on the next statement |
| `F10` on an `if` | *then / else / both* — pick the path to read |
| `F10` on a `throw` | jumps to the `catch` that receives it, or says it leaves the function |
| 💥 (toolbar) on a call that *may* throw | follows that possibility instead of the happy path |
| `F9` then `F5` | runs silently to the breakpoint — across calls, like a debugger |
| ▶▶ (toolbar) or `Cmd/Ctrl+Alt+A` | **auto-walk**: advances every few seconds; `F6` pauses |
| ◀ Step Back | previous stops, call stack included |
| hover a variable | an example value that matches its type (`user = { id: "u_42" } // or: null`) |
| type in the Debug Console | a question about the current line, answered with its context |

<p align="center">
  <img src="images/step-into.png" width="380" alt="Step Into: call stack and callee summary">
  <img src="images/branch.png" width="380" alt="Branch choice on an if">
</p>

## Languages

| Walker | Languages | Precision |
|---|---|---|
| TypeScript compiler | TypeScript, JavaScript, TSX, JSX | exact: statements, `if` branches, `try/catch/finally`, throws |
| tree-sitter (`web-tree-sitter` + a 0.5–1 MB grammar) | Python, Rust | exact: `raise`/`except`, `?`/`Err`/`panic!`, `match` arms as branches |
| LSP-generic (document symbols + selection ranges + keyword tables) | Go, Java, Kotlin, Scala, C#, C, C++, Objective-C, Dart, Swift, PHP, Ruby | depends on the language server; branches and `try` by indentation/braces |

Step Into works even without a language server: the walker finds the function in the file,
then in the workspace. With one (Pylance, rust-analyzer, gopls…) you also get types and callers.

## Providers

`explain.provider` picks the model; everything (steps, summaries, values, console) goes through it.
Change it from the status bar (`Explain: embedded · Qwen2.5-Coder 3B`).

| Provider | Needs | Per-step | Notes |
|---|---|---|---|
| `embedded` (default) | nothing: llama.cpp (`node-llama-cpp`) inside the extension, model downloaded once after confirmation | ~0.7 s | one model, the measured sweet spot; +55 MB of extension (native binary per platform) |
| `ollama` | Ollama + any model (`explain.model`) | ~0.4 s | tiers measured in [bench/RESULTS.md](bench/RESULTS.md): `qwen2.5-coder:0.5b` (0.4 GB) → `3b` (default) → `7b` → `qwen2.5:14b` (9 GB); above 2 GB latency grows faster than accuracy |
| `openai` | base URL + `Explain Mode: Set API key` | 1–3 s | OpenRouter, OpenAI, LM Studio, vLLM, Ollama's `/v1`; the key lives in VS Code secret storage |
| `vscode-lm` | GitHub Copilot (or any Language Model Chat Provider extension) | 1–3 s | one consent prompt; not available in Cursor |
| `claude-cli` | Claude Code CLI signed in (subscription or key) | ~2 s amortized | one call per **function**, a pool of persistent sessions, `--effort low`; API-key env vars are hidden so it can only use your login |
| `cursor-cli` | Cursor Agent CLI, `agent login` once | ? | reuses the Cursor subscription; pick the model (effort is in its name) from the status bar |

On seconds-per-call providers the extension makes **one call per function**: the function, its
resolved callees, types, tests and throw sites go once, and every statement, the summary and the
example values are cached from that single answer. Local models keep one call per statement.

Your code leaves your machine only with `openai`, `vscode-lm`, `claude-cli` or `cursor-cli` — and
only to the service you chose.

## Settings worth knowing

| Setting | Default | What it does |
|---|---|---|
| `explain.provider` | `embedded` | the model backend |
| `explain.language` | `English` | language of the prose (labels stay) |
| `explain.askBranch` | `true` | F10 on an `if` asks which branch to follow |
| `explain.auto.dwellMs` | `3000` | milliseconds per line in auto-walk |
| `explain.prefetch` | `3` | statements prepared ahead while you read |
| `explain.context.definitionDepth` | `2` | go-to-definition levels fed to the model |
| `explain.exampleValues` | `true` | one extra local call per statement for example values |

## How it is built

A Debug Adapter that runs nothing: "execution" is walking statements of the AST. That buys the
native toolbar, F-keys, call stack and breakpoints for free. Deterministic facts (callees, types,
throw sites, tests, callers) are gathered through the language server and the AST, then a small
model turns them into three lines — it never has to guess, which is why a 3B model is enough.

Layout: `src/adapter.ts` (stepping, breakpoints, auto-walk, throw flow), `src/lang/`
(walkers + registry), `src/providers/` (one file per backend + registry), `src/context.ts` (what
the model sees), `src/explain.ts` (prompts), `src/ui.ts` (thread, hover, pickers).

## Develop

```bash
npm install
npm run build          # esbuild bundle + grammars → dist/
npm run typecheck
npm run test:dap       # headless Debug Adapter harness (:auto, :throw, :batch variants)
npm run test:lang      # steps every language walker produces on the samples
npm run bench          # prompt bench against the local model
```

Open the repo in VS Code, **F5** → an Extension Development Host on `sample/`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to add a language or a provider.

VS Code gotchas met here, all silent: `@vscode/debugadapter` dispatches `setBreakpoints` to
`setBreak**P**ointsRequest`; manifest contributions load only when a host **window starts**
(close it, launch a new one); the debug toolbar menu id is `debug/tool**B**ar`; `web-tree-sitter`
must stay outside the esbuild bundle (its `createRequire(import.meta.url)`).

## Similar tools

Plenty of extensions explain a *selection* (Copilot, Continue, Cody, Ollama front-ends), and a few
narrate a *walkthrough* a coding agent wrote (AI Code Walkthrough, Agent Walkthrough, Code
Walkthrough — Claude-backed). CodeTour plays recorded tours. What they do not do is the debugger
part: deterministic stepping through the call graph, branch choice, exception flow, breakpoints,
step back — with the explanation following you. That is the gap Explain Mode fills, locally.

## License

MIT — see [LICENSE](LICENSE).
