# Contributing

[AGENTS.md](AGENTS.md) says what autofork is and the principles behind it. The [roadmap](README.md#roadmap) says what's planned and what we're building now. For anything bigger than a fix, open an issue first, so we agree on the shape before you build it.

Work on a branch and open a pull request to `main`. Say what it does and the decisions it makes, so it can be reviewed in a minute.

## Check

```sh
bun install
bun run check
```

`check` typechecks, lints and runs the tests. The tests rebuild `dist/autofork.js`, the file the action runs, so commit it with your change. CI runs the same check on every pull request.

Every pull request is also reviewed by microscope: a maintainer runs `microscope review <number>` after it opens and after each push, and you fix or reply to what it finds. Merging needs its `microscope/correctness` status.

Forks run the action at the `v1` tag, which we move up to `main` when a change should reach them.
