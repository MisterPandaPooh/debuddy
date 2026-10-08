# Publishing

One-time setup, then a release is a tag push.

## 1. VS Code Marketplace (one time)

No Personal Access Token anywhere (Azure DevOps retires them on 2026-12-01): the Marketplace is
reached through Microsoft Entra ID with a federated credential — GitHub proves who it is through
OIDC, nothing expires, nothing to rotate.

### Publisher

Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create the
publisher **`MisterPandaPooh`** — the id must equal `"publisher"` in `package.json`.

### Entra ID identity for GitHub Actions (recommended, no secret)

1. <https://entra.microsoft.com> (same Microsoft account; a free tenant is enough, no Azure
   subscription needed) → *App registrations* → **New registration** → name `debuddy-publisher`,
   single tenant. Note the **Application (client) ID** and the **Directory (tenant) ID**.
2. In the app → *Certificates & secrets* → **Federated credentials** → *Add* → scenario
   **GitHub Actions deploying Azure resources**: organization `MisterPandaPooh`, repository
   `debuddy`, entity type **Environment**, environment name **`marketplace`**. Save.
3. Back on <https://marketplace.visualstudio.com/manage> → publisher → **Members** → *Add* → paste
   the app's **Application (client) ID**, role **Contributor**. (If the page cannot find it, add it
   after a first `az login` as that app and the `az rest … /profiles/me` call from the VS Code docs.)
4. GitHub repo → *Settings → Environments* → **New environment** `marketplace` (optionally require
   your approval before each publish). In it, add two **variables** (not secrets):
   `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`.

That is all: the `Release` workflow signs in with `azure/login` (OIDC) and runs
`vsce publish --azure-credential` for each VSIX.

### No automation at all

Upload the four VSIX files by hand on the management page (first one with *New extension*, the
others with *⋯ → Update*). No token of any kind; five minutes per release.

## 2. Open VSX = the Cursor marketplace (one time)

Cursor, VSCodium, Windsurf and Gitpod have no registry of their own: their extension panels read
Open VSX. Publishing there is what puts DeBuddy in Cursor's search results.

1. Sign in at <https://open-vsx.org> with GitHub, accept the Eclipse publisher agreement
   (Profile → *Publisher Agreement*), create an access token (Profile → *Access Tokens*).
2. Create the namespace once: `npx ovsx create-namespace MisterPandaPooh -p <token>`.
3. `gh secret set OVSX_PAT` and paste the token (Open VSX is not affected by the Azure PAT retirement; rotate it when it expires).

Without the Entra variables / the Open VSX token, the release workflow still builds the VSIX
files and attaches them to a GitHub release; only the publish steps are skipped.

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
az login --tenant <AZURE_TENANT_ID>   # the same Microsoft account, member of the publisher
npx @vscode/vsce publish --azure-credential --target darwin-arm64
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
- Nothing to rotate on the Marketplace side (OIDC). The Open VSX token lives until you revoke it;
  if you ever regenerate it: `gh secret set OVSX_PAT` again.
