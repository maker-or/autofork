import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../dist/autofork.js");
const home = mkdtempSync(join(tmpdir(), "autofork-test-"));
const gitconfig = join(home, "gitconfig");
writeFileSync(gitconfig, "[user]\n\tname = test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[diff]\n\tnoprefix = true\n");
const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", RUNNER_TEMP: home };
const github = join(home, "github");
writeFileSync(gitconfig, `[url "${github}/"]\n\tinsteadOf = https://github.com/\n`, { flag: "a" });
const fakeApi = join(home, "fake-api.mjs");
writeFileSync(fakeApi, `globalThis.fetch = async (url) => {
  const latest = process.env.LATEST_RELEASE;
  if (latest && String(url).endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: latest }));
  if (process.env.RELEASES && String(url).includes("/releases?")) return new Response(process.env.RELEASES);
  return new Response("{}", { status: 404 });
};
`);

function sh(cwd: string, command: string) {
  const result = spawnSync("sh", ["-c", command], { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}\n${result.stderr}`);
  return result.stdout.trim();
}

function autofork(cwd: string, ...args: string[]) {
  return autoforkWith({}, cwd, ...args);
}

function autoforkWith(extra: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
  const outputs = join(home, "github-output");
  writeFileSync(outputs, "");
  const result = spawnSync("node", ["--import", fakeApi, cli, ...args], { cwd, env: { ...env, ...extra, GITHUB_OUTPUT: outputs }, encoding: "utf8" });
  const output = Object.fromEntries(readFileSync(outputs, "utf8").split("\n").filter(Boolean).map((line) => line.split("=")));
  return { ok: result.status === 0, log: result.stderr, output };
}

const upstream = join(home, "upstream");
const fork = join(home, "fork");
const file = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const write = (dir: string, name: string, text: string) => writeFileSync(join(dir, name), text);

function agent(script: string) {
  const path = join(home, "agent.sh");
  writeFileSync(path, `cat > /dev/null\n${script}\n`);
  const config = JSON.parse(file(fork, ".autofork/config.json"));
  write(fork, ".autofork/config.json", `${JSON.stringify({ ...config, agent: `sh ${path}` }, null, 2)}\n`);
  sh(fork, "git diff --quiet || git commit -qam 'use test agent'");
}

function commitUpstream(text: string, message: string) {
  write(upstream, "app.js", text);
  sh(upstream, `git commit -qam '${message}'`);
}

function patch(id: string, text: string) {
  mkdirSync(join(fork, ".autofork", id), { recursive: true });
  write(fork, `.autofork/${id}/PATCH.md`, `${text}\n`);
}

test("init tracks upstream", () => {
  mkdirSync(upstream);
  sh(upstream, "git init -q");
  write(upstream, "app.js", 'export function greet(name) {\n  return "hello " + name;\n}\n');
  write(upstream, "notes.txt", "one\n");
  write(upstream, ".gitignore", "*.patch\n");
  sh(upstream, "git add -A && git commit -qm init");
  sh(home, `git clone -q ${upstream} fork`);
  const { ok, log } = autofork(fork, "init", upstream, "--verify", "node -e \"import('./app.js').then(m => process.exit(m.greet('x') === 'x' ? 1 : 0))\"");
  expect(ok).toBe(true);
  expect(log).toContain(`autofork follows ${upstream}'s main branch, since it has no releases`);
  expect(file(fork, ".github/workflows/autofork.yml")).toContain('push:\n    branches: [main]\n    paths: [".autofork/**"]');
  sh(fork, "git add -A && git commit -qm 'track upstream'");
});

test("save turns your changes into the patch PATCH.md describes", () => {
  write(fork, "app.js", 'export function greet(name) {\n  return "hello " + name.toUpperCase();\n}\n');
  expect(autofork(fork, "save", "shout").log).toContain("write .autofork/shout/PATCH.md first");
  patch("shout", "greet() shouts the name in upper case.");
  const { ok, log } = autofork(fork, "save", "shout");
  expect(ok).toBe(true);
  expect(log).toContain("saved 1 file to .autofork/shout");
  expect(file(fork, ".autofork/shout/shout.patch")).toContain("+  return \"hello \" + name.toUpperCase();");
  sh(fork, "git add -A && git commit -qm 'shout'");
  expect(sh(fork, "git ls-files .autofork/shout")).toContain("shout.patch");
});

test("sync with nothing new is a no-op", () => {
  agent("exit 1");
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("already up to date");
});

test("a clean upstream change applies without the agent", () => {
  write(upstream, "notes.txt", "two\n");
  sh(upstream, "git commit -qam notes");
  const { ok, log } = autofork(fork, "sync", "--no-heal");
  expect(ok).toBe(true);
  expect(log).not.toContain("healing");
  expect(file(fork, "notes.txt")).toBe("two\n");
  expect(file(fork, "app.js")).toContain("toUpperCase");
  expect(sh(fork, "git log -1 --format=%P").split(" ")).toHaveLength(2);
});

test("a drifted patch waits for a run that heals", () => {
  commitUpstream('export function greet(name) {\n  return "hi " + name;\n}\n', "hi");
  const head = sh(fork, "git rev-parse HEAD");
  const { ok, log } = autofork(fork, "sync", "--no-heal");
  expect(ok).toBe(true);
  expect(log).toContain("shout doesn't apply");
  expect(log).toContain("The next run that heals rebuilds it");
  expect(sh(fork, "git rev-parse HEAD")).toBe(head);
});

test("a drifted patch is healed from its PATCH.md", () => {
  agent(`sed -i 's/"hi " + name;/"hi " + name.toUpperCase();/' app.js`);
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healing shout");
  expect(log).toContain("healed shout");
  expect(file(fork, "app.js")).toContain('"hi " + name.toUpperCase()');
  expect(file(fork, ".autofork/shout/shout.patch")).toContain('+  return "hi " + name.toUpperCase();');
  agent("exit 1");
  expect(autofork(fork, "sync").log).toContain("already up to date");
});

test("changes no patch holds wait quietly until upstream moves", () => {
  write(fork, "notes.txt", "mine\n");
  sh(fork, "git commit -qam 'stray change'");
  const head = sh(fork, "git rev-parse HEAD");
  const idle = autofork(fork, "sync");
  expect(idle.ok).toBe(true);
  expect(idle.output.result).toBe("current");
  expect(sh(fork, "git rev-parse HEAD")).toBe(head);
});

test("once upstream moves, sync refuses to drop changes no patch holds, and fails only once", () => {
  write(upstream, "license.txt", "MIT\n");
  sh(upstream, "git add -A && git commit -qm license");
  const { ok, log, output } = autofork(fork, "sync");
  expect(ok).toBe(false);
  expect(log).toContain("notes.txt");
  expect(output.key).toBeTruthy();
  const again = autofork(fork, "sync", "--skip", output.key);
  expect(again.ok).toBe(true);
  expect(again.output.result).toBe("skipped");
  sh(fork, "git reset -q --hard HEAD~1");
});

test("a patch upstream now does is paused, not applied, until you pick it up", () => {
  commitUpstream('export function greet(name) {\n  return "hi " + name.toUpperCase() + "!";\n}\n', "shout upstream");
  agent("echo 'upstream greet() upper-cases the name now' > .autofork/shout/UPSTREAM.md");
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("upstream has shout: upstream greet() upper-cases the name now");
  expect(sh(fork, "ls .autofork/shout")).toBe("PATCH.md\nUPSTREAM.md");
  expect(file(fork, ".autofork/shout/UPSTREAM.md")).toContain("autofork stopped applying this patch");
  expect(file(fork, "app.js")).toContain('"hi " + name.toUpperCase() + "!"');
  expect(autofork(fork, "status").log).toContain("shout  (upstream has it");
  agent("exit 1");
  write(upstream, "notes.txt", "two and a half\n");
  sh(upstream, "git commit -qam notes");
  expect(autofork(fork, "sync").ok).toBe(true);
  expect(file(fork, "notes.txt")).toBe("two and a half\n");
});

test("deleting UPSTREAM.md brings your version back", () => {
  write(fork, ".autofork/shout/PATCH.md", "greet() shouts the name and ends with three bangs, not upstream's one.\n");
  sh(fork, "git rm -q .autofork/shout/UPSTREAM.md && git commit -qam 'keep mine'");
  agent(`sed -i 's/ + "!";/ + "!!!";/' app.js`);
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("built shout");
  expect(file(fork, "app.js")).toContain('"!!!"');
  sh(fork, "git rm -rq .autofork/shout && git checkout refs/autofork/upstream -- app.js && git commit -qm 'take upstream'");
});

test("a patch that's only a PATCH.md is built by the agent", () => {
  patch("wave", "greet() waves at the end.");
  sh(fork, "git add -A && git commit -qm wave");
  expect(autofork(fork, "status").log).toContain("wave  (not built yet)");
  agent(`sed -i 's/ + "!";/ + "! o\\/";/' app.js\nprintf '\\nThe wave is text, so it works in any terminal.\\n' >> .autofork/wave/PATCH.md`);
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("built wave");
  expect(file(fork, "app.js")).toContain('"! o/"');
  expect(file(fork, ".autofork/wave/wave.patch")).toContain('"! o/"');
  expect(file(fork, ".autofork/wave/PATCH.md")).toBe("greet() waves at the end.\n\nThe wave is text, so it works in any terminal.\n");
  agent("exit 1");
  expect(autofork(fork, "sync").log).toContain("already up to date");
});

test("a patch upstream merged as is is paused without the agent", () => {
  commitUpstream(file(fork, "app.js"), "merge the wave");
  agent("exit 1");
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("upstream has wave: the same change, line for line");
  expect(sh(fork, "ls .autofork/wave")).toBe("PATCH.md\nUPSTREAM.md");
});

test("files verify leaves behind stay out of the fork", () => {
  const config = JSON.parse(file(fork, ".autofork/config.json"));
  write(fork, ".autofork/config.json", `${JSON.stringify({ ...config, verify: "touch verify-output.log" }, null, 2)}\n`);
  sh(fork, "git commit -qam 'noisy verify'");
  write(upstream, "notes.txt", "three\n");
  sh(upstream, "git commit -qam notes");
  const { ok } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(sh(fork, "git ls-files verify-output.log")).toBe("");
});

test("a fork can follow upstream's releases instead of a branch", () => {
  sh(upstream, "git tag v1.0.0");
  write(upstream, "notes.txt", "four\n");
  sh(upstream, "git commit -qam notes && git tag v1.1.0-beta.1");
  const config = JSON.parse(file(fork, ".autofork/config.json"));
  write(fork, ".autofork/config.json", `${JSON.stringify({ ...config, follow: "releases" }, null, 2)}\n`);
  sh(fork, "git commit -qam 'follow releases'");
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("already up to date");
  expect(file(fork, "notes.txt")).toBe("three\n");
  sh(upstream, "git tag v1.1.0");
  expect(autofork(fork, "sync").ok).toBe(true);
  expect(file(fork, "notes.txt")).toBe("four\n");
});

test("a fork ahead of upstream's newest release stays where it is", () => {
  const follow = (to: string) => {
    const config = JSON.parse(file(fork, ".autofork/config.json"));
    write(fork, ".autofork/config.json", `${JSON.stringify({ ...config, follow: to }, null, 2)}\n`);
    sh(fork, `git commit -qam 'follow ${to}'`);
  };
  follow("main");
  write(upstream, "notes.txt", "five\n");
  sh(upstream, "git commit -qam notes");
  expect(autofork(fork, "sync").ok).toBe(true);
  follow("releases");
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("already up to date");
  expect(file(fork, "notes.txt")).toBe("five\n");
});

test("init puts a note under the README's title as a saved patch, which later syncs apply without the agent", () => {
  const origin = join(home, "demo");
  const mine = join(home, "demo-fork");
  mkdirSync(origin);
  sh(origin, "git init -q");
  write(origin, "README.md", "# Demo\n\nDemo does things.\n\n## Install\n\nRun it.\n");
  sh(origin, "git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} demo-fork`);
  const { ok, log } = autofork(mine, "init", origin);
  expect(ok).toBe(true);
  expect(log).toContain("README.md now says this is a personal fork");
  expect(file(mine, "README.md")).toBe(
    "# Demo\n\n> A personal fork of Demo that updates itself with [autofork](https://autofork.com). Its changes, each described in plain words, are in [`.autofork/`](.autofork).\n\nDemo does things.\n\n## Install\n\nRun it.\n",
  );
  expect(file(mine, ".autofork/fork-readme/PATCH.md")).toContain("delete this folder");
  write(mine, ".autofork/config.json", `${JSON.stringify({ ...JSON.parse(file(mine, ".autofork/config.json")), agent: "exit 1" }, null, 2)}\n`);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  write(origin, "README.md", "# Demo\n\nDemo does things.\n\n## Install\n\nRun it with care.\n");
  sh(origin, "git commit -qam install");
  const synced = autofork(mine, "sync");
  expect(synced.ok).toBe(true);
  expect(synced.log).not.toContain("building");
  expect(file(mine, "README.md")).toContain("> A personal fork of Demo");
  expect(file(mine, "README.md")).toContain("Run it with care.");
});

test("a fork on GitHub follows its latest release, not its highest tag", () => {
  const app = join(github, "acme/app.git");
  mkdirSync(app, { recursive: true });
  sh(app, "git init -q && echo one > notes.txt && git add -A && git commit -qm one && git tag v9.0.0");
  sh(app, "echo two > notes.txt && git commit -qam two && git tag desktop-v1.0.0 && echo three > notes.txt && git commit -qam three");
  sh(home, `git clone -q ${app} app && git -C app reset -q --hard v9.0.0`);
  const mine = join(home, "app");
  expect(autofork(mine, "init", "acme/app").log).toContain("autofork follows acme/app's releases.");
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  expect(autofork(mine, "sync").log).toContain("already up to date");
  const released = autoforkWith({ LATEST_RELEASE: "desktop-v1.0.0" }, mine, "sync");
  expect(released.ok).toBe(true);
  expect(released.output.result).toBe("synced");
  expect(file(mine, "notes.txt")).toBe("two\n");
});

test("init follows releases when every release is named with a dash", () => {
  const app = join(github, "acme/desktop.git");
  mkdirSync(app, { recursive: true });
  sh(app, "git init -q && echo one > notes.txt && git add -A && git commit -qm one && git tag desktop-v1.0.0");
  sh(home, `git clone -q ${app} desktop`);
  const mine = join(home, "desktop");
  expect(autoforkWith({ LATEST_RELEASE: "desktop-v1.0.0" }, mine, "init", "acme/desktop").log).toContain("autofork follows acme/desktop's releases.");
  sh(mine, "rm -rf .autofork .github");
  expect(autofork(mine, "init", "acme/desktop").log).toContain("acme/desktop's main branch, since it has no releases");
});

test("a fork can follow one channel of upstream's releases, named by its tags", () => {
  const app = join(github, "acme/nightly.git");
  mkdirSync(app, { recursive: true });
  sh(app, "git init -q && echo one > notes.txt && git add -A && git commit -qm one && git tag v1.0.0");
  sh(app, "echo two > notes.txt && git commit -qam two && git tag v1.1.0-nightly.1 && echo three > notes.txt && git commit -qam three && git tag v1.1.0-preview.1");
  sh(home, `git clone -q ${app} nightly && git -C nightly reset -q --hard v1.0.0`);
  const mine = join(home, "nightly");
  const releases = JSON.stringify([
    { tag_name: "v1.1.0-nightly.2", draft: true, prerelease: true, published_at: null },
    { tag_name: "v1.1.0-preview.1", draft: false, prerelease: true, published_at: "2026-01-03T00:00:00Z" },
    { tag_name: "v1.1.0-nightly.1", draft: false, prerelease: true, published_at: "2026-01-02T00:00:00Z" },
    { tag_name: "v1.0.0", draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z" },
  ]);
  const init = autoforkWith({ RELEASES: releases, LATEST_RELEASE: "v1.0.0" }, mine, "init", "acme/nightly");
  expect(init.log).toContain("autofork follows acme/nightly's releases.\nIt also publishes v*-preview.*, v*-nightly.*.");
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(mine, ".autofork/config.json", `${JSON.stringify({ ...config, follow: "v*-nightly.*" }, null, 2)}\n`);
  sh(mine, "git add -A && git commit -qm 'track nightlies'");
  const synced = autoforkWith({ RELEASES: releases }, mine, "sync");
  expect(synced.output).toMatchObject({ result: "synced", tag: "v1.1.0-nightly.1" });
  expect(file(mine, "notes.txt")).toBe("two\n");
  expect(autofork(mine, "sync").output.result).toBe("current");
  expect(file(mine, "notes.txt")).toBe("two\n");
});

test("init turns on Actions and issues for the fork origin points to, not the upstream gh picks", () => {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> ${home}/gh.log
case "$*" in
  "repo view"*) echo acme/app ;;
  "api repos/me/app") echo '{"fork":true,"owner":{"login":"me"},"parent":{"full_name":"acme/app","description":"An app"}}' ;;
  "api users/me") echo '{"type":"User","name":"Ada Lovelace"}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });
  sh(home, `git clone -q ${join(github, "acme/app.git")} mine && git -C mine remote set-url origin git@github.com:me/app.git`);
  const { ok } = autoforkWith({ PATH: `${bin}:${process.env.PATH}` }, join(home, "mine"), "init", "acme/app");
  expect(ok).toBe(true);
  const calls = file(home, "gh.log");
  expect(calls).toContain("api -X PUT repos/me/app/actions/permissions -F enabled=true");
  expect(calls).toContain("repo edit me/app --enable-issues");
  expect(calls).toContain("api -X PATCH repos/me/app -f description=Ada's autofork · An app");
});
