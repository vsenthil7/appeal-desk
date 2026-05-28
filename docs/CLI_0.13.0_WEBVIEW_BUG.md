# Devvit CLI 0.13.0 web-view rendering bug — root cause + fix

> **Date:** 2026-05-28 07:25 BST
> **Symptom:** the "Appeal-Desk: create dashboard" menu item successfully
> creates a custom post, but the post's web view renders as a blank white box
> (no header, no tabs, no "Launch App" button — completely empty).

## Root cause

A genuine bug in **Devvit CLI 0.13.0** (the stable release). The CLI's
config parser and its Blocks bootstrap template disagree on the shape of the
`post` config:

- `@devvit/shared-types/schemas/config-file.v1.js#AppPostConfig` parses
  `devvit.json`'s `post` into `{ dir, entrypoints }` (matching the published
  JSON schema).
- But `@devvit/build-pack/esbuild/templatizer/blocks.template.js#configurePost`
  reads `post.client.entry` and `post.client.dir` — a shape that no longer
  exists in the parsed config.

So `post.client` is `undefined` at render time, `post.client.entry.replace(...)`
throws, `addCustomPostType` is never called, and the custom post has no
renderer → blank box. (The post itself still gets created because our
`/internal/menu/create-dashboard` server endpoint calls `reddit.submitCustomPost`
independently of the Blocks bootstrap.)

The 0.13.0 template even rendered a stub `"Launch App"` button plus a stray
`";"` text node — clearly mid-migration, half-broken code. The
`// to-do: just return post once classic is removed` comments throughout
`project.js` confirm it.

## Fix

Upgrade the global Devvit CLI from `0.13.0` (stable) to
`0.13.1-next-2026-05-27-...` (prerelease):

```
npm install -g devvit@next
```

The 0.13.1 build-pack template replaces `configurePost` with a comment that
says it all:

> "Posts are no longer configured here. Native Blocks apps are no longer
>  supported, and Devvit Web apps no longer use a Blocks bootstrap, opting
>  instead to directly render the entrypoint..."

i.e. 0.13.1 renders the web-view entrypoint **directly** — no Blocks
bootstrap, no `post.client` mismatch, no "Launch App" stub. The blank-box
bug is gone.

## Versions

| Component | Was | Now |
|---|---|---|
| Global `devvit` CLI | 0.13.0 | 0.13.1-next-2026-05-27-22-50-14-2f8c5db01.0 |
| `@devvit/public-api` | 0.13.0 | 0.13.0 (unchanged — still works) |
| `@devvit/web` | 0.13.0 | 0.13.0 (unchanged) |
| App version on dashboard | 0.0.11 | 0.0.12 |
| Install on r/appeal_desk_dev | 0.0.11 | 0.0.12 |

The project's `@devvit/*` package deps did NOT need bumping — only the CLI
that does the bundling. v0.0.12 uploaded + installed cleanly with the new
CLI.

## Action for verification

The OLD dashboard post (created under v0.0.11's broken renderer) may stay
blank — its render path was baked at creation. Create a FRESH dashboard
post via the menu item under v0.0.12; that one uses the direct-render path
and should show the full UI.

## Note for CI / other devs

Anyone building this app must use Devvit CLI **>= 0.13.1**. With 0.13.0 the
web view renders blank. This is a CLI-level requirement, not expressible in
package.json (the CLI is installed globally), so it's documented here and in
the README's build section.
