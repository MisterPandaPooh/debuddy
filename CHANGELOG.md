# Changelog

## 0.1.0 — 2026-10-08

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
