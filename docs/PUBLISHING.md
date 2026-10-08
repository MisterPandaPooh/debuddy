# Publishing

One-time setup, then a release is a tag push.

## 1. VS Code Marketplace (one time)

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create
   the publisher **`MisterPandaPooh`** — the id must equal `"publisher"` in `package.json`.
2. Create a Personal Access Token at <https://dev.azure.com> → user settings → *Personal access
   tokens* → **Organization: All accessible organizations**, **Scopes: Marketplace → Manage**,
   expiry up to one year.
3. Store it in the repo (never in a file): `gh secret set VSCE_PAT` and paste the token.

## 2. Open VSX — Cursor, VSCodium, Gitpod (one time)

1. Sign in at <https://open-vsx.org> with GitHub, accept the Eclipse publisher agreement
   (Profile → *Publisher Agreement*), create an access token (Profile → *Access Tokens*).
2. Create the namespace once: `npx ovsx create-namespace MisterPandaPooh -p <token>`.
3. `gh secret set OVSX_PAT` and paste the token.

Without these secrets the release workflow still builds the VSIX files and attaches them to a
GitHub release; only the two publish steps are skipped.

## 3. Release

```bash
# bump the version and the changelog
npm version 0.1.0 --no-git-tag-version
$EDITOR CHANGELOG.md
git commit -am "release: 0.1.0"
git tag v0.1.0
git push origin main v0.1.0
```

The `Release` workflow then: checks the tag equals `package.json`, runs typecheck + harness,
builds one VSIX per platform (darwin-arm64, darwin-x64, linux-x64, win32-x64), creates the GitHub
release with the four files, and publishes each to the Marketplace and Open VSX.

First time, publish one platform by hand to validate the publisher before trusting CI:

```bash
npm run build
VSCE_PAT=… npx @vscode/vsce publish --target darwin-arm64
```

## 4. Check

- Marketplace: <https://marketplace.visualstudio.com/items?itemName=MisterPandaPooh.debuddy>
  (the page shows the README; relative image links are rewritten to the GitHub repo because
  `repository` is set, so the screenshots must be committed under `images/`).
- Open VSX: <https://open-vsx.org/extension/MisterPandaPooh/debuddy>.
- In a clean VS Code: install, open a TS file, `Cmd/Ctrl+Alt+E`, accept the model download.

## Notes

- Platform-specific VSIX: each file carries one `@node-llama-cpp` binary; the Marketplace serves
  the right one by the user's platform. A user on an unlisted platform (linux-arm64, win-arm64)
  gets nothing until that target is added to the matrix.
- The GPU variants (CUDA/Vulkan) are excluded on purpose; the default binary uses Metal on macOS
  and CPU elsewhere.
- Rotate the tokens before they expire: `gh secret set VSCE_PAT` again.
