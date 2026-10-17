<a href="https://autofork.com"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/header-dark.png">
  <img alt="autofork: Customized forks that maintain themselves." src="assets/header-light.png">
</picture></a>

Personal forks of open-source apps that auto-track upstream. Each change you make is saved in plain words, in a `PATCH.md`. On every upstream release your changes go back on top, and when one no longer applies, an agent rebuilds it from what you wrote, in your fork's own GitHub Actions, on your Claude or ChatGPT plan.

Fork something at [autofork.com](https://autofork.com), or from a terminal:

```sh
npx github:AVGVSTVS96/autofork fork pingdotgg/t3code
```

That forks the repo, clones it and adds the autofork workflow, plus one line under your README's title saying it's a personal fork that updates itself with autofork. That line is a patch like any other, `.autofork/fork-readme`; to drop it, delete the line and the folder. Set `CLAUDE_CODE_OAUTH_TOKEN` first (`claude setup-token` prints one) and it adds that secret too. Already have a fork? Run `init owner/repo` inside it.

## Patches

Each change you keep is a folder in `.autofork/`:

```
.autofork/context-usage/
├── PATCH.md              what it does and why
└── context-usage.patch   the diff
```

Change the code, write the `PATCH.md`, and save the diff:

```sh
npx github:AVGVSTVS96/autofork save context-usage
```

Or just write the `PATCH.md` and push. The workflow has an agent build it.

A `PATCH.md` is plain prose: what you want and why, and why it's built the way it is, not which lines it touches, so an agent can rebuild it on whatever upstream looks like next. This is the one in [my T3 Code fork](https://github.com/AVGVSTVS96/t3code/tree/main/.autofork/context-usage):

```md
Always show the thread's context usage in the composer.

Build it on whatever T3 Code shows for context at the time. Right now that's
the compact button next to send, which only shows up once a thread gets big:
keep it there all the time with the context number, as just the icon, without
the "Full"/"Compact" text. Clicking it still makes the next send compact first.

If T3 Code knows whether the prompt cache is still warm, say so in the
button's tooltip.

Once T3 Code shows context usage all the time by default, this patch is done.
```

A patch can also be a whole fork you've taken over. [hex-voice](https://github.com/AVGVSTVS96/hex-voice/tree/main/.autofork/hex-voice) started as David Mokos's Expo voice app template and is mine to maintain now. Its one patch holds every change, and its `PATCH.md` says what to take if upstream ever moves:

```md
If upstream ever updates, treat it as a new fork rather than the line this one
follows: bring in anything clearly valuable, judged by what these
customizations show this app cares about, like fixes, Expo and dependency
updates, and better audio, call handling or Persona animations. Leave out
what only serves the template's server, tools or web app.

Where upstream's opinions differ from ours, weigh ours more heavily: keep
hex-voice's behavior and design, and take upstream's change only where it
doesn't undo them.
```

## Updates

When upstream publishes a release, the workflow rebuilds your fork on it. Patches that still apply go in with git. When one doesn't, an agent rebuilds it from its `PATCH.md`, your `verify` command checks the build, and the result is pushed as a signed commit.

When upstream ships its own version of one of your patches, autofork stops applying it and opens an issue on your fork. The fork takes upstream's version, and the agent isn't called for that patch again. You decide what happens next: delete the patch's folder to keep upstream's, or say in its `PATCH.md` how yours differs and delete its `UPSTREAM.md` to bring yours back.

The agent only runs when a release breaks a patch. Between releases, the workflow's hourly check is git only and ends in seconds. A failed rebuild isn't retried until upstream or your fork changes; running the workflow by hand always retries.

Commit straight to your fork and the workflow leaves it alone until upstream moves. A rebuild would drop changes no patch holds, so then it stops once and lists them: save them as a patch and push, and the next run syncs.

To follow a channel like nightlies, put its tag pattern in `follow`, like `"v*-nightly.*"`. The fork then moves to the newest release whose tag matches, and `init` lists the channels upstream publishes. To follow a branch instead, set `"follow": "main"`. Every upstream commit then gets the same treatment.

An app that updates itself, like a desktop app, updates from upstream's releases until the fork publishes its own. The skill's [release steps](skills/autofork/releases.md) set that up once: a release workflow that runs after each sync, the updater pointed at the fork, and Mac builds signed so they can update without an Apple certificate. [My T3 Code fork](https://github.com/AVGVSTVS96/t3code/releases) works this way.

## Agents

```sh
npx skills add AVGVSTVS96/autofork
```

Your agent then knows how to fork a repo and keep its changes as patches.

## Codebase

The implementation is in `src/autofork.ts`. It contains the CLI commands (`fork`, `init`, `save`, `status` and `sync`) and the shared Git helpers they use. A sync builds patches in order in a temporary Git worktree, checks the result, then refreshes patch files and updates the fork. The `action.sh` entry point runs the built CLI in GitHub Actions; `action.yml` defines that action, and `dist/autofork.js` is the generated executable published by the package.

## Config

`.autofork/config.json`:

```json
{
  "upstream": "pingdotgg/t3code",
  "follow": "releases",
  "verify": "pnpm install --frozen-lockfile --ignore-scripts && pnpm --filter @t3tools/web typecheck"
}
```

| key | |
| --- | --- |
| `upstream` | `owner/repo`, or any git URL |
| `follow` | `releases` (the release GitHub marks as upstream's latest, or its newest version tag when it has no GitHub releases), a channel (a tag pattern like `v*-nightly.*`: the newest release whose tag matches) or a branch. Default: `releases`, or the default branch if upstream has no releases |
| `verify` | the command that checks a build |
| `agent` | the command that rebuilds a patch, prompt on stdin. Default: Claude Code when `CLAUDE_CODE_OAUTH_TOKEN` is set, otherwise Codex when it's signed in (a `CODEX_AUTH` secret holding `~/.codex/auth.json`) |
| `green` | when following a branch, `false` takes upstream's newest commit even when its checks failed |

`.github/workflows/autofork.yml` is yours too: change how often it checks, and set up what `verify` needs (Node, Bun, Rust) before the autofork step. The action takes `heal: false` to apply what still fits without calling the agent, if you want rebuilds on one schedule and heals on another. With Codex, give it `codex-auth-url` and `id-token: write` so a refreshed sign-in is saved back to the secret.

## Commands

```
$ npx github:AVGVSTVS96/autofork --help
autofork: Customized forks that maintain themselves.
Personal forks of open-source apps that auto-track upstream.

Usage:
  autofork fork <owner/repo>    fork it on GitHub, set it up and push
  autofork init <owner/repo>    set up a fork you already have, from inside it
  autofork save <id>            save your changes as the patch in .autofork/<id>
  autofork status               your patches, and changes no patch holds yet
  autofork sync                 rebuild on upstream; an agent heals what no longer applies

Options for fork and init:
  --follow <what>               releases (upstream's Latest), a channel of them
                                by tag, like 'v*-nightly.*', or a branch.
                                Default: releases, or the default branch if
                                upstream has none
  --verify <command>            the command that checks a build
```

## Roadmap

First batch of updates after launch:

- An option to re-check every change against what you asked for on each new release, not only when a release breaks it. Today a change is only revisited when it stops applying.

## History

- **May 2026:** [pi-patcher](https://github.com/AVGVSTVS96/pi-patcher) keeps patches to the [pi](https://github.com/earendil-works/pi) coding agent working across updates. Proof of concept.
- **June:** [PATCH.md](https://patchmd.vercel.app), the format.
- **July:** [herdr](https://github.com/AVGVSTVS96/herdr), the first fork rebuilt from patches. Proof of concept.
- **October:** forks of [Claude Code's plugins](https://github.com/AVGVSTVS96/claude-plugins-official), [Buzz](https://github.com/AVGVSTVS96/buzz) and [T3 Code](https://github.com/AVGVSTVS96/t3code), in daily use.
- **October:** autofork.

## License

MIT
