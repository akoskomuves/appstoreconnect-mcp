# Contributing

Thanks for considering a contribution. This project is small enough that the bar is low — a focused PR with a changeset is usually all it takes.

## Dev setup

Requires Node 22 LTS or newer.

```sh
git clone https://github.com/akoskomuves/appstoreconnect-mcp.git
cd appstoreconnect-mcp
npm install
cp .env.example .env   # fill in your ASC credentials for local testing
npm run dev
```

## Working on a change

1. Branch from `main` (`feat/...`, `fix/...`, `docs/...`).
2. Run `npm run lint` and `npm test` before pushing.
3. Add a changeset: `npm run changeset`. Pick `patch` for bugfixes, `minor` for new tools/domains, `major` for breaking changes.
4. Open a PR. CI runs typecheck, lint, tests, and build on every push.
5. The release workflow on `main` opens a "Release PR" that batches changesets — merging it publishes to npm.

## Adding a new ASC domain

The architecture is plug-in: each App Store Connect domain lives in `src/domains/<name>.ts` and exports one `register<Name>(server, client)` function. To add e.g. TestFlight:

1. Create `src/domains/testflight.ts`.
2. Register tools with `server.registerTool(name, { title, description, inputSchema }, handler)`.
3. Wire it up in `src/index.ts`.
4. Add a section to the README under [Tools](README.md#tools).
5. Tests in `tests/domains/testflight.test.ts` mocking the HTTP layer.

Keep tool names prefixed `asc_<domain>_<verb>` for grep-ability.

## Style

- Biome handles lint + format. CI fails on violations; run `npm run lint:fix` locally.
- TypeScript: strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Use `import type { ... }` for type-only imports.
- Imports use the `.js` extension on relative paths (NodeNext ESM).

## Tests

Vitest. Mock the HTTP boundary, not the JWT signing — the auth layer's correctness is *the* hardest thing about this codebase, so it gets real tests against generated keys.

## Commits

Conventional Commits encouraged but not enforced (changesets handles changelog generation, not the commit log).

## Code of Conduct

Be kind. Issues and PRs that aren't are closed without further engagement.

## Release process (maintainer notes)

Releases are driven by [changesets](https://github.com/changesets/changesets) and [`changesets/action`](https://github.com/changesets/action). The flow:

1. Every PR that changes user-visible behaviour adds a `.changeset/*.md` (`patch` / `minor` / `major`) describing the change.
2. When changesets are present on `main`, the release workflow opens a "chore: release" PR that bumps `package.json` version, regenerates `CHANGELOG.md`, and consumes the changesets.
3. Merging the release PR triggers the publish step:
   - `npm run build` produces the `dist/` artifacts.
   - `changeset publish` pushes the new version to npm with provenance enabled.
   - `createGithubReleases: true` auto-creates a GitHub Release for the new tag with the changelog notes.

Required repo secret: `NPM_TOKEN` — an npm Automation token with publish access to the `appstoreconnect-mcp` package. Set with:

```sh
gh secret set NPM_TOKEN -R akoskomuves/appstoreconnect-mcp
```

(Settings → Actions → General → Workflow permissions must be set to "Read and write" with "Allow GitHub Actions to create and approve pull requests" for the version-PR step to work.)
