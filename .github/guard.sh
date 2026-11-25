#!/usr/bin/env bash
# Pull-request guard (docs/RELEASE.md, "Guarded paths and approvals").
# Env: BASE  base ref, e.g. origin/main
#      HEAD  the checked-out pull_request merge ref (HEAD in CI)
#      HEAD_SHA  the PR's own head commit (github.event.pull_request.head.sha)
#      PR  the pull request number
# The workflow runs the BASE branch's copy of this script when the base has one (so a PR cannot weaken the check that judges it)
# and the merge ref's copy only for the bootstrap. Residual risk: a PR that edits ci.yml itself; the coordinator reads every
# .github diff. A tripwire against accidental edits of audio-path code, not a security boundary.
set -euo pipefail
: "${BASE:?}" "${HEAD:?}" "${HEAD_SHA:?}" "${PR:?}"

fail() { echo "::error::$*"; exit 1; }
[[ $PR =~ ^[0-9]+$ ]] || fail "PR number is not numeric: $PR"

dir=.github/guard-approvals
own=$dir/$PR.txt
fixture=e2e/fixtures/payloads-1.0.21.json
guarded='^(worker/|worker-rs/|src-tauri/src/(engine|store|pack|docx|update|lib)\.rs$|\.github/)'

# The payload fixture is owner-locked: any change to it or to a case variant of its path (they collide on Windows) fails, approved or not.
locked=$(git diff --name-only --no-renames "$BASE...$HEAD" -- ":(icase)$fixture")
[ -z "$locked" ] || fail "The payload fixture is locked and cannot be approved: $locked"

# -z: no path quoting (a non-ASCII name must still match); --no-renames: a rename shows both its old and new path.
list=$(mktemp); trap 'rm -f "$list"' EXIT
git diff -z --name-only --no-renames "$BASE...$HEAD" > "$list"
changed=
while IFS= read -r -d '' f; do
  case $f in *$'\n'*) fail "A changed path contains a newline: ${f//$'\n'/\\n}" ;; esac
  changed+=$f$'\n'
done < "$list"

# Only this PR's own approval file may change under the approvals directory (case-sensitive: a case variant is a guarded .github path).
while IFS= read -r f; do
  case $f in "$dir"/*) [ "$f" = "$own" ] || fail "Only $own may change under $dir (got $f)" ;; esac
done <<< "$changed"

paths=$(printf '%s' "$changed" | grep -Ei "$guarded" | grep -Ev '^\.github/guard-approvals/' || true)
if [ -z "$paths" ]; then echo "No guarded paths changed."; exit 0; fi
echo "Guarded paths changed:"; printf '%s\n' "$paths"

# The approval must be the last commit, alone, on top of the head the coordinator reviewed.
parents=$(git rev-list --parents -n1 "$HEAD_SHA")
read -r -a ids <<< "$parents"
[ "${#ids[@]}" -eq 2 ] || fail "The head commit must have exactly one parent (a merge commit or the root cannot be the approval)."
parent=${ids[1]}
status=$(git diff --name-status --no-renames "$parent" "$HEAD_SHA")
[ "$status" = $'A\t'"$own" ] || [ "$status" = $'M\t'"$own" ] \
  || fail "The head commit must change exactly $own (added or modified) and nothing else."

approval=$(git show "$HEAD_SHA:$own" | tr -d '\r')
first=${approval%%$'\n'*}
first=${first#$'\xef\xbb\xbf'} # UTF-8 BOM
[[ $first =~ ^reviewed\ ([0-9a-f]{40})$ ]] || fail "First line of $own must be: reviewed <40-hex sha>"
[ "${BASH_REMATCH[1]}" = "$(git rev-parse "$parent")" ] || fail "reviewed ${BASH_REMATCH[1]} is not the commit under the approval ($parent)."
case $approval in *$'\n'*) lines=${approval#*$'\n'} ;; *) lines= ;; esac

# Every changed guarded path needs a line with its blob on the merge ref (or "deleted" when the merge ref has no such file).
# A symlink or submodule is never approvable: its blob is only the link text or a commit id.
while IFS= read -r p; do
  mode=$(git ls-tree "$HEAD" -- "$p" | cut -c1-6)
  case $mode in 120000|160000) fail "$p is a symlink or submodule on the merge ref ($mode)." ;; esac
  blob=$(git rev-parse --verify -q "$HEAD:$p" || echo deleted)
  grep -qxF -- "$p $blob" <<< "$lines" || fail "$own has no line '$p $blob'."
  echo "approved: $p $blob"
done <<< "$paths"
