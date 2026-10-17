#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DIR = ".autofork";
const CONTROL = [DIR, ".github"];
const SOURCE = [".", ...CONTROL.map((path) => `:(exclude)${path}`)];
const BOT = [
  "-c", "user.name=autofork",
  "-c", "user.email=autofork@users.noreply.github.com",
  "-c", "commit.gpgsign=false",
];
const RED = ["failure", "timed_out", "action_required", "startup_failure"];

type Config = {
  upstream: string;
  follow: string;
  verify?: string;
  agent?: string;
  green?: boolean;
};

type Fork = Config & { patches: string[] };

type Build = {
  dir: string;
  steps: string[];
  source: string;
  healed: string[];
  upstreamHas: Map<string, string>;
};

class Failure extends Error {}
class Drifted extends Failure {}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd, env, maxBuffer: 1 << 30 });
  return { ok: result.status === 0, out: result.stdout, err: result.stderr?.toString().trim() ?? "" };
}

function git(cwd: string, ...args: string[]) {
  return gitWith(cwd, undefined, ...args);
}

function gitWith(cwd: string, env: NodeJS.ProcessEnv | undefined, ...args: string[]) {
  const result = run("git", args, cwd, env);
  if (!result.ok) throw new Failure(`git ${args.join(" ")}\n${result.err}`);
  return result.out.toString().trim();
}

function gitBytes(cwd: string, ...args: string[]) {
  const result = run("git", args, cwd);
  if (!result.ok) throw new Failure(`git ${args.join(" ")}\n${result.err}`);
  return result.out;
}

function shell(command: string, cwd: string, input?: string) {
  const stdin = input === undefined ? "inherit" : "pipe";
  return spawnSync("sh", ["-c", command], { cwd, input, stdio: [stdin, "inherit", "inherit"] }).status === 0;
}

const say = (line: string) => console.error(line);
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const short = (sha: string) => sha.slice(0, 12);
const patchFile = (dir: string, id: string) => join(dir, DIR, id, `${id}.patch`);
const patchDoc = (dir: string, id: string) => join(dir, DIR, id, "PATCH.md");
const upstreamDoc = (dir: string, id: string) => join(dir, DIR, id, "UPSTREAM.md");
const configFile = (dir: string) => join(dir, DIR, "config.json");

function output(values: Record<string, string>) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
}

function readConfig(root: string): Fork {
  if (!existsSync(configFile(root))) {
    throw new Failure("no .autofork/config.json here. Start with: autofork init <owner/repo>");
  }
  const { branch, patches: _, ...config } = JSON.parse(readFileSync(configFile(root), "utf8"));
  return { follow: branch ?? "main", ...config, patches: discover(root).filter((id) => !existsSync(upstreamDoc(root, id))) };
}

function discover(root: string) {
  return readdirSync(join(root, DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(patchDoc(root, entry.name)))
    .map((entry) => entry.name)
    .sort();
}

function writeConfig(dir: string, { upstream, follow, verify, agent, green }: Config) {
  mkdirSync(join(dir, DIR), { recursive: true });
  writeFileSync(configFile(dir), `${JSON.stringify({ upstream, follow, verify, agent, green }, null, 2)}\n`);
  writeFileSync(join(dir, DIR, ".gitignore"), "!*.patch\n");
}

function githubRepo(upstream: string) {
  return upstream.match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
}

function upstreamUrl(upstream: string) {
  return /^[\w.-]+\/[\w.-]+$/.test(upstream) ? `https://github.com/${upstream}.git` : upstream;
}

function github(path: string) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`https://api.github.com/${path}`, { headers });
}

type Follow = { branch: string } | { channel?: RegExp };

function parseFollow(follow: string): Follow {
  if (follow === "releases") return {};
  if (!follow.includes("*")) return { branch: follow };
  const escaped = follow.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return { channel: new RegExp(`^${escaped.join(".*")}$`) };
}

async function fetchUpstream(root: string, config: Config) {
  const url = upstreamUrl(config.upstream);
  const follow = parseFollow(config.follow);
  const tag = "branch" in follow ? undefined : await latestRelease(root, config.upstream, follow.channel);
  if (!("branch" in follow) && !tag) throw new Failure(`${url} has no releases${follow.channel ? ` matching ${config.follow}` : ""}. Follow a branch or another channel instead: set "follow" in ${DIR}/config.json`);
  const ref = "branch" in follow ? `refs/heads/${follow.branch}` : `refs/tags/${tag}`;
  git(root, "fetch", "--quiet", "--no-tags", url, `+${ref}:refs/autofork/upstream`, "+HEAD:refs/autofork/branch");
  return { tip: git(root, "rev-parse", "refs/autofork/upstream^{commit}"), tag };
}

type Release = { tag_name: string; draft: boolean; prerelease: boolean; published_at: string };

async function releases(upstream: string, path: string) {
  const repo = githubRepo(upstream);
  if (!repo) return;
  try {
    const response = await github(`repos/${repo}/${path}`);
    if (response.ok) return response.json();
    if (response.status !== 404) say(`can't read ${repo}'s releases (${response.status}), using its newest version tag`);
  } catch {
    say(`can't reach GitHub for ${repo}'s releases, using its newest version tag`);
  }
}

async function latestRelease(root: string, upstream: string, channel?: RegExp): Promise<string | undefined> {
  const published = channel
    ? ((await releases(upstream, "releases?per_page=100")) as Release[] | undefined)
        ?.filter((release) => !release.draft && channel.test(release.tag_name))
        .sort((a, b) => b.published_at.localeCompare(a.published_at))[0]?.tag_name
    : ((await releases(upstream, "releases/latest")) as Release | undefined)?.tag_name;
  if (published) return published;
  const tags = git(root, "ls-remote", "--tags", "--refs", "--sort=-v:refname", upstreamUrl(upstream)).split("\n");
  return tags.map((line) => line.split("\t")[1]?.replace("refs/tags/", "")).find((tag) => tag && (channel ? channel.test(tag) : !tag.includes("-")));
}

const channelOf = (tag: string) => tag.replace(/\d+/g, "*").replace(/\*(?:\.\*)+/g, "*");

async function channels(upstream: string) {
  const published = ((await releases(upstream, "releases?per_page=100")) as Release[] | undefined) ?? [];
  return [...new Set(published.filter((release) => release.prerelease && !release.draft).map((release) => channelOf(release.tag_name)))];
}

function baseline(root: string) {
  const synced = git(root, "log", "--first-parent", "-1", "--format=%s", "-E", "--grep=^auto(fork|patch): sync ", "HEAD").split(" ").at(-1);
  const last = synced && run("git", ["rev-parse", "--verify", "--quiet", `${synced}^{commit}`], root);
  const base = last && last.ok ? last : run("git", ["merge-base", "HEAD", "refs/autofork/branch"], root);
  if (!base.ok) throw new Failure("this branch shares no history with upstream");
  return base.out.toString().trim();
}

function newer(root: string, base: string, candidate: string) {
  return candidate !== base && run("git", ["merge-base", "--is-ancestor", candidate, base], root).ok ? base : candidate;
}

async function newestGreen(root: string, config: Config, base: string, tip: string) {
  const repo = githubRepo(config.upstream);
  if (config.green === false || !("branch" in parseFollow(config.follow)) || !repo) return tip;
  for (const sha of git(root, "rev-list", "--first-parent", "--max-count=30", `${base}..${tip}`).split("\n").filter(Boolean)) {
    const response = await github(`repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    if (!response.ok) {
      say(`can't read upstream checks (${response.status}), using upstream's tip`);
      return tip;
    }
    const conclusions: (string | null)[] = (await response.json()).check_runs.map((check: { conclusion: string | null }) => check.conclusion);
    if (conclusions.includes(null) || conclusions.some((conclusion) => RED.includes(conclusion!))) continue;
    if (sha !== tip) say(`upstream's tip isn't green yet, using ${short(sha)}`);
    return sha;
  }
  if (base !== tip) say(`no newer upstream commit has passed its checks yet, staying on ${short(base)}`);
  return base;
}

function intent(root: string, id: string) {
  const doc = existsSync(patchDoc(root, id)) ? readFileSync(patchDoc(root, id), "utf8") : "";
  if (!doc.trim()) throw new Failure(`${DIR}/${id}/PATCH.md is empty: say what the patch does and why. It's what the agent rebuilds it from.`);
}

const isEmpty = (file: string) => !existsSync(file) || readFileSync(file).length === 0;

function touched(dir: string, file: string) {
  const stat = run("git", ["apply", "--numstat", file], dir);
  return stat.ok ? stat.out.toString().trim().split("\n").filter(Boolean).map((line) => line.split("\t")[2]) : [];
}

function healPrompt(config: Fork, build: Build, id: string, source: string, from: string) {
  const before = config.patches.slice(0, config.patches.indexOf(id));
  const fresh = isEmpty(patchFile(build.dir, id));
  const files = touched(build.dir, patchFile(build.dir, id));
  const changes = from !== source && files.length ? `\nTo see what upstream changed under it: git diff ${from} ${source} -- ${files.join(" ")}` : "";
  const steps = [
    `Read ${DIR}/${id}/PATCH.md. It says what the patch does and why, and that's the contract.`,
    ...(fresh ? [] : [`${DIR}/${id}/${id}.patch is how it was done before. Use it as a guide, not as text to force in.${changes}`]),
    "Build it on the current source, the smallest change that fully does what PATCH.md says. Build on what upstream has now: where upstream has its own version of what the patch touches, change that rather than bringing the old one back. Follow upstream's code and conventions, and leave everything else alone.",
    ...(config.verify ? [`Run \`${config.verify}\` and fix what your change breaks. Patches after this one aren't applied yet.`] : []),
    ...(fresh ? [`Add a short paragraph to the end of ${DIR}/${id}/PATCH.md on why it's built the way it is, for whoever rebuilds it after upstream moves. Keep what's there as it is.`] : []),
  ];
  return `You are keeping a patched fork of ${config.upstream} in sync. The fork is upstream plus a stack of patches, each one described in ${DIR}/<id>/PATCH.md.

This checkout is upstream at ${source}${before.length ? `, with ${before.join(", ")} already applied` : ""}. ${fresh ? `Patch "${id}" is new and hasn't been built yet.` : `Upstream changed, and patch "${id}" no longer applies.`}

${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

Don't edit anything ${fresh ? "else " : ""}in ${DIR}/ or .github/, and don't commit. Leave only your source change: remove anything your checks generated that git would pick up.
If upstream already does what PATCH.md asks, or something close enough that building it would duplicate upstream's own version, change nothing and write one line saying what upstream does to ${DIR}/${id}/UPSTREAM.md.`;
}

const installed = (bin: string) => run("sh", ["-c", `command -v ${bin}`], ".").ok;

function agentCommand(config: Config) {
  if (config.agent) return config.agent;
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && existsSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"))) {
    const codex = installed("codex") ? "codex" : "npx -y @openai/codex";
    return `${codex} exec --dangerously-bypass-approvals-and-sandbox -`;
  }
  const claude = installed("claude") ? "claude" : "npx -y @anthropic-ai/claude-code";
  return `${claude} -p --dangerously-skip-permissions`;
}

function restoreControl(dir: string, base: string) {
  const owned = git(dir, "ls-tree", "--name-only", base, "--", ...CONTROL).split("\n").filter(Boolean);
  if (owned.length) git(dir, "checkout", base, "--", ...owned);
  git(dir, "clean", "-fdq", "--", ...CONTROL);
}

function changed(dir: string) {
  return git(dir, "status", "--porcelain").length > 0;
}

function heal(config: Fork, build: Build, id: string, source: string, from: string) {
  const prompt = healPrompt(config, build, id, source, from);
  const fresh = isEmpty(patchFile(build.dir, id));
  const [doing, done] = fresh ? ["building", "built"] : ["healing", "healed"];
  const doc = patchDoc(build.dir, id);
  const wish = readFileSync(doc, "utf8").trimEnd();
  let nudge = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    say(`${doing} ${id}${attempt > 1 ? " (second try)" : ""}`);
    if (!shell(agentCommand(config), build.dir, prompt + nudge)) throw new Failure(`the agent failed while ${doing} ${id}`);
    git(build.dir, "reset", "--soft", "--quiet", build.steps.at(-1)!);
    const reason = existsSync(upstreamDoc(build.dir, id)) ? readFileSync(upstreamDoc(build.dir, id), "utf8").trim() : "";
    const why = fresh && existsSync(doc) ? readFileSync(doc, "utf8") : "";
    restoreControl(build.dir, build.steps[0]);
    if (changed(build.dir)) {
      if (why.startsWith(wish)) writeFileSync(doc, why);
      build.healed.push(`${done} ${id}`);
      return;
    }
    if (reason) {
      build.upstreamHas.set(id, reason);
      return;
    }
    nudge = `\n\nYour last attempt exited without changing any source file. Build what PATCH.md asks for, or write ${DIR}/${id}/UPSTREAM.md if upstream already covers it.`;
  }
  throw new Failure(`the agent changed nothing while ${doing} ${id}`);
}

function commit(dir: string, message: string) {
  git(dir, "add", "-A");
  git(dir, ...BOT, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function apply(dir: string, file: string) {
  if (run("git", ["apply", "--3way", "--whitespace=nowarn", file], dir).ok) return true;
  git(dir, "reset", "--hard", "--quiet");
  git(dir, "clean", "-fdq");
  return false;
}

function scratch(root: string) {
  const parent = process.env.RUNNER_TEMP ?? join(homedir(), ".cache");
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return join(parent, "autofork", `${basename(root)}-${hash}`);
}

function worktree(root: string, base: string) {
  const dir = scratch(root);
  if (existsSync(dir)) run("git", ["worktree", "remove", "--force", dir], root);
  rmSync(dir, { recursive: true, force: true });
  git(root, "worktree", "prune");
  git(root, "worktree", "add", "--detach", "--quiet", dir, base);
  for (const path of CONTROL) {
    rmSync(join(dir, path), { recursive: true, force: true });
    if (existsSync(join(root, path))) cpSync(join(root, path), join(dir, path), { recursive: true });
  }
  return dir;
}

function build(root: string, config: Fork, base: string, options: { healFrom?: string; fold?: { id: string; patch: string } }): Build {
  const dir = worktree(root, base);
  const build: Build = { dir, source: base, steps: [commit(dir, `upstream ${short(base)}`)], healed: [], upstreamHas: new Map() };
  for (const id of config.patches) {
    const file = patchFile(dir, id);
    if (isEmpty(file) ? options.healFrom : !apply(dir, file)) {
      if (!options.healFrom) throw new Drifted(`${id} doesn't apply to ${short(base)}`);
      heal(config, build, id, base, options.healFrom);
    } else if (!isEmpty(file) && !changed(dir)) {
      build.upstreamHas.set(id, "the same change, line for line");
    }
    if (options.fold?.id === id && !apply(dir, options.fold.patch)) {
      throw new Failure(`your changes don't apply on top of ${id}`);
    }
    build.steps.push(commit(dir, id));
  }
  return build;
}

function refresh(target: string, config: Fork, build: Build) {
  config.patches.forEach((id, index) => {
    const diff = gitBytes(build.dir, "diff-tree", "-p", "--binary", "--full-index", build.steps[index], build.steps[index + 1], "--", ...SOURCE);
    if (diff.length || existsSync(patchFile(target, id))) writeFileSync(patchFile(target, id), diff);
  });
  for (const [id, reason] of build.upstreamHas) {
    rmSync(patchFile(target, id), { force: true });
    writeFileSync(upstreamDoc(target, id), `${reason}

${config.upstream} does this on its own as of ${short(build.source)}, so autofork stopped applying this patch.
To keep upstream's version, delete ${DIR}/${id}/.
To keep yours, say in PATCH.md how it differs from upstream's, delete this file and push. The next sync rebuilds it.
`);
  }
}

function cleanup(root: string, build?: Build) {
  if (build) run("git", ["worktree", "remove", "--force", build.dir], root);
}

function workingTree(root: string) {
  const gitDir = git(root, "rev-parse", "--path-format=absolute", "--git-dir");
  const index = join(gitDir, "autofork-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  cpSync(join(gitDir, "index"), index);
  gitWith(root, env, "add", "-A");
  const tree = gitWith(root, env, "write-tree");
  rmSync(index, { force: true });
  return tree;
}

function check(root: string, config: Fork, against: string, base = baseline(root)) {
  const rebuilt = build(root, config, base, {});
  try {
    const drift = git(root, "diff-tree", "-r", "--name-only", rebuilt.steps.at(-1)!, against, "--", ...SOURCE);
    return { base, rebuilt: rebuilt.steps.at(-1)!, drift: drift.split("\n").filter(Boolean) };
  } finally {
    cleanup(root, rebuilt);
  }
}

async function sync(root: string, args: string[]) {
  const config = readConfig(root);
  config.patches.forEach((id) => intent(root, id));
  if (git(root, "status", "--porcelain")) throw new Failure("commit or stash your changes first");
  const { tip, tag } = await fetchUpstream(root, config);
  const base = baseline(root);
  const source = newer(root, base, await newestGreen(root, config, base, tip));
  const key = `${short(source)}-${short(git(root, "rev-parse", "HEAD"))}`;
  output({ key });
  if (flag(args, "--skip") === key) {
    say(`already failed on upstream ${short(source)} with this fork, skipping until either changes`);
    return output({ result: "skipped" });
  }
  if (base === source && config.patches.every((id) => !isEmpty(patchFile(root, id)))) {
    say(`already up to date with ${config.upstream} at ${short(source)}`);
    return output({ result: "current" });
  }
  const { drift } = check(root, config, "HEAD", base);
  if (drift.length) {
    throw new Failure(`these files differ from what your patches build, so a sync would drop them:\n  ${drift.join("\n  ")}\nSave them as a patch first: write ${DIR}/<id>/PATCH.md, then run autofork save <id>`);
  }
  const moved = base === source ? short(source) : `${short(base)} → ${short(source)}`;
  say(`upstream ${moved}, ${config.patches.length} patch${config.patches.length === 1 ? "" : "es"}`);
  let result: Build | undefined;
  try {
    try {
      result = build(root, config, source, { healFrom: args.includes("--no-heal") ? undefined : base });
    } catch (error) {
      if (!(error instanceof Drifted)) throw error;
      say(`${error.message}. The next run that heals rebuilds it.`);
      return output({ result: "waiting" });
    }
    if (config.verify && !shell(config.verify, result.dir)) throw new Failure(`verify failed: ${config.verify}`);
    git(result.dir, "reset", "--hard", "--quiet");
    git(result.dir, "clean", "-fdq");
    refresh(result.dir, config, result);
    const tree = git(result.dir, "rev-parse", `${commit(result.dir, "refresh")}^{tree}`);
    if (tree === git(root, "rev-parse", "HEAD^{tree}")) {
      say("already up to date");
      return output({ result: "current" });
    }
    const head = git(root, "rev-parse", "HEAD");
    const parents = ["-p", head];
    if (!run("git", ["merge-base", "--is-ancestor", source, head], root).ok) parents.push("-p", source);
    const lines = [
      ...result.healed,
      ...[...result.upstreamHas].map(([id, reason]) => `upstream has ${id}: ${reason}`),
    ];
    const message = [`autofork: sync ${config.upstream} to ${short(source)}`, lines.join("\n")].filter(Boolean).join("\n\n");
    git(root, "merge", "--ff-only", "--quiet", git(root, "commit-tree", tree, ...parents, "-m", message));
    say(message);
    output({ result: "synced", ...(tag && source === tip ? { tag } : {}) });
  } finally {
    cleanup(root, result);
  }
}

async function save(root: string, args: string[]) {
  const id = args[0];
  if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Failure("usage: autofork save <id>   (id like fix-login)");
  if (!existsSync(patchDoc(root, id))) throw new Failure(`write ${DIR}/${id}/PATCH.md first: what the change does and why`);
  intent(root, id);
  rmSync(upstreamDoc(root, id), { force: true });
  const config = readConfig(root);
  await fetchUpstream(root, config);
  const files = workingTree(root);
  const { base, rebuilt, drift } = check(root, config, files);
  if (!drift.length) return say(`nothing to save: your code matches what the patches build. Push ${DIR}/${id}/PATCH.md as it is and the next sync has an agent build it.`);
  const fold = join(git(root, "rev-parse", "--path-format=absolute", "--git-dir"), "autofork-fold.patch");
  writeFileSync(fold, gitBytes(root, "diff-tree", "-p", "--binary", "--full-index", rebuilt, files, "--", ...SOURCE));
  const result = build(root, config, base, { fold: { id, patch: fold } });
  try {
    refresh(root, config, result);
    say(`saved ${drift.length} file${drift.length === 1 ? "" : "s"} to ${DIR}/${id}. Commit and push.`);
  } finally {
    rmSync(fold, { force: true });
    cleanup(root, result);
  }
}

const workflow = (branch: string) => `name: autofork

on:
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:
  push:
    branches: [${branch}]
    paths: [".autofork/**"]

permissions:
  contents: write
  issues: write

concurrency: autofork

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      # Set up whatever your verify command needs here (node, bun, rust, ...).
      - id: autofork
        uses: AVGVSTVS96/autofork@v1
        env:
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
`;

async function setup(root: string, upstream: string, args: string[]) {
  if (existsSync(configFile(root))) throw new Failure(`${DIR}/config.json already exists`);
  const url = upstreamUrl(upstream);
  const head = run("git", ["ls-remote", "--symref", url, "HEAD"], root).out.toString();
  const branch = head.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? "main";
  const follow = flag(args, "--follow") ?? ((await latestRelease(root, upstream)) ? "releases" : branch);
  const config: Config = { upstream, follow, verify: flag(args, "--verify") };
  writeConfig(root, config);
  const path = join(root, ".github/workflows/autofork.yml");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, workflow(git(root, "branch", "--show-current") || branch));
  await fetchUpstream(root, config);
  const { base, drift } = check(root, { ...config, patches: [] }, workingTree(root));
  const readme = addNote(root, upstream, base, drift);
  const inherited = git(root, "ls-files", ".github/workflows").split("\n").filter((file) => file && !file.endsWith("/autofork.yml"));
  if ("branch" in parseFollow(follow)) {
    say(`autofork follows ${upstream}'s ${follow} branch${flag(args, "--follow") ? "" : ", since it has no releases"}.`);
  } else {
    const others = (await channels(upstream)).filter((channel) => channel !== follow);
    say(`autofork follows ${upstream}'s ${follow === "releases" ? "" : `${follow} `}releases.`);
    if (others.length) say(`It also publishes ${others.join(", ")}. To follow one, put it in "follow" in ${DIR}/config.json.`);
  }
  if (inherited.length) say(`Your fork has ${inherited.length} workflow${inherited.length === 1 ? "" : "s"} copied from upstream, and they run here too. Delete the ones you don't want; upstream's new ones never get copied in.`);
  if (readme) say(`${readme} now says this is a personal fork kept current by autofork. To drop that line, delete it and ${DIR}/${NOTE}/.`);
  if (drift.length) say(`Your branch already changes ${drift.length} file${drift.length === 1 ? "" : "s"}. Save them as a patch: write ${DIR}/<id>/PATCH.md, then autofork save <id>`);
  return readme;
}

const NOTE = "fork-readme";
const appName = (upstream: string) => basename(upstream).replace(/\.git$/, "");

function withNote(readme: string, upstream: string) {
  if (!readme.trim() || readme.includes("autofork.com")) return undefined;
  const repo = githubRepo(upstream);
  const link = repo ? `https://github.com/${repo}` : /^https?:\/\//.test(upstream) ? upstream.replace(/\.git$/, "") : undefined;
  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const lines = readme.split(eol);
  const titled = /^\uFEFF?#\s/.test(lines[0]);
  const name = (titled && lines[0].match(/^\uFEFF?#\s+([^[\]<>`*_!]+?)[\s#]*$/)?.[1]) || appName(upstream);
  const note = `> A personal fork of ${link ? `[${name}](${link})` : name} that updates itself with [autofork](https://autofork.com). Its changes, each described in plain words, are in [\`${DIR}/\`](${DIR}).`;
  const at = titled ? 1 : 0;
  const block = titled ? ["", note, ...(lines[1]?.trim() ? [""] : [])] : [note, ""];
  return [...lines.slice(0, at), ...block, ...lines.slice(at)].join(eol);
}

const noteDoc = (name: string) => `One line under the README's title says this is a personal fork of ${name} that updates itself with autofork, linking ${name}, https://autofork.com and this fork's \`${DIR}/\` folder. The rest of the README stays as upstream wrote it.

To drop the line, delete it from the README and delete this folder, in the same commit.
`;

function addNote(root: string, upstream: string, base: string, drift: string[]) {
  const readme = git(root, "ls-tree", "--name-only", base).split("\n").find((file) => /^readme\.md$/i.test(file));
  if (!readme || drift.includes(readme) || existsSync(join(root, DIR, NOTE))) return;
  const text = withNote(readFileSync(join(root, readme), "utf8"), upstream);
  if (!text) return;
  writeFileSync(join(root, readme), text);
  mkdirSync(join(root, DIR, NOTE), { recursive: true });
  writeFileSync(patchFile(root, NOTE), gitBytes(root, "diff", "--no-ext-diff", "--no-color", "--binary", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", base, "--", readme));
  writeFileSync(patchDoc(root, NOTE), noteDoc(appName(upstream)));
  return readme;
}

function origin(root: string) {
  const url = run("git", ["remote", "get-url", "origin"], root).out.toString().trim();
  return url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? "";
}

function claim(root: string, upstream: string) {
  const api = (...args: string[]) => {
    const result = run("gh", ["api", ...args], root);
    return result.ok ? JSON.parse(result.out.toString()) : undefined;
  };
  const repo = origin(root);
  const fork = repo ? api(`repos/${repo}`) : undefined;
  if (!fork?.fork) return;
  run("gh", ["api", "-X", "PUT", `repos/${repo}/actions/permissions`, "-F", "enabled=true"], root);
  run("gh", ["repo", "edit", repo, "--enable-issues"], root);
  if (fork.parent?.full_name.toLowerCase() !== githubRepo(upstream)?.toLowerCase()) return;
  const owner = api(`users/${fork.owner.login}`);
  const who = (owner?.type === "User" ? owner.name?.trim().split(/\s+/)[0] : owner?.name?.trim()) || fork.owner.login;
  api("-X", "PATCH", `repos/${repo}`, "-f", `description=${[`${who}'s autofork`, fork.parent.description].filter(Boolean).join(" · ")}`);
}

async function init(root: string, args: string[]) {
  if (!args[0]) throw new Failure("usage: autofork init <owner/repo | git url> [--follow <releases | channel | branch>] [--verify <command>]");
  await setup(root, args[0], args);
  claim(root, args[0]);
  say("Add a CLAUDE_CODE_OAUTH_TOKEN secret (claude setup-token), commit, and push.");
}

async function fork(cwd: string, args: string[]) {
  const upstream = args[0];
  if (!/^[\w.-]+\/[\w.-]+$/.test(upstream ?? "")) throw new Failure("usage: autofork fork <owner/repo> [--follow <releases | channel | branch>] [--verify <command>]");
  if (!run("gh", ["repo", "fork", upstream, "--clone", "--default-branch-only"], cwd).ok) throw new Failure("gh couldn't fork it. Is the GitHub CLI installed and logged in?");
  const root = join(cwd, upstream.split("/")[1]);
  const readme = await setup(root, upstream, args);
  claim(root, upstream);
  const repo = origin(root);
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) run("gh", ["secret", "set", "CLAUDE_CODE_OAUTH_TOKEN", "--repo", repo, "--body", token], root);
  git(root, "add", DIR, ".github/workflows/autofork.yml", ...(readme ? [readme] : []));
  git(root, "commit", "--quiet", "-m", `autofork: follow ${upstream}`);
  git(root, "push", "--quiet");
  say(`${repo} now keeps itself current with ${upstream}. It's cloned in ./${basename(root)}.`);
  if (!token) say(`Last step: run claude setup-token, then gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${repo}`);
}

async function status(root: string) {
  const config = readConfig(root);
  await fetchUpstream(root, config);
  const { base, drift } = check(root, config, workingTree(root));
  const behind = git(root, "rev-list", "--count", "--first-parent", `${base}..refs/autofork/upstream`);
  say(`${config.upstream} at ${short(base)}, ${behind} commit${behind === "1" ? "" : "s"} behind upstream`);
  for (const id of discover(root)) {
    const note = existsSync(upstreamDoc(root, id)) ? "  (upstream has it: see UPSTREAM.md)" : isEmpty(patchFile(root, id)) ? "  (not built yet)" : "";
    say(`  ${id}${note}`);
  }
  if (drift.length) say(`not in any patch yet:\n  ${drift.join("\n  ")}`);
}

const USAGE = `autofork: Customized forks that maintain themselves.
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

A patch is .autofork/<id>/PATCH.md, saying what the change does and why, next
to <id>.patch, the diff. https://github.com/AVGVSTVS96/autofork
`;

const commands: Record<string, (root: string, args: string[]) => Promise<unknown>> = { init, save, status, sync };

async function main([name, ...args]: string[]) {
  if (name === "fork") return fork(process.cwd(), args);
  const command = commands[name];
  if (!command) return void process.stdout.write(USAGE);
  const top = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  if (!top.ok) throw new Failure("run autofork inside your fork's git checkout");
  await command(top.out.toString().trim(), args);
}

main(process.argv.slice(2)).catch((error) => {
  if (!(error instanceof Failure)) throw error;
  say(`autofork: ${error.message}`);
  process.exitCode = 1;
});
