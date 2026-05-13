# Push to GitHub

The repo is already initialized with the initial commit. Two paths to push:

## Option A: Use the prepared tarball (fastest)

The file `mssql-mcp-server-git.tar.gz` in this folder contains a fully prepared git repo
with the initial commit already made.

```bash
# Extract somewhere outside the Cowork session folder (Windows mount can corrupt .git)
mkdir ~/code/mssql-mcp-server && cd ~/code/mssql-mcp-server
tar -xzf "/path/to/mssql-mcp-server-git.tar.gz"

# Create the GitHub repo and push (single command)
gh repo create bherbruck/mssql-mcp-server --public --source=. --remote=origin --push

# That's it. CI runs immediately.
```

## Option B: Init from the existing files in this folder

If you'd rather start from the files already in this folder (not the tarball):

```bash
cd <this-folder>
git init -b main
git add -A
git commit -m "feat: initial mssql-mcp-server with Cowork plugin"
gh repo create bherbruck/mssql-mcp-server --public --source=. --remote=origin --push
```

## What happens next

1. **CI runs immediately.** `ci.yml` runs `npm test`, `tsc --noEmit`, `npm run build`,
   and `npm run build:plugin` on the initial commit. It attaches the built `.plugin`
   file as an artifact you can download from the Actions tab.

2. **release-please opens a release PR.** Watch the Actions tab — within ~30s
   `release.yml` will open a PR titled "chore(main): release 0.1.0". The PR body
   shows the changelog (generated from your conventional-commit messages).

3. **Merge the release PR to ship.** When you merge it, release-please:
   - tags `v0.1.0`
   - creates a GitHub Release
   - triggers the `build-plugin` job which builds `mssql-mcp-server.plugin`
   - uploads the `.plugin` to the Release assets

4. **Install in Cowork.** Download `mssql-mcp-server.plugin` from the Release,
   drop into Cowork chat, click install.

## Future releases

Use conventional-commit prefixes in commit messages:

| Prefix | Effect on version |
|---|---|
| `fix:` | patch bump (0.1.0 → 0.1.1) |
| `feat:` | minor bump (0.1.0 → 0.2.0) |
| `feat!:` or `BREAKING CHANGE:` in body | major bump (0.1.0 → 1.0.0) |
| `chore:`, `docs:`, `refactor:` | no version bump |

release-please will keep a rolling PR up to date with the next release. Merge it
whenever you want to cut a release.

## Manual release without release-please

If you'd rather skip release-please and tag manually:

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 --generate-notes
gh release upload v0.1.0 dist/plugin/mssql-mcp-server.plugin
```

(But you'd need to remove `release.yml` first or it'll complain.)
