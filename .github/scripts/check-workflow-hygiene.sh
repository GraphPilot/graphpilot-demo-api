#!/usr/bin/env bash
# Workflow hygiene for this repository's GitHub Actions files. Every GraphPilot repository with
# workflows carries an identical copy; graphpilot-platform's is the original, change it there
# first and copy it over.
#
#   1. Runner labels come from the organization variables RUNNER_HEAVY, RUNNER_MEDIUM,
#      RUNNER_ARM and RUNNER_LIGHT, so moving load between providers is a variable change.
#      The literals allowed are macos-14 and windows-2025 (CLI release builds on GitHub's
#      hosted macOS and Windows runners).
#   2. Every action from another repository is pinned to a full commit SHA with its version in
#      a trailing comment. A tag is mutable; Dependabot reads the comment to propose the next SHA.
#   3. A workflow that runs on pull requests cancels superseded runs.
#   4. A pull-request workflow builds Rust in the debug profile: fat LTO is for the shipped
#      artifact, built once on main.
#   5. A job bound to the prod environment lives in a workflow that no branch push, pull
#      request or schedule can start. prod deploys run from release tags; the environment
#      refuses anything else, so such a job could only ever fail (or worse, be "fixed" by
#      loosening the environment).
#
# Usage: .github/scripts/check-workflow-hygiene.sh [directory]   (default: .github)
# Written for bash 3.2 as well, so it runs on a stock macOS shell.
set -euo pipefail

root="${1:-.github}"
failed=0

report() { # file, message
  echo "::error file=$1::$2"
  failed=1
}

# The file without comments, so that an explanation never trips a rule.
code_of() {
  sed -E -e 's/^[[:space:]]*#.*$//' -e 's/[[:space:]]+#.*$//' "$1"
}

# Whether the comment-free file has a line matching the pattern. `grep >/dev/null`, not
# `grep -q`: -q exits at the first match, sed then dies of SIGPIPE on a long file, and under
# pipefail that turns a match into "no match".
code_has() { # file, extended regex
  code_of "$1" | grep -E "$2" >/dev/null
}

check_runners() {
  local file="$1" line value
  while IFS= read -r line; do
    value="$(printf '%s' "$line" | sed -E 's/^[[:space:]]*-?[[:space:]]*(runs-on|os):[[:space:]]*//; s/[[:space:]]+$//')"
    case "$value" in
      '${{ vars.RUNNER_HEAVY }}' | '${{ vars.RUNNER_MEDIUM }}' | '${{ vars.RUNNER_ARM }}' | '${{ vars.RUNNER_LIGHT }}') ;;
      '${{ matrix.'*' }}' | macos-14 | windows-2025) ;;
      *) report "$file" "runner label must come from vars.RUNNER_*: $value" ;;
    esac
  done < <(code_of "$file" | grep -E '^[[:space:]]*-?[[:space:]]*(runs-on|os):' || true)
}

check_pins() {
  local file="$1" line ref
  while IFS= read -r line; do
    ref="$(printf '%s' "$line" | sed -E "s/^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*//; s/[[:space:]].*\$//; s/^[\"']//; s/[\"']\$//")"
    case "$ref" in ./* | docker://*) continue ;; esac
    if ! printf '%s' "$ref" | grep -Eq '@[0-9a-f]{40}$'; then
      report "$file" "action not pinned to a full commit SHA: $ref"
    elif ! printf '%s' "$line" | grep -Eq '#[[:space:]]*v[0-9]'; then
      report "$file" "pinned action without a version comment: $ref"
    fi
  done < <(grep -E '^[[:space:]]*-?[[:space:]]*uses:' "$file" || true)
}

is_pull_request_workflow() {
  code_has "$1" '^[[:space:]]*-?[[:space:]]*pull_request(_target)?[[:space:]]*:?[[:space:]]*$|^on:.*pull_request'
}

check_workflow() {
  local file="$1"
  if is_pull_request_workflow "$file"; then
    code_has "$file" '^[[:space:]]*cancel-in-progress:[[:space:]]*true' ||
      report "$file" "pull_request workflow without cancel-in-progress: true"
    if code_has "$file" 'cargo[[:space:]].*(--release|--profile[[:space:]=]+release)'; then
      report "$file" "pull_request workflow builds Rust in a release profile"
    fi
  fi
  if code_has "$file" '^[[:space:]]*environment:[[:space:]]*prod[[:space:]]*$'; then
    if is_pull_request_workflow "$file" || code_has "$file" '^[[:space:]]*(schedule|branches):'; then
      report "$file" "prod job in a workflow that a branch push, pull request or schedule can start"
    fi
  fi
}

found=0
while IFS= read -r file; do
  found=1
  check_runners "$file"
  check_pins "$file"
  case "$file" in */workflows/*) check_workflow "$file" ;; esac
done < <(find "$root" -type f \( -name '*.yml' -o -name '*.yaml' \) ! -name 'dependabot.yml' ! -name 'actionlint.yaml' | sort)

if [ "$found" = 0 ]; then
  echo "::error::no workflow files under $root"
  exit 1
fi
if [ "$failed" = 1 ]; then exit 1; fi
echo "workflow hygiene: OK ($root)"
