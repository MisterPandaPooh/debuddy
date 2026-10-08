# Changelog — DeBuddy

## 0.1.2 — 2026-10-09

- While the auto-walk runs, only Pause / Restart / Stop remain: the throw and settings buttons
  hide along with ▶▶.
- README: Marketplace and Open VSX links and live version badges, keycaps, wording.

## 0.1.1 — 2026-10-09

- The provider warms up when a session starts (status bar: "loading model…"), overlapping with
  the first explanation; `explain.preload` loads it as soon as a supported file opens (off by default).
- Cursor CLI found automatically (`agent` or `cursor-agent`, PATH or `~/.local/bin`).
- The ▶▶ auto-walk button and shortcut disappear while the auto-walk runs.
- README: real screenshots, keycaps, logo; publishing through Microsoft Entra ID (no PAT).

## 0.1.0 — 2026-10-09

First public release.

- Debugger-like static walkthrough: Step Over / Into / Out, run to breakpoint, Step Back,
  auto-walk (▶▶ / F6), branch choice on `if … else` / `match`, Step Over skips a lone `if` or loop
  body while Step Into reads it, guard clauses flagged, `try` / `catch` / `finally` steps,
  follow-the-exception.
- Explanations as a comment thread under the statement: Does / Why / Watch, deterministic
  **Throws** and where it lands, example values in the hover and Variables view, questions in
  the Debug Console.
- Deterministic context: resolved callees (2 levels), expanded types, test titles as spec,
  throw sites, callers at Step Into, whole function with the current line marked.
- Languages: TypeScript/JavaScript (compiler), Python and Rust (tree-sitter), LSP-generic
  walker for Go, Java, Kotlin, C#, C/C++, Swift, PHP, Ruby, Dart, Scala, Objective-C.
- Providers: embedded llama.cpp (default, Qwen2.5-Coder 3B downloaded once), Ollama,
  OpenAI-compatible, VS Code language models (Copilot), Claude Code CLI (session pool, one call
  per function), Cursor Agent CLI.
- Measured model tiers in `bench/RESULTS.md`.
