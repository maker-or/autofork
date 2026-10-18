# autofork

Customized forks that maintain themselves. A fork is upstream plus patches, and each patch is a `PATCH.md`: what the user wants and why, in plain words, next to the diff that last built it. On every upstream release, git puts back the patches that still fit, and an agent rebuilds the rest from their `PATCH.md`, in the fork's own GitHub Actions, on the user's own Claude or ChatGPT plan.

Forks are the first job. The same agent is meant to grow into automatic maintenance of any codebase, and autofork is its first clean packaging: set up in one step, with an app to see and manage your forks and what they cost.

## Principles

- **For many repos.** The engine, the skill and the prompts serve every fork. What's true of one app lives in that fork's own `.autofork/` files, and comes here only as something that helps many apps.
- **Intent is the contract.** A `PATCH.md` says what the change is for, not where it goes, so it survives upstream rewriting the code under it. The diff is a guide for the next rebuild.
- **Upstream leads.** A patch is rebuilt on what upstream has now, in upstream's code and conventions. When upstream ships its own version, autofork stops applying the patch and the user decides which to keep.
- **Git first, the agent when it's needed.** Agent runs cost the user's money and time, so git does all it can, the agent runs when a patch needs it, and a failed run waits until something changes.
- **Seamless.** For people and the agents working for them alike: one command sets up a fork, the defaults are right, and installed apps update from the fork on their own. The user hears from autofork when something is theirs to decide.
- **Trust the agent.** The prompts and the skill give the agent the facts and the goal and leave the how to it. Every constraint costs it performance, so the few kept are ones models really need, each with its reason.
- **Small.** The simplest change that fully does the job, in code and in words.

To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md). What's planned and in progress is in the [roadmap](README.md#roadmap).
