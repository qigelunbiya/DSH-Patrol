# Publishing DSH Patrol to npm

This repository is structured so the npm package contains prebuilt `lib/` output. Users who install from npm therefore do not need to allow a Git dependency `prepare` script.

## Target user install command

```bash
dsh plugin --profile web add dsh-patrol
```

For a Harness source checkout, the equivalent command is:

```bash
pnpm dsh plugin --profile web add dsh-patrol
```

## First publish: one-time bootstrap

The first npm publish must be done interactively because an npm Trusted Publisher can only be attached after the package exists in the registry.

Do not paste npm passwords, 2FA codes, or access tokens into GitHub issues, chat messages, or repository files.

From a clean `main` checkout:

```powershell
git checkout main
git pull --ff-only origin main
pnpm install --no-frozen-lockfile
pnpm typecheck
pnpm test
pnpm check:extension
pnpm check:encoding
pnpm build
npm publish --dry-run
npm login
npm whoami
npm publish --access public
```

The current package version is a prerelease version. Publishing without a custom dist-tag intentionally makes it the default install target so users can use the simple `dsh plugin ... add dsh-patrol` command. Keep the README's alpha warning visible until a stable release is cut.

After publishing, verify:

```powershell
npm view dsh-patrol version
npm view dsh-patrol dist-tags
```

Then test installation in a disposable or development profile before promoting the package broadly.

If npm reports that the unscoped name `dsh-patrol` is unavailable, do not publish under a confusingly similar name. Switch the package to an owned scope such as `@qigelunbiya/dsh-patrol`, update README/install commands, and republish.

## Enable npm Trusted Publishing

After the first package version exists on npmjs.com, configure a Trusted Publisher for future releases:

- Provider: GitHub Actions
- GitHub user/organization: `qigelunbiya`
- Repository: `DSH-Patrol`
- Workflow filename: `publish.yml`
- Allowed action: allow direct `npm publish`

The workflow already requests `id-token: write` and uses a GitHub-hosted runner. No long-lived `NPM_TOKEN` is required after Trusted Publishing is configured.

## Future releases

1. Update `version` in `package.json`.
2. Commit and push to `main`.
3. Wait for CI to pass.
4. Open GitHub Actions → **Publish npm** → **Run workflow** on `main`.
5. Verify the published npm version.
6. Create the matching GitHub Release/tag and write release notes.

Never reuse an npm version. If a publish fails after the registry accepted the package, bump to a new version before retrying.

## Why npm is preferred over GitHub-source installation

Git-hosted TypeScript dependencies need a `prepare` build after download. pnpm 10+ requires users to explicitly allow that dependency build. The npm package is packed after `lib/` is built, so normal npm installation receives runnable JavaScript and avoids that permission prompt.

The CI pack smoke test verifies that the tarball contains the main runtime, preset installer, browser runtime, browser extension, cleanup runtime, presets, docs, and package metadata before changes are considered healthy.
