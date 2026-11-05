#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const oidc = {
  url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
};
delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
const LEDGER = process.env.AUTOFORK_LEDGER;
delete process.env.AUTOFORK_LEDGER;
const SITE = process.env.AUTOFORK_URL ?? "https://autofork.com";
const LIMITS = { rebuilds: 10, month: 200, rebuild: 20 };
const EVERY: Record<string, string> = {
  "5m": "2-59/5 * * * *",
  "15m": "7-59/15 * * * *",
  "1h": "17 * * * *",
  "1d": "17 6 * * *",
};
const DIR = ".autofork";
const WORKFLOWS = ".github/workflows";
const CONTROL = [DIR, WORKFLOWS];
const SOURCE = [".", ...CONTROL.map((path) => `:(exclude)${path}`)];
const configs = Number(process.env.GIT_CONFIG_COUNT ?? 0);
const settings = [
  ["commit.gpgsign", "false"],
  ["rebase.autoStash", "true"],
];
const BOT = {
  ...process.env,
  GIT_AUTHOR_NAME: "autofork",
  GIT_AUTHOR_EMAIL: "autofork@users.noreply.github.com",
  GIT_COMMITTER_NAME: "autofork",
  GIT_COMMITTER_EMAIL: "autofork@users.noreply.github.com",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_CONFIG_COUNT: String(configs + settings.length),
  ...Object.fromEntries(
    settings.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${configs + index}`, key],
      [`GIT_CONFIG_VALUE_${configs + index}`, value],
    ]),
  ),
};
const RED = ["failure", "timed_out", "action_required", "startup_failure"];
const MARKER = /^(<{7} ours|>{7} theirs)\r?$/m;
const CHECKS = ["setup", "verify"] as const;

type Config = {
  upstream: string;
  follow: string;
  setup?: string;
  generated?: string[];
  verify?: string;
  agent?: string;
  green?: boolean;
  limits?: Partial<typeof LIMITS>;
  picked?: Checks;
};

type Checks = Partial<Record<(typeof CHECKS)[number], string>>;

type Fork = Config & { patches: string[] };

type Build = {
  dir: string;
  steps: string[];
  source: string;
  healed: Map<string, string>;
  upstreamHas: Map<string, string>;
  ready?: string;
  rebuilt?: string;
  failed?: Failed;
};

type Failed = { check: "setup" | "verify"; lines: string };

type Left = { conflicted: string[]; rejected: string[]; missed: string[]; gone: string[] };

class Failure extends Error {}
class Drifted extends Failure {}
class Waiting extends Drifted {
  constructor(
    message: string,
    readonly why = message,
  ) {
    super(message);
  }
}

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
  const end = `autofork-${randomUUID()}`;
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) =>
        value.includes("\n") ? `${key}<<${end}\n${value}\n${end}\n` : `${key}=${value}\n`,
      )
      .join(""),
    { flag: "a" },
  );
}

async function readConfig(root: string): Promise<Fork> {
  if (!existsSync(configFile(root))) {
    throw new Failure("no .autofork/config.json here. Start with: autofork init <owner/repo>");
  }
  let config: Partial<Config> & { upstream: string };
  try {
    config = JSON.parse(readFileSync(configFile(root), "utf8"));
  } catch (error) {
    throw new Failure(`${DIR}/config.json isn't valid JSON: ${(error as Error).message}`);
  }
  if (!config || typeof config.upstream !== "string" || !config.upstream)
    throw new Failure(`${DIR}/config.json needs "upstream", like "owner/repo"`);
  if (config.generated?.length && !config.setup)
    throw new Failure(
      `"generated" files are rebuilt by "setup", so set your own in ${DIR}/config.json`,
    );
  limitsOf(config);
  const follow = config.follow ?? (await defaultFollow(root, config.upstream));
  const picked: Checks = {};
  for (const key of CHECKS) {
    const command = config.picked?.[key];
    if (!config[key] && typeof command === "string") picked[key] = command;
  }
  return {
    ...config,
    ...picked,
    picked: Object.keys(picked).length ? picked : undefined,
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
  { upstream, follow, setup, generated, verify, agent, green, limits }: Config,
) {
  mkdirSync(join(dir, DIR), { recursive: true });
  writeFileSync(
    configFile(dir),
    `${JSON.stringify({ upstream, follow, setup, generated, verify, agent, green, limits }, null, 2)}\n`,
  );
  keepPatches(dir);
}

function keepPatches(dir: string) {
  const file = join(dir, DIR, ".gitignore");
  if (!existsSync(file)) writeFileSync(file, "!*.patch\n!*.md\n!*.json\n");
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

type Release = { tag_name: string; draft: boolean; published_at: string };

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

function lastSync(root: string) {
  for (const subject of git(
    root,
    "log",
    "--first-parent",
    "--format=%s",
    "-E",
    "--grep=^auto(fork|patch): sync ",
    "HEAD",
  ).split("\n")) {
    const synced = subject.match(/^auto(?:fork|patch): sync .+ to ([0-9a-f]{7,40})$/)?.[1];
    const last =
      synced && run("git", ["rev-parse", "--verify", "--quiet", `${synced}^{commit}`], root);
    if (last && last.ok) return last;
  }
}

function baseline(root: string) {
  const base = lastSync(root) ?? run("git", ["merge-base", "HEAD", "refs/autofork/branch"], root);
  if (!base.ok) throw new Failure("this branch shares no history with upstream");
  return base.out.toString().trim();
}

/* A new fork starts where it follows, even behind the branch it was forked from. Once it has synced
   or has changes of its own, it never moves back */
function newer(root: string, config: Config, base: string, candidate: string) {
  const behind =
    candidate !== base && run("git", ["merge-base", "--is-ancestor", candidate, base], root).ok;
  const own =
    !!lastSync(root) ||
    !run("git", ["diff", "--quiet", base, "HEAD", "--", ...sourcePaths(config)], root).ok;
  return behind && own ? base : candidate;
}

async function newestGreen(root: string, config: Config, base: string, tip: string) {
  const repo = githubRepo(config.upstream);
  if (config.green === false || !("branch" in parseFollow(config.follow)) || !repo) return tip;
  const commits = git(root, "rev-list", "--first-parent", "--max-count=30", `${base}..${tip}`)
    .split("\n")
    .filter(Boolean);
  // Nothing newer: the branch is at or behind base, and newer() decides whether a new fork moves back
  if (!commits.length) return tip;
  for (const sha of commits) {
    const passed = await green(repo, sha);
    if (passed === undefined) return tip;
    if (!passed) continue;
    if (sha !== tip) say(`upstream's tip isn't green yet, using ${short(sha)}`);
    return sha;
  }
  say(`no newer upstream commit has passed its checks yet, staying on ${short(base)}`);
  return base;
}

async function green(repo: string, sha: string) {
  for (let page = 1, read = 0; ; page++) {
    const response = await github(
      `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    if (!response.ok) {
      say(`can't read upstream checks (${response.status}), using upstream's tip`);
      return;
    }
    const { total_count, check_runs } = await response.json();
    if (
      check_runs.some(
        ({ conclusion }: { conclusion: string | null }) => !conclusion || RED.includes(conclusion),
      )
    )
      return false;
    read += check_runs.length;
    if (!check_runs.length || read >= total_count) return true;
  }
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

function unfinished({ conflicted, rejected, missed, gone }: Left, to: string, from?: string) {
  const files = [...conflicted, ...rejected, ...missed, ...gone];
  if (!files.length) return "";
  const left = [
    conflicted.length ? `the conflict markers in ${conflicted.join(", ")}` : "",
    rejected.length
      ? `the hunks that didn't fit, in ${rejected.map((path) => `${path}.rej`).join(", ")}`
      : "",
    missed.length ? `the changes to ${missed.join(", ")}, which didn't apply at all` : "",
    gone.length ? `the deletion of ${gone.join(", ")}, which upstream deleted too` : "",
  ].filter(Boolean);
  const changes =
    from && from !== to
      ? ` To see what upstream changed under them: git diff ${from} ${to} -- ${files.join(" ")}`
      : "";
  return ` Git applied the rest of it. What's left: ${left.join("; ")}.${changes}`;
}

function healPrompt(config: Fork, build: Build, id: string, broken: string) {
  const index = config.patches.indexOf(id);
  const before = config.patches.slice(0, index);
  const after = config.patches.slice(index + 1).filter((later) => !build.upstreamHas.has(later));
  const fresh = isEmpty(patchFile(build.dir, id));
  const steps = [
    `Read ${DIR}/${id}/PATCH.md. It says what the patch does and why, and that's the contract.`,
    ...(fresh
      ? []
      : [
          `${DIR}/${id}/${id}.patch is how it was done before. Use it as a guide, not as text to force in.`,
        ]),
    "Build it on what upstream has now, the smallest change that fully does what PATCH.md says: where upstream has its own version of what the patch touches, change that rather than bringing the old one back. Follow upstream's code and conventions, and leave everything else alone.",
    ...(config.verify
      ? []
      : [
          `This fork has no check yet. From upstream's CI (\`git show ${build.source}:.github/workflows\`), write ${DIR}/config.json's ${
            config.setup
              ? `"verify", which checks a build, as one \`sh -c\` command. A sync runs it on a fresh machine after \`${config.setup}\`, so it can use only what that installs. It has to pass on upstream alone too, or the sync drops it.`
              : `"setup", which installs dependencies, and "verify", which checks a build, each one \`sh -c\` command. A sync runs them on a fresh machine and puts the checkout back as git has it after \`setup\`, so \`setup\` installs all \`verify\` needs, outside the checkout or where git ignores it. Both have to pass on upstream alone too, or the sync drops them.`
          }`,
        ]),
    `Run upstream's own checks for the code you touched, and ${config.verify ? `\`${config.verify}\`` : "your `verify`"}, which the sync has to pass.${config.setup ? ` Dependencies are installed: \`${config.setup}\` ran here, so run it again if you change them.` : ""} Fix what your change breaks.${after.length ? ` Patches after this one aren't applied yet: ${after.join(", ")}. Each goes on top of yours, so leave what its PATCH.md asks for to it.` : ""}`,
    ...(fresh
      ? [
          `Add a short paragraph to the end of ${DIR}/${id}/PATCH.md on why it's built the way it is, for whoever rebuilds it after upstream moves. Keep what's there as it is.`,
        ]
      : []),
  ];
  return `You are keeping a patched fork of ${config.upstream} in sync. The fork is upstream plus a stack of patches, each one described in ${DIR}/<id>/PATCH.md.

This checkout is upstream at ${build.source}${before.length ? `, with ${before.join(", ")} already applied` : ""}. ${fresh ? `Patch "${id}" is new and hasn't been built yet.` : broken}

${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

The sync keeps your source change and puts ${DIR}/ and ${WORKFLOWS}/ back after you, except what this asks you to write there. Remove anything your checks generated that git would pick up${config.generated?.length ? `, but leave ${config.generated.join(", ")}, which the sync rebuilds` : ""}.
If upstream already does what PATCH.md asks, or something close enough that building it would duplicate upstream's own version, write one line saying what upstream does to ${DIR}/${id}/UPSTREAM.md, and the sync leaves the patch out.`;
}

const installed = (bin: string) => run("sh", ["-c", `command -v ${bin}`], ".").ok;

/* Claude's plans count a claude -p run, labeled sdk-cli, as more usage per token than interactive
   Claude Code, and a run labeled autofork like interactive Claude Code (anthropics/claude-code#97074).
   A label inherited from a Claude Code session autofork runs in is that session's, not the user's */
const entrypoint = (!process.env.CLAUDECODE && process.env.CLAUDE_CODE_ENTRYPOINT) || "autofork";

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

function agentCommand(config: Config, cap: number, dir: string) {
  if (config.agent) return { agent: "custom", command: config.agent } as const;
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && existsSync(join(codexHome(), "auth.json"))) {
    const codex = installed("codex") ? "codex" : "npx -y @openai/codex";
    return {
      agent: "codex",
      command: `${codex} exec --json --dangerously-bypass-approvals-and-sandbox -`,
    } as const;
  }
  const claude = installed("claude") ? "claude" : "npx -y @anthropic-ai/claude-code";
  if (
    process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
    /"loggedIn":\s*false/.test(
      run("sh", ["-c", `${claude} auth status --json`], dir).out.toString(),
    )
  )
    throw new Failure(
      "Claude Code isn't signed in, so no agent can run: give the autofork step CLAUDE_CODE_OAUTH_TOKEN (claude setup-token prints one), or CODEX_AUTH for ChatGPT, from the fork's secrets",
    );
  /* Claude Code's default tools, and MCP servers from upstream's .mcp.json, add about 24k tokens that
     every turn reads again; a rebuild needs only these */
  return {
    agent: "claude",
    command: `${claude} -p --dangerously-skip-permissions --output-format json --max-budget-usd ${cap} --tools Bash,Read,Edit,Write,Glob,Grep --strict-mcp-config`,
  } as const;
}

type Row = {
  patch: string;
  agent: "claude" | "codex" | "custom";
  cap: number;
  cost: number;
  status: "running" | "done" | "stopped";
  at: string;
};
type Spend = { cost?: number; model?: string };

/* An agent run blocks the event loop for minutes, and the first request after it can go out on a
   connection the server already closed, so a request that fails at once is tried once more; one that
   timed out may have been saved, so it isn't */
async function site(path: string, body?: object) {
  if (!oidc.url || !oidc.token) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const minted = await fetch(`${oidc.url}&audience=autofork`, {
        headers: { authorization: `Bearer ${oidc.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const { value } = await minted.json();
      if (!minted.ok || typeof value !== "string") return;
      return await fetch(`${SITE}/api/${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${value}`, "content-type": "application/json" },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if ((error as Error).name === "TimeoutError") return;
    }
  }
}

let ledger = { file: "", month: "", rebuilds: [] as Row[] };

function openLedger(file: string) {
  const month = new Date().toISOString().slice(0, 7);
  let saved;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  const rows = saved?.month === month && Array.isArray(saved.rebuilds) ? saved.rebuilds : [];
  ledger = {
    file,
    month,
    rebuilds: rows.filter((row: Row | null) => typeof row?.cost === "number"),
  };
}

function saveLedger() {
  const { file, ...kept } = ledger;
  if (!file) return;
  try {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(kept, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    say(`couldn't write the spend tally to ${file}: ${(error as Error).message}`);
  }
}

const usd = (amount: number) => `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

function limitsOf(config: Partial<Config>) {
  const given = config.limits;
  const limits = { ...LIMITS, ...given };
  if (
    (given !== undefined && (typeof given !== "object" || !given || Array.isArray(given))) ||
    Object.keys(limits).length > 3 ||
    Object.values(limits).some((value) => !Number.isFinite(value) || value < 0) ||
    !limits.rebuild
  )
    throw new Failure(
      `"limits" in ${DIR}/config.json takes numbers, like ${JSON.stringify(LIMITS)}`,
    );
  return limits;
}

async function room(config: Config, count = 1) {
  const limits = limitsOf(config);
  if (ledger.month !== new Date().toISOString().slice(0, 7)) openLedger(ledger.file);
  const answer = await site("ledger");
  const remote = answer?.status === 200 ? await answer.json().catch(() => undefined) : undefined;
  if (oidc.url && !remote)
    say(
      "couldn't read this month's spend from autofork.com, so only this fork's own count is used",
    );
  const rebuilds = Math.max(ledger.rebuilds.length, Number(remote?.rebuilds) || 0);
  const spent = Math.max(
    ledger.rebuilds.reduce(
      (sum, row) => sum + (typeof row.cost === "number" ? row.cost : limits.rebuild),
      0,
    ),
    Number(remote?.spent) || 0,
  );
  const cost = count * limits.rebuild;
  if (rebuilds + count <= limits.rebuilds && spent + cost <= limits.month) return { limits, spent };
  const next = new Date();
  next.setUTCMonth(next.getUTCMonth() + 1, 1);
  const month = next.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const some = count === 1 ? "a rebuild" : `${count} rebuilds`;
  const over = (rebuilds: number, spent: number) =>
    [
      rebuilds + count > limits.rebuilds && "rebuilds",
      spent + cost > limits.month && "month",
    ].filter((key) => key !== false);
  const never = over(0, 0);
  const keys = never.length ? never : over(rebuilds, spent);
  const why = keys
    .map((key) =>
      key === "rebuilds"
        ? `${some} won't fit in this month's ${limits.rebuilds} (${rebuilds} used)`
        : `${some} may cost ${usd(cost)} and ${usd(Math.max(0, limits.month - spent))} of this month's ${usd(limits.month)} is left`,
    )
    .join(", and ");
  const raise = `raise ${keys.map((key) => `"${key}"`).join(" and ")} in "limits" in ${DIR}/config.json`;
  const when = never.length
    ? `It needs you to ${raise}.`
    : `It runs ${month} 1 (UTC), or ${raise}.`;
  return { limits, spent, why, full: `${why}. ${when}` };
}

async function agent(
  config: Config,
  build: Build,
  what: string,
  prompt: string,
  env?: NodeJS.ProcessEnv,
) {
  const dir = build.dir;
  const { limits, full, why } = await room(config);
  if (full) throw new Waiting(`${what} waits: ${full}`, why);
  const { agent, command } = agentCommand(config, limits.rebuild, dir);
  const row: Row = {
    patch: what,
    agent,
    cap: limits.rebuild,
    cost: limits.rebuild,
    status: "running",
    at: new Date().toISOString(),
  };
  ledger.rebuilds.push(row);
  saveLedger();
  output({ ledger: "changed" });
  const opened = await site("ledger", { patch: what, agent, cap: row.cap });
  const id = opened?.status === 201 ? (await opened.json().catch(() => undefined))?.id : undefined;
  const printed = `${dir}-agent.out`;
  const out = openSync(printed, "w");
  const result = spawnSync("sh", ["-c", command], {
    cwd: dir,
    env: { ...(env ?? process.env), CLAUDE_CODE_ENTRYPOINT: entrypoint },
    input: prompt,
    stdio: ["pipe", agent === "custom" ? "inherit" : out, "inherit"],
  });
  closeSync(out);
  const stdout = readFileSync(printed);
  rmSync(printed);
  const spend =
    agent === "claude" ? claudeSpend(stdout) : agent === "codex" ? await codexSpend(stdout) : {};
  row.status = result.status === 0 ? "done" : "stopped";
  if (spend.cost !== undefined) row.cost = spend.cost;
  saveLedger();
  const closed =
    id !== undefined && (await site("ledger/close", { id, status: row.status, ...spend }))?.ok;
  if (oidc.url && !closed) say("couldn't report this rebuild's cost to autofork.com");
  say(`${what} cost ${spend.cost === undefined ? `up to ${usd(row.cap)}` : usd(spend.cost)}`);
  return row.status === "done";
}

function claudeSpend(out: Buffer): Spend {
  let report;
  try {
    report = JSON.parse(out.toString().trim().split("\n").at(-1)!);
  } catch {
    process.stderr.write(out);
    return {};
  }
  if (Array.isArray(report)) report = report.findLast((message) => message?.type === "result");
  if (!report || typeof report !== "object") return {};
  for (const line of [report.result, ...(Array.isArray(report.errors) ? report.errors : [])])
    if (typeof line === "string") say(line);
  const models = Object.entries((report.modelUsage ?? {}) as Record<string, { costUSD?: number }>);
  return {
    cost: typeof report.total_cost_usd === "number" ? report.total_cost_usd : undefined,
    model: models.sort(
      ([, a], [, b]) => (Number(b?.costUSD) || 0) - (Number(a?.costUSD) || 0),
    )[0]?.[0],
  };
}

async function codexSpend(out: Buffer): Promise<Spend> {
  let thread: string | undefined;
  let used: Record<string, number> | undefined;
  for (const line of out.toString().split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (line.trim()) say(line);
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.type === "thread.started") thread = event.thread_id;
    const said = event.type === "item.completed" ? event.item?.text : event.message;
    if (typeof said === "string") say(said);
    if (event.type === "turn.failed" && event.error?.message) say(event.error.message);
    if (event.type === "turn.completed") used = event.usage;
  }
  if (!used || !Object.values(used).some((count) => Number(count) > 0)) return {};
  const model = thread && codexModel(thread);
  const tokens = (key: string) => Number(used![key]) || 0;
  const price = model ? await prices(model) : undefined;
  if (!price || !(Number(price.input_cost_per_token) > 0)) {
    say(`couldn't price ${model ?? "Codex's model"}, so this rebuild counts at its cap`);
    return { model };
  }
  const rate = (key: string) => Number(price[key] ?? price.input_cost_per_token);
  const cost =
    (tokens("input_tokens") - tokens("cached_input_tokens") - tokens("cache_write_input_tokens")) *
      rate("input_cost_per_token") +
    tokens("cached_input_tokens") * rate("cache_read_input_token_cost") +
    tokens("cache_write_input_tokens") * rate("cache_creation_input_token_cost") +
    tokens("output_tokens") * Number(price.output_cost_per_token);
  return Number.isFinite(cost) ? { model, cost } : { model };
}

// Codex's --json events don't name the model, so it's read from the session file Codex writes; if that layout changes, the run counts at its cap.
function codexModel(thread: string) {
  const sessions = join(codexHome(), "sessions");
  try {
    const rollout = readdirSync(sessions, { recursive: true, encoding: "utf8" }).find((name) =>
      name.endsWith(`${thread}.jsonl`),
    );
    return rollout && readFileSync(join(sessions, rollout), "utf8").match(/"model":"([^"]+)"/)?.[1];
  } catch {}
}

let table: Promise<Record<string, Record<string, number>>> | undefined;

async function prices(model: string) {
  table ??= fetch(
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    { signal: AbortSignal.timeout(30_000) },
  )
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => {
      table = undefined;
      return {};
    });
  const rates = await table;
  if (!rates || typeof rates !== "object") return undefined;
  return rates[model] ?? rates[`openai/${model}`];
}

function checksIn(dir: string): Record<string, unknown> | undefined {
  try {
    const written = JSON.parse(readFileSync(configFile(dir), "utf8"));
    if (written && typeof written === "object") return written;
  } catch {}
}

function keepChecks(config: Config, written: Record<string, unknown> | undefined) {
  if (config.verify) return;
  if (!written)
    return say(
      `the agent left ${DIR}/config.json unreadable, so the checks it picked weren't kept`,
    );
  for (const key of CHECKS) {
    const command = written[key];
    if (config[key] || typeof command !== "string" || !command.trim()) continue;
    config[key] = command;
    config.picked = { ...config.picked, [key]: command };
  }
}

function restoreControl(dir: string, base: string) {
  git(dir, "rm", "-rq", "--cached", "--ignore-unmatch", "--", ...CONTROL);
  const owned = git(dir, "ls-tree", "--name-only", base, "--", ...CONTROL)
    .split("\n")
    .filter(Boolean);
  if (owned.length) git(dir, "checkout", base, "--", ...owned);
  git(dir, "clean", "-fdxq", "--", ...CONTROL);
}

function workflowsBehind(root: string, since: string, source: string) {
  const files = (...args: string[]) =>
    git(root, "diff", "--name-only", "--no-renames", ...args, "--", WORKFLOWS).split("\n");
  const upstreamChanged = new Set(files(since, source));
  return files("--diff-filter=MD", "HEAD", source).filter(
    (file) => file && upstreamChanged.has(file),
  );
}

async function updateWorkflows(config: Fork, build: Build, files: string[], range: string) {
  const head = git(build.dir, "rev-parse", "HEAD");
  const own = `${WORKFLOWS}/autofork.yml`;
  const rest = [".", `:(exclude)${WORKFLOWS}`];
  say(`bringing upstream's changes into ${files.join(", ")}`);
  const ran = await agent(
    config,
    build,
    "workflow update",
    `You are keeping a patched fork of ${config.upstream} in sync. The workflows in ${WORKFLOWS}/ are the fork's own copies, and upstream changed ${files.join(", ")}: git diff ${range} -- ${WORKFLOWS}

Bring into this fork's copies what it needs from those changes, and keep what the fork does differently. Add a workflow only where upstream split or renamed one the fork keeps. Only what you change in ${WORKFLOWS}/ is kept, except autofork.yml, and the sync commits it.`,
  ).catch((error) => {
    if (!(error instanceof Failure)) throw error;
    say(
      `workflow update ${error instanceof Waiting ? `has no room: ${error.why}` : `can't run: ${error.message}`}. The workflows stay as they were, and later syncs won't bring them over.`,
    );
  });
  git(build.dir, "reset", "--quiet", head);
  if (!ran) {
    if (ran === false) say("the agent failed while updating workflows, so they stay as they were");
    reset(build.dir);
    return;
  }
  git(build.dir, "checkout", "--", ...rest);
  git(build.dir, "clean", "-fdq", "--", ...rest);
  run("git", ["checkout", "--", own], build.dir);
  git(build.dir, "clean", "-fq", "--", own);
  git(build.dir, "add", "-A", "--", WORKFLOWS);
  const updated = git(
    build.dir,
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    head,
    "--",
    WORKFLOWS,
  );
  return updated.split("\n").filter(Boolean);
}

async function heal(
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
  say(`${doing} ${id}`);
  try {
    if (!(await agent(config, build, id, prompt, BOT)))
      throw new Failure(`the agent failed while ${doing} ${id}`);
    git(build.dir, "reset", "--soft", "--quiet", step);
    const reason = existsSync(upstreamDoc(build.dir, id))
      ? readFileSync(upstreamDoc(build.dir, id), "utf8").trim()
      : "";
    const why = fresh && existsSync(doc) ? readFileSync(doc, "utf8") : "";
    const written = checksIn(build.dir);
    restoreControl(build.dir, step);
    if (reason) {
      keepChecks(config, written);
      reset(build.dir, step);
      build.upstreamHas.set(id, reason);
      return;
    }
    const marked = (left?.conflicted ?? []).filter((path) => {
      const file = join(build.dir, path);
      return existsSync(file) && MARKER.test(readFileSync(file, "utf8"));
    });
    if (marked.length)
      throw new Failure(
        `the agent left conflict markers in ${marked.join(", ")} while ${doing} ${id}`,
      );
    /* When git applied all but deletions upstream made too, the agent finding nothing left to do is
       an answer */
    const settled =
      !!left &&
      !left.conflicted.length &&
      !left.rejected.length &&
      !left.missed.length &&
      !run("git", ["diff", "--quiet", step, before, "--", ...sourcePaths(config)], build.dir).ok;
    if (workingTree(build.dir, rejects) === before && !settled)
      throw new Failure(`the agent changed nothing while ${doing} ${id}`);
    if (why.startsWith(wish)) writeFileSync(doc, why);
    keepChecks(config, written);
    build.healed.set(id, done);
  } finally {
    for (const file of rejects) rmSync(join(build.dir, file), { force: true });
  }
}

function changed(dir: string) {
  return git(dir, "status", "--porcelain").length > 0;
}

function commit(dir: string, message: string) {
  git(dir, "add", "-A");
  const hidden = git(
    dir,
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    DIR,
  )
    .split("\0")
    .filter((path) => /\.(patch|md|json)$|\/\.gitignore$/.test(path));
  if (hidden.length) git(dir, "add", "-f", "--", ...hidden);
  gitWith(dir, BOT, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message);
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
  const left: Left = { conflicted: [], rejected: [], missed: [], gone: [] };
  for (const path of touched(dir, file, config)) {
    const only = [`--include=${path.replace(/[*?[\\]/g, "\\$&")}`, "--whitespace=nowarn", file];
    if (run("git", ["apply", "--3way", ...only], dir).ok) continue;
    if (git(dir, "ls-files", "--unmerged", "--", `:(literal)${path}`)) left.conflicted.push(path);
    else if (run("git", ["apply", "--reject", ...only], dir).ok) continue;
    else if (existsSync(join(dir, `${path}.rej`))) left.rejected.push(path);
    // The patch deletes it and it's already gone: the reverse, creating it, fits
    else if (
      !existsSync(join(dir, path)) &&
      run("git", ["apply", "--reverse", "--check", ...only], dir).ok
    )
      left.gone.push(path);
    else left.missed.push(path);
  }
  git(dir, "reset", "--quiet");
  return left;
}

function prepare(config: Config, build: Build) {
  if (!config.setup) return true;
  const ready = `${git(build.dir, "rev-parse", "HEAD")} ${config.setup}`;
  if (build.ready !== ready) {
    say(`setup: ${config.setup}`);
    if (!succeeds(build, "setup", config.setup)) return false;
    build.ready = ready;
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

function scratch(root: string) {
  const parent = process.env.RUNNER_TEMP ?? join(homedir(), ".cache");
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return join(parent, "autofork", `${basename(root)}-${hash}`);
}

function worktree(root: string, base: string) {
  const dir = scratch(root);
  run("git", ["worktree", "remove", "--force", "--force", dir], root);
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

async function build(
  root: string,
  config: Fork,
  base: string,
  options: { healFrom?: string; wait?: boolean; fold?: { id: string; patch: string } },
): Promise<Build> {
  const dir = worktree(root, base);
  const build: Build = {
    dir,
    source: base,
    steps: [commit(dir, `upstream ${short(base)}`)],
    healed: new Map(),
    upstreamHas: new Map(),
  };
  if (options.healFrom) await fitsUpFront(config, build);
  for (const id of config.patches) {
    const file = patchFile(dir, id);
    if (options.wait && !options.healFrom && isEmpty(file))
      throw new Drifted(`${id} isn't built yet`);
    if (isEmpty(file) ? options.healFrom : !apply(dir, file, config)) {
      if (!options.healFrom) throw new Drifted(`${id} doesn't apply to ${short(base)}`);
      await verify(config, build, options.healFrom);
      await heal(
        config,
        build,
        id,
        `Upstream changed, and patch "${id}" no longer applies cleanly.`,
        isEmpty(file) ? undefined : { file, from: options.healFrom },
      );
    } else {
      if (!isEmpty(file) && !changed(dir))
        build.upstreamHas.set(id, "the same change, line for line");
    }
    if (options.fold?.id === id && !apply(dir, options.fold.patch, config)) {
      throw new Failure(`your changes don't apply on top of ${id}`);
    }
    build.steps.push(commit(dir, id));
  }
  return build;
}

/* git counts the patches that will need an agent, so a sync whose month can't fit them all waits before it pays for any */
async function fitsUpFront(config: Fork, build: Build) {
  const broken = config.patches.filter((id) => {
    const file = patchFile(build.dir, id);
    const fits = !isEmpty(file) && apply(build.dir, file, config);
    if (fits) commit(build.dir, id);
    return !fits;
  });
  reset(build.dir, build.steps[0]);
  git(build.dir, "clean", "-fdxq");
  const { full } = broken.length ? await room(config, broken.length) : {};
  if (full)
    throw new Waiting(`${broken.join(", ")} wait${broken.length === 1 ? "s" : ""}: ${full}`);
}

function passesAt(config: Fork, build: Build, commit: string) {
  reset(build.dir, commit);
  return passes(config, build);
}

async function verify(config: Fork, build: Build, from?: string): Promise<void> {
  if (!config.setup && !config.verify) return;
  try {
    if (passesAt(config, build, build.steps.at(-1)!)) return;
    const failed = build.failed!;
    const patched = build.steps.length > 1 && (!!from || !!config.picked);
    if (patched) say(`${failed.check} fails, verify with upstream ${short(build.source)} alone`);
    const alone = patched && passesAt(config, build, build.steps[0]);
    if (!alone) {
      const { check } = build.failed!;
      const yours = !!config.verify && !config.picked?.verify;
      if (!yours && config.picked?.[check]) {
        say(
          `\`${config[check]}\` fails on upstream alone, so the checks an agent picked are dropped and the next agent that builds or heals a patch picks new ones`,
        );
        for (const key of Object.keys(config.picked) as (keyof Checks)[]) delete config[key];
        delete config.picked;
        return await verify(config, build, from);
      }
      if (from) guard(config, build, from);
      if (build.steps.length <= config.patches.length) return;
    }
    if (!from) throw new Drifted(`${failed.check} fails, so a patch needs rebuilding`);
    await fix(config, build, failed, from, alone);
  } finally {
    reset(build.dir, build.steps.at(-1)!);
  }
}

function guard(config: Fork, build: Build, from: string) {
  const { check } = build.failed!;
  let broke = !config.patches.length;
  if (!broke && from !== build.source) {
    say(`verify with upstream ${short(from)} alone, where the fork was`);
    broke = passesAt(config, build, from);
  }
  if (broke)
    throw new Failure(`${check} fails on upstream ${short(build.source)} itself: ${config[check]}`);
  say(
    `${check} fails on upstream alone where the fork was too, so the patches are what make it pass`,
  );
}

function fixPrompt(config: Fork, build: Build, ids: string[], failed: Failed, from: string) {
  const paused = ids.filter((id) => build.upstreamHas.has(id));
  const later = config.patches.slice(ids.length);
  const changes =
    from !== build.source
      ? `\n\nTo see what upstream changed: git diff --stat ${from} ${build.source}`
      : "";
  return `You are keeping a patched fork of ${config.upstream} in sync. The fork is upstream plus a stack of patches, each one described in ${DIR}/<id>/PATCH.md.

This checkout is upstream at ${build.source} with the patches on top, one commit each, named by its id: ${ids.join(", ")}.${paused.length ? ` Upstream already has ${paused.join(", ")}: leave ${paused.length === 1 ? "its commit" : "their commits"} empty.` : ""} They all apply, but \`${config[failed.check]}\` fails with them. Its last lines:

\`\`\`
${failed.lines}
\`\`\`${changes}

Make it pass. Fold each fix into the commit of the patch it belongs to (git commit --fixup, then an autosquash rebase onto ${build.steps[0]}), built on what upstream has now and in upstream's code and conventions, so each patch still does what its PATCH.md says. When you're done, the commits on ${build.steps[0]} are these patches, one each, named by its id, in this order.${config.setup && failed.check === "verify" ? ` Dependencies are installed: \`${config.setup}\` ran here, so run it again if you change them.` : ""}${later.length ? ` Patches after these aren't applied yet: ${later.join(", ")}. Each goes on top, so leave what its PATCH.md asks for to it.` : ""}

The sync keeps your commits and puts ${DIR}/ and ${WORKFLOWS}/ back after you, except what this asks you to write there. Leave out of your commits anything your checks generated${config.generated?.length ? `, and the changes setup made to ${config.generated.join(", ")}, which the sync rebuilds` : ""}.
If upstream now does what a patch's PATCH.md asks, or something close enough that the patch would duplicate upstream's own version, edit that patch's commit so it's empty, keeping the commit, and write one line saying what upstream does to ${DIR}/<id>/UPSTREAM.md. The sync leaves the patch out.`;
}

const patchId = (config: Config, dir: string, from: string, to: string) =>
  spawnSync("git", ["patch-id", "--stable"], {
    cwd: dir,
    input: gitBytes(
      dir,
      "diff-tree",
      "-p",
      "-U0",
      "--binary",
      from,
      to,
      "--",
      ...sourcePaths(config),
    ),
  })
    .stdout.toString()
    .split(" ")[0];

async function fix(config: Fork, build: Build, failed: Failed, from: string, alone: boolean) {
  const [base, ...before] = build.steps;
  const ids = config.patches.slice(0, before.length);
  const command = config[failed.check];
  if (ids.every((id) => build.upstreamHas.has(id))) {
    if (ids.length < config.patches.length) return;
    throw new Failure(
      `${failed.check} fails on upstream ${short(build.source)}, which has every patch: ${command}`,
    );
  }
  const last = ids.findLastIndex((id) => build.healed.has(id));
  if (
    last >= 0 &&
    (last === 0 || !alone || passesAt(config, build, build.steps[last])) &&
    (last === ids.length - 1 || !passesAt(config, build, build.steps[last + 1]))
  ) {
    say(`${failed.check} fails with ${ids[last]}, which an agent just built, so run it again`);
    if (passesAt(config, build, before.at(-1)!)) return;
    throw new Failure(
      `${failed.check} fails with ${ids[last]}, which the agent ${build.healed.get(ids[last])}: ${command}`,
    );
  }
  reset(build.dir, before.at(-1)!);
  if (failed.check === "verify") prepared(config, build);
  say(`fixing ${failed.check} in the patches`);
  const prompt = fixPrompt(config, build, ids, failed, from);
  if (!(await agent(config, build, `${failed.check} fix`, prompt, BOT)))
    throw new Failure(`the agent failed while fixing ${failed.check}`);
  const pausing = new Set<string>();
  for (const id of ids) {
    const doc = upstreamDoc(build.dir, id);
    const reason = existsSync(doc) ? readFileSync(doc, "utf8").trim() : "";
    if (reason && !build.upstreamHas.has(id)) {
      build.upstreamHas.set(id, reason);
      build.healed.delete(id);
      pausing.add(id);
    }
  }
  if (
    ["rebase-merge", "rebase-apply"].some((path) =>
      existsSync(resolve(build.dir, git(build.dir, "rev-parse", "--git-path", path))),
    )
  )
    throw new Failure(`the agent left a rebase unfinished while fixing ${failed.check}`);
  const onUpstream = run("git", ["merge-base", "--is-ancestor", base, "HEAD"], build.dir).ok;
  if (
    !onUpstream ||
    git(build.dir, "log", "--reverse", "--format=%s", `${base}..HEAD`) !== ids.join("\n")
  )
    throw new Failure(
      `the agent's commits on upstream aren't ${ids.join(", ")}, one per patch in that order, so nothing was pushed`,
    );
  git(build.dir, "reset", "--quiet");
  restoreControl(build.dir, before.at(-1)!);
  if (!run("git", ["diff", "--cached", "--quiet"], build.dir).ok)
    gitWith(
      build.dir,
      BOT,
      "commit",
      "--amend",
      "--quiet",
      "--no-verify",
      "--allow-empty",
      "--no-edit",
    );
  const old = build.steps;
  build.steps = [base, ...git(build.dir, "rev-list", "--reverse", `${base}..HEAD`).split("\n")];
  ids.forEach((id, index) => {
    const was = patchId(config, build.dir, old[index], old[index + 1]);
    const now = patchId(config, build.dir, build.steps[index], build.steps[index + 1]);
    if (build.upstreamHas.has(id)) {
      if (now)
        throw new Failure(
          pausing.has(id)
            ? `the agent wrote UPSTREAM.md for ${id} but left its change in, so nothing was pushed`
            : `the agent's fix changed ${id}, which upstream already has, so nothing was pushed`,
        );
    } else if (was && !now) {
      throw new Failure(
        `the agent's fix left ${id} with nothing to add, so nothing was pushed: say in the PATCH.md files which patch makes which change, or merge them into one`,
      );
    } else if (now !== was) build.healed.set(id, build.healed.get(id) ?? "healed");
  });
  build.ready = undefined;
  if (!passesAt(config, build, build.steps.at(-1)!)) {
    const { check } = build.failed!;
    throw new Failure(`${check} still fails after the agent's fix: ${config[check]}`);
  }
}

function saveConfig(target: string, { follow, picked }: Config) {
  const saved = JSON.parse(readFileSync(configFile(target), "utf8"));
  const config = { ...saved, follow, picked };
  if (JSON.stringify(config) !== JSON.stringify(saved))
    writeFileSync(configFile(target), `${JSON.stringify(config, null, 2)}\n`);
}

function refresh(target: string, config: Fork, build: Build) {
  keepPatches(target);
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

function cleanup(root: string, dir?: string) {
  if (dir) run("git", ["worktree", "remove", "--force", dir], root);
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

async function check(root: string, config: Fork, against: string, base = baseline(root)) {
  const rebuilt = await build(root, config, base, {});
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
    cleanup(root, rebuilt.dir);
  }
}

async function sync(root: string, args: string[]) {
  const config = await readConfig(root);
  config.patches.forEach((id) => intent(root, id));
  if (git(root, "status", "--porcelain")) throw new Failure("commit or stash your changes first");
  const { tip, tag } = await fetchUpstream(root, config);
  const base = baseline(root);
  const source = newer(root, config, base, await newestGreen(root, config, base, tip));
  const key = `${short(source)}-${short(git(root, "rev-parse", "HEAD"))}`;
  output({ key });
  if (flag(args, "--skip") === key) {
    say(
      `autofork: already failed on upstream ${short(source)} with this fork, skipping until either changes`,
    );
    return output({ result: "skipped" });
  }
  if (base === source && config.patches.every((id) => !isEmpty(patchFile(root, id)))) {
    say(`autofork: already up to date with ${config.upstream} at ${short(source)}`);
    return output({ result: "current" });
  }
  const { drift } = await check(root, config, "HEAD", base);
  if (drift.length) {
    throw new Failure(
      `these files differ from what your patches build, so a sync would drop them:\n  ${drift.join("\n  ")}\nWhere one is just an old copy of upstream's, take upstream's first: git checkout ${short(base)} -- <file>, or git rm <file> if upstream had it and deleted it. Then save the fork's own changes, on top of upstream's copies, as a patch: write ${DIR}/<id>/PATCH.md, then run autofork save <id>`,
    );
  }
  const moved = base === source ? short(source) : `${short(base)} → ${short(source)}`;
  say(
    `upstream ${moved}, ${config.patches.length} patch${config.patches.length === 1 ? "" : "es"}`,
  );
  const healFrom = args.includes("--no-heal") ? undefined : base;
  openLedger(LEDGER ?? `${scratch(root)}-ledger.json`);
  const since = run("git", ["merge-base", "HEAD", source], root).out.toString().trim() || base;
  const behind = workflowsBehind(root, since, source);
  const range = `${short(since)}..${short(source)}`;
  let result: Build | undefined;
  let updated: string[] | undefined;
  try {
    try {
      result = await build(root, config, source, { healFrom, wait: true });
      await verify(config, result, healFrom);
      regenerate(config, result);
      if (behind.length && !args.includes("--no-workflows")) {
        if (!healFrom) throw new Drifted("upstream changed workflows this fork keeps");
        updated = await updateWorkflows(config, result, behind, range);
      }
    } catch (error) {
      if (!(error instanceof Drifted)) throw error;
      say(
        `autofork: ${error.message}${error instanceof Waiting ? "" : ". The next run that heals rebuilds it."}`,
      );
      return output({ result: "waiting" });
    }
    saveConfig(result.dir, config);
    refresh(result.dir, config, result);
    const tree = git(result.dir, "rev-parse", `${commit(result.dir, "refresh")}^{tree}`);
    if (tree === git(root, "rev-parse", "HEAD^{tree}") && !behind.length) {
      say("autofork: already up to date");
      return output({ result: "current" });
    }
    const head = git(root, "rev-parse", "HEAD");
    const parents = ["-p", head];
    if (!run("git", ["merge-base", "--is-ancestor", source, head], root).ok)
      parents.push("-p", source);
    const lines = [
      ...[...result.healed].map(([id, done]) => `${done} ${id}`),
      ...[...result.upstreamHas].map(([id, reason]) => `upstream has ${id}: ${reason}`),
      ...(updated
        ? updated.map((file) => `brought upstream's changes to ${file} in ${range}`)
        : behind.map((file) => `upstream changed ${file} in ${range}`)),
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
    cleanup(root, scratch(root));
    saveLedger();
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
  const { base, rebuilt, drift } = await check(root, config, files);
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
  const result = await build(root, config, base, { fold: { id, patch: fold } });
  try {
    refresh(root, config, result);
    say(
      `saved ${drift.length} file${drift.length === 1 ? "" : "s"} to ${DIR}/${id}. Commit and push.`,
    );
  } finally {
    rmSync(fold, { force: true });
    cleanup(root, result.dir);
  }
}

const workflow = (branch: string, cron: string) => `name: autofork

on:
  schedule:
    - cron: "${cron}"
  workflow_dispatch:
  push:
    branches: [${branch}]
    paths: [".autofork/**"]

permissions:
  contents: write
  issues: write
  id-token: write

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
        with:
          codex-auth-url: ${SITE}/api/chatgpt/auth
        env:
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CODEX_AUTH: \${{ secrets.CODEX_AUTH }}
`;

function options(args: string[]) {
  const setup = flag(args, "--setup");
  const generated = flag(args, "--generated")?.split(",");
  if (generated && !setup)
    throw new Failure("--generated files are rebuilt by --setup, so set it too");
  const every = flag(args, "--every");
  if (args.includes("--every") && !Object.hasOwn(EVERY, every ?? ""))
    throw new Failure(`--every takes ${Object.keys(EVERY).join(", ")}, not ${every ?? "nothing"}`);
  return {
    follow: flag(args, "--follow"),
    setup,
    generated,
    verify: flag(args, "--verify"),
    every,
  };
}

async function setup(
  root: string,
  upstream: string,
  { every, ...chosen }: ReturnType<typeof options>,
) {
  if (existsSync(configFile(root))) throw new Failure(`${DIR}/config.json already exists`);
  const follow = chosen.follow ?? (await defaultFollow(root, upstream));
  const config: Config = { ...chosen, upstream, follow, limits: LIMITS };
  // Reach upstream before writing anything, so an init that fails can be run again
  await fetchUpstream(root, config);
  const base = baseline(root);
  writeConfig(root, config);
  const path = join(root, ".github/workflows/autofork.yml");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  if (!existsSync(path)) {
    const repo = !every && origin(root);
    const asked = repo ? run("gh", ["api", `repos/${repo}`, "--jq", ".private"], root) : undefined;
    const answer = asked?.ok ? asked.out.toString().trim() : undefined;
    const hourly = !!asked && answer !== "false";
    if (hourly)
      say(
        `${answer === "true" ? "This repo is private" : "Couldn't tell whether this repo is private"}, and a private repo's scheduled runs bill Actions minutes, so it checks hourly (--every 1h).`,
      );
    writeFileSync(
      path,
      workflow(
        git(root, "branch", "--show-current") || defaultBranch(root, upstream),
        EVERY[every ?? (hourly ? "1h" : "15m")],
      ),
    );
  } else if (
    every ||
    !/^\s*(id-token:\s*['"]?write|permissions:\s*['"]?write-all)/m.test(readFileSync(path, "utf8"))
  )
    say(
      `Kept your ${path.slice(root.length + 1)} as it is: its cron line is the schedule, and spend reporting needs \`id-token: write\` in its permissions.`,
    );
  const { drift } = await check(root, { ...config, patches: [] }, workingTree(root), base);
  const readme = addNote(root, upstream, base, drift);
  const upstreamHas = new Set(
    git(root, "ls-tree", "-r", "--name-only", base, "--", WORKFLOWS).split("\n"),
  );
  const inherited = git(root, "ls-files", WORKFLOWS)
    .split("\n")
    .filter((file) => file && upstreamHas.has(file) && !file.endsWith("/autofork.yml"));
  if ("branch" in parseFollow(follow)) {
    say(
      `autofork follows ${upstream}'s ${follow} branch${chosen.follow ? "" : ", since it has no releases"}.`,
    );
  } else {
    say(`autofork follows ${upstream}'s ${follow === "releases" ? "" : `${follow} `}releases.`);
  }
  if (inherited.length)
    say(
      `Your fork has ${inherited.length} workflow${inherited.length === 1 ? "" : "s"} copied from upstream, and they run here too. Delete the ones you don't want. autofork leaves workflows to you: it never copies upstream's new ones in, and when upstream changes one you keep, the sync's agent brings that into your copy, or opens an issue when the workflow's token can't push workflow files.`,
    );
  if (readme)
    say(
      `The first sync adds a line to ${readme} saying this is a personal fork kept current by autofork. To skip it, delete ${DIR}/${NOTE}/.`,
    );
  if (drift.length)
    say(
      `Your branch already changes ${drift.length} file${drift.length === 1 ? "" : "s"}. Save them as a patch: write ${DIR}/<id>/PATCH.md, then autofork save <id>`,
    );
}

const NOTE = "fork-readme";

function addNote(root: string, upstream: string, base: string, drift: string[]) {
  const readme = git(root, "ls-tree", "--name-only", base)
    .split("\n")
    .find((file) => /^readme\.md$/i.test(file));
  if (!readme || drift.includes(readme) || existsSync(join(root, DIR, NOTE))) return;
  const text = git(root, "show", `${base}:${readme}`);
  if (!text.trim() || text.includes("autofork.com")) return;
  const name = basename(upstream).replace(/\.git$/, "");
  mkdirSync(join(root, DIR, NOTE), { recursive: true });
  writeFileSync(
    patchDoc(root, NOTE),
    `One line under the README's title says this is a personal fork of ${name} that updates itself with autofork, linking ${name}, https://autofork.com and this fork's \`${DIR}/\` folder. The rest of the README stays as upstream wrote it.

To drop the line, delete it from the README and delete this folder, in the same commit.
`,
  );
  return readme;
}

function origin(root: string) {
  for (const args of [
    ["remote", "get-url", "origin"],
    ["config", "--get", "remote.origin.url"],
  ]) {
    const url = run("git", args, root).out.toString().trim();
    const repo = url.match(
      /(?:^|[@/.])github\.com(?::\d+)?[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
    )?.[1];
    if (repo) return repo;
  }
  return "";
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
  const own = fork.description?.trim() ?? "";
  if (/autofork/i.test(own)) return;
  const owner = api(`users/${fork.owner.login}`);
  const who =
    (owner?.type === "User" ? owner.name?.trim().split(/\s+/)[0] : owner?.name?.trim()) ||
    fork.owner.login;
  api(
    "-X",
    "PATCH",
    `repos/${repo}`,
    "-f",
    `description=${[`${who}'s autofork`, own].filter(Boolean).join(" · ")}`,
  );
}

async function init(root: string, args: string[]) {
  if (!args[0])
    throw new Failure(
      "usage: autofork init <owner/repo | git url> [--follow <releases | channel | branch>] [--setup <command>] [--generated <files>] [--verify <command>] [--every <5m | 15m | 1h | 1d>]",
    );
  await setup(root, args[0], options(args));
  claim(root, args[0]);
  const mine = origin(root);
  const repo = mine && ` --repo ${mine}`;
  say(
    `Add a CLAUDE_CODE_OAUTH_TOKEN secret (claude setup-token prints one), commit, and push. If you pushed before the secret was set, start the first sync by hand: gh workflow run autofork.yml${repo}. ${CHATGPT(repo)}`,
  );
  say(LINK);
}

async function fork(cwd: string, args: string[]) {
  const upstream = args[0];
  if (!/^[\w.-]+\/[\w.-]+$/.test(upstream ?? ""))
    throw new Failure(
      "usage: autofork fork <owner/repo> [--follow <releases | channel | branch>] [--setup <command>] [--generated <files>] [--verify <command>] [--every <5m | 15m | 1h | 1d>]",
    );
  const chosen = options(args);
  if (!run("gh", ["repo", "fork", upstream, "--clone", "--default-branch-only"], cwd).ok)
    throw new Failure("gh couldn't fork it. Is the GitHub CLI installed and logged in?");
  const root = join(cwd, upstream.split("/")[1]);
  await setup(root, upstream, chosen);
  claim(root, upstream);
  const repo = origin(root);
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const secret =
    !!token &&
    run("gh", ["secret", "set", "CLAUDE_CODE_OAUTH_TOKEN", "--repo", repo, "--body", token], root)
      .ok;
  git(root, "add", DIR, ".github/workflows/autofork.yml");
  git(root, "commit", "--quiet", "-m", `autofork: follow ${upstream}`);
  git(root, "push", "--quiet");
  say(`${repo} now keeps itself current with ${upstream}. It's cloned in ./${basename(root)}.`);
  if (!secret)
    say(
      `Last step: run claude setup-token, then gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${repo}, then start its first sync: gh workflow run autofork.yml --repo ${repo}. ${CHATGPT(` --repo ${repo}`)}`,
    );
  say(LINK.replace("npx", `cd ${basename(root)} && npx`));
}

const CHATGPT = (repo: string) =>
  `For ChatGPT instead, give the fork a Codex sign-in of its own, since each refresh retires the last one. Turn on device code login in ChatGPT's security settings, run sh -c 'd=$(mktemp -d) && trap "rm -rf \\"\\$d\\"" EXIT && CODEX_HOME="$d" codex login --device-auth && gh secret set CODEX_AUTH${repo} < "$d/auth.json"', then start its first sync: gh workflow run autofork.yml${repo}. Link it too (below): only a linked fork saves Codex's refreshed sign-ins, and without them it stops working within about a week.`;

const LINK = "GitHub's timer can run hours late. Run it on time and track spend: npx autofork link";

async function linked(owner: string, name: string) {
  try {
    const response = await fetch(`${SITE}/api/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, name }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return !!(await response.json())?.linked;
    if (response.status < 500 && response.status !== 429)
      throw new Failure(`${SITE}/api/link answered ${response.status}: ${await response.text()}`);
  } catch (error) {
    if (error instanceof Failure) throw error;
  }
}

async function link(root: string) {
  const [owner, name] = origin(root).split("/");
  if (!name) throw new Failure("run autofork link inside a clone of your fork on GitHub");
  const done = () => say("linked: autofork.com starts it within a minute of upstream changing.");
  const now = await linked(owner, name);
  if (now === undefined) throw new Failure(`can't reach ${SITE}, try again in a minute`);
  if (now) return done();
  const fetched = run("git", ["fetch", "--quiet", "origin", "HEAD"], root);
  if (!fetched.ok) throw new Failure(`can't fetch ${owner}/${name}: ${fetched.err}`);
  if (!run("git", ["cat-file", "-e", `FETCH_HEAD:${DIR}/config.json`], root).ok)
    throw new Failure(`push ${DIR}/config.json to ${owner}/${name}'s default branch first`);
  const page = `${SITE}/link/${owner}/${name}`;
  say(`finish linking in your browser: ${page}`);
  const opener = { darwin: "open", win32: "explorer" }[process.platform as string] ?? "xdg-open";
  spawn(opener, [page], { detached: true, stdio: "ignore" })
    .on("error", () => {})
    .unref();
  for (const deadline = Date.now() + 600_000; Date.now() < deadline;) {
    await new Promise((wake) => setTimeout(wake, 3_000));
    if (await linked(owner, name)) return done();
  }
  throw new Failure(`not linked yet: finish at ${page}, then run autofork link again`);
}

async function status(root: string) {
  const config = await readConfig(root);
  await fetchUpstream(root, config);
  const { base, drift } = await check(root, config, workingTree(root));
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
  autofork link                 have autofork.com start its syncs on time

Options for fork and init:
  --follow <what>               releases (upstream's Latest), a channel of them
                                by tag, like 'v*-nightly.*', or a branch.
                                Default: releases, or the default branch if
                                upstream has none
  --setup <command>             the command that installs dependencies
  --generated <files>           files setup writes, like lockfiles, comma
                                separated: rebuilt by setup, never patched
  --verify <command>            the command that checks a build
  --every <5m|15m|1h|1d>        how often GitHub's timer checks upstream.
                                Default: 15m, or 1h when the repo is private

A patch is .autofork/<id>/PATCH.md, saying what the change does and why, next
to <id>.patch, the diff. https://github.com/AVGVSTVS96/autofork
`;

const commands: Record<string, (root: string, args: string[]) => Promise<unknown>> = {
  init,
  link,
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
  output({ error: (error instanceof Error ? error.message : String(error)).slice(0, 50_000) });
  if (!(error instanceof Failure)) throw error;
  say(`autofork: ${error.message}`);
  process.exitCode = 1;
});
