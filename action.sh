#!/usr/bin/env bash
set -euo pipefail

open_issue() {
  gh issue list -R "$GITHUB_REPOSITORY" --state open --limit 1000 --json number,title \
    --jq "map(select(.title == \"$1\"))[0].number // empty" 2> /dev/null
}

failed_title="autofork sync failed"
run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}"

close_failed() {
  local issue
  issue="$(open_issue "$failed_title")" || return 0
  [ -z "$issue" ] || gh issue close "$issue" -R "$GITHUB_REPOSITORY" --comment "$1" > /dev/null || true
}

if [ "${1:-}" = failed ]; then
  why="The sync was cancelled, ran out of time, or stopped without saying why. The run's log has the rest."
  [ -z "${ERROR:-}" ] || why="$(printf '````\nautofork: %s\n````' "$ERROR")"
  if issue="$(open_issue "$failed_title")" && [ -z "$issue" ]; then
    gh issue create -R "$GITHUB_REPOSITORY" --title "$failed_title" --body "$why

$run_url

To try again now, run the workflow by hand. The next sync that goes through closes this issue." > /dev/null
  elif [ -n "$issue" ] && last="$(gh issue view "$issue" -R "$GITHUB_REPOSITORY" --json body,comments --jq '[.body, .comments[].body] | last')"; then
    [[ "$last" == "$why"$'\n\n'* ]] || gh issue comment "$issue" -R "$GITHUB_REPOSITORY" --body "$why"$'\n\n'"$run_url" > /dev/null
  else
    false
  fi || echo "::warning::the sync failed, but autofork couldn't open an issue about it: turn on the fork's issues and give the workflow issues: write"
  exit 0
fi

head="$(git rev-parse HEAD)"
failed="$RUNNER_TEMP/autofork-failed"
skip="$(cat "$failed" 2>/dev/null || true)"
[ "${GITHUB_EVENT_NAME:-}" = schedule ] || [ "${GITHUB_TRIGGERING_ACTOR:-}" = "autofork-app[bot]" ] || skip=""
[ "${GITHUB_RUN_ATTEMPT:-1}" = 1 ] || skip=""
tip="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$GITHUB_REF_NAME" --jq .object.sha 2> /dev/null)" || tip="$head"
if [ "$tip" != "$head" ]; then
  echo "$GITHUB_REF_NAME moved since this run started, so the next run syncs it instead"
  echo "result=moved" >> "$GITHUB_OUTPUT"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

heal=""
[ "${HEAL:-true}" = true ] || heal="--no-heal"

codex_auth="${CODEX_HOME:-$HOME/.codex}/auth.json"
if [ -n "${CODEX_AUTH:-}" ]; then
  mkdir -p "$(dirname "$codex_auth")"
  printf '%s' "$CODEX_AUTH" > "$codex_auth"
fi

oidc() {
  curl -fsS -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" "${ACTIONS_ID_TOKEN_REQUEST_URL:-}&audience=autofork" | jq -r .value
}

keep_codex_auth() {
  [ -n "${CODEX_AUTH:-}" ] && [ -n "${CODEX_AUTH_URL:-}" ] || return 0
  [ "$(cat "$codex_auth")" != "$CODEX_AUTH" ] || return 0
  if curl -fsS -X POST -H "Authorization: Bearer $(oidc)" -H "Content-Type: application/json" --data-binary @"$codex_auth" "$CODEX_AUTH_URL" > /dev/null; then
    echo "saved Codex's refreshed sign-in"
  else
    echo "::warning::couldn't save Codex's refreshed sign-in; sign in again if the next run can't reach Codex"
  fi
}
trap keep_codex_auth EXIT

workflow_token() {
  local token
  token="$(curl -fsS -X POST -H "Authorization: Bearer $(oidc)" "$WORKFLOW_TOKEN_URL" | jq -re .token)" || return 1
  echo "::add-mask::$token" >&2
  echo "$token"
}

leave_workflows="--no-workflows"
if [ -n "${WORKFLOW_TOKEN_URL:-}" ] &&
  [ -n "$(git ls-files .github/workflows ':!.github/workflows/autofork.yml')" ]; then
  if workflow_token > /dev/null; then
    leave_workflows=""
  else
    echo "no token that can push workflow files from $WORKFLOW_TOKEN_URL, so upstream's changes to this fork's workflows become an issue"
  fi
fi

if ! node "$GITHUB_ACTION_PATH/dist/autofork.js" sync ${skip:+--skip "$skip"} $heal $leave_workflows; then
  echo "result=failed" >> "$GITHUB_OUTPUT"
  exit 1
fi
[ "$(sed -n 's/^result=//p' "$GITHUB_OUTPUT" | tail -1)" != current ] || close_failed "Up to date in $run_url."

if [ "$(git rev-parse HEAD)" != "$head" ]; then
  # Until the branch moves, a failing step means nothing was pushed, whatever the sync said
  trap 'printf "result=failed\nerror=the sync built its commit, but pushing it to %s failed, so nothing was pushed. The run'"'"'s log says why.\n" "$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"' ERR
  parents=()
  for parent in $(git log -1 --format=%P); do parents+=(-f "parents[]=$parent"); done
  pusher="$GH_TOKEN"
  if ! git diff --quiet "$head" HEAD -- .github/workflows && ! pusher="$(workflow_token)"; then
    error="the sync changed workflows, but $WORKFLOW_TOKEN_URL gave no token to push them, so nothing was pushed"
    echo "::error::$error"
    printf 'result=failed\nerror=%s\n' "$error" >> "$GITHUB_OUTPUT"
    exit 1
  fi
  remote="https://x-access-token:${pusher}@github.com/${GITHUB_REPOSITORY}.git"
  scratch="refs/heads/autofork-objects-${GITHUB_RUN_ID}"
  push() { git -c http.https://github.com/.extraheader= -c core.hooksPath=/dev/null push --quiet "$remote" "$@"; }
  push "$(git commit-tree -p HEAD -m '[skip ci]' 'HEAD^{tree}'):$scratch" 2>&1 | { grep -v '^remote:' || true; } >&2
  trap 'push --delete "$scratch" || true; keep_codex_auth' EXIT
  signed="$(GH_TOKEN="$pusher" gh api "repos/$GITHUB_REPOSITORY/git/commits" \
    -f message="$(git log -1 --format=%B)" -f tree="$(git rev-parse 'HEAD^{tree}')" "${parents[@]}" --jq .sha)"
  if ! moved="$(GH_TOKEN="$pusher" gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/heads/$GITHUB_REF_NAME" -f sha="$signed" 2>&1)"; then
    tip="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$GITHUB_REF_NAME" --jq .object.sha 2> /dev/null)" || tip="$head"
    if [ "$tip" = "$head" ]; then
      echo "$moved" >&2
      reason="$(awk 'sub(/^gh: /, "") { print; exit }' <<< "$moved")"
      printf "result=failed\nerror=GitHub didn't move %s to the sync's commit, so nothing was pushed%s\n" "$GITHUB_REF_NAME" "${reason:+: $reason}" >> "$GITHUB_OUTPUT"
      exit 1
    fi
    echo "$GITHUB_REF_NAME changed while this ran, so the next run syncs it instead"
    echo "result=moved" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  trap - ERR
  echo "pushed ${signed:0:12} to $GITHUB_REF_NAME, signed by GitHub"
  close_failed "Synced in ${signed:0:12}."

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
    issue="$(open_issue "$title" || true)"
    if [ -n "$issue" ]; then
      gh issue comment "$issue" -R "$GITHUB_REPOSITORY" --body "Upstream changed these too, synced in ${signed:0:12}:"$'\n\n'"$workflows" > /dev/null
    else
      gh issue create -R "$GITHUB_REPOSITORY" --title "$title" --body "Upstream changed workflows this fork keeps its own copies of:

$workflows

autofork leaves the fork's \`.github/workflows/\` to it, and this sync didn't bring these changes over, and later syncs won't. Its agent does it during the sync when the workflow can get a token that can push workflow files, from autofork's GitHub app (https://github.com/apps/autofork-app), since a workflow's own token can't, and when this month's \`limits\` in .autofork/config.json have room for a rebuild. Bring over what this fork needs from upstream's changes, keeping what it does differently, or delete the copies it doesn't run, then close this issue.

Synced in ${signed:0:12}." > /dev/null
    fi || echo "::warning::upstream changed workflows this fork copied, but autofork couldn't open an issue about it: turn on the fork's issues and give the workflow issues: write"
  fi
fi
