# Changesets

This directory contains [changesets](https://github.com/changesets/changesets) — tiny markdown files that describe a change and the version bump it warrants. Every PR with a user-visible change should include one.

To add a changeset:

```sh
npm run changeset
```

Pick the version bump (`patch`, `minor`, `major`) and write a short summary. The release workflow on `main` will batch open changesets into a "Release PR" — merging it bumps the version, updates `CHANGELOG.md`, and publishes to npm.
