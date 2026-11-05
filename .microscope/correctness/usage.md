# How autofork is used

Judge findings against this, and name a realistic trigger for anything you call blocking.

- **Scale.** A handful of forks, each following one public upstream, each syncing a few times a day at most. Syncs of one fork run one at a time (`concurrency: autofork`).
- **Agent runs.** Most syncs are git-only and cost nothing. An agent run costs API-price dollars, mostly on flat subscription plans, not a bill. A sync that finds nothing new spends nothing.
- **Limits.** The up-front count is an estimate on purpose; each run is then checked on its own. A run that never reports keeps its cap, on purpose. Overcounting so a sync waits is the safe side.
- **Trust.** Code that `setup`, `verify` or the agent runs already holds every credential in the job, including `contents: write` and the agent's sign-in. Deleting env vars doesn't stop determined code (`/proc/<pid>/environ`); the README says so. A forged ledger report only changes that fork's own spend.
- **Files.** autofork writes `.autofork/config.json` and `.github/workflows/autofork.yml` itself, in one format.
- **Decided trade-offs.** `id-token: write` is on by default so every fork, linked or not, can report its cost. Answers already given on this PR stand unless a finding brings new evidence.
