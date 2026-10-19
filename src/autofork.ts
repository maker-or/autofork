#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DIR = ".autofork";
const CONTROL = [DIR, ".github"];
const WORKFLOWS = [".github/workflows", ".github/actions"];
const SOURCE = [".", ...CONTROL.map((path) => `:(exclude)${path}`)];
const BOT = [
  "-c",
  "user.name=autofork",
  "-c",
  "user.email=autofork@users.noreply.github.com",
  "-c",
  "commit.gpgsign=false",
];
const RED = ["failure", "timed_out", "action_required", "startup_failure"];
const MARKER = /^(<{7} ours|>{7} theirs)\r?$/m;

type Config = {
  upstream: string;
  follow: string;
  setup?: string;
  generated?: string[];
  verify?: string;
  agent?: string;
  green?: boolean;
};

type Fork = Config & { patches: string[] };

type Build = {
  dir: string;
  steps: string[];
  source: string;
  verified: number;
  healed: Map<string, string>;
  upstreamHas: Map<string, string>;
  ready?: string;
  rebuilt?: string;
  failed?: { check: "setup" | "verify"; lines: string };
};

type Left = { conflicted: string[]; rejected: string[]; missed: string[] };

class Failure extends Error {}
class Drifted extends Failure {}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd, env, maxBuffer: 1 << 30 });
  return {
    ok: result.status === 0,
    out: result.stdout,
    err: result.stderr?.toString().trim() ?? "",
  };
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
  return (
    spawnSync("sh", ["-c", command], { cwd, input, stdio: [stdin, "inherit", "inherit"] })
      .status === 0
  );
}

const say = (line: string) => console.error(line);
const flag = (args: string[], name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const short = (sha: string) => sha.slice(0, 12);
const patchFile = (dir: string, id: string) => join(dir, DIR, id, `${id}.patch`);
const patchDoc = (dir: string, id: string) => join(dir, DIR, id, "PATCH.md");
const upstreamDoc = (dir: string, id: string) => join(dir, DIR, id, "UPSTREAM.md");
const configFile = (dir: string) => join(dir, DIR, "config.json");

function output(values: Record<string, string>) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    { flag: "a" },
  );
}

async function readConfig(root: string): Promise<Fork> {
  if (!existsSync(configFile(root))) {
    throw new Failure("no .autofork/config.json here. Start with: autofork init <owner/repo>");
  }
  const config: Partial<Config> & { upstream: string } = JSON.parse(
    readFileSync(configFile(root), "utf8"),
  );
  if (config.generated?.length && !config.setup)
    throw new Failure(
      `"generated" files are rebuilt by "setup", so set it too in ${DIR}/config.json`,
    );
  const follow = config.follow ?? (await defaultFollow(root, config.upstream));
  return {
    ...config,
    follow,
    patches: discover(root).filter((id) => !existsSync(upstreamDoc(root, id))),
  };
}

function discover(root: string) {
  return readdirSync(join(root, DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(patchDoc(root, entry.name)))
    .map((entry) => entry.name)
    .sort();
}

function writeConfig(
  dir: string,
  { upstream, follow, setup, generated, verify, agent, green }: Config,
) {
  mkdirSync(join(dir, DIR), { recursive: true });
  writeFileSync(
    configFile(dir),
    `${JSON.stringify({ upstream, follow, setup, generated, verify, agent, green }, null, 2)}\n`,
  );
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
  const tag =
    "branch" in follow ? undefined : await latestRelease(root, config.upstream, follow.channel);
  if (!("branch" in follow) && !tag)
    throw new Failure(
      `${url} has no releases${follow.channel ? ` matching ${config.follow}` : ""}. Follow a branch or another channel instead: set "follow" in ${DIR}/config.json`,
    );
  const ref = "branch" in follow ? `refs/heads/${follow.branch}` : `refs/tags/${tag}`;
  git(
    root,
    "fetch",
    "--quiet",
    "--no-tags",
    url,
    `+${ref}:refs/autofork/upstream`,
    "+HEAD:refs/autofork/branch",
  );
  return { tip: git(root, "rev-parse", "refs/autofork/upstream^{commit}"), tag };
}

type Release = { tag_name: string; draft: boolean; prerelease: boolean; published_at: string };

async function releases(upstream: string, path: string) {
  const repo = githubRepo(upstream);
  if (!repo) return;
  try {
    const response = await github(`repos/${repo}/${path}`);
    if (response.ok) return response.json();
    if (response.status !== 404)
      say(`can't read ${repo}'s releases (${response.status}), using its newest version tag`);
  } catch {
    say(`can't reach GitHub for ${repo}'s releases, using its newest version tag`);
  }
}

async function latestRelease(
  root: string,
  upstream: string,
  channel?: RegExp,
): Promise<string | undefined> {
  const published = channel
    ? ((await releases(upstream, "releases?per_page=100")) as Release[] | undefined)
        ?.filter((release) => !release.draft && channel.test(release.tag_name))
        .sort((a, b) => b.published_at.localeCompare(a.published_at))[0]?.tag_name
    : ((await releases(upstream, "releases/latest")) as Release | undefined)?.tag_name;
  if (published) return published;
  const tags = git(
    root,
    "ls-remote",
    "--tags",
    "--refs",
    "--sort=-v:refname",
    upstreamUrl(upstream),
  ).split("\n");
  return tags
    .map((line) => line.split("\t")[1]?.replace("refs/tags/", ""))
    .find((tag) => tag && (channel ? channel.test(tag) : !tag.includes("-")));
}

function defaultBranch(root: string, upstream: string) {
  const head = run(
    "git",
    ["ls-remote", "--symref", upstreamUrl(upstream), "HEAD"],
    root,
  ).out.toString();
  return head.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? "main";
}

async function defaultFollow(root: string, upstream: string) {
  return (await latestRelease(root, upstream)) ? "releases" : defaultBranch(root, upstream);
}

const channelOf = (tag: string) => tag.replace(/\d+/g, "*").replace(/\*(?:\.\*)+/g, "*");

async function channels(upstream: string) {
  const published =
    ((await releases(upstream, "releases?per_page=100")) as Release[] | undefined) ?? [];
  return [
    ...new Set(
      published
        .filter((release) => release.prerelease && !release.draft)
        .map((release) => channelOf(release.tag_name)),
    ),
  ];
}

function baseline(root: string) {
  const synced = git(
    root,
    "log",
    "--first-parent",
    "-1",
    "--format=%s",
    "-E",
    "--grep=^auto(fork|patch): sync ",
    "HEAD",
  )
    .split(" ")
    .at(-1);
  const last =
    synced && run("git", ["rev-parse", "--verify", "--quiet", `${synced}^{commit}`], root);
  const base =
    last && last.ok ? last : run("git", ["merge-base", "HEAD", "refs/autofork/branch"], root);
  if (!base.ok) throw new Failure("this branch shares no history with upstream");
  return base.out.toString().trim();
}

function newer(root: string, base: string, candidate: string) {
  return candidate !== base && run("git", ["merge-base", "--is-ancestor", candidate, base], root).ok
    ? base
    : candidate;
}

async function newestGreen(root: string, config: Config, base: string, tip: string) {
  const repo = githubRepo(config.upstream);
  if (config.green === false || !("branch" in parseFollow(config.follow)) || !repo) return tip;
  for (const sha of git(root, "rev-list", "--first-parent", "--max-count=30", `${base}..${tip}`)
    .split("\n")
    .filter(Boolean)) {
    const response = await github(`repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    if (!response.ok) {
      say(`can't read upstream checks (${response.status}), using upstream's tip`);
      return tip;
    }
    const conclusions: (string | null)[] = (await response.json()).check_runs.map(
      (check: { conclusion: string | null }) => check.conclusion,
    );
    if (conclusions.includes(null) || conclusions.some((conclusion) => RED.includes(conclusion!)))
      continue;
    if (sha !== tip) say(`upstream's tip isn't green yet, using ${short(sha)}`);
    return sha;
  }
  if (base !== tip)
    say(`no newer upstream commit has passed its checks yet, staying on ${short(base)}`);
  return base;
}

function intent(root: string, id: string) {
  const doc = existsSync(patchDoc(root, id)) ? readFileSync(patchDoc(root, id), "utf8") : "";
  if (!doc.trim())
    throw new Failure(
      `${DIR}/${id}/PATCH.md is empty: say what the patch does and why. It's what the agent rebuilds it from.`,
    );
}

const isEmpty = (file: string) => !existsSync(file) || readFileSync(file).length === 0;

const sourcePaths = (config: Config) => [
  ...SOURCE,
  ...(config.generated ?? []).map((path) => `:(exclude)${path}`),
];
const skipGenerated = (config: Config) =>
  (config.generated ?? []).map((path) => `--exclude=${path}`);

function touched(dir: string, file: string, config: Config) {
  return run("git", ["apply", "--numstat", "-z", ...skipGenerated(config), file], dir)
    .out.toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => line.split("\t")[2]);
}

function unfinished({ conflicted, rejected, missed }: Left, to: string, from?: string) {
  const files = [...conflicted, ...rejected, ...missed];
  if (!files.length) return "";
  const left = [
    conflicted.length ? `the conflict markers in ${conflicted.join(", ")}` : "",
    rejected.length
      ? `the hunks that didn't fit, in ${rejected.map((path) => `${path}.rej`).join(", ")}`
      : "",
    missed.length ? `the changes to ${missed.join(", ")}, which didn't apply at all` : "",
  ].filter(Boolean);
  const changes =
    from && from !== to
      ? ` To see what upstream changed under them: git diff ${from} ${to} -- ${files.join(" ")}`
      : "";
  return ` Git applied the rest of it. What's left: ${left.join("; ")}.${changes}`;
}

function healPrompt(config: Fork, build: Build, id: string, broken: string) {
  const before = config.patches.slice(0, config.patches.indexOf(id));
  const fresh = isEmpty(patchFile(build.dir, id));
  const steps = [
    `Read ${DIR}/${id}/PATCH.md. It says what the patch does and why, and that's the contract.`,
    ...(fresh
      ? []
      : [
          `${DIR}/${id}/${id}.patch is how it was done before. Use it as a guide, not as text to force in.`,
        ]),
    "Build it on the current source, the smallest change that fully does what PATCH.md says. Build on what upstream has now: where upstream has its own version of what the patch touches, change that rather than bringing the old one back. Follow upstream's code and conventions, and leave everything else alone.",
    `Run upstream's own checks for the code you touched${config.verify ? `, and \`${config.verify}\`, which the sync has to pass` : ""}.${config.setup ? ` Dependencies are installed: \`${config.setup}\` ran here, so run it again if you change them.` : ""} Fix what your change breaks. Patches after this one aren't applied yet.`,
    ...(fresh
      ? [
          `Add a short paragraph to the end of ${DIR}/${id}/PATCH.md on why it's built the way it is, for whoever rebuilds it after upstream moves. Keep what's there as it is.`,
        ]
      : []),
  ];
  return `You are keeping a patched fork of ${config.upstream} in sync. The fork is upstream plus a stack of patches, each one described in ${DIR}/<id>/PATCH.md.

This checkout is upstream at ${build.source}${before.length ? `, with ${before.join(", ")} already applied` : ""}. ${fresh ? `Patch "${id}" is new and hasn't been built yet.` : broken}

${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

Don't edit anything ${fresh ? "else " : ""}in ${DIR}/ or .github/, and don't commit. Leave only your source change: remove anything your checks generated that git would pick up${config.generated?.length ? `, but leave ${config.generated.join(", ")}, which the sync rebuilds` : ""}.
If upstream already does what PATCH.md asks, or something close enough that building it would duplicate upstream's own version, write one line saying what upstream does to ${DIR}/${id}/UPSTREAM.md, and the sync leaves the patch out.`;
}

const installed = (bin: string) => run("sh", ["-c", `command -v ${bin}`], ".").ok;

function agentCommand(config: Config) {
  if (config.agent) return config.agent;
  if (
    !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
    existsSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"))
  ) {
    const codex = installed("codex") ? "codex" : "npx -y @openai/codex";
    return `${codex} exec --dangerously-bypass-approvals-and-sandbox -`;
  }
  const claude = installed("claude") ? "claude" : "npx -y @anthropic-ai/claude-code";
  return `${claude} -p --dangerously-skip-permissions`;
}

function restoreControl(dir: string, base: string) {
  const owned = git(dir, "ls-tree", "--name-only", base, "--", ...CONTROL)
    .split("\n")
    .filter(Boolean);
  if (owned.length) git(dir, "checkout", base, "--", ...owned);
  git(dir, "clean", "-fdq", "--", ...CONTROL);
}

function workflowsBehind(root: string, base: string, source: string) {
  const files = (...args: string[]) =>
    git(root, "diff", "--name-only", "--no-renames", ...args, "--", ...WORKFLOWS).split("\n");
  const upstreamChanged = new Set(files(base, source));
  return files("--diff-filter=MD", "HEAD", source).filter(
    (file) => file && upstreamChanged.has(file),
  );
}

const sameSource = (config: Config, dir: string, ...commits: string[]) =>
  run("git", ["diff", "--quiet", ...commits, "--", ...sourcePaths(config)], dir).ok;

function heal(
  config: Fork,
  build: Build,
  id: string,
  broken: string,
  patch?: { file: string; from?: string },
) {
  prepared(config, build);
  const step = build.steps.at(-1)!;
  const left = patch ? merge(build.dir, patch.file, config) : undefined;
  const rejects = left?.rejected.map((path) => `${path}.rej`) ?? [];
  const before = workingTree(build.dir, rejects);
  const prompt = healPrompt(
    config,
    build,
    id,
    broken + (left ? unfinished(left, build.source, patch?.from) : ""),
  );
  const fresh = isEmpty(patchFile(build.dir, id));
  const [doing, done] = fresh ? ["building", "built"] : ["healing", "healed"];
  const doc = patchDoc(build.dir, id);
  const wish = readFileSync(doc, "utf8").trimEnd();
  let nudge = "";
  let marked: string[] = [];
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      say(`${doing} ${id}${attempt > 1 ? " (second try)" : ""}`);
      if (!shell(agentCommand(config), build.dir, prompt + nudge))
        throw new Failure(`the agent failed while ${doing} ${id}`);
      git(build.dir, "reset", "--soft", "--quiet", step);
      const reason = existsSync(upstreamDoc(build.dir, id))
        ? readFileSync(upstreamDoc(build.dir, id), "utf8").trim()
        : "";
      const why = fresh && existsSync(doc) ? readFileSync(doc, "utf8") : "";
      restoreControl(build.dir, step);
      if (reason) {
        reset(build.dir, step);
        build.upstreamHas.set(id, reason);
        return;
      }
      marked = (left?.conflicted ?? []).filter((path) => {
        const file = join(build.dir, path);
        return existsSync(file) && MARKER.test(readFileSync(file, "utf8"));
      });
      if (!marked.length && workingTree(build.dir, rejects) !== before) {
        if (why.startsWith(wish)) writeFileSync(doc, why);
        build.healed.set(id, done);
        return;
      }
      nudge = marked.length
        ? `\n\nYour last attempt left conflict markers in ${marked.join(", ")}. Resolve them into what PATCH.md asks for.`
        : `\n\nYour last attempt exited without changing any source file. Build what PATCH.md asks for, or write ${DIR}/${id}/UPSTREAM.md if upstream already covers it.`;
    }
  } finally {
    for (const file of rejects) rmSync(join(build.dir, file), { force: true });
  }
  throw new Failure(
    marked.length
      ? `the agent left conflict markers in ${marked.join(", ")} while ${doing} ${id}`
      : `the agent changed nothing while ${doing} ${id}`,
  );
}

function changed(dir: string) {
  return git(dir, "status", "--porcelain").length > 0;
}

function commit(dir: string, message: string) {
  git(dir, "add", "-A");
  git(dir, ...BOT, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function reset(dir: string, to = "HEAD") {
  git(dir, "reset", "--hard", "--quiet", to);
  git(dir, "clean", "-fdq");
}

function apply(dir: string, file: string, config: Config) {
  if (
    run("git", ["apply", "--3way", "--whitespace=nowarn", ...skipGenerated(config), file], dir).ok
  )
    return true;
  reset(dir);
  return false;
}

function merge(dir: string, file: string, config: Config): Left {
  const left: Left = { conflicted: [], rejected: [], missed: [] };
  for (const path of touched(dir, file, config)) {
    const only = [`--include=${path.replace(/[*?[\\]/g, "\\$&")}`, "--whitespace=nowarn", file];
    if (run("git", ["apply", "--3way", ...only], dir).ok) continue;
    if (git(dir, "ls-files", "--unmerged", "--", `:(literal)${path}`)) left.conflicted.push(path);
    else if (run("git", ["apply", "--reject", ...only], dir).ok) continue;
    else if (existsSync(join(dir, `${path}.rej`))) left.rejected.push(path);
    else left.missed.push(path);
  }
  git(dir, "reset", "--quiet");
  return left;
}

function prepare(config: Config, build: Build) {
  if (!config.setup) return true;
  const head = git(build.dir, "rev-parse", "HEAD");
  if (build.ready !== head) {
    say(`setup: ${config.setup}`);
    if (!succeeds(build, "setup", config.setup)) return false;
    build.ready = head;
    build.rebuilt = generatedChanges(config, build.dir);
    reset(build.dir);
  }
  if (build.rebuilt && !git(build.dir, "status", "--porcelain", "--", ...(config.generated ?? [])))
    git(build.dir, "apply", "--whitespace=nowarn", build.rebuilt);
  return true;
}

function prepared(config: Config, build: Build) {
  if (!prepare(config, build))
    throw new Failure(
      `setup fails on ${short(git(build.dir, "rev-parse", "HEAD"))}: ${config.setup}`,
    );
}

function generatedChanges(config: Config, dir: string) {
  if (!config.generated?.length) return undefined;
  for (const path of config.generated) run("git", ["add", "-A", "--", path], dir);
  const diff = gitBytes(
    dir,
    "diff-index",
    "--cached",
    "-p",
    "--binary",
    "HEAD",
    "--",
    ...config.generated,
  );
  if (!diff.length) return undefined;
  const file = join(
    git(dir, "rev-parse", "--path-format=absolute", "--git-dir"),
    "autofork-generated.patch",
  );
  writeFileSync(file, diff);
  return file;
}

function regenerate(config: Config, build: Build) {
  if (!config.generated?.length) return;
  prepared(config, build);
  commit(build.dir, "generated");
}

function succeeds(build: Build, check: "setup" | "verify", command: string) {
  const result = spawnSync("sh", ["-c", `exec 2>&1\n${command}`], {
    cwd: build.dir,
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: 1 << 30,
  });
  process.stderr.write(result.stdout);
  if (result.status === 0) return true;
  const lines = result.stdout.toString().trimEnd().split("\n").slice(-100).join("\n");
  build.failed = { check, lines };
  return false;
}

const passes = (config: Fork, build: Build) =>
  prepare(config, build) && (!config.verify || succeeds(build, "verify", config.verify));

function stepPatch(config: Config, build: Build, step: string) {
  const gitDir = git(build.dir, "rev-parse", "--path-format=absolute", "--git-dir");
  const file = join(gitDir, `autofork-${step}.patch`);
  writeFileSync(
    file,
    gitBytes(
      build.dir,
      "diff-tree",
      "-p",
      "--binary",
      "--full-index",
      `${step}~`,
      step,
      "--",
      ...sourcePaths(config),
    ),
  );
  return file;
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
    if (existsSync(join(root, path)))
      cpSync(join(root, path), join(dir, path), { recursive: true });
  }
  return dir;
}

function build(
  root: string,
  config: Fork,
  base: string,
  options: { healFrom?: string; wait?: boolean; fold?: { id: string; patch: string } },
): Build {
  const dir = worktree(root, base);
  const build: Build = {
    dir,
    source: base,
    steps: [commit(dir, `upstream ${short(base)}`)],
    verified: -1,
    healed: new Map(),
    upstreamHas: new Map(),
  };
  for (const id of config.patches) {
    const file = patchFile(dir, id);
    if (options.wait && !options.healFrom && isEmpty(file))
      throw new Drifted(`${id} isn't built yet`);
    if (isEmpty(file) ? options.healFrom : !apply(dir, file, config)) {
      if (!options.healFrom) throw new Drifted(`${id} doesn't apply to ${short(base)}`);
      verify(config, build, options.healFrom);
      heal(
        config,
        build,
        id,
        `Upstream changed, and patch "${id}" no longer applies cleanly.`,
        isEmpty(file) ? undefined : { file, from: options.healFrom },
      );
    } else if (!isEmpty(file) && !changed(dir)) {
      build.upstreamHas.set(id, "the same change, line for line");
    }
    if (options.fold?.id === id && !apply(dir, options.fold.patch, config)) {
      throw new Failure(`your changes don't apply on top of ${id}`);
    }
    build.steps.push(commit(dir, id));
  }
  return build;
}

function verifies(config: Fork, build: Build, step: number, from?: string) {
  const failed = build.failed;
  reset(build.dir, build.steps[step]);
  if (passes(config, build)) return true;
  if (step > 0 || !from) return false;
  const { check } = build.failed!;
  let broke = !config.patches.length;
  if (!broke && from !== build.source) {
    say(`verify with upstream ${short(from)} alone, where the fork was`);
    reset(build.dir, from);
    broke = passes(config, build);
  }
  if (broke)
    throw new Failure(`${check} fails on upstream ${short(build.source)} itself: ${config[check]}`);
  say(
    `${check} fails on upstream alone where the fork was too, so the patches are what make it pass`,
  );
  build.failed = failed;
  return true;
}

function bisect(config: Fork, build: Build, from: string) {
  let bad = build.steps.length;
  while (bad - build.verified > 1) {
    const step = Math.floor((build.verified + bad) / 2);
    say(`verify with ${step ? `the patches up to ${config.patches[step - 1]}` : "upstream alone"}`);
    if (verifies(config, build, step, from)) build.verified = step;
    else bad = step;
  }
  return bad;
}

function restack(config: Fork, build: Build, index: number, from: string) {
  const culprit = config.patches[index];
  const { check, lines } = build.failed!;
  const [built, ...later] = build.steps.splice(index + 1);
  reset(build.dir, build.steps[index]);
  const changes =
    from !== build.source
      ? `\n\nTo see what upstream changed: git diff --stat ${from} ${build.source}`
      : "";
  heal(
    config,
    build,
    culprit,
    `Patch "${culprit}" still applies cleanly, and it's applied here, but \`${config[check]}\` fails with it. Its last lines:\n\n\`\`\`\n${lines}\n\`\`\`${changes}`,
    { file: stepPatch(config, build, built) },
  );
  build.steps.push(commit(build.dir, culprit));
  later.forEach((step, offset) => {
    const id = config.patches[index + 1 + offset];
    const file = stepPatch(config, build, step);
    if (!isEmpty(file) && !apply(build.dir, file, config)) {
      verify(config, build, from);
      heal(
        config,
        build,
        id,
        `Patch "${id}" no longer applies cleanly on top of ${culprit}, which was just rebuilt.`,
        { file },
      );
    } else if (
      sameSource(config, build.dir, "HEAD") &&
      !sameSource(config, build.dir, `${step}~`, step)
    ) {
      throw new Failure(
        `rebuilding ${culprit} also made the change ${id} makes, so ${id} has nothing left to add and nothing was pushed: say in their PATCH.md files which patch makes which change, or merge them into one`,
      );
    }
    build.steps.push(commit(build.dir, id));
  });
}

function verify(config: Fork, build: Build, from?: string) {
  if (!config.setup && !config.verify) return;
  while (!verifies(config, build, build.steps.length - 1, from)) {
    if (!from) throw new Drifted(`${build.failed!.check} fails, so a patch needs rebuilding`);
    say(`${build.failed!.check} failed, finding the patch it fails on`);
    const step = bisect(config, build, from);
    if (step === build.steps.length) {
      say(`${build.failed!.check} passed when run again`);
      break;
    }
    const failing = build.failed!.check;
    const command = config[failing];
    const id = config.patches[step - 1];
    if (run("git", ["diff", "--quiet", build.steps[step - 1], build.steps[step]], build.dir).ok) {
      throw new Failure(
        `${failing} passes and fails on the same code, so the sync can't tell which patch breaks it: ${command}`,
      );
    }
    if (build.healed.has(id))
      throw new Failure(
        `${failing} fails with ${id}, which the agent ${build.healed.get(id)}: ${command}`,
      );
    restack(config, build, step - 1, from);
  }
  build.verified = build.steps.length - 1;
  reset(build.dir, build.steps.at(-1)!);
}

function refresh(target: string, config: Fork, build: Build) {
  config.patches.forEach((id, index) => {
    const diff = gitBytes(
      build.dir,
      "diff-tree",
      "-p",
      "--binary",
      "--full-index",
      build.steps[index],
      build.steps[index + 1],
      "--",
      ...sourcePaths(config),
    );
    if (diff.length || existsSync(patchFile(target, id)))
      writeFileSync(patchFile(target, id), diff);
  });
  for (const [id, reason] of build.upstreamHas) {
    rmSync(patchFile(target, id), { force: true });
    writeFileSync(
      upstreamDoc(target, id),
      `${reason}

${config.upstream} does this on its own as of ${short(build.source)}, so autofork stopped applying this patch.
To keep upstream's version, delete ${DIR}/${id}/.
To keep yours, say in PATCH.md how it differs from upstream's, delete this file and push. The next sync rebuilds it.
`,
    );
  }
}

function cleanup(root: string, build?: Build) {
  if (build) run("git", ["worktree", "remove", "--force", build.dir], root);
}

function workingTree(root: string, skip: string[] = []) {
  const gitDir = git(root, "rev-parse", "--path-format=absolute", "--git-dir");
  const index = join(gitDir, "autofork-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  cpSync(join(gitDir, "index"), index, { preserveTimestamps: true });
  gitWith(root, env, "add", "-A", "--", ".", ...skip.map((path) => `:(exclude,literal)${path}`));
  const tree = gitWith(root, env, "write-tree");
  rmSync(index, { force: true });
  return tree;
}

function check(root: string, config: Fork, against: string, base = baseline(root)) {
  const rebuilt = build(root, config, base, {});
  try {
    const drift = git(
      root,
      "diff-tree",
      "-r",
      "--name-only",
      rebuilt.steps.at(-1)!,
      against,
      "--",
      ...sourcePaths(config),
    );
    return { base, rebuilt: rebuilt.steps.at(-1)!, drift: drift.split("\n").filter(Boolean) };
  } finally {
    cleanup(root, rebuilt);
  }
}

async function sync(root: string, args: string[]) {
  const config = await readConfig(root);
  config.patches.forEach((id) => intent(root, id));
  if (git(root, "status", "--porcelain")) throw new Failure("commit or stash your changes first");
  const { tip, tag } = await fetchUpstream(root, config);
  const base = baseline(root);
  const source = newer(root, base, await newestGreen(root, config, base, tip));
  const key = `${short(source)}-${short(git(root, "rev-parse", "HEAD"))}`;
  output({ key });
  if (flag(args, "--skip") === key) {
    say(
      `already failed on upstream ${short(source)} with this fork, skipping until either changes`,
    );
    return output({ result: "skipped" });
  }
  if (base === source && config.patches.every((id) => !isEmpty(patchFile(root, id)))) {
    say(`already up to date with ${config.upstream} at ${short(source)}`);
    return output({ result: "current" });
  }
  const { drift } = check(root, config, "HEAD", base);
  if (drift.length) {
    throw new Failure(
      `these files differ from what your patches build, so a sync would drop them:\n  ${drift.join("\n  ")}\nSave them as a patch first: write ${DIR}/<id>/PATCH.md, then run autofork save <id>`,
    );
  }
  const moved = base === source ? short(source) : `${short(base)} → ${short(source)}`;
  say(
    `upstream ${moved}, ${config.patches.length} patch${config.patches.length === 1 ? "" : "es"}`,
  );
  const healFrom = args.includes("--no-heal") ? undefined : base;
  let result: Build | undefined;
  try {
    try {
      result = build(root, config, source, { healFrom, wait: true });
      verify(config, result, healFrom);
      regenerate(config, result);
    } catch (error) {
      if (!(error instanceof Drifted)) throw error;
      say(`${error.message}. The next run that heals rebuilds it.`);
      return output({ result: "waiting" });
    }
    refresh(result.dir, config, result);
    const tree = git(result.dir, "rev-parse", `${commit(result.dir, "refresh")}^{tree}`);
    if (tree === git(root, "rev-parse", "HEAD^{tree}")) {
      say("already up to date");
      return output({ result: "current" });
    }
    const head = git(root, "rev-parse", "HEAD");
    const parents = ["-p", head];
    if (!run("git", ["merge-base", "--is-ancestor", source, head], root).ok)
      parents.push("-p", source);
    const lines = [
      ...[...result.healed].map(([id, done]) => `${done} ${id}`),
      ...[...result.upstreamHas].map(([id, reason]) => `upstream has ${id}: ${reason}`),
      ...workflowsBehind(root, base, source).map(
        (file) => `upstream changed ${file} in ${short(base)}..${short(source)}`,
      ),
    ];
    const message = [`autofork: sync ${config.upstream} to ${short(source)}`, lines.join("\n")]
      .filter(Boolean)
      .join("\n\n");
    git(
      root,
      "merge",
      "--ff-only",
      "--quiet",
      git(root, "commit-tree", tree, ...parents, "-m", message),
    );
    say(message);
    output({ result: "synced", ...(tag && source === tip ? { tag } : {}) });
  } finally {
    cleanup(root, result);
  }
}

async function save(root: string, args: string[]) {
  const id = args[0];
  if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    throw new Failure("usage: autofork save <id>   (id like fix-login)");
  if (!existsSync(patchDoc(root, id)))
    throw new Failure(`write ${DIR}/${id}/PATCH.md first: what the change does and why`);
  intent(root, id);
  rmSync(upstreamDoc(root, id), { force: true });
  const config = await readConfig(root);
  await fetchUpstream(root, config);
  const files = workingTree(root);
  const { base, rebuilt, drift } = check(root, config, files);
  if (!drift.length)
    return say(
      `nothing to save: your code matches what the patches build. Push ${DIR}/${id}/PATCH.md as it is and the next sync has an agent build it.`,
    );
  const fold = join(
    git(root, "rev-parse", "--path-format=absolute", "--git-dir"),
    "autofork-fold.patch",
  );
  writeFileSync(
    fold,
    gitBytes(
      root,
      "diff-tree",
      "-p",
      "--binary",
      "--full-index",
      rebuilt,
      files,
      "--",
      ...sourcePaths(config),
    ),
  );
  const result = build(root, config, base, { fold: { id, patch: fold } });
  try {
    refresh(root, config, result);
    say(
      `saved ${drift.length} file${drift.length === 1 ? "" : "s"} to ${DIR}/${id}. Commit and push.`,
    );
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
      # Set up the tools your setup and verify commands need here (node, bun, rust, ...).
      - id: autofork
        uses: AVGVSTVS96/autofork@v1
        env:
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
`;

function options(args: string[]) {
  const setup = flag(args, "--setup");
  const generated = flag(args, "--generated")?.split(",");
  if (generated && !setup)
    throw new Failure("--generated files are rebuilt by --setup, so set it too");
  return { follow: flag(args, "--follow"), setup, generated, verify: flag(args, "--verify") };
}

async function setup(root: string, upstream: string, chosen: ReturnType<typeof options>) {
  if (existsSync(configFile(root))) throw new Failure(`${DIR}/config.json already exists`);
  const follow = chosen.follow ?? (await defaultFollow(root, upstream));
  const config: Config = { ...chosen, upstream, follow };
  writeConfig(root, config);
  const path = join(root, ".github/workflows/autofork.yml");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  if (!existsSync(path))
    writeFileSync(
      path,
      workflow(git(root, "branch", "--show-current") || defaultBranch(root, upstream)),
    );
  await fetchUpstream(root, config);
  const { base, drift } = check(root, { ...config, patches: [] }, workingTree(root));
  const readme = addNote(root, upstream, base, drift);
  const inherited = git(root, "ls-files", ".github/workflows")
    .split("\n")
    .filter((file) => file && !file.endsWith("/autofork.yml"));
  if ("branch" in parseFollow(follow)) {
    say(
      `autofork follows ${upstream}'s ${follow} branch${chosen.follow ? "" : ", since it has no releases"}.`,
    );
  } else {
    const others = (await channels(upstream)).filter((channel) => channel !== follow);
    say(`autofork follows ${upstream}'s ${follow === "releases" ? "" : `${follow} `}releases.`);
    if (others.length)
      say(
        `It also publishes ${others.join(", ")}. To follow one, put it in "follow" in ${DIR}/config.json.`,
      );
  }
  if (inherited.length)
    say(
      `Your fork has ${inherited.length} workflow${inherited.length === 1 ? "" : "s"} copied from upstream, and they run here too. Delete the ones you don't want. autofork leaves workflows to you: it never copies upstream's new ones in, and opens an issue when upstream changes one you keep.`,
    );
  if (readme)
    say(
      `${readme} now says this is a personal fork kept current by autofork. To drop that line, delete it and ${DIR}/${NOTE}/.`,
    );
  if (drift.length)
    say(
      `Your branch already changes ${drift.length} file${drift.length === 1 ? "" : "s"}. Save them as a patch: write ${DIR}/<id>/PATCH.md, then autofork save <id>`,
    );
  return readme;
}

const NOTE = "fork-readme";
const appName = (upstream: string) => basename(upstream).replace(/\.git$/, "");

function withNote(readme: string, upstream: string) {
  if (!readme.trim() || readme.includes("autofork.com")) return undefined;
  const repo = githubRepo(upstream);
  const link = repo
    ? `https://github.com/${repo}`
    : /^https?:\/\//.test(upstream)
      ? upstream.replace(/\.git$/, "")
      : undefined;
  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const lines = readme.split(eol);
  const titled = /^\uFEFF?#\s/.test(lines[0]);
  const name =
    (titled && lines[0].match(/^\uFEFF?#\s+([^[\]<>`*_!]+?)[\s#]*$/)?.[1]) || appName(upstream);
  const note = `> A personal fork of ${link ? `[${name}](${link})` : name} that updates itself with [autofork](https://autofork.com). Its changes, each described in plain words, are in [\`${DIR}/\`](${DIR}).`;
  const at = titled ? 1 : 0;
  const block = titled ? ["", note, ...(lines[1]?.trim() ? [""] : [])] : [note, ""];
  return [...lines.slice(0, at), ...block, ...lines.slice(at)].join(eol);
}

const noteDoc = (
  name: string,
) => `One line under the README's title says this is a personal fork of ${name} that updates itself with autofork, linking ${name}, https://autofork.com and this fork's \`${DIR}/\` folder. The rest of the README stays as upstream wrote it.

To drop the line, delete it from the README and delete this folder, in the same commit.
`;

function addNote(root: string, upstream: string, base: string, drift: string[]) {
  const readme = git(root, "ls-tree", "--name-only", base)
    .split("\n")
    .find((file) => /^readme\.md$/i.test(file));
  if (!readme || drift.includes(readme) || existsSync(join(root, DIR, NOTE))) return;
  const text = withNote(readFileSync(join(root, readme), "utf8"), upstream);
  if (!text) return;
  writeFileSync(join(root, readme), text);
  mkdirSync(join(root, DIR, NOTE), { recursive: true });
  writeFileSync(
    patchFile(root, NOTE),
    gitBytes(
      root,
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--binary",
      "--full-index",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      base,
      "--",
      readme,
    ),
  );
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
  const who =
    (owner?.type === "User" ? owner.name?.trim().split(/\s+/)[0] : owner?.name?.trim()) ||
    fork.owner.login;
  api(
    "-X",
    "PATCH",
    `repos/${repo}`,
    "-f",
    `description=${[`${who}'s autofork`, fork.parent.description].filter(Boolean).join(" · ")}`,
  );
}

async function init(root: string, args: string[]) {
  if (!args[0])
    throw new Failure(
      "usage: autofork init <owner/repo | git url> [--follow <releases | channel | branch>] [--setup <command>] [--generated <files>] [--verify <command>]",
    );
  await setup(root, args[0], options(args));
  claim(root, args[0]);
  say("Add a CLAUDE_CODE_OAUTH_TOKEN secret (claude setup-token), commit, and push.");
}

async function fork(cwd: string, args: string[]) {
  const upstream = args[0];
  if (!/^[\w.-]+\/[\w.-]+$/.test(upstream ?? ""))
    throw new Failure(
      "usage: autofork fork <owner/repo> [--follow <releases | channel | branch>] [--setup <command>] [--generated <files>] [--verify <command>]",
    );
  const chosen = options(args);
  if (!run("gh", ["repo", "fork", upstream, "--clone", "--default-branch-only"], cwd).ok)
    throw new Failure("gh couldn't fork it. Is the GitHub CLI installed and logged in?");
  const root = join(cwd, upstream.split("/")[1]);
  const readme = await setup(root, upstream, chosen);
  claim(root, upstream);
  const repo = origin(root);
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token)
    run("gh", ["secret", "set", "CLAUDE_CODE_OAUTH_TOKEN", "--repo", repo, "--body", token], root);
  git(root, "add", DIR, ".github/workflows/autofork.yml", ...(readme ? [readme] : []));
  git(root, "commit", "--quiet", "-m", `autofork: follow ${upstream}`);
  git(root, "push", "--quiet");
  say(`${repo} now keeps itself current with ${upstream}. It's cloned in ./${basename(root)}.`);
  if (!token)
    say(
      `Last step: run claude setup-token, then gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${repo}`,
    );
}

async function status(root: string) {
  const config = await readConfig(root);
  await fetchUpstream(root, config);
  const { base, drift } = check(root, config, workingTree(root));
  const behind = git(
    root,
    "rev-list",
    "--count",
    "--first-parent",
    `${base}..refs/autofork/upstream`,
  );
  say(
    `${config.upstream} at ${short(base)}, ${behind} commit${behind === "1" ? "" : "s"} behind upstream`,
  );
  for (const id of discover(root)) {
    const note = existsSync(upstreamDoc(root, id))
      ? "  (upstream has it: see UPSTREAM.md)"
      : isEmpty(patchFile(root, id))
        ? "  (not built yet)"
        : "";
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
  autofork sync                 rebuild on upstream; an agent heals what breaks

Options for fork and init:
  --follow <what>               releases (upstream's Latest), a channel of them
                                by tag, like 'v*-nightly.*', or a branch.
                                Default: releases, or the default branch if
                                upstream has none
  --setup <command>             the command that installs dependencies
  --generated <files>           files setup writes, like lockfiles, comma
                                separated: rebuilt by setup, never patched
  --verify <command>            the command that checks a build

A patch is .autofork/<id>/PATCH.md, saying what the change does and why, next
to <id>.patch, the diff. https://github.com/AVGVSTVS96/autofork
`;

const commands: Record<string, (root: string, args: string[]) => Promise<unknown>> = {
  init,
  save,
  status,
  sync,
};

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
