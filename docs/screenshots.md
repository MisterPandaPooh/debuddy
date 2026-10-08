# Screenshots for the README

Four images, captured in the Extension Development Host on `sample/` (dark theme, ~1200 px wide).
Save them under `images/` with these exact names; the README already points at them.

| File | What to show | How |
|---|---|---|
| `images/walkthrough.png` | the comment thread under a line: banner, Does / Why / Watch / Throws | `order.service.ts` L14, `Cmd+Alt+E` |
| `images/step-into.png` | call stack with two frames + the `↳ audit()` header and "Called from" | from L16, `F11` |
| `images/branch.png` | the QuickPick `then / else / both` | L15, `F10` |
| `images/providers.png` | the provider QuickPick from the status bar | click `Explain: …` in the status bar |

A 15-second GIF of `▶▶` auto-walking `saveOrder()` (`images/auto-walk.gif`) is worth all four.
