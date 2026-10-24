# Changesets

Run `npx changeset` to describe a change (patch for YouTube-breakage fixes, minor for features).
Use a major changeset for breaking changes. Versions follow Semantic Versioning.

Once the repository's `NPM_TOKEN` Actions secret is configured and GitHub Actions is allowed to create pull requests,
merging to `main` opens a "Version packages" PR; merging that PR publishes to npm with provenance.
Without the secret, the release workflow runs its checks and skips publishing.

For a local release, run `npx changeset version`, review and commit the version, lockfile and changelog, then run
`npm run build`, `npm test`, `npm run check:exports` and `npm run smoke:pack`. Publish with `npm publish --access public`,
tag that commit as `v<version>`, push the commit and tag, and create the matching GitHub release.
