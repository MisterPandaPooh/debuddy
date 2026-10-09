# Changelog — DeBuddy

## 0.1.3 — 2026-10-09

- Prefetch is a window now: `explain.prefetch.ahead` statements along the Step Over path (10),
  the first `explain.prefetch.into` statements of every project callee in it (5),
  `explain.prefetch.depth` levels down (2), prepared in the background with
  `explain.prefetch.parallel` calls in flight (2). The statement on screen never waits behind it,
  and every stop extends the window (infinite scroll). Replaces `explain.prefetch`.
- Auto-walk prepares that window first, with a progress notification and the same count with a
  percentage under the current line (Cancel starts walking now).
- Session start: a loader under the line ("Getting the local model ready…", "Explaining the
  first statement…"); VS Code is told we stopped only once the provider has answered and the
  first statement is explained. The Claude session pool warms up by running one turn per session.
- First-run dialog: "Set up another provider…" opens the provider picker. Picking Embedded there
  asks for the download again even if the first dialog was dismissed. A session that was waiting
  for the download, or whose provider/model changed from the status bar, restarts from scratch.
- Claude CLI: `--setting-sources "" --disable-slash-commands` (~3.3 s per turn instead of ~4.5 s);
  `explain.claude.settingSources` loads settings.json back when the login needs it. `--bare` is
  not usable with the subscription login (API key only).
- The auto-walk context key is reset at launch and when the walk ends, so ▶▶ / 💥 / ⚙ cannot
  stay hidden after a session ended mid-walk.
- README: model providers (subscriptions), language logos, card on four lines, highlights table.

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
