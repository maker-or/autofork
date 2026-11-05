---
name: autofork
description: Fork a repo and keep your changes to it working as upstream moves. Use when asked to fork, customize or patch someone else's project, when changing code in a repo that has an .autofork/ folder, or when a fork's installed app should update itself from the fork.
---

# autofork

A fork with an `.autofork/` folder is upstream plus patches. A workflow rebuilds it from upstream: patches that still apply go in with git, and an agent rebuilds the rest from their `PATCH.md`.

```
.autofork/<id>/
├── PATCH.md      what the change does and why
└── <id>.patch    the diff, written by autofork
```

## Fork a repo

```sh
npx autofork fork owner/repo
```

It follows upstream's releases, or its default branch if it has none. `--follow <branch>` picks a branch; `--follow 'v*-nightly.*'` picks a channel of releases by tag; stable is `releases`, the default. To see the channels upstream publishes, list its releases (`gh release list -R owner/repo --exclude-drafts -L 100`) and its tags (`git ls-remote --tags --refs --sort=-v:refname <url> | head -100`), since a channel can be published as tags alone. A channel's pattern keeps the part of the tag that names it and puts `*` for the numbers, like `v*-nightly.*`: `*` matches anything, so a pattern without that part also matches other channels, and a `follow` without `*` is read as a branch. It needs `gh` logged in. In a fork that's already cloned, use `npx autofork init owner/repo` instead, with upstream's name, and save the fork's own changes as patches before pushing.

If `CLAUDE_CODE_OAUTH_TOKEN` is set, `fork` also adds that secret. Otherwise give the user the sign-in steps it prints, for Claude or ChatGPT, then run `gh workflow run autofork.yml --repo <fork>`: the run `fork`'s push started fails without the secret, and this one builds the README line if `fork` wrote one.

GitHub runs the workflow on the `cron` line in `.github/workflows/autofork.yml`, often hours late. `npx autofork link`, run in the clone once the config is pushed to the fork's default branch, has autofork.com start syncs within a minute of upstream changing. The user finishes it in a browser at `https://autofork.com/link/<owner>/<name>`, signing in with GitHub and adding autofork's app to the fork, and `link` waits up to 10 minutes for that, so give the user the link and run `link` in the background or again once they're done. Like `workflow-token-url`, the app lets code the sync runs push workflow files, so say so when offering it.

`verify` is the check a sync has to pass before it pushes, and `setup` installs what it needs. Leave both out and the first agent run picks them from upstream's CI; until one runs, syncs push without a check. When the user names a check, give it with `--verify "<command>"` and its install with `--setup "<command>"`, since a fork with its own `verify` gets no picked `setup`. A check should pass on upstream as it is (or, when upstream can't build on its own, like a package split out of a monorepo, with the patch that makes it build) and give the same answer every run. Set up the tools both need in `.github/workflows/autofork.yml`, before the autofork step. List the files `setup` writes, like lockfiles, with `--generated <file>,<file>`: they stay out of patches and are rebuilt once the patches are in.

## Change a fork

Start from a fork whose first sync has run: once it has the sign-in, wait for the autofork run you started to finish (`gh run list --repo <fork> -w autofork.yml -L 1`), then `git pull`.

1. Make the change.
2. Write `.autofork/<id>/PATCH.md`, the prose an agent rebuilds the change from after upstream rewrites that code: what the user wants and why, and why it's built the way it is where upstream does it differently. Write it from what the user asked for; a commit message or diff only says how.
3. Run `npx autofork save <id>`.
4. Commit everything and push.

Every source change must belong to a patch: once upstream moves, a sync refuses to rebuild while the fork has changes no patch holds, and `npx autofork status` lists them. To change an existing patch, edit the code, update its `PATCH.md` if the intent changed, and `save` the same id. `save` puts every change no patch holds yet into `<id>`, so save each change before starting the next. To drop a patch, delete its folder and undo its change in the same commit. When a change reaches code `verify` doesn't check, widen `verify` in `.autofork/config.json`.

A patch can also be just a `PATCH.md`. Push it and the next sync has an agent build it.

A sync that fails opens an `autofork sync failed` issue saying why, with a link to the run. Fix what it names, push, and start a sync with `gh workflow run autofork.yml --repo <fork>`.

Patches go on in the alphabetical order of their ids, each on top of the ones before it. Give a patch the others need, like one that makes the project build on its own, an id that sorts first, like `0-standalone`.

## When upstream has a patch

If `.autofork/<id>/UPSTREAM.md` exists, upstream shipped its own version of that patch and autofork stopped applying it. Show the user what it says and ask which they want. Upstream's: delete `.autofork/<id>/`. Theirs: update `PATCH.md` to say how theirs differs from upstream's, delete `UPSTREAM.md`, and push; the next sync rebuilds it.

## When upstream changes a workflow

`.github/workflows/` is the fork's own, and the rest of `.github/` syncs like code, so a fork's own changes there, like a composite action its release workflow uses, are saved as a patch. When upstream changes a workflow the fork keeps a copy of, the sync's agent brings over what the fork's copy needs. Pushing that takes a token that can push workflow files, which a workflow's own GitHub token can't: forks made on autofork.com get one from autofork's GitHub app. For another fork, install the app (https://github.com/apps/autofork-app), then give the autofork step `workflow-token-url: https://autofork.com/api/github/token` and the workflow `id-token: write`. Code the sync runs can reach that token too, so ask the user before turning it on. Without one, the sync opens an issue. Bring over what the fork needs from upstream's change, keeping what the fork's copy does differently, or delete copies the fork doesn't run. Then close the issue.

## Spend limits

Every agent run counts against `limits` in `.autofork/config.json`: by default 10 rebuilds a month (UTC), $200 a month and $20 a rebuild, at API prices (on a Claude or ChatGPT plan, what the run would cost on the API, not a bill). With no room the sync ends `waiting`, and one line in the run's log says what's left and when it runs. To let a waiting sync run now, raise each key the line names, by as much as the user agrees to, and push.

## Apps that update themselves

A fork's code stays current on its own, but an installed app updates from wherever its updater points, which is upstream. When the user wants installs of the fork that update themselves, follow [releases.md](releases.md).
