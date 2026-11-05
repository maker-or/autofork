import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../dist/autofork.js");
const home = mkdtempSync(join(tmpdir(), "autofork-test-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const gitconfig = join(home, "gitconfig");
writeFileSync(
  gitconfig,
  "[user]\n\tname = test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[diff]\n\tnoprefix = true\n",
);
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: gitconfig,
  GIT_CONFIG_NOSYSTEM: "1",
  RUNNER_TEMP: home,
};
const github = join(home, "github");
writeFileSync(gitconfig, `[url "${github}/"]\n\tinsteadOf = https://github.com/\n`, { flag: "a" });
const fakeApi = join(home, "fake-api.mjs");
writeFileSync(
  fakeApi,
  `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const latest = process.env.LATEST_RELEASE;
  if (latest && url.endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: latest }));
  if (process.env.RELEASES && url.includes("/releases?")) return new Response(process.env.RELEASES);
  if (process.env.PRICES && url.endsWith("/model_prices_and_context_window.json")) return new Response(process.env.PRICES);
  if (process.env.CHECK_RUNS && url.includes("/check-runs?")) {
    const { pathname, searchParams } = new URL(url);
    const runs = JSON.parse(process.env.CHECK_RUNS)[pathname.split("/")[5]] ?? [];
    const page = Number(searchParams.get("page") ?? 1);
    return Response.json({ total_count: runs.length, check_runs: runs.slice(page * 100 - 100, page * 100).map((conclusion) => ({ conclusion })) });
  }
  if (url.startsWith("https://token.test/")) return Response.json({ value: "oidc-" + new URL(url).searchParams.get("audience") });
  if (url.startsWith("https://site.test/")) {
    const path = url.slice("https://site.test".length);
    const log = process.env.SITE_LOG;
    let calls = 0;
    try { calls = readFileSync(log, "utf8").split("\\n").filter((line) => line.includes('"' + path + '"')).length; } catch {}
    const body = init.body && JSON.parse(init.body);
    const once = process.env.SITE_FAIL_ONCE === path && log + ".failed";
    if (once && !existsSync(once)) {
      writeFileSync(once, "");
      throw new TypeError("fetch failed");
    }
    appendFileSync(log, JSON.stringify({ method: init.method ?? "GET", path, auth: init.headers?.authorization, body }) + "\\n");
    if (path === "/api/ledger" && !body) return process.env.SITE_TOTALS ? new Response(process.env.SITE_TOTALS) : new Response("{}", { status: 404 });
    if (path === "/api/ledger") return Response.json({ id: "row-1" }, { status: 201 });
    if (path === "/api/ledger/close") return new Response(null, { status: 204 });
    if (path === "/api/link") return Response.json({ linked: calls >= Number(process.env.LINK_AFTER ?? 0), cron: null });
  }
  return new Response("{}", { status: 404 });
};
`,
);

function sh(cwd: string, command: string) {
  const result = spawnSync("sh", ["-c", command], { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}\n${result.stderr}`);
  return result.stdout.trim();
}

function autofork(cwd: string, ...args: string[]) {
  return autoforkWith({}, cwd, ...args);
}

let calls = 0;

function autoforkWith(extra: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
  const outputs = join(home, "github-output");
  writeFileSync(outputs, "");
  const result = spawnSync("node", ["--import", fakeApi, cli, ...args], {
    cwd,
    env: {
      ...env,
      AUTOFORK_LEDGER: join(home, `ledger-${++calls}.json`),
      ...extra,
      GITHUB_OUTPUT: outputs,
    },
    encoding: "utf8",
  });
  const output = Object.fromEntries(
    [...readFileSync(outputs, "utf8").matchAll(/^(\w+)(?:=(.*)|<<(\S+)\n([\s\S]*?)\n\3)$/gm)].map(
      ([, key, value, , block]) => [key, value ?? block],
    ),
  );
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
  write(
    fork,
    ".autofork/config.json",
    `${JSON.stringify({ ...config, agent: `sh ${path}` }, null, 2)}\n`,
  );
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
  const { ok, log } = autofork(
    fork,
    "init",
    upstream,
    "--verify",
    "node -e \"import('./app.js').then(m => process.exit(m.greet('x') === 'x' ? 1 : 0))\"",
  );
  expect(ok).toBe(true);
  expect(log).toContain(`autofork follows ${upstream}'s main branch, since it has no releases`);
  expect(file(fork, ".github/workflows/autofork.yml")).toContain(
    'push:\n    branches: [main]\n    paths: [".autofork/**"]',
  );
  sh(fork, "git add -A && git commit -qm 'track upstream'");
});

test("save turns your changes into the patch PATCH.md describes", () => {
  write(
    fork,
    "app.js",
    'export function greet(name) {\n  return "hello " + name.toUpperCase();\n}\n',
  );
  expect(autofork(fork, "save", "shout").log).toContain("write .autofork/shout/PATCH.md first");
  patch("shout", "greet() shouts the name in upper case.");
  const { ok, log } = autofork(fork, "save", "shout");
  expect(ok).toBe(true);
  expect(log).toContain("saved 1 file to .autofork/shout");
  expect(file(fork, ".autofork/shout/shout.patch")).toContain(
    '+  return "hello " + name.toUpperCase();',
  );
  sh(fork, "git add -A && git commit -qm 'shout'");
  expect(sh(fork, "git ls-files .autofork/shout")).toContain("shout.patch");
});

test("a run killed while it set up its worktree doesn't block the next one", () => {
  const root = sh(fork, "git rev-parse --show-toplevel");
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const dir = join(home, "autofork", `fork-${hash}`);
  sh(fork, `git worktree add -q --detach ${dir} && git worktree lock --reason initializing ${dir}`);
  expect(autofork(fork, "status").ok).toBe(true);
  expect(sh(fork, "git worktree list")).not.toContain(dir);
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

test("an agent that leaves conflict markers fails the heal after one run", () => {
  agent(`echo run >> ${join(home, "runs")}`);
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(false);
  expect(log).toContain("the agent left conflict markers in app.js while healing shout");
  expect(file(home, "runs")).toBe("run\n");
});

test("a drifted patch is healed from git's conflict markers and its PATCH.md", () => {
  agent(
    `grep -q '^<<<<<<< ours' app.js || exit 1\nprintf 'export function greet(name) {\\n  return "hi " + name.toUpperCase();\\n}\\n' > app.js`,
  );
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healing shout");
  expect(log).toContain("healed shout");
  expect(file(fork, "app.js")).toContain('"hi " + name.toUpperCase()');
  expect(file(fork, ".autofork/shout/shout.patch")).toContain(
    '+  return "hi " + name.toUpperCase();',
  );
  expect(file(fork, ".autofork/config.json")).not.toContain("picked");
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
  commitUpstream(
    'export function greet(name) {\n  return "hi " + name.toUpperCase() + "!";\n}\n',
    "shout upstream",
  );
  agent("echo 'upstream greet() upper-cases the name now' > .autofork/shout/UPSTREAM.md");
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("upstream has shout: upstream greet() upper-cases the name now");
  expect(sh(fork, "ls .autofork/shout")).toBe("PATCH.md\nUPSTREAM.md");
  expect(file(fork, ".autofork/shout/UPSTREAM.md")).toContain(
    "autofork stopped applying this patch",
  );
  expect(file(fork, "app.js")).toContain('"hi " + name.toUpperCase() + "!"');
  expect(autofork(fork, "status").log).toContain("shout  (upstream has it");
  agent("exit 1");
  write(upstream, "notes.txt", "two and a half\n");
  sh(upstream, "git commit -qam notes");
  expect(autofork(fork, "sync").ok).toBe(true);
  expect(file(fork, "notes.txt")).toBe("two and a half\n");
});

test("deleting UPSTREAM.md brings your version back", () => {
  write(
    fork,
    ".autofork/shout/PATCH.md",
    "greet() shouts the name and ends with three bangs, not upstream's one.\n",
  );
  sh(fork, "git rm -q .autofork/shout/UPSTREAM.md && git commit -qam 'keep mine'");
  agent(`sed -i 's/ + "!";/ + "!!!";/' app.js`);
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("built shout");
  expect(file(fork, "app.js")).toContain('"!!!"');
  sh(
    fork,
    "git rm -rq .autofork/shout && git checkout refs/autofork/upstream -- app.js && git commit -qm 'take upstream'",
  );
});

test("a patch that's only a PATCH.md is built by the agent", () => {
  patch("wave", "greet() waves at the end.");
  sh(fork, "git add -A && git commit -qm wave");
  expect(autofork(fork, "status").log).toContain("wave  (not built yet)");
  const head = sh(fork, "git rev-parse HEAD");
  const waiting = autofork(fork, "sync", "--no-heal");
  expect(waiting.ok).toBe(true);
  expect(waiting.log).toContain("wave isn't built yet. The next run that heals rebuilds it.");
  expect(waiting.output.result).toBe("waiting");
  expect(sh(fork, "git rev-parse HEAD")).toBe(head);
  write(upstream, "notes.txt", "wave pending\n");
  sh(upstream, "git commit -qam notes");
  expect(autofork(fork, "sync", "--no-heal").output.result).toBe("waiting");
  expect(sh(fork, "git rev-parse HEAD")).toBe(head);
  agent(
    `sed -i 's/ + "!";/ + "! o\\/";/' app.js\nprintf '\\nThe wave is text, so it works in any terminal.\\n' >> .autofork/wave/PATCH.md`,
  );
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("built wave");
  expect(file(fork, "app.js")).toContain('"! o/"');
  expect(file(fork, ".autofork/wave/wave.patch")).toContain('"! o/"');
  expect(file(fork, ".autofork/wave/PATCH.md")).toBe(
    "greet() waves at the end.\n\nThe wave is text, so it works in any terminal.\n",
  );
  agent("exit 1");
  expect(autofork(fork, "sync").log).toContain("already up to date");
});

test("an agent that changes nothing fails the build after one run", () => {
  patch("idle", "greet() idles.");
  sh(fork, "git add -A && git commit -qm idle");
  agent(`echo run >> ${join(home, "idle-runs")}`);
  const { ok, log } = autofork(fork, "sync");
  expect(ok).toBe(false);
  expect(log).toContain("the agent changed nothing while building idle");
  expect(file(home, "idle-runs")).toBe("run\n");
  sh(fork, "git rm -rq .autofork/idle && git commit -qm 'drop idle'");
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
  write(
    fork,
    ".autofork/config.json",
    `${JSON.stringify({ ...config, verify: "touch verify-output.log" }, null, 2)}\n`,
  );
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
  write(
    fork,
    ".autofork/config.json",
    `${JSON.stringify({ ...config, follow: "releases" }, null, 2)}\n`,
  );
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

test("a new fork starts at the release it follows, and one with changes of its own stays where it is", () => {
  const app = join(github, "acme/stable.git");
  mkdirSync(app, { recursive: true });
  sh(
    app,
    "git init -q && mkdir -p .github/workflows && echo one | tee notes.txt > .github/workflows/ci.yml && git add -A && git commit -qm one && git tag v1.0.0 && echo two | tee notes.txt > .github/workflows/ci.yml && git commit -qam two && echo unreleased | tee notes.txt > .github/workflows/ci.yml && git commit -qam unreleased",
  );
  sh(home, `git clone -q ${app} stable && git clone -q ${app} stable-mine`);
  const mine = join(home, "stable");
  expect(autofork(mine, "init", "acme/stable").log).toContain(
    "autofork follows acme/stable's releases.",
  );
  const runs = join(home, "stable-runs.log");
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(mine, ".autofork/config.json", JSON.stringify({ ...config, agent: `echo ran >> ${runs}` }));
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  const { ok, log, output } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(output).toMatchObject({ result: "synced", tag: "v1.0.0" });
  expect(file(mine, "notes.txt")).toBe("one\n");
  expect(log).not.toContain("upstream changed");
  sh(app, "git tag v1.1.0 HEAD~1");
  const next = autofork(mine, "sync");
  expect(next.output).toMatchObject({ result: "synced", tag: "v1.1.0" });
  expect(file(mine, "notes.txt")).toBe("two\n");
  expect(next.log).not.toContain("upstream changed");
  expect(existsSync(runs)).toBe(false);

  const own = join(home, "stable-mine");
  expect(autofork(own, "init", "acme/stable").ok).toBe(true);
  write(own, "notes.txt", "unreleased, and mine\n");
  mkdirSync(join(own, ".autofork/mine"));
  write(own, ".autofork/mine/PATCH.md", "notes.txt is mine.\n");
  expect(autofork(own, "save", "mine").ok).toBe(true);
  sh(own, "git add -A && git commit -qm mine");
  expect(autofork(own, "sync").output.result).toBe("current");
  expect(file(own, "notes.txt")).toBe("unreleased, and mine\n");
});

test("a commit of the fork's own titled like a sync doesn't move where the next sync starts", () => {
  const origin = join(home, "branched");
  const mine = join(home, "branched-fork");
  mkdirSync(origin);
  sh(origin, "git init -q && echo one > notes.txt && git add -A && git commit -qm one");
  sh(home, `git clone -q ${origin} branched-fork`);
  sh(
    origin,
    "git checkout -qb stable && echo two > notes.txt && git commit -qam two && git checkout -q main && echo main > main.txt && git add -A && git commit -qm main",
  );
  expect(autofork(mine, "init", origin, "--follow", "stable").ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track stable'");
  expect(autofork(mine, "sync").output.result).toBe("synced");
  write(mine, ".github/workflows/autofork.yml", "name: autofork\n");
  sh(mine, "git commit -qam 'autofork: sync on pushes to main, the branch this becomes'");
  const { ok, output } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(output.result).toBe("current");
});

test("an upstream commit with a check still running past the first hundred isn't green", () => {
  const app = join(github, "acme/green.git");
  mkdirSync(app, { recursive: true });
  sh(app, "git init -q && echo one > notes.txt && git add -A && git commit -qm one");
  sh(home, `git clone -q ${app} green`);
  const mine = join(home, "green");
  expect(autofork(mine, "init", "acme/green").ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  sh(app, "echo two > notes.txt && git commit -qam two");
  const two = sh(app, "git rev-parse HEAD");
  sh(app, "echo three > notes.txt && git commit -qam three");
  const passed = Array(150).fill("success");
  const runs = { [two]: passed, [sh(app, "git rev-parse HEAD")]: [...passed, null] };
  const { ok, log } = autoforkWith({ CHECK_RUNS: JSON.stringify(runs) }, mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain(`upstream's tip isn't green yet, using ${two.slice(0, 12)}`);
  expect(file(mine, "notes.txt")).toBe("two\n");
});

test("init leaves the README's note to the first sync's agent, and later syncs apply it without the agent", () => {
  const origin = join(home, "demo");
  const mine = join(home, "demo-fork");
  mkdirSync(origin);
  sh(origin, "git init -q");
  const readme = "# Demo\n\nDemo does things.\n\n## Install\n\nRun it.\n";
  write(origin, "README.md", readme);
  sh(origin, "git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} demo-fork`);
  const { ok, log } = autofork(mine, "init", origin);
  expect(ok).toBe(true);
  expect(log).toContain("The first sync adds a line to README.md");
  expect(file(mine, "README.md")).toBe(readme);
  expect(sh(mine, "ls .autofork/fork-readme")).toBe("PATCH.md");
  expect(file(mine, ".autofork/fork-readme/PATCH.md")).toContain("personal fork of demo");
  const useAgent = (agent: string) => {
    const config = JSON.parse(file(mine, ".autofork/config.json"));
    write(mine, ".autofork/config.json", `${JSON.stringify({ ...config, agent }, null, 2)}\n`);
    sh(mine, "git add -A && git commit -qm 'use test agent'");
  };
  const noted = readme.replace("\n\n", "\n\n> A personal fork of Demo.\n\n");
  write(home, "note-agent.sh", `cat > /dev/null\ncat > README.md <<'EOF'\n${noted}EOF\n`);
  useAgent(`sh ${join(home, "note-agent.sh")}`);
  const built = autofork(mine, "sync");
  expect(built.ok).toBe(true);
  expect(built.log).toContain("built fork-readme");
  expect(file(mine, "README.md")).toContain("# Demo\n\n> A personal fork of Demo.\n");
  useAgent("exit 1");
  write(origin, "README.md", readme.replace("Run it.", "Run it with care."));
  sh(origin, "git commit -qam install");
  const synced = autofork(mine, "sync");
  expect(synced.ok).toBe(true);
  expect(synced.log).not.toContain("building");
  expect(file(mine, "README.md")).toContain("> A personal fork of Demo.");
  expect(file(mine, "README.md")).toContain("Run it with care.");
});

test("init leaves out the README line when upstream's README already mentions autofork", () => {
  const origin = join(home, "noted");
  mkdirSync(origin);
  sh(origin, "git init -q");
  write(
    origin,
    "README.md",
    "# Noted\n\n> A personal fork that updates itself with [autofork](https://autofork.com).\n",
  );
  sh(origin, "git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} noted-fork`);
  const mine = join(home, "noted-fork");
  expect(autofork(mine, "init", origin).ok).toBe(true);
  expect(existsSync(join(mine, ".autofork/fork-readme"))).toBe(false);
});

test("a fork on GitHub follows its latest release, not its highest tag", () => {
  const app = join(github, "acme/app.git");
  mkdirSync(app, { recursive: true });
  sh(
    app,
    "git init -q && echo one > notes.txt && git add -A && git commit -qm one && git tag v9.0.0",
  );
  sh(
    app,
    "echo two > notes.txt && git commit -qam two && git tag desktop-v1.0.0 && echo three > notes.txt && git commit -qam three",
  );
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
  sh(
    app,
    "git init -q && echo one > notes.txt && git add -A && git commit -qm one && git tag desktop-v1.0.0",
  );
  sh(home, `git clone -q ${app} desktop`);
  const mine = join(home, "desktop");
  expect(
    autoforkWith({ LATEST_RELEASE: "desktop-v1.0.0" }, mine, "init", "acme/desktop").log,
  ).toContain("autofork follows acme/desktop's releases.");
  sh(mine, "rm -rf .autofork .github");
  expect(autofork(mine, "init", "acme/desktop").log).toContain(
    "acme/desktop's main branch, since it has no releases",
  );
});

test("a fork can follow one channel of upstream's releases, named by its tags", () => {
  const app = join(github, "acme/nightly.git");
  mkdirSync(app, { recursive: true });
  sh(
    app,
    "git init -q && echo one > notes.txt && git add -A && git commit -qm one && git tag v1.0.0",
  );
  sh(
    app,
    "echo two > notes.txt && git commit -qam two && git tag v1.1.0-nightly.1 && echo three > notes.txt && git commit -qam three && git tag v1.1.0-preview.1",
  );
  sh(home, `git clone -q ${app} nightly && git -C nightly reset -q --hard v1.0.0`);
  const mine = join(home, "nightly");
  const releases = JSON.stringify([
    { tag_name: "v1.1.0-nightly.2", draft: true, prerelease: true, published_at: null },
    {
      tag_name: "v1.1.0-preview.1",
      draft: false,
      prerelease: true,
      published_at: "2026-01-03T00:00:00Z",
    },
    {
      tag_name: "v1.1.0-nightly.1",
      draft: false,
      prerelease: true,
      published_at: "2026-01-02T00:00:00Z",
    },
    { tag_name: "v1.0.0", draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z" },
  ]);
  const init = autoforkWith(
    { RELEASES: releases, LATEST_RELEASE: "v1.0.0" },
    mine,
    "init",
    "acme/nightly",
  );
  expect(init.log).toContain("autofork follows acme/nightly's releases.");
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(
    mine,
    ".autofork/config.json",
    `${JSON.stringify({ ...config, follow: "v*-nightly.*" }, null, 2)}\n`,
  );
  sh(mine, "git add -A && git commit -qm 'track nightlies'");
  const synced = autoforkWith({ RELEASES: releases }, mine, "sync");
  expect(synced.output).toMatchObject({ result: "synced", tag: "v1.1.0-nightly.1" });
  expect(file(mine, "notes.txt")).toBe("two\n");
  expect(autofork(mine, "sync").output.result).toBe("current");
  expect(file(mine, "notes.txt")).toBe("two\n");
});

test("init turns on Actions and issues for the fork origin points to, not the upstream gh picks, checks a private fork hourly, and starts the fork's own description with its owner's autofork once", () => {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> ${home}/gh.log
case "$*" in
  "repo view"*) echo acme/app ;;
  "api repos/me/app --jq .private") echo true ;;
  "api repos/me/app") cat ${home}/fork.json ;;
  "api users/me") echo '{"type":"User","name":"Ada Lovelace"}' ;;
  *) echo '{}' ;;
esac
`,
    { mode: 0o755 },
  );
  const repo = (description: string) =>
    write(
      home,
      "fork.json",
      JSON.stringify({
        fork: true,
        description,
        owner: { login: "me" },
        parent: { full_name: "acme/app", description: "An app" },
      }),
    );
  repo("My app, my way");
  sh(
    home,
    `git clone -q ${join(github, "acme/app.git")} mine && git -C mine remote set-url origin git@github.com:me/app.git`,
  );
  const { ok, log } = autoforkWith(
    { PATH: `${bin}:${process.env.PATH}` },
    join(home, "mine"),
    "init",
    "acme/app",
  );
  expect(ok).toBe(true);
  expect(log).toContain("This repo is private");
  expect(log).toContain(
    String.raw`sh -c 'd=$(mktemp -d) && trap "rm -rf \"\$d\"" EXIT && CODEX_HOME="$d" codex login --device-auth && gh secret set CODEX_AUTH --repo me/app < "$d/auth.json"', then start its first sync: gh workflow run autofork.yml --repo me/app.`,
  );
  expect(log).toContain("start the first sync by hand: gh workflow run autofork.yml --repo me/app");
  expect(file(join(home, "mine"), ".github/workflows/autofork.yml")).toContain("17 * * * *");
  const calls = file(home, "gh.log");
  expect(calls).toContain("api -X PUT repos/me/app/actions/permissions -F enabled=true");
  expect(calls).toContain("repo edit me/app --enable-issues");
  expect(calls).toContain(
    "api -X PATCH repos/me/app -f description=Ada's autofork · My app, my way",
  );
  repo("Ada's autofork · My app, my way");
  sh(join(home, "mine"), "rm -rf .autofork .github/workflows/autofork.yml && : > ../gh.log");
  expect(
    autoforkWith({ PATH: `${bin}:${process.env.PATH}` }, join(home, "mine"), "init", "acme/app").ok,
  ).toBe(true);
  expect(file(home, "gh.log")).not.toContain("description=");
});

test("init counts only the workflows the fork has from upstream as copied from it", () => {
  const origin = join(home, "flows");
  const mine = join(home, "flows-fork");
  mkdirSync(join(origin, ".github/workflows"), { recursive: true });
  sh(origin, "git init -q && echo one > app.js");
  write(origin, ".github/workflows/test.yml", "name: test\n");
  sh(origin, "git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} flows-fork`);
  write(mine, ".github/workflows/desktop.yml", "name: desktop\n");
  sh(mine, "git add -A && git commit -qm 'build the desktop app'");
  expect(autofork(mine, "init", origin).log).toContain(
    "Your fork has 1 workflow copied from upstream",
  );
  sh(
    mine,
    "git rm -q .github/workflows/test.yml && rm -rf .autofork .github/workflows/autofork.yml",
  );
  expect(autofork(mine, "init", origin).log).not.toContain("copied from upstream");
});

test("a sync brings upstream's .github/ in, but names upstream's changes to workflows the fork keeps when it can't update them", () => {
  const origin = join(home, "ci");
  const mine = join(home, "ci-fork");
  mkdirSync(join(origin, ".github/workflows"), { recursive: true });
  mkdirSync(join(origin, ".github/scripts"), { recursive: true });
  sh(origin, "git init -q -b trunk && echo one > app.js");
  write(origin, ".github/scripts/changes.cjs", "one\n");
  for (const name of ["release", "test", "lint"])
    write(origin, `.github/workflows/${name}.yml`, `name: ${name}\n`);
  sh(origin, "git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} ci-fork`);
  const base = sh(mine, "git rev-parse HEAD").slice(0, 12);
  expect(autofork(mine, "init", origin).log).toContain(
    "opens an issue when the workflow's token can't push workflow files",
  );
  write(mine, ".github/workflows/release.yml", "name: release from the fork\n");
  sh(
    mine,
    "git rm -q .github/workflows/lint.yml && git add -A && git commit -qm 'track upstream, release from the fork'",
  );
  sh(origin, "echo two > app.js && echo two > .github/scripts/changes.cjs");
  for (const name of ["release", "test", "lint", "deploy"])
    write(origin, `.github/workflows/${name}.yml`, `name: ${name} 2\n`);
  sh(origin, "git add -A && git commit -qm two");
  write(mine, ".github/workflows/test.yml", "name: test 2\n");
  sh(mine, "git commit -qam 'bring test.yml over'");
  const { ok, log } = autofork(mine, "sync", "--no-workflows");
  expect(ok).toBe(true);
  expect(file(mine, "app.js")).toBe("two\n");
  expect(file(mine, ".github/scripts/changes.cjs")).toBe("two\n");
  expect(log).toContain(
    `upstream changed .github/workflows/release.yml in ${base}..${sh(origin, "git rev-parse HEAD").slice(0, 12)}`,
  );
  expect(log).not.toMatch(/upstream changed .*(test|lint|deploy)\.yml/);
  expect(file(mine, ".github/workflows/release.yml")).toBe("name: release from the fork\n");
  expect(sh(mine, "ls .github/workflows")).toBe("autofork.yml\nrelease.yml\ntest.yml");
});

test("the agent brings upstream's changes into the workflows the fork keeps, and only its workflow changes are kept, autofork.yml aside", () => {
  const origin = join(home, "ci");
  const mine = join(home, "ci-fork");
  const path = join(home, "workflow-agent.sh");
  writeFileSync(
    path,
    `cat > ${home}/workflow-prompt.txt\necho 'on: push' >> .github/workflows/release.yml\necho mine > app.js\necho mine >> .github/workflows/autofork.yml\necho 'name: build' > .github/workflows/build.yml\n`,
  );
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(mine, ".autofork/config.json", `${JSON.stringify({ ...config, agent: `sh ${path}` })}\n`);
  sh(mine, "git commit -qam 'use test agent'");
  const from = sh(origin, "git rev-parse HEAD").slice(0, 12);
  sh(origin, "echo three > app.js && echo 'name: release 3' > .github/workflows/release.yml");
  sh(origin, "git commit -qam three");
  const to = sh(origin, "git rev-parse HEAD").slice(0, 12);
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(file(home, "workflow-prompt.txt")).toContain(
    `upstream changed .github/workflows/release.yml: git diff ${from}..${to} -- .github/workflows`,
  );
  expect(log).toContain(
    `brought upstream's changes to .github/workflows/release.yml in ${from}..${to}`,
  );
  expect(log).not.toContain("upstream changed");
  expect(file(mine, ".github/workflows/release.yml")).toBe(
    "name: release from the fork\non: push\n",
  );
  expect(file(mine, "app.js")).toBe("three\n");
  expect(file(mine, ".github/workflows/build.yml")).toBe("name: build\n");
  expect(log).toContain(
    `brought upstream's changes to .github/workflows/build.yml in ${from}..${to}`,
  );
  expect(file(mine, ".github/workflows/autofork.yml")).not.toContain("mine");
});

test("an upstream change to workflows alone moves the fork on, so the agent isn't paid again for it", () => {
  const origin = join(home, "ci");
  const mine = join(home, "ci-fork");
  const path = join(home, "workflow-agent.sh");
  writeFileSync(path, `cat > /dev/null\necho run >> ${home}/workflow-runs.log\n`);
  sh(
    origin,
    "echo 'name: release 4' > .github/workflows/release.yml && git commit -qam 'release 4'",
  );
  expect(autofork(mine, "sync").output.result).toBe("synced");
  expect(autofork(mine, "sync").output.result).toBe("current");
  expect(file(home, "workflow-runs.log")).toBe("run\n");
});

test("a run that doesn't heal leaves upstream's workflow changes for one that does", () => {
  const origin = join(home, "ci");
  const mine = join(home, "ci-fork");
  writeFileSync(join(home, "workflow-runs.log"), "");
  sh(
    origin,
    "echo 'name: release 5' > .github/workflows/release.yml && git commit -qam 'release 5'",
  );
  expect(autofork(mine, "sync", "--no-heal").output.result).toBe("waiting");
  expect(file(home, "workflow-runs.log")).toBe("");
  expect(autofork(mine, "sync").output.result).toBe("synced");
  expect(file(home, "workflow-runs.log")).toBe("run\n");
});

test("a config without follow follows what init would pick", () => {
  const mine = join(home, "ci-fork");
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(
    mine,
    ".autofork/config.json",
    `${JSON.stringify({ upstream: config.upstream }, null, 2)}\n`,
  );
  sh(mine, "git commit -qam 'no follow'");
  sh(join(home, "ci"), "echo four > app.js && git commit -qam four");
  expect(autofork(mine, "sync").output.result).toBe("synced");
  expect(file(mine, "app.js")).toBe("four\n");
  expect(JSON.parse(file(mine, ".autofork/config.json")).follow).toBe(config.follow);
});

const checked = join(home, "checked");
const checkedFork = join(home, "checked-fork");
const runs = join(home, "agent-runs.log");

function checkedAgent(heals: Record<string, string>, fork = checkedFork) {
  const path = join(home, "checked-agent.sh");
  const cases = Object.entries(heals).map(([key, script]) => {
    const fix = key.match(/^fix ?(.*)$/);
    const [name, pattern] = fix ? ["fix", `named by its id: ${fix[1]}`] : [key, `"${key}"`];
    return `  *'${pattern}'*) echo ${name} >> ${runs}; printf '%s' "$prompt" > ${home}/prompt-${name}.txt; ${script} ;;`;
  });
  writeFileSync(path, `prompt="$(cat)"\ncase "$prompt" in\n${cases.join("\n")}\nesac\n`);
  writeFileSync(runs, "");
  const config = JSON.parse(file(fork, ".autofork/config.json"));
  write(
    fork,
    ".autofork/config.json",
    `${JSON.stringify({ ...config, agent: `sh ${path}` }, null, 2)}\n`,
  );
  sh(fork, "git diff --quiet || git commit -qam 'use test agent'");
}

function fixup(fixes: Record<string, string>) {
  const commits = Object.entries(fixes).map(
    ([id, script]) =>
      `${script} && git add -A && git commit -q --fixup=$(git log -1 --format=%H --grep='^${id}$') && `,
  );
  return `${commits.join("")}GIT_SEQUENCE_EDITOR=true git rebase -qi --autosquash $(git log -1 --format=%H --grep='^upstream ')`;
}

function savePatch(id: string, intent: string, change: () => void, fork = checkedFork) {
  change();
  mkdirSync(join(fork, ".autofork", id), { recursive: true });
  write(fork, `.autofork/${id}/PATCH.md`, `${intent}\n`);
  expect(autofork(fork, "save", id).ok).toBe(true);
  sh(fork, `git add -A && git commit -qm ${id}`);
}

const loads = `for f in *.js; do node -e "import('./$f')" || exit 1; done > loaded.txt`;

test("a patch that still applies but fails verify waits for a run that heals", () => {
  mkdirSync(checked);
  sh(checked, "git init -q && echo one > notes.txt");
  write(checked, "name.js", 'export const name = () => "world";\n');
  write(
    checked,
    "app.js",
    'import { name } from "./name.js";\nexport const greet = () => "hello " + name();\n',
  );
  sh(checked, "git add -A && git commit -qm init");
  sh(home, `git clone -q ${checked} checked-fork`);
  expect(autofork(checkedFork, "init", checked, "--verify", loads).ok).toBe(true);
  sh(checkedFork, "git add -A && git commit -qm 'track upstream'");
  savePatch("a-notes", "notes.txt says the notes are mine.", () =>
    write(checkedFork, "notes.txt", "mine\n"),
  );
  savePatch("b-shout", "extra.js has shout(), the name in upper case.", () =>
    write(
      checkedFork,
      "extra.js",
      'import { name } from "./name.js";\nexport const shout = () => name().toUpperCase();\n',
    ),
  );
  write(checked, "name.js", 'export const who = () => "world";\n');
  write(
    checked,
    "app.js",
    'import { who } from "./name.js";\nexport const greet = () => "hello " + who();\n',
  );
  sh(checked, "git commit -qam 'name is who now'");
  checkedAgent({});
  const head = sh(checkedFork, "git rev-parse HEAD");
  const { ok, log, output } = autofork(checkedFork, "sync", "--no-heal");
  expect(ok).toBe(true);
  expect(output.result).toBe("waiting");
  expect(log).toContain(
    "verify fails, so a patch needs rebuilding. The next run that heals rebuilds it.",
  );
  expect(log).not.toContain("alone");
  expect(sh(checkedFork, "git rev-parse HEAD")).toBe(head);
});

test("verify that still fails after the agent's fix fails the sync instead of calling it again", () => {
  savePatch("c-wave", "greet() waves at the end.", () =>
    write(
      checkedFork,
      "app.js",
      'import { name } from "./name.js";\nexport const greet = () => "hello " + name() + " o/";\n',
    ),
  );
  checkedAgent({ fix: "true", "c-wave": "true" });
  const head = sh(checkedFork, "git rev-parse HEAD");
  const { ok, log } = autofork(checkedFork, "sync");
  expect(ok).toBe(false);
  expect(log).toContain(`verify still fails after the agent's fix: ${loads}`);
  expect(file(home, "agent-runs.log")).toBe("fix\n");
  expect(sh(checkedFork, "git rev-parse HEAD")).toBe(head);
});

test("verify that fails on a patch the agent just rebuilt fails the sync instead of paying for a fix", () => {
  checkedAgent({
    fix: fixup({
      "b-shout": `printf 'import { who } from "./name.js";\\nexport const shout = () => who().toUpperCase();\\n' > extra.js`,
    }),
    "c-wave": `printf 'import { whom } from "./name.js";\\nexport const greet = () => "hello " + whom() + " o/";\\n' > app.js`,
  });
  const head = sh(checkedFork, "git rev-parse HEAD");
  const { ok, log } = autofork(checkedFork, "sync");
  expect(ok).toBe(false);
  expect(log).toContain("verify fails with c-wave, which the agent healed");
  expect(file(home, "agent-runs.log")).toBe("fix\nc-wave\n");
  expect(sh(checkedFork, "git rev-parse HEAD")).toBe(head);
});

test("patches that still apply but fail verify are fixed in their own commits by one agent run, before the agent builds a later patch on top of them", () => {
  checkedAgent({
    fix: fixup({
      "b-shout": `printf 'import { who } from "./name.js";\\nexport const shout = () => who().toUpperCase();\\n' > extra.js`,
    }),
    "c-wave": `printf 'import { who } from "./name.js";\\nexport const greet = () => "hello " + who() + " o/";\\n' > app.js`,
  });
  const { ok, log } = autofork(checkedFork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("verify fails, verify with upstream");
  expect(log).toContain("healed b-shout\nhealed c-wave");
  expect(file(home, "agent-runs.log")).toBe("fix\nc-wave\n");
  expect(file(home, "prompt-fix.txt")).toContain(
    `with the patches on top, one commit each, named by its id: a-notes, b-shout. They all apply, but \`${loads}\` fails with them. Its last lines:`,
  );
  expect(file(home, "prompt-fix.txt")).toContain("does not provide an export named 'name'");
  expect(file(home, "prompt-fix.txt")).toContain(
    "Patches after these aren't applied yet: c-wave. Each goes on top, so leave what its PATCH.md asks for to it.",
  );
  expect(file(home, "prompt-fix.txt")).toContain(
    "The sync keeps your commits and puts .autofork/ and .github/workflows/ back after you, except what this asks you to write there.",
  );
  expect(file(checkedFork, "extra.js")).toContain("who().toUpperCase()");
  expect(file(checkedFork, "app.js")).toContain('who() + " o/"');
  expect(file(checkedFork, "notes.txt")).toBe("mine\n");
  expect(file(checkedFork, ".autofork/b-shout/b-shout.patch")).toContain(
    "+export const shout = () => who().toUpperCase();",
  );
});

test("verify that fails on upstream itself fails the sync without the agent", () => {
  write(checked, "name.js", 'export const whom = () => "world";\n');
  sh(checked, "git commit -qam 'break upstream'");
  checkedAgent({ "b-shout": "true", "c-wave": "true" });
  const { ok, log } = autofork(checkedFork, "sync");
  expect(ok).toBe(false);
  expect(log).toContain(
    `verify fails on upstream ${sh(checked, "git rev-parse HEAD").slice(0, 12)} itself`,
  );
  expect(file(home, "agent-runs.log")).toBe("");
});

test("each new patch keeps the note its agent added to PATCH.md, when a later patch is built in the same sync", () => {
  write(checked, "name.js", 'export const who = () => "world";\n');
  sh(checked, "git commit -qam 'fix upstream'");
  for (const id of ["d-bang", "e-tilde"]) {
    mkdirSync(join(checkedFork, ".autofork", id), { recursive: true });
    write(checkedFork, `.autofork/${id}/PATCH.md`, `notes.txt ends with a ${id.slice(2)}.\n`);
  }
  sh(checkedFork, "git add -A && git commit -qm 'two new patches'");
  checkedAgent({
    "d-bang": `echo '!' >> notes.txt; printf '\\nA line of its own.\\n' >> .autofork/d-bang/PATCH.md`,
    "e-tilde": `echo '~' >> notes.txt; printf '\\nAfter the bang.\\n' >> .autofork/e-tilde/PATCH.md`,
  });
  const { ok, log } = autofork(checkedFork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("built d-bang\nbuilt e-tilde");
  expect(file(checkedFork, "notes.txt")).toBe("mine\n!\n~\n");
  expect(file(checkedFork, ".autofork/d-bang/PATCH.md")).toBe(
    "notes.txt ends with a bang.\n\nA line of its own.\n",
  );
  expect(file(checkedFork, ".autofork/e-tilde/PATCH.md")).toBe(
    "notes.txt ends with a tilde.\n\nAfter the bang.\n",
  );
});

test("patches that fail verify are fixed before the agent rebuilds a later one that no longer applies", () => {
  savePatch("f-wink", "wink.js has wink(), the name with a wink.", () =>
    write(
      checkedFork,
      "wink.js",
      'import { who } from "./name.js";\nexport const wink = () => who() + " ;)";\n',
    ),
  );
  savePatch("g-loud", "shout() ends with an exclamation mark.", () =>
    write(
      checkedFork,
      "extra.js",
      'import { who } from "./name.js";\nexport const shout = () => who().toUpperCase() + "!";\n',
    ),
  );
  write(checked, "name.js", 'export const whom = () => "world";\n');
  write(
    checked,
    "app.js",
    'import { whom } from "./name.js";\nexport const greet = () => "hello " + whom();\n',
  );
  sh(checked, "git commit -qam 'who is whom now'");
  checkedAgent({
    "fix a-notes, b-shout.": fixup({
      "b-shout": `printf 'import { whom } from "./name.js";\\nexport const shout = () => whom().toUpperCase();\\n' > extra.js`,
    }),
    "c-wave": `printf 'import { whom } from "./name.js";\\nexport const greet = () => "hello " + whom() + " o/";\\n' > app.js`,
    "fix a-notes, b-shout, c-wave, d-bang, e-tilde, f-wink.": fixup({
      "f-wink": `printf 'import { whom } from "./name.js";\\nexport const wink = () => whom() + " ;)";\\n' > wink.js`,
    }),
    "g-loud": `printf 'import { whom } from "./name.js";\\nexport const shout = () => whom().toUpperCase() + "!";\\n' > extra.js`,
  });
  const { ok, log } = autofork(checkedFork, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healed b-shout\nhealed c-wave\nhealed f-wink\nhealed g-loud");
  expect(file(home, "agent-runs.log")).toBe("fix\nc-wave\nfix\ng-loud\n");
  expect(file(home, "prompt-fix.txt")).toContain(
    `named by its id: a-notes, b-shout, c-wave, d-bang, e-tilde, f-wink. They all apply, but \`${loads}\` fails with them.`,
  );
  expect(file(checkedFork, "extra.js")).toContain('whom().toUpperCase() + "!"');
  expect(file(checkedFork, "wink.js")).toContain('whom() + " ;)"');
  expect(file(checkedFork, "app.js")).toContain('whom() + " o/"');
  expect(file(checkedFork, "notes.txt")).toBe("mine\n!\n~\n");
  expect(existsSync(join(checkedFork, "loaded.txt"))).toBe(false);
});

function checkWith(verify: string) {
  const config = JSON.parse(file(checkedFork, ".autofork/config.json"));
  write(
    checkedFork,
    ".autofork/config.json",
    `${JSON.stringify({ ...config, verify }, null, 2)}\n`,
  );
  checkedAgent({ fix: "true" });
}

test("verify that fails once and passes when run again lets the sync through after an agent run that changes nothing", () => {
  write(checked, "readme.txt", "hi\n");
  sh(checked, "git add -A && git commit -qm readme");
  checkWith(`test -e ${home}/verified || { touch ${home}/verified; exit 1; }`);
  const { ok, log, output } = autofork(checkedFork, "sync");
  expect(ok).toBe(true);
  expect(output.result).toBe("synced");
  expect(log).not.toContain("healed");
  expect(file(home, "agent-runs.log")).toBe("fix\n");
  expect(file(checkedFork, "readme.txt")).toBe("hi\n");
  expect(file(checkedFork, "extra.js")).toContain('whom().toUpperCase() + "!"');
});

test("one agent run fixes every patch that fails verify, each in its own commit, and the patches are read back from them", () => {
  const origin = join(home, "stacked");
  const mine = join(home, "stacked-fork");
  mkdirSync(origin);
  write(origin, "name.js", 'export const who = () => "world";\n');
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} stacked-fork`);
  expect(autofork(mine, "init", origin, "--verify", loads).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "a-loud",
    "loud.js has loud(), the name in upper case.",
    () =>
      write(
        mine,
        "loud.js",
        'import { who } from "./name.js";\nexport const loud = () => who().toUpperCase();\n',
      ),
    mine,
  );
  savePatch(
    "b-wink",
    "wink.js has wink(), the name with a wink.",
    () =>
      write(
        mine,
        "wink.js",
        'import { who } from "./name.js";\nexport const wink = () => who() + " ;)";\n',
      ),
    mine,
  );
  savePatch(
    "c-louder",
    "loud() ends with an exclamation mark.",
    () =>
      write(
        mine,
        "loud.js",
        'import { who } from "./name.js";\nexport const loud = () => who().toUpperCase() + "!";\n',
      ),
    mine,
  );
  write(origin, "name.js", 'export const whom = () => "world";\n');
  sh(origin, "git commit -qam 'who is whom now'");
  checkedAgent(
    {
      fix: [
        "git reset -q --hard $(git log -1 --format=%H --grep='^upstream ')",
        `printf 'import { whom } from "./name.js";\\nexport const loud = () => whom().toUpperCase();\\n' > loud.js && git add -A && git commit -qm a-loud`,
        `printf 'import { whom } from "./name.js";\\nexport const wink = () => whom() + " ;)";\\n' > wink.js && git add -A && git commit -qm b-wink`,
        `printf 'import { whom } from "./name.js";\\nexport const loud = () => whom().toUpperCase() + "!";\\n' > loud.js && git commit -qam c-louder`,
      ].join(" && "),
    },
    mine,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healed a-loud\nhealed b-wink\nhealed c-louder");
  expect(file(home, "agent-runs.log")).toBe("fix\n");
  expect(file(mine, "loud.js")).toBe(
    'import { whom } from "./name.js";\nexport const loud = () => whom().toUpperCase() + "!";\n',
  );
  expect(file(mine, "wink.js")).toContain('whom() + " ;)"');
  expect(file(mine, ".autofork/a-loud/a-loud.patch")).toContain(
    "+export const loud = () => whom().toUpperCase();",
  );
  expect(file(mine, ".autofork/c-louder/c-louder.patch")).toContain(
    '+export const loud = () => whom().toUpperCase() + "!";',
  );
  expect(existsSync(join(mine, "loaded.txt"))).toBe(false);
});

test("an agent fix that leaves a patch with nothing to add fails the sync instead of emptying it", () => {
  const origin = join(home, "overlap");
  const mine = join(home, "overlap-fork");
  mkdirSync(origin);
  write(origin, "name.js", 'export const who = () => "world";\n');
  write(origin, "notes.txt", "one\n");
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} overlap-fork`);
  expect(autofork(mine, "init", origin, "--verify", loads).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "a-loud",
    "loud.js has loud(), the name in upper case.",
    () =>
      write(
        mine,
        "loud.js",
        'import { who } from "./name.js";\nexport const loud = () => who().toUpperCase();\n',
      ),
    mine,
  );
  savePatch(
    "b-notes",
    "notes.txt mentions loud().",
    () => write(mine, "notes.txt", "one\nloud\n"),
    mine,
  );
  write(origin, "name.js", 'export const whom = () => "world";\n');
  sh(origin, "git commit -qam 'who is whom now'");
  checkedAgent(
    {
      fix: [
        "git reset -q --hard $(git log -1 --format=%H --grep='^upstream ')",
        `printf 'import { whom } from "./name.js";\\nexport const loud = () => whom().toUpperCase();\\n' > loud.js && echo loud >> notes.txt && git add -A && git commit -qm a-loud`,
        "git commit -q --allow-empty -m b-notes",
      ].join(" && "),
    },
    mine,
  );
  const head = sh(mine, "git rev-parse HEAD");
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(false);
  expect(log).toContain("the agent's fix left b-notes with nothing to add");
  expect(file(home, "agent-runs.log")).toBe("fix\n");
  expect(sh(mine, "git rev-parse HEAD")).toBe(head);
});

test("a patch that no longer applies keeps what git could apply, and the agent gets only what's left", () => {
  const origin = join(home, "partial");
  const mine = join(home, "partial-fork");
  const lines = Array.from({ length: 20 }, (_, index) => `l${index + 1}`);
  mkdirSync(origin);
  write(origin, "one.txt", "1\n2\n3\n");
  write(origin, "two.txt", "a\nb\nc\n");
  write(origin, "three.txt", "x\n");
  write(origin, "four.txt", `${lines.join("\n")}\n`);
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} partial-fork`);
  expect(autofork(mine, "init", origin).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "edit",
    "Each file says it's mine.",
    () => {
      write(mine, "one.txt", "1\nTWO\n3\n");
      write(mine, "two.txt", "a\nB\nc\n");
      write(mine, "three.txt", "y\n");
      write(
        mine,
        "four.txt",
        `${lines.join("\n").replace("l2\n", "L2\n").replace("l19", "L19")}\n`,
      );
    },
    mine,
  );
  const saved = join(mine, ".autofork/edit/edit.patch");
  writeFileSync(
    saved,
    readFileSync(saved, "utf8").replace(/(?<=four\.txt\nindex )[0-9a-f]{40}/, "1111111"),
  );
  sh(mine, "git commit -qam 'four.txt from a commit this clone never had'");
  write(origin, "one.txt", "1\ndeux\n3\n");
  write(origin, "four.txt", `${lines.join("\n").replace("l2\n", "el2\n")}\n`);
  sh(origin, "git rm -q three.txt && git commit -qam 'upstream moves'");
  checkedAgent(
    {
      edit: `grep -q '^<<<<<<< ours' one.txt && test -f four.txt.rej || exit 1; printf '1\\nTWO\\n3\\n' > one.txt; sed -i 's/^el2$/L2/' four.txt`,
    },
    mine,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healed edit");
  const prompt = file(home, "prompt-edit.txt");
  expect(prompt).toContain(
    "What's left: the conflict markers in one.txt; the hunks that didn't fit, in four.txt.rej; the changes to three.txt, which didn't apply at all.",
  );
  expect(prompt).toMatch(/git diff \w+ \w+ -- one\.txt four\.txt three\.txt$/m);
  expect(prompt).not.toContain("two.txt");
  expect(file(mine, "one.txt")).toBe("1\nTWO\n3\n");
  expect(file(mine, "two.txt")).toBe("a\nB\nc\n");
  expect(file(mine, "four.txt")).toContain("L2\n");
  expect(file(mine, "four.txt")).toContain("L19\n");
  expect(existsSync(join(mine, "three.txt"))).toBe(false);
  expect(existsSync(join(mine, "four.txt.rej"))).toBe(false);
  expect(file(mine, ".autofork/edit/edit.patch")).toContain("+B");
  expect(file(mine, ".autofork/edit/edit.patch")).toContain("+L19");
});

test("setup installs before the agent and verify run, and generated files are rebuilt instead of patched", () => {
  const origin = join(home, "deps");
  const mine = join(home, "deps-fork");
  const setup =
    "mkdir -p deps && cp package.json deps/ && sed 's/^/locked /' package.json > lock.txt";
  mkdirSync(origin);
  write(origin, ".gitignore", "deps/\n");
  write(origin, "package.json", '{\n  "a": "1"\n}\n');
  sh(origin, `git init -q && ${setup} && git add -A && git commit -qm init`);
  sh(home, `git clone -q ${origin} deps-fork`);
  expect(autofork(mine, "init", origin, "--verify", "cmp package.json deps/package.json").ok).toBe(
    true,
  );
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "dep-b",
    "The app depends on b.",
    () => {
      write(mine, "package.json", '{\n  "a": "1",\n  "b": "1"\n}\n');
      sh(mine, setup);
    },
    mine,
  );
  expect(file(mine, ".autofork/dep-b/dep-b.patch")).toContain("lock.txt");
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(
    mine,
    ".autofork/config.json",
    `${JSON.stringify({ ...config, generated: ["lock.txt"] }, null, 2)}\n`,
  );
  expect(autofork(mine, "status").log).toContain('"generated" files are rebuilt by "setup"');
  write(
    mine,
    ".autofork/config.json",
    `${JSON.stringify({ ...config, setup, generated: ["lock.txt"] }, null, 2)}\n`,
  );
  sh(mine, "git commit -qam 'lock.txt is generated'");
  write(origin, "package.json", '{\n  "a": "1",\n  "c": "1"\n}\n');
  sh(origin, `${setup} && git commit -qam 'depend on c'`);
  checkedAgent(
    {
      "dep-b": `grep -q '^<<<<<<< ours' package.json && test -f deps/package.json || exit 1; printf '{\\n  "a": "1",\\n  "b": "1",\\n  "c": "1"\\n}\\n' > package.json`,
    },
    mine,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healed dep-b");
  const prompt = file(home, "prompt-dep-b.txt");
  expect(prompt).toContain(`Dependencies are installed: \`${setup}\` ran here`);
  expect(prompt).toContain("What's left: the conflict markers in package.json.");
  expect(prompt).toContain(
    "The sync keeps your source change and puts .autofork/ and .github/workflows/ back after you, except what this asks you to write there. Remove anything your checks generated that git would pick up, but leave lock.txt, which the sync rebuilds.",
  );
  expect(prompt).toContain(" -- package.json\n");
  expect(file(mine, "lock.txt")).toBe(
    'locked {\nlocked   "a": "1",\nlocked   "b": "1",\nlocked   "c": "1"\nlocked }\n',
  );
  expect(file(mine, ".autofork/dep-b/dep-b.patch")).not.toContain("lock.txt");
  expect(sh(mine, "git status --porcelain")).toBe("");
  write(origin, "notes.txt", "one\n");
  sh(origin, "git add -A && git commit -qm notes");
  checkedAgent({}, mine);
  const again = autofork(mine, "sync");
  expect(again.output.result).toBe("synced");
  expect(file(home, "agent-runs.log")).toBe("");
  expect(file(mine, "lock.txt")).toContain('locked   "b": "1",');
});

test("a patch fixed for verify keeps a later patch upstream merged as is paused", () => {
  const origin = join(home, "merged-later");
  const mine = join(home, "merged-later-fork");
  mkdirSync(origin);
  write(origin, "name.js", 'export const who = () => "world";\n');
  write(origin, "notes.txt", "one\n");
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} merged-later-fork`);
  expect(autofork(mine, "init", origin, "--verify", loads).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "a-loud",
    "loud.js has loud(), the name in upper case.",
    () =>
      write(
        mine,
        "loud.js",
        'import { who } from "./name.js";\nexport const loud = () => who().toUpperCase();\n',
      ),
    mine,
  );
  savePatch(
    "b-notes",
    "notes.txt has a second line.",
    () => write(mine, "notes.txt", "one\ntwo\n"),
    mine,
  );
  write(origin, "name.js", 'export const whom = () => "world";\n');
  write(origin, "notes.txt", "one\ntwo\n");
  sh(origin, "git commit -qam 'who is whom now, and notes has two lines'");
  const loud = `printf 'import { whom } from "./name.js";\\nexport const loud = () => whom().toUpperCase();\\n' > loud.js`;
  checkedAgent({ fix: fixup({ "b-notes": loud }) }, mine);
  const misplaced = autofork(mine, "sync");
  expect(misplaced.ok).toBe(false);
  expect(misplaced.log).toContain("the agent's fix changed b-notes, which upstream already has");
  checkedAgent(
    {
      fix: fixup({
        "a-loud": `printf 'import { whom } from "./name.js";\\nexport const loud = () => whom().toUpperCase();\\n' > loud.js`,
      }),
    },
    mine,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healed a-loud\nupstream has b-notes: the same change, line for line");
  expect(file(home, "agent-runs.log")).toBe("fix\n");
  expect(file(home, "prompt-fix.txt")).toContain(
    "named by its id: a-loud, b-notes. Upstream already has b-notes: leave its commit empty.",
  );
  expect(sh(mine, "ls .autofork/b-notes")).toBe("PATCH.md\nUPSTREAM.md");
});

test("verify that fails on a rebuilt patch under one that applied cleanly fails the sync instead of paying for a fix", () => {
  const origin = join(home, "rebuilt-under");
  const mine = join(home, "rebuilt-under-fork");
  mkdirSync(origin);
  write(origin, "name.js", 'export const who = () => "world";\n');
  write(
    origin,
    "app.js",
    'import { who } from "./name.js";\nexport const greet = () => "hello " + who();\n',
  );
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} rebuilt-under-fork`);
  expect(autofork(mine, "init", origin, "--verify", loads).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "a-wave",
    "greet() waves at the end.",
    () =>
      write(
        mine,
        "app.js",
        'import { who } from "./name.js";\nexport const greet = () => "hello " + who() + " o/";\n',
      ),
    mine,
  );
  savePatch("b-notes", "notes.txt says hi.", () => write(mine, "notes.txt", "hi\n"), mine);
  write(origin, "name.js", 'export const whom = () => "world";\n');
  write(
    origin,
    "app.js",
    'import { whom } from "./name.js";\nexport const greet = () => "hello " + whom();\n',
  );
  sh(origin, "git commit -qam 'who is whom now'");
  checkedAgent(
    {
      "a-wave": `printf 'import { who } from "./name.js";\\nexport const greet = () => "hello " + who() + " o/";\\n' > app.js`,
      fix: "true",
    },
    mine,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(false);
  expect(log).toContain("verify fails with a-wave, which the agent healed");
  expect(file(home, "agent-runs.log")).toBe("a-wave\n");
});

test("a patch that still applies but fails verify because upstream now does it is paused by the fix", () => {
  const origin = join(home, "duplicated");
  const mine = join(home, "duplicated-fork");
  mkdirSync(origin);
  write(origin, "name.js", 'export const who = () => "world";\n');
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} duplicated-fork`);
  expect(autofork(mine, "init", origin, "--verify", loads).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "a-loud",
    "loud.js has loud(), the name in upper case.",
    () =>
      write(
        mine,
        "loud.js",
        'import { who } from "./name.js";\nexport const loud = () => who().toUpperCase();\n',
      ),
    mine,
  );
  write(
    origin,
    "name.js",
    'export const whom = () => "world";\nexport const loud = () => "WORLD";\n',
  );
  sh(origin, "git commit -qam 'name.js has loud() now'");
  checkedAgent(
    {
      fix: [
        "git reset -q --hard $(git log -1 --format=%H --grep='^upstream ')",
        "echo 'name.js exports loud()' > .autofork/a-loud/UPSTREAM.md",
        "git add -A && git commit -qm a-loud",
      ].join(" && "),
    },
    mine,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("upstream has a-loud: name.js exports loud()");
  expect(file(home, "agent-runs.log")).toBe("fix\n");
  expect(existsSync(join(mine, "loud.js"))).toBe(false);
  expect(sh(mine, "ls .autofork/a-loud")).toBe("PATCH.md\nUPSTREAM.md");
});

test("verify sees the generated files setup rebuilt for the patches under it", () => {
  const origin = join(home, "locked");
  const mine = join(home, "locked-fork");
  const setup = "sed 's/^/locked /' package.json > lock.txt";
  mkdirSync(origin);
  write(origin, "package.json", '{\n  "a": "1"\n}\n');
  sh(origin, `git init -q && ${setup} && git add -A && git commit -qm init`);
  sh(home, `git clone -q ${origin} locked-fork`);
  const verify = "sed 's/^/locked /' package.json | cmp - lock.txt";
  const unset = autofork(mine, "init", origin, "--generated", "lock.txt", "--verify", verify);
  expect(unset.log).toContain("--generated files are rebuilt by --setup, so set it too");
  expect(existsSync(join(mine, ".autofork"))).toBe(false);
  expect(
    autofork(
      mine,
      "init",
      origin,
      "--setup",
      setup,
      "--generated",
      "lock.txt,other.lock",
      "--verify",
      verify,
    ).ok,
  ).toBe(true);
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  expect(config).toMatchObject({ setup, generated: ["lock.txt", "other.lock"], verify });
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "dep-b",
    "The app depends on b.",
    () => {
      write(mine, "package.json", '{\n  "a": "1",\n  "b": "1"\n}\n');
      sh(mine, setup);
    },
    mine,
  );
  expect(file(mine, ".autofork/dep-b/dep-b.patch")).not.toContain("lock.txt");
  write(origin, "notes.txt", "one\n");
  sh(origin, "git add -A && git commit -qm notes");
  checkedAgent({}, mine);
  const { ok, output } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(output.result).toBe("synced");
  expect(file(home, "agent-runs.log")).toBe("");
  expect(file(mine, "lock.txt")).toContain('locked   "b": "1"');
});

function breaksSetup(name: string, verify?: string) {
  const origin = join(home, name);
  const mine = join(home, `${name}-fork`);
  const setup = `while read d; do test -f "pkgs/$d" || { echo "no package $d"; exit 1; }; done < deps.txt`;
  mkdirSync(join(origin, "pkgs"), { recursive: true });
  write(origin, "deps.txt", "a\n");
  write(origin, "pkgs/a", "");
  write(origin, "pkgs/b", "");
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} ${name}-fork`);
  expect(autofork(mine, "init", origin, ...(verify ? ["--verify", verify] : [])).ok).toBe(true);
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(mine, ".autofork/config.json", `${JSON.stringify({ ...config, setup }, null, 2)}\n`);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch("dep-b", "The app depends on b.", () => write(mine, "deps.txt", "a\nb\n"), mine);
  sh(origin, "git mv pkgs/b pkgs/bee && git commit -qm 'b is bee now'");
  checkedAgent({ fix: fixup({ "dep-b": `printf 'a\\nbee\\n' > deps.txt` }) }, mine);
  const waiting = autofork(mine, "sync", "--no-heal");
  expect(waiting.output.result).toBe("waiting");
  expect(waiting.log).toContain("setup fails, so a patch needs rebuilding");
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healed dep-b");
  expect(file(home, "agent-runs.log")).toBe("fix\n");
  const prompt = file(home, "prompt-fix.txt");
  expect(prompt).toContain(`but \`${setup}\` fails with them. Its last lines:`);
  expect(prompt).not.toContain("Dependencies are installed");
  expect(prompt).toContain("no package b");
  expect(file(mine, "deps.txt")).toBe("a\nbee\n");
}

test("a patch that still applies but breaks setup is fixed like one that fails verify", () =>
  breaksSetup("installs", "test -f deps.txt"));

test("setup without verify is the check a sync has to pass", () => breaksSetup("installs-only"));

test("a patch the build needs is fixed when verify fails with it, even though upstream alone never passes verify", () => {
  const origin = join(home, "split");
  const mine = join(home, "split-fork");
  mkdirSync(origin);
  write(
    origin,
    "app.js",
    'import { who } from "./lib/name.js";\nexport const greet = () => "hello " + who();\n',
  );
  write(origin, "notes.txt", "one\n");
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} split-fork`);
  expect(autofork(mine, "init", origin, "--verify", loads).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "a-standalone",
    "lib/name.js stands in for the monorepo's name package, so the app builds on its own.",
    () => {
      mkdirSync(join(mine, "lib"));
      write(mine, "lib/name.js", 'export const who = () => "world";\n');
      write(mine, "notes.txt", "one\nstandalone\n");
    },
    mine,
  );
  savePatch(
    "b-shout",
    "extra.js has shout(), the name in upper case.",
    () =>
      write(
        mine,
        "extra.js",
        'import { who } from "./lib/name.js";\nexport const shout = () => who().toUpperCase();\n',
      ),
    mine,
  );
  write(
    origin,
    "app.js",
    'import { whom } from "./lib/name.js";\nexport const greet = () => "hello " + whom();\n',
  );
  sh(origin, "git commit -qam 'greet whom'");
  checkedAgent(
    {
      fix: fixup({
        "a-standalone": `printf 'export const who = () => "world";\\nexport const whom = who;\\n' > lib/name.js`,
      }),
    },
    mine,
  );
  const failed = autofork(mine, "sync");
  expect(failed.ok).toBe(true);
  expect(failed.log).toContain(
    "verify fails on upstream alone where the fork was too, so the patches are what make it pass",
  );
  expect(failed.log).toContain("healed a-standalone");
  expect(file(home, "agent-runs.log")).toBe("fix\n");
  expect(file(home, "prompt-fix.txt")).toContain("named by its id: a-standalone, b-shout.");
  expect(file(mine, "lib/name.js")).toContain("export const whom = who;");
  expect(file(mine, "extra.js")).toContain("who().toUpperCase()");

  write(origin, "notes.txt", "uno\n");
  sh(origin, "git commit -qam 'notes in spanish'");
  checkedAgent(
    {
      "a-standalone": `grep -q '^<<<<<<< ours' notes.txt || exit 1; printf 'uno\\nstandalone\\n' > notes.txt`,
    },
    mine,
  );
  const drifted = autofork(mine, "sync");
  expect(drifted.ok).toBe(true);
  expect(drifted.log).toContain("healed a-standalone");
  expect(file(home, "agent-runs.log")).toBe("a-standalone\n");
  expect(file(mine, "notes.txt")).toBe("uno\nstandalone\n");
  expect(file(mine, "lib/name.js")).toContain("export const whom = who;");
});

test("a rebuild under the patch that makes upstream build doesn't pay for a fix on the stack below it", () => {
  const origin = join(home, "split-later");
  const mine = join(home, "split-later-fork");
  mkdirSync(origin);
  write(
    origin,
    "app.js",
    'import { who } from "./lib/name.js";\nexport const greet = () => "hello " + who();\n',
  );
  write(origin, "notes.txt", "one\n");
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} split-later-fork`);
  expect(autofork(mine, "init", origin, "--verify", loads).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "a-extra",
    "extra.js says hi.",
    () => write(mine, "extra.js", "export const hi = 1;\n"),
    mine,
  );
  savePatch(
    "b-notes",
    "notes.txt has a second line.",
    () => write(mine, "notes.txt", "one\ntwo\n"),
    mine,
  );
  savePatch(
    "c-standalone",
    "lib/name.js stands in for the monorepo's name package, so the app builds on its own.",
    () => {
      mkdirSync(join(mine, "lib"));
      write(mine, "lib/name.js", 'export const who = () => "world";\n');
    },
    mine,
  );
  write(origin, "notes.txt", "uno\n");
  sh(origin, "git commit -qam 'notes in spanish'");
  checkedAgent({ "b-notes": "printf 'uno\\ntwo\\n' > notes.txt", fix: "true" }, mine);
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healed b-notes");
  expect(file(home, "agent-runs.log")).toBe("b-notes\n");
  expect(file(mine, "notes.txt")).toBe("uno\ntwo\n");
});

test("a rebuilt patch upstream needs to build fails the sync without paying for a fix, even under a patch that applies", () => {
  const origin = join(home, "split-last");
  const mine = join(home, "split-last-fork");
  mkdirSync(origin);
  write(
    origin,
    "app.js",
    'import { who } from "./lib/name.js";\nexport const greet = () => "hello " + who();\n',
  );
  write(origin, "notes.txt", "one\n");
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} split-last-fork`);
  expect(autofork(mine, "init", origin, "--verify", loads).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  savePatch(
    "a-extra",
    "extra.js says hi.",
    () => write(mine, "extra.js", "export const hi = 1;\n"),
    mine,
  );
  savePatch(
    "z-standalone",
    "lib/name.js stands in for the monorepo's name package, so the app builds on its own.",
    () => {
      mkdirSync(join(mine, "lib"));
      write(mine, "lib/name.js", 'export const who = () => "world";\n');
      write(mine, "notes.txt", "one\nstandalone\n");
    },
    mine,
  );
  write(origin, "notes.txt", "uno\n");
  sh(origin, "git commit -qam 'notes in spanish'");
  checkedAgent(
    { "z-standalone": "printf 'uno\\nstandalone\\n' > notes.txt && rm lib/name.js", fix: "true" },
    mine,
  );
  const head = sh(mine, "git rev-parse HEAD");
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(false);
  expect(log).toContain("verify fails with z-standalone, which the agent healed");
  expect(file(home, "agent-runs.log")).toBe("z-standalone\n");
  expect(sh(mine, "git rev-parse HEAD")).toBe(head);
});

test("a fork without patches whose upstream never passes verify fails the sync instead of pushing", () => {
  const origin = join(home, "unpatched");
  const mine = join(home, "unpatched-fork");
  mkdirSync(origin);
  write(origin, "notes.txt", "one\n");
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} unpatched-fork`);
  expect(autofork(mine, "init", origin, "--verify", "false").ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  write(origin, "notes.txt", "two\n");
  sh(origin, "git commit -qam two");
  const head = sh(mine, "git rev-parse HEAD");
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(false);
  expect(log).toContain(
    `verify fails on upstream ${sh(origin, "git rev-parse HEAD").slice(0, 12)} itself`,
  );
  expect(sh(mine, "git rev-parse HEAD")).toBe(head);
});

test("a fork with only its upstream gets the setup and verify its first agent picks from upstream's CI", () => {
  const origin = join(home, "bare");
  const mine = join(home, "bare-fork");
  mkdirSync(origin);
  write(origin, "app.js", 'export const greet = (name) => "hello " + name;\n');
  write(origin, ".gitignore", "*.patch\nconfig.json\n*.md\n");
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} bare-fork`);
  const script = join(home, "bare-agent.sh");
  write(
    home,
    "bare-agent.sh",
    `cat > ${join(home, "bare-prompt.txt")}
sed -i 's/+ name/+ name.toUpperCase()/' app.js
node -e 'const fs = require("fs"); const c = JSON.parse(fs.readFileSync(".autofork/config.json")); fs.writeFileSync(".autofork/config.json", JSON.stringify({ ...c, setup: "echo installed", verify: "node --check app.js && echo verified" }))'
`,
  );
  mkdirSync(join(mine, ".autofork/shout"), { recursive: true });
  write(mine, ".autofork/config.json", JSON.stringify({ upstream: origin, agent: `sh ${script}` }));
  write(mine, ".autofork/shout/PATCH.md", "greet() shouts the name.\n");
  sh(
    mine,
    "git add -A && git add -f .autofork && git commit -qm 'autofork: greet() shouts the name'",
  );

  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(file(home, "bare-prompt.txt")).toContain(
    'write .autofork/config.json\'s "setup", which installs dependencies, and "verify", which checks a build',
  );
  expect(log).toContain("built shout");
  expect(log).toContain("setup: echo installed");
  expect(log).toContain("verified");
  expect(JSON.parse(file(mine, ".autofork/config.json"))).toEqual({
    upstream: origin,
    agent: `sh ${script}`,
    follow: "main",
    picked: { setup: "echo installed", verify: "node --check app.js && echo verified" },
  });
  expect(sh(mine, "git ls-files .autofork").split("\n")).toEqual(
    expect.arrayContaining([
      ".autofork/config.json",
      ".autofork/shout/PATCH.md",
      ".autofork/shout/shout.patch",
    ]),
  );

  write(origin, "notes.txt", "two\n");
  sh(origin, "git add -A && git commit -qm notes");
  const later = autofork(mine, "sync");
  expect(later.ok).toBe(true);
  expect(later.log).toContain("verified");
  expect(JSON.parse(file(mine, ".autofork/config.json")).picked).toEqual({
    setup: "echo installed",
    verify: "node --check app.js && echo verified",
  });
});

function picking(name: string, own: object = {}) {
  const origin = join(home, name);
  const mine = join(home, `${name}-fork`);
  const tool = join(home, `${name}-tool`);
  const runs = join(home, `${name}-runs.log`);
  const prompt = join(home, `${name}-prompt.txt`);
  const script = join(home, `${name}-agent.sh`);
  mkdirSync(origin);
  write(origin, "app.js", 'export const greet = (name) => "hello " + name;\n');
  sh(origin, "git init -q && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} ${name}-fork`);
  const agent = (checks: object, edit = "sed -i 's/+ name/+ name.toUpperCase()/' app.js") =>
    writeFileSync(
      script,
      `cat > ${prompt}
echo ran >> ${runs}
touch ${tool}
${edit}
node -e 'const fs = require("fs"); const c = JSON.parse(fs.readFileSync(".autofork/config.json")); fs.writeFileSync(".autofork/config.json", JSON.stringify({ ...c, ...JSON.parse(process.argv[1]) }))' '${JSON.stringify(checks).replaceAll("'", "'\\''")}'
`,
    );
  mkdirSync(join(mine, ".autofork/shout"), { recursive: true });
  write(
    mine,
    ".autofork/config.json",
    JSON.stringify({ upstream: origin, agent: `sh ${script}`, ...own }),
  );
  write(mine, ".autofork/shout/PATCH.md", "greet() shouts the name.\n");
  sh(mine, "git add -A && git commit -qm 'autofork: greet() shouts the name'");
  const moveUpstream = () => {
    write(origin, "notes.txt", "two\n");
    sh(origin, "git add -A && git commit -qm notes");
  };
  return { origin, mine, tool, runs, prompt, script, agent, moveUpstream };
}

test("checks an agent picked that fail on upstream alone are dropped, and the sync ships without them, even one that doesn't heal", () => {
  const { mine, tool, runs, prompt, agent, moveUpstream } = picking("handmade", { setup: "true" });
  agent({ verify: `test -f ${tool}` });
  expect(autofork(mine, "sync").ok).toBe(true);
  expect(readFileSync(prompt, "utf8")).toContain(
    'write .autofork/config.json\'s "verify", which checks a build, as one `sh -c` command. A sync runs it on a fresh machine after `true`',
  );
  expect(JSON.parse(file(mine, ".autofork/config.json")).picked).toEqual({
    verify: `test -f ${tool}`,
  });
  rmSync(tool);
  moveUpstream();
  const { ok, log } = autofork(mine, "sync", "--no-heal");
  expect(ok).toBe(true);
  expect(log).toContain(
    `\`test -f ${tool}\` fails on upstream alone, so the checks an agent picked are dropped`,
  );
  expect(readFileSync(runs, "utf8")).toBe("ran\n");
  expect(file(mine, "notes.txt")).toBe("two\n");
  expect(file(mine, "app.js")).toContain("name.toUpperCase()");
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  expect(config.setup).toBe("true");
  expect(config.picked).toBeUndefined();
});

test("checks an agent picked that fail on upstream alone are dropped before it rebuilds a patch, and it picks new ones", () => {
  const { origin, mine, tool, prompt, agent } = picking("repick");
  agent({ setup: "true", verify: `test -f ${tool}` });
  expect(autofork(mine, "sync").ok).toBe(true);
  expect(readFileSync(prompt, "utf8")).toContain(
    'write .autofork/config.json\'s "setup", which installs dependencies, and "verify", which checks a build',
  );
  rmSync(tool);
  write(origin, "app.js", 'export const greet = (name) => "hi " + name;\n');
  sh(origin, "git commit -qam hi");
  agent(
    { verify: "node --check app.js" },
    `printf 'export const greet = (name) => "hi " + name.toUpperCase();\\n' > app.js`,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("the checks an agent picked are dropped");
  expect(readFileSync(prompt, "utf8")).toContain("This fork has no check yet");
  expect(file(mine, "app.js")).toContain('"hi " + name.toUpperCase()');
  expect(JSON.parse(file(mine, ".autofork/config.json")).picked).toEqual({
    verify: "node --check app.js",
  });
});

test("new picks that replace dropped ones run their own setup on upstream alone, so a patch that breaks them still stops the sync", () => {
  const ready = join(home, "replaced-ready");
  const { origin, mine, tool, runs, agent } = picking("replaced");
  agent({ setup: "true", verify: `test -f ${tool}` });
  expect(autofork(mine, "sync").ok).toBe(true);
  rmSync(tool);
  write(origin, "app.js", 'export const greet = (name) => "hi " + name;\n');
  sh(origin, "git commit -qam hi");
  agent(
    { setup: `! grep -q broken app.js && touch ${ready}`, verify: `test -f ${ready}` },
    `printf 'export const greet = (name) => "hi " + name.toUpperCase(); // broken\\n' > app.js`,
  );
  const head = sh(mine, "git rev-parse HEAD");
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(false);
  expect(log).toContain("the checks an agent picked are dropped");
  expect(log).toContain("setup fails with shout, which the agent healed");
  expect(readFileSync(runs, "utf8")).toBe("ran\nran\n");
  expect(sh(mine, "git rev-parse HEAD")).toBe(head);
});

test("checks an agent leaves in an unreadable config aren't kept, and the sync says so", () => {
  const { mine, script } = picking("unreadable");
  writeFileSync(
    script,
    `cat > /dev/null
sed -i 's/+ name/+ name.toUpperCase()/' app.js
printf '{"verify": ' > .autofork/config.json
`,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("the agent left .autofork/config.json unreadable");
  expect(file(mine, "app.js")).toContain("name.toUpperCase()");
  expect(JSON.parse(file(mine, ".autofork/config.json")).picked).toBeUndefined();
});

test("a check an agent picks that fails with the patch it built stops the sync instead of shipping the patch", () => {
  const { mine, runs, agent } = picking("broken");
  agent({ verify: `node -e "import('./app.js')"` }, `printf 'export const broken = ;\\n' > app.js`);
  const head = sh(mine, "git rev-parse HEAD");
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(false);
  expect(log).toContain(
    `verify fails with shout, which the agent built: node -e "import('./app.js')"`,
  );
  expect(readFileSync(runs, "utf8")).toBe("ran\n");
  expect(sh(mine, "git rev-parse HEAD")).toBe(head);
});

test("a check an agent picks that an earlier saved patch fails gets that patch fixed, instead of failing the one the agent built", () => {
  const { mine, script, runs } = picking("earlier");
  mkdirSync(join(mine, ".autofork/amark"));
  write(mine, ".autofork/amark/PATCH.md", "mark.txt marks the fork.\n");
  write(mine, "mark.txt", "bad\n");
  expect(autofork(mine, "save", "amark").ok).toBe(true);
  sh(mine, "git add -A && git commit -qm mark");
  writeFileSync(
    script,
    `prompt="$(cat)"
case "$prompt" in
  *'named by its id'*) echo fix >> ${runs}; ${fixup({ amark: "printf 'good\\n' > mark.txt" })} ;;
  *) echo shout >> ${runs}; sed -i 's/+ name/+ name.toUpperCase()/' app.js; node -e 'const fs = require("fs"); const c = JSON.parse(fs.readFileSync(".autofork/config.json")); fs.writeFileSync(".autofork/config.json", JSON.stringify({ ...c, verify: "! grep -qs bad mark.txt" }))' ;;
esac
`,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("healed amark");
  expect(readFileSync(runs, "utf8")).toBe("shout\nfix\n");
  expect(file(mine, "mark.txt")).toBe("good\n");
  expect(file(mine, "app.js")).toContain("name.toUpperCase()");
  expect(JSON.parse(file(mine, ".autofork/config.json")).picked).toEqual({
    verify: "! grep -qs bad mark.txt",
  });
});

test("a picked verify that fails on upstream alone is dropped even when a patch broke setup, and the patch is still fixed", () => {
  const tool = join(home, "caught-tool");
  const { mine, script, runs, moveUpstream } = picking("caught", {
    setup: "! grep -qs bad mark.txt",
    picked: { verify: `test -f ${tool}` },
  });
  sh(mine, "git rm -rq .autofork/shout && git commit -qm 'no shout'");
  mkdirSync(join(mine, ".autofork/zmark"));
  write(mine, ".autofork/zmark/PATCH.md", "mark.txt marks the fork.\n");
  write(mine, "mark.txt", "bad\n");
  expect(autofork(mine, "save", "zmark").ok).toBe(true);
  sh(mine, "git add -A && git commit -qm zmark");
  moveUpstream();
  writeFileSync(
    script,
    `cat > /dev/null\necho fix >> ${runs}\n${fixup({ zmark: "printf 'good\\n' > mark.txt" })}\n`,
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain(
    `\`test -f ${tool}\` fails on upstream alone, so the checks an agent picked are dropped`,
  );
  expect(log).toContain("healed zmark");
  expect(file(mine, "mark.txt")).toBe("good\n");
  expect(readFileSync(runs, "utf8")).toBe("fix\n");
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  expect(config.setup).toBe("! grep -qs bad mark.txt");
  expect(config.picked).toBeUndefined();
});

test("a check an agent picked that fails with a saved patch gets the patch fixed, like a check you wrote", () => {
  const { mine, script, agent, moveUpstream } = picking("gate");
  agent({ verify: "! grep -qs bad mark.txt" });
  expect(autofork(mine, "sync").ok).toBe(true);
  mkdirSync(join(mine, ".autofork/zmark"));
  write(mine, ".autofork/zmark/PATCH.md", "mark.txt marks the fork.\n");
  write(mine, "mark.txt", "bad\n");
  expect(autofork(mine, "save", "zmark").ok).toBe(true);
  sh(mine, "git add -A && git commit -qm mark");
  moveUpstream();
  writeFileSync(
    script,
    "cat > /dev/null\nprintf 'good\\n' > mark.txt\ngit -c user.name=a -c user.email=a@a commit -qa --amend --no-edit\n",
  );
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(log).toContain("fixing verify in the patches");
  expect(log).toContain("healed zmark");
  expect(file(mine, "mark.txt")).toBe("good\n");
  expect(JSON.parse(file(mine, ".autofork/config.json")).picked).toEqual({
    verify: "! grep -qs bad mark.txt",
  });
});

test("once you write your own verify, the agent's picks count as yours and stop the sync when upstream breaks them", () => {
  const { origin, mine, agent, moveUpstream } = picking("owned");
  agent({ setup: "test ! -f notes.txt", verify: "true" });
  expect(autofork(mine, "sync").ok).toBe(true);
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(mine, ".autofork/config.json", JSON.stringify({ ...config, verify: "true && true" }));
  sh(mine, "git commit -qam 'my verify'");
  moveUpstream();
  agent({});
  const head = sh(mine, "git rev-parse HEAD");
  const { ok, log } = autofork(mine, "sync");
  expect(ok).toBe(false);
  expect(log).toContain(
    `setup fails on upstream ${sh(origin, "git rev-parse HEAD").slice(0, 12)} itself: test ! -f notes.txt`,
  );
  expect(log).not.toContain("dropped");
  expect(sh(mine, "git rev-parse HEAD")).toBe(head);
});

function spendFork(name: string, limits?: object) {
  const origin = join(home, name);
  const mine = join(home, `${name}-fork`);
  mkdirSync(origin);
  sh(
    origin,
    "git init -q && echo 'export const app = 1;' > app.js && git add -A && git commit -qm init",
  );
  sh(home, `git clone -q ${origin} ${name}-fork`);
  expect(autofork(mine, "init", origin, "--verify", "true").ok).toBe(true);
  if (limits) {
    const config = JSON.parse(file(mine, ".autofork/config.json"));
    write(mine, ".autofork/config.json", JSON.stringify({ ...config, limits }));
  }
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  return mine;
}

function wish(mine: string, id: string, agent?: string) {
  mkdirSync(join(mine, ".autofork", id), { recursive: true });
  write(mine, `.autofork/${id}/PATCH.md`, `app.js says ${id}.\n`);
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(mine, ".autofork/config.json", JSON.stringify({ ...config, agent }));
  sh(mine, `git add -A && git commit -qm ${id}`);
}

const stub = (dir: string, name: string, script: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
};

test("init and fork write the limits, the schedule --every picks, id-token: write and the line about linking", () => {
  const origin = join(home, "timed");
  mkdirSync(origin);
  sh(origin, "git init -q && echo one > app.js && git add -A && git commit -qm init");
  sh(home, `git clone -q ${origin} timed-fork`);
  const mine = join(home, "timed-fork");
  expect(autofork(mine, "init", origin, "--every", "2h").log).toContain(
    "--every takes 5m, 15m, 1h, 1d, not 2h",
  );
  const { ok, log } = autofork(mine, "init", origin, "--every", "1h");
  expect(ok).toBe(true);
  expect(log).toContain(
    "GitHub's timer can run hours late. Run it on time and track spend: npx autofork link",
  );
  expect(JSON.parse(file(mine, ".autofork/config.json")).limits).toEqual({
    rebuilds: 10,
    month: 200,
    rebuild: 20,
  });
  const workflow = file(mine, ".github/workflows/autofork.yml");
  expect(workflow).toContain('- cron: "17 * * * *"');
  expect(workflow).toContain("  id-token: write\n");
  expect(workflow).toContain(
    "        with:\n          codex-auth-url: https://autofork.com/api/chatgpt/auth\n        env:\n          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n          CODEX_AUTH: ${{ secrets.CODEX_AUTH }}\n",
  );
  sh(mine, "rm -rf .autofork .github");
  autofork(mine, "init", origin);
  expect(file(mine, ".github/workflows/autofork.yml")).toContain('- cron: "7-59/15 * * * *"');
});

test("a sync waits before paying for any rebuild when the month has no room for all it needs", () => {
  const mine = spendFork("capped", { rebuilds: 2 });
  const ledger = join(home, "capped-ledger.json");
  const runs = join(home, "capped-runs");
  const month = new Date().toISOString().slice(0, 7);
  const old = { patch: "old", agent: "claude", cap: 20, cost: 3, status: "done", at: "" };
  writeFileSync(ledger, JSON.stringify({ month, rebuilds: [old] }));
  const build = `id=$(grep -o 'Patch "[a-z]*"' | cut -d'"' -f2)\necho $id >> ${runs}\necho "// $id" >> app.js`;
  wish(mine, "one", build);
  wish(mine, "two", build);
  const head = sh(mine, "git rev-parse HEAD");
  const sync = (limits: object) => {
    const config = JSON.parse(file(mine, ".autofork/config.json"));
    write(mine, ".autofork/config.json", JSON.stringify({ ...config, limits }));
    sh(mine, "git diff --quiet || git commit -qam limits");
    return autoforkWith({ AUTOFORK_LEDGER: ledger }, mine, "sync");
  };
  const waiting = autoforkWith({ AUTOFORK_LEDGER: ledger }, mine, "sync");
  expect(waiting.ok).toBe(true);
  expect(waiting.output.result).toBe("waiting");
  expect(waiting.log).toMatch(
    /autofork: one, two wait: 2 rebuilds won't fit in this month's 2 \(1 used\)\. It runs \w{3} 1 \(UTC\), or raise "rebuilds" in "limits" in \.autofork\/config\.json\.\n$/,
  );
  expect(existsSync(runs)).toBe(false);
  expect(sh(mine, "git rev-parse HEAD")).toBe(head);

  const never = sync({ rebuilds: 1 });
  expect(never.log).toContain(
    'one, two wait: 2 rebuilds won\'t fit in this month\'s 1 (1 used). It needs you to raise "rebuilds" in "limits" in .autofork/config.json.',
  );
  expect(existsSync(runs)).toBe(false);

  writeFileSync(ledger, JSON.stringify({ month: "2000-01", rebuilds: [old] }));
  const built = sync({ rebuilds: 2 });
  expect(built.output).toMatchObject({ result: "synced", ledger: "changed" });
  expect(built.log).toContain("one cost up to $20");
  expect(file(home, "capped-runs")).toBe("one\ntwo\n");
  expect(JSON.parse(file(home, "capped-ledger.json")).rebuilds).toMatchObject([
    { patch: "one", agent: "custom", cap: 20, cost: 20, status: "done" },
    { patch: "two", agent: "custom", cap: 20, cost: 20, status: "done" },
  ]);
});

test("a rebuild waits when a whole rebuild's cap no longer fits under the month's, and names every limit that's short", () => {
  const mine = spendFork("broke", { month: 30 });
  const ledger = join(home, "broke-ledger.json");
  const month = new Date().toISOString().slice(0, 7);
  const row = { patch: "old", agent: "claude", cap: 20, status: "done", at: "" };
  writeFileSync(ledger, JSON.stringify({ month, rebuilds: [{ ...row, cost: 9.5 }] }));
  wish(mine, "three", "echo '// three' >> app.js");
  const fits = autoforkWith({ AUTOFORK_LEDGER: ledger }, mine, "sync");
  expect(fits.output.result).toBe("synced");
  wish(mine, "four", "echo '// four' >> app.js");
  writeFileSync(ledger, JSON.stringify({ month, rebuilds: [{ ...row, cost: 15 }] }));
  const { log, output } = autoforkWith({ AUTOFORK_LEDGER: ledger }, mine, "sync");
  expect(output.result).toBe("waiting");
  expect(log).toContain(
    "autofork: four waits: a rebuild may cost $20 and $15 of this month's $30 is left. It runs",
  );
  write(
    mine,
    ".autofork/config.json",
    JSON.stringify({
      ...JSON.parse(file(mine, ".autofork/config.json")),
      limits: { month: 30, rebuilds: 1 },
    }),
  );
  sh(mine, "git commit -qam 'one rebuild a month'");
  expect(autoforkWith({ AUTOFORK_LEDGER: ledger }, mine, "sync").log).toMatch(
    /four waits: a rebuild won't fit in this month's 1 \(1 used\), and a rebuild may cost \$20 and \$15 of this month's \$30 is left\. It runs \w{3} 1 \(UTC\), or raise "rebuilds" and "month" in "limits"/,
  );
  write(
    mine,
    ".autofork/config.json",
    JSON.stringify({
      ...JSON.parse(file(mine, ".autofork/config.json")),
      limits: { month: "lots" },
    }),
  );
  sh(mine, "git commit -qam 'bad limits'");
  expect(autoforkWith({ AUTOFORK_LEDGER: ledger }, mine, "sync").log).toContain(
    '"limits" in .autofork/config.json takes numbers',
  );
});

test("Claude runs with this rebuild's cap, its own cost goes to the site, and the site's totals hold the limits", () => {
  const mine = spendFork("billed");
  const bin = join(home, "billed-bin");
  stub(
    bin,
    "claude",
    `cat > /dev/null
echo "$*" > ${home}/claude-args
env > ${home}/claude-env
echo '// built' >> app.js
echo '{"type":"result","subtype":"success","is_error":false,"result":"built it","total_cost_usd":1.25,"modelUsage":{"claude-opus-5-5":{"inputTokens":10,"outputTokens":20,"cacheReadInputTokens":100,"cacheCreationInputTokens":5,"costUSD":1.2},"claude-haiku-5-5":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.05}}}'`,
  );
  const siteLog = join(home, "billed-site.log");
  const site = {
    PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_CODE_OAUTH_TOKEN: "token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.test/?run=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request",
    AUTOFORK_URL: "https://site.test",
    SITE_LOG: siteLog,
  };
  wish(mine, "five");
  const { ok, log } = autoforkWith(
    {
      ...site,
      SITE_TOTALS: '{"rebuilds":3,"spent":40}',
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
    },
    mine,
    "sync",
  );
  expect(ok).toBe(true);
  expect(log).toContain("built it\nfive cost $1.25\n");
  expect(file(home, "claude-args")).toContain(
    "-p --dangerously-skip-permissions --output-format json --max-budget-usd 20 --tools Bash,Read,Edit,Write,Glob,Grep --strict-mcp-config\n",
  );
  expect(file(home, "claude-env")).not.toContain("ACTIONS_ID_TOKEN_REQUEST");
  expect(file(home, "claude-env")).toContain("CLAUDE_CODE_ENTRYPOINT=autofork\n");
  const calls = file(home, "billed-site.log")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toEqual([
    { method: "GET", path: "/api/ledger", auth: "Bearer oidc-autofork" },
    { method: "GET", path: "/api/ledger", auth: "Bearer oidc-autofork" },
    {
      method: "POST",
      path: "/api/ledger",
      auth: "Bearer oidc-autofork",
      body: { patch: "five", agent: "claude", cap: 20 },
    },
    {
      method: "POST",
      path: "/api/ledger/close",
      auth: "Bearer oidc-autofork",
      body: {
        id: "row-1",
        status: "done",
        cost: 1.25,
        model: "claude-opus-5-5",
      },
    },
  ]);

  wish(mine, "retried");
  const retried = autoforkWith(
    {
      ...site,
      SITE_TOTALS: '{"rebuilds":4,"spent":41.25}',
      SITE_FAIL_ONCE: "/api/ledger/close",
      CLAUDECODE: "",
      CLAUDE_CODE_ENTRYPOINT: "mine",
    },
    mine,
    "sync",
  );
  expect(retried.log).not.toContain("couldn't report");
  expect(file(home, "claude-env")).toContain("CLAUDE_CODE_ENTRYPOINT=mine\n");
  expect(file(home, "billed-site.log")).toContain(
    '"path":"/api/ledger/close","auth":"Bearer oidc-autofork","body":{"id":"row-1","status":"done"',
  );

  wish(mine, "six");
  const capped = autoforkWith({ ...site, SITE_TOTALS: '{"rebuilds":3,"spent":190}' }, mine, "sync");
  expect(capped.output.result).toBe("waiting");
  expect(capped.log).toContain(
    "six waits: a rebuild may cost $20 and $10 of this month's $200 is left",
  );
});

test("on GitHub's runners, a rebuild with no agent signed in fails before it takes one of the month's rebuilds, and says what to add", () => {
  const mine = spendFork("signed-out");
  const bin = join(home, "signed-out-bin");
  stub(
    bin,
    "claude",
    `[ "$1 $2" = "auth status" ] && { printf '{\\n  "loggedIn": false,\\n  "authMethod": "none"\\n}\\n'; exit 1; }
echo run >> ${home}/signed-out-runs`,
  );
  const ledger = join(home, "signed-out-ledger.json");
  wish(mine, "ten");
  const { ok, output } = autoforkWith(
    {
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CODEX_HOME: join(home, "signed-out-codex"),
      RUNNER_ENVIRONMENT: "github-hosted",
      AUTOFORK_LEDGER: ledger,
    },
    mine,
    "sync",
  );
  expect(ok).toBe(false);
  expect(output.error).toBe(
    "Claude Code isn't signed in, so no agent can run: give the autofork step CLAUDE_CODE_OAUTH_TOKEN (claude setup-token prints one), or CODEX_AUTH for ChatGPT, from the fork's secrets",
  );
  expect(existsSync(join(home, "signed-out-runs"))).toBe(false);
  expect(JSON.parse(file(home, "signed-out-ledger.json")).rebuilds).toEqual([]);
  const local = autoforkWith(
    {
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CODEX_HOME: join(home, "signed-out-codex"),
      RUNNER_ENVIRONMENT: "self-hosted",
      AUTOFORK_LEDGER: ledger,
    },
    mine,
    "sync",
  );
  expect(local.output.error).toBe("the agent changed nothing while building ten");
  expect(file(home, "signed-out-runs")).toBe("run\n");
});

test("Codex's tokens are priced from LiteLLM's table for the model its session used", () => {
  const mine = spendFork("priced");
  const bin = join(home, "priced-bin");
  const codexHome = join(home, "priced-codex");
  mkdirSync(codexHome);
  write(codexHome, "auth.json", "{}");
  stub(
    bin,
    "codex",
    `cat > /dev/null
echo "$*" > ${home}/codex-args
mkdir -p "$CODEX_HOME/sessions/2026/11/01"
echo '{"type":"turn_context","payload":{"model":"gpt-test"}}' > "$CODEX_HOME/sessions/2026/11/01/rollout-2026-11-01-thread-9.jsonl"
echo '// built' >> app.js
echo '{"type":"thread.started","thread_id":"thread-9"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"built it"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"cache_write_input_tokens":100,"output_tokens":50}}'`,
  );
  const ledger = join(home, "priced-ledger.json");
  wish(mine, "seven");
  const { ok, log } = autoforkWith(
    {
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CODEX_HOME: codexHome,
      AUTOFORK_LEDGER: ledger,
      PRICES: JSON.stringify({
        "gpt-test": {
          input_cost_per_token: 0.001,
          cache_read_input_token_cost: 0.0001,
          cache_creation_input_token_cost: 0.002,
          output_cost_per_token: 0.01,
        },
      }),
    },
    mine,
    "sync",
  );
  expect(ok).toBe(true);
  expect(file(home, "codex-args")).toContain("exec --json");
  expect(log).toContain("built it\nseven cost $1.24\n");
  const [row] = JSON.parse(file(home, "priced-ledger.json")).rebuilds;
  expect(row).toMatchObject({ patch: "seven", agent: "codex", status: "done" });
  expect(row.cost).toBeCloseTo(1.24);
});

test("link opens the site's page once the config is pushed, and waits until the fork is linked", () => {
  const app = join(github, "me/linked.git");
  mkdirSync(app, { recursive: true });
  sh(app, "git init -q --bare");
  const mine = join(home, "linked");
  mkdirSync(mine);
  sh(mine, "git init -q && echo one > app.js && git add -A && git commit -qm init");
  sh(mine, "git remote add origin https://github.com/me/linked && git push -q origin main");
  sh(app, "git symbolic-ref HEAD refs/heads/main");
  const bin = join(home, "link-bin");
  stub(bin, "xdg-open", `echo "$1" >> ${home}/opened`);
  stub(bin, "open", `echo "$1" >> ${home}/opened`);
  const siteLog = join(home, "link-site.log");
  const linking = (after: number) =>
    autoforkWith(
      {
        PATH: `${bin}:${process.env.PATH}`,
        AUTOFORK_URL: "https://site.test",
        SITE_LOG: siteLog,
        LINK_AFTER: String(after),
      },
      mine,
      "link",
    );
  const early = linking(9);
  expect(early.ok).toBe(false);
  expect(early.log).toContain("push .autofork/config.json to me/linked's default branch first");
  mkdirSync(join(mine, ".autofork"));
  write(mine, ".autofork/config.json", "{}");
  sh(mine, "git add -A && git commit -qm config && git push -q origin main");
  const { ok, log } = linking(2);
  expect(ok).toBe(true);
  expect(log).toContain("finish linking in your browser: https://site.test/link/me/linked");
  expect(log).toContain("linked: autofork.com starts it within a minute of upstream changing.");
  expect(file(home, "opened")).toBe("https://site.test/link/me/linked\n");
  expect(JSON.parse(file(home, "link-site.log").split("\n")[0])).toMatchObject({
    method: "POST",
    path: "/api/link",
    body: { owner: "me", name: "linked" },
  });
  const again = linking(0);
  expect(again.log).toBe("linked: autofork.com starts it within a minute of upstream changing.\n");
});

test("after the up-front count, each rebuild still needs room of its own", () => {
  const mine = spendFork("reserved", { month: 60 });
  const bin = join(home, "reserved-bin");
  stub(
    bin,
    "claude",
    `id=$(grep -o 'Patch "[a-z]*"' | cut -d'"' -f2)
echo "// $id" >> app.js
echo '{"type":"result","result":"built","total_cost_usd":25,"modelUsage":{}}'`,
  );
  const ledger = join(home, "reserved-ledger.json");
  const month = new Date().toISOString().slice(0, 7);
  const old = { patch: "old", agent: "claude", cap: 20, cost: 20, status: "done", at: "" };
  writeFileSync(ledger, JSON.stringify({ month, rebuilds: [old] }));
  wish(mine, "eight");
  wish(mine, "nine");
  const { log, output } = autoforkWith(
    {
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      AUTOFORK_LEDGER: ledger,
    },
    mine,
    "sync",
  );
  expect(output.result).toBe("waiting");
  expect(log).toContain("eight cost $25\n");
  expect(log).toContain("nine waits: a rebuild may cost $20 and $15 of this month's $60 is left");
  expect(JSON.parse(file(home, "reserved-ledger.json")).rebuilds).toHaveLength(2);
});

test("an init that can't reach the branch it follows writes nothing, so it can run again, and a config that isn't JSON says so", () => {
  const origin = join(home, "retry");
  mkdirSync(origin);
  sh(origin, "git init -q && echo one > notes.txt && git add -A && git commit -qm one");
  sh(home, `git clone -q ${origin} retry-fork`);
  const mine = join(home, "retry-fork");
  const failed = autofork(mine, "init", origin, "--follow", "nope");
  expect(failed.ok).toBe(false);
  expect(sh(mine, "git status --porcelain")).toBe("");
  expect(autofork(mine, "init", origin).ok).toBe(true);
  write(mine, ".autofork/config.json", '{\n  "upstream": "x",\n}\n');
  sh(mine, "git add -A && git commit -qm 'track upstream'");
  const { ok, log, output } = autofork(mine, "sync");
  expect(ok).toBe(false);
  expect(log).toContain("autofork: .autofork/config.json isn't valid JSON: ");
  expect(output.error).toContain(".autofork/config.json isn't valid JSON");
});

test("a new fork of a branch behind where it was forked starts there, even when upstream's checks count", () => {
  const app = join(github, "acme/behind.git");
  mkdirSync(app, { recursive: true });
  sh(
    app,
    "git init -q && echo one > notes.txt && git add -A && git commit -qm one && git branch stable && echo two > notes.txt && git commit -qam two",
  );
  sh(home, `git clone -q ${app} behind`);
  const mine = join(home, "behind");
  expect(autofork(mine, "init", "acme/behind", "--follow", "stable").ok).toBe(true);
  sh(mine, "git add -A && git commit -qm 'track stable'");
  const { ok, log, output } = autoforkWith({ CHECK_RUNS: "{}" }, mine, "sync");
  expect(ok).toBe(true);
  expect(log).not.toContain("no newer upstream commit");
  expect(output.result).toBe("synced");
  expect(file(mine, "notes.txt")).toBe("one\n");
});

test("a patch whose deletion upstream made too is healed when the agent finds nothing left, and git applies it after", () => {
  const origin = join(home, "deleted");
  mkdirSync(origin);
  sh(
    origin,
    "git init -q && echo one > notes.txt && echo old > old.txt && git add -A && git commit -qm one",
  );
  sh(home, `git clone -q ${origin} deleted-fork`);
  const mine = join(home, "deleted-fork");
  expect(autofork(mine, "init", origin).ok).toBe(true);
  sh(mine, "git add -A && git commit -qm track");
  sh(mine, "git rm -q old.txt && echo mine >> notes.txt && mkdir -p .autofork/tidy");
  write(mine, ".autofork/tidy/PATCH.md", "Drop old.txt and add a line to notes.txt.\n");
  expect(autofork(mine, "save", "tidy").ok).toBe(true);
  const prompt = join(home, "deleted-prompt.txt");
  const config = JSON.parse(file(mine, ".autofork/config.json"));
  write(mine, ".autofork/config.json", JSON.stringify({ ...config, agent: `cat > ${prompt}` }));
  sh(mine, "git add -A && git commit -qm tidy");
  sh(origin, "git rm -q old.txt && git commit -qm 'drop old.txt'");
  const { ok, log, output } = autofork(mine, "sync");
  expect(ok).toBe(true);
  expect(output.result).toBe("synced");
  expect(file(home, "deleted-prompt.txt")).toContain(
    "the deletion of old.txt, which upstream deleted too",
  );
  expect(log).toContain("healed tidy");
  expect(file(mine, "notes.txt")).toBe("one\nmine\n");
  expect(file(mine, ".autofork/tidy/tidy.patch")).not.toContain("old.txt");
  rmSync(prompt);
  sh(origin, "echo two > two.txt && git add -A && git commit -qm two");
  expect(autofork(mine, "sync").output.result).toBe("synced");
  expect(existsSync(prompt)).toBe(false);
});
