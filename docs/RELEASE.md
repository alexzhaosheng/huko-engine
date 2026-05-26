# Release process

This package publishes to npm as `@alexzhaosheng/huko-engine`. Tags
trigger publication; no manual `npm publish` from a laptop.

## One-time setup

Add an npm **automation token** with publish rights on
`@alexzhaosheng/huko-engine` as the GitHub repo secret `NPM_TOKEN`.

```
Settings → Secrets and variables → Actions → New repository secret
  Name:  NPM_TOKEN
  Value: npm_********  (from https://www.npmjs.com/settings/<user>/tokens)
```

The publish workflow also needs `id-token: write` for npm provenance
attestation — already declared in `.github/workflows/release.yml`.

## Cutting a release

1. **Verify state**
   - `main` is green (CI passing on the latest commit)
   - CHANGELOG entry written for the new version
   - No uncommitted changes locally

2. **Bump version**
   - Pick the bump per [semver](https://semver.org/):
     - `patch` — bug fixes, doc-only changes
     - `minor` — new public API, no breaking change
     - `major` — any breaking change to the public facade
   - `npm version <patch|minor|major>` rewrites `package.json` AND
     creates a `v<x.y.z>` commit + tag in one go. Verify the tag
     matches the version you intended.

3. **Push**
   - `git push origin main --follow-tags`
   - Watch the `release` workflow at
     https://github.com/alexzhaosheng/huko-engine/actions
   - On success: package lands on npm within ~1 minute. Check
     https://www.npmjs.com/package/@alexzhaosheng/huko-engine

## What the workflow does

`release.yml` triggers on tags matching `v*`:

1. Checkout, install deps via `npm ci`
2. Verify the tag's version matches `package.json` (catches the
   "tagged v0.2.0 but package.json still says 0.1.0" mistake)
3. `npm publish --provenance --access public`
   - `prepublishOnly` in `package.json` runs check + test + build
     BEFORE the publish, so a broken build can't ship
   - `--provenance` attests the tarball was built by this exact CI
     run (https://docs.npmjs.com/generating-provenance-statements)
   - `--access public` is required for scoped names on first publish;
     harmless on subsequent publishes

## Rollback

npm allows unpublishing within 72 hours, but **don't rely on it**.
The right move when a bad version ships:

- Cut a patch release that fixes / reverts the issue
- Deprecate the bad version: `npm deprecate @alexzhaosheng/huko-engine@x.y.z "use x.y.z+1; broken because ..."`
- Communicate via the GitHub repo (issue + release notes)

## Manual publish (escape hatch only)

If CI is broken and you absolutely must ship:

```sh
npm run check && npm run test && npm run build
npm publish --provenance --access public
```

Document why a manual publish was required in the next CHANGELOG entry.
