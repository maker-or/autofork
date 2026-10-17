# Make a fork's installs update themselves

autofork keeps the fork's code current. An installed app only follows the fork if the fork publishes its own releases and the app's updater reads them. Do this once per fork, for apps that update themselves: desktop apps, CLIs with a self-update command, servers that download their own runtimes.

## 1. Find how the app updates

List every place the app or its build reads releases from upstream's repo: the updater's publish or feed config (`electron-builder` `publish`, Sparkle appcast URLs, Tauri updater endpoints), self-update commands, and hardcoded `owner/repo` or release download URLs. Note which update files the release ships next to its builds, and which channels the updater knows.

## 2. Follow the channel the user installs

Set `follow` to the channel the user runs. `init` lists the channels upstream publishes; pick one by its tag pattern, like `"v*-nightly.*"`, or `"releases"` for stable. The fork releases each build under the same tag as the upstream release it's built on, so the updater compares versions the way it does upstream.

## 3. Point the updater at the fork

Make one patch, a `release-feed` patch, that swaps upstream's repo for the fork's wherever step 1 found it. Keep any override upstream offers, like an environment variable for the download URL. Build tools guess the repo from config such as `package.json`'s `repository`, so check the feed file in a built app rather than trusting the config.

If the updater checks its own signature on updates, like Tauri's `pubkey` or Sparkle's `SUPublicEDKey`, generate a keypair for the fork. Patch the public key in, and add the private key as a repo secret.

## 4. Add a release workflow

Start from upstream's release workflow. Save it as the fork's own file in `.github/workflows/`, which autofork never rebuilds or overwrites.

- Trigger it only on `workflow_dispatch`, with a `tag` input. Upstream's tag triggers never fire in the fork.
- Build the commit the dispatch ran on, the fork's branch. Never check out upstream's tag, which has none of the patches.
- Give the build the version from the tag explicitly. The fork's commit carries no tag, so tools that read the version from git get it wrong.
- Keep the builds and the update files. Drop package registry publishing, deploys, announcements and anything else that needs upstream's secrets.
- Publish the GitHub Release yourself, under the tag and at the built commit, with upstream's prerelease and latest flags for that tag. Never publish a draft. Updaters skip drafts.
- When the `tag` input is empty, find it the way autofork does. The last sync commit's message ends with the upstream commit. Pick the tag on that commit in `git ls-remote --tags <upstream>` that matches `follow`.
- Run on GitHub's standard hosted runners, which cost nothing on a public fork. A private fork pays for every minute, and macOS minutes cost the most.

Then start it from `autofork.yml`. A push made with `GITHUB_TOKEN` starts no workflows, but a dispatch does. Give the autofork step `id: autofork`, add `actions: write` to the workflow's `permissions`, and add this step after it:

```yaml
- if: steps.autofork.outputs.result == 'synced'
  env:
    GH_TOKEN: ${{ github.token }}
    TAG: ${{ steps.autofork.outputs.tag }}
  run: gh workflow run release.yml --repo "$GITHUB_REPOSITORY" ${TAG:+-f tag="$TAG"}
```

## 5. Sign without upstream's certificates

Keep upstream's signing path for builds that have the secrets. Without them:

- **macOS with Squirrel.Mac, which Electron apps use.** It installs a new build only if the build satisfies the running app's designated requirement. A plain ad-hoc signature requires its own code hash, so every update is refused. Make a patch that signs builds without a certificate ad hoc, with the hardened runtime off and the app bundle's designated requirement set to `identifier "<bundle id>"`. With electron-builder that's `identity: "-"`, `hardenedRuntime: false`, and `requirements: '=designated => identifier "<bundle id>"'` on the outer app only.
- **Windows.** Unsigned builds install and update, unless the update config names a publisher. electron-updater refuses unsigned updates when `publisherName` is set, so drop it for unsigned builds.

## 6. Check the real release

Download the fork's release, not a local build, and check:

- The version is the upstream tag.
- The feed file inside the app names the fork and the channel.
- On macOS, `codesign -d -r-` prints `designated => identifier "<bundle id>"`, and `codesign --verify --strict --deep` passes.

## 7. Move each install over once

A build of upstream's follows upstream's feed, and a Mac app signed by a different identity refuses an ad-hoc update. So install the fork's build once on every machine.

1. Quit the app.
2. Set the old app aside and put the fork's build in its place.
3. Open it.

Keep the bundle id and app id, so the app finds its existing data. Download with `curl`. A browser download is marked as from the internet. macOS then blocks an ad-hoc app until it's allowed in System Settings, Privacy & Security, and Windows SmartScreen warns. Updater downloads carry no such mark. For a runtime the app installs itself, install the fork's version once with the app's own update command.

From then on, each upstream release in the channel reaches the install through its own updater.

A change to a patch alone rebuilds the release under the same tag. Installs already on that version pick the change up with the next upstream release.
