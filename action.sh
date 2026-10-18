#!/usr/bin/env bash
set -euo pipefail

failed="$RUNNER_TEMP/autofork-failed"
skip="$(cat "$failed" 2>/dev/null || true)"
[ "${GITHUB_EVENT_NAME:-}" = schedule ] || skip=""
head="$(git rev-parse HEAD)"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

heal=""
[ "${HEAL:-true}" = true ] || heal="--no-heal"

codex_auth="${CODEX_HOME:-$HOME/.codex}/auth.json"
if [ -n "${CODEX_AUTH:-}" ]; then
  mkdir -p "$(dirname "$codex_auth")"
  printf '%s' "$CODEX_AUTH" > "$codex_auth"
fi

keep_codex_auth() {
  [ -n "${CODEX_AUTH:-}" ] && [ -n "${CODEX_AUTH_URL:-}" ] || return 0
  [ "$(cat "$codex_auth")" != "$CODEX_AUTH" ] || return 0
  oidc="$(curl -fsS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=autofork" | jq -r .value)"
  if curl -fsS -X POST -H "Authorization: Bearer $oidc" -H "Content-Type: application/json" --data-binary @"$codex_auth" "$CODEX_AUTH_URL" > /dev/null; then
    echo "saved Codex's refreshed sign-in"
  else
    echo "::warning::couldn't save Codex's refreshed sign-in; sign in again if the next run can't reach Codex"
  fi
}
trap keep_codex_auth EXIT

if ! node "$GITHUB_ACTION_PATH/dist/autofork.js" sync ${skip:+--skip "$skip"} $heal; then
  echo "result=failed" >> "$GITHUB_OUTPUT"
  exit 1
fi

if [ "$(git rev-parse HEAD)" != "$head" ]; then
  parents=()
  for parent in $(git log -1 --format=%P); do parents+=(-f "parents[]=$parent"); done
  remote="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
  scratch="refs/heads/autofork-objects-${GITHUB_RUN_ID}"
  git push --quiet "$remote" "HEAD:$scratch" 2>&1 | { grep -v '^remote:' || true; } >&2
  trap 'git push --quiet "$remote" --delete "$scratch" || true; keep_codex_auth' EXIT
  signed="$(gh api "repos/$GITHUB_REPOSITORY/git/commits" \
    -f message="$(git log -1 --format=%B)" -f tree="$(git rev-parse 'HEAD^{tree}')" "${parents[@]}" --jq .sha)"
  if ! moved="$(gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/heads/$GITHUB_REF_NAME" -f sha="$signed" 2>&1)"; then
    if [ "$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$GITHUB_REF_NAME" --jq .object.sha)" = "$head" ]; then
      echo "$moved" >&2
      exit 1
    fi
    echo "$GITHUB_REF_NAME changed while this ran, so the next run syncs it instead"
    echo "result=moved" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  echo "pushed ${signed:0:12} to $GITHUB_REF_NAME, signed by GitHub"

  for doc in $(git diff --name-only --diff-filter=A "$head" HEAD -- '.autofork/*/UPSTREAM.md'); do
    id="$(basename "$(dirname "$doc")")"
    if ! gh issue create -R "$GITHUB_REPOSITORY" --title "$id: upstream does this now" \
      --body "$(cat "$doc")"$'\n\n'"Paused in ${signed:0:12}." > /dev/null; then
      echo "::warning::upstream has $id now and autofork paused it, but couldn't open an issue about it: turn on the fork's issues and give the workflow issues: write"
    fi
  done

  workflows="$(git log -1 --format=%B | sed -n 's/^upstream changed \(.*\) in \(.*\)$/- `\1`, in \2/p')"
  title="upstream changed workflows this fork copied"
  if [ -n "$workflows" ]; then
    issue="$(gh issue list -R "$GITHUB_REPOSITORY" --state open --search "$title in:title" --json number,title \
      --jq "map(select(.title == \"$title\"))[0].number // empty" 2> /dev/null || true)"
    if [ -n "$issue" ]; then
      gh issue comment "$issue" -R "$GITHUB_REPOSITORY" --body "Upstream changed these too, synced in ${signed:0:12}:"$'\n\n'"$workflows" > /dev/null
    else
      gh issue create -R "$GITHUB_REPOSITORY" --title "$title" --body "Upstream changed workflows this fork keeps its own copies of:

$workflows

autofork never changes the fork's \`.github/\`, and a workflow's GitHub token can't push workflow files. Bring over what this fork needs from upstream's changes, keeping what it does differently, or delete the copies it doesn't run, then close this issue.

Synced in ${signed:0:12}." > /dev/null
    fi || echo "::warning::upstream changed workflows this fork copied, but autofork couldn't open an issue about it: turn on the fork's issues and give the workflow issues: write"
  fi
fi
