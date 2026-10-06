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
#   5. A job bound to the prod environment (any spelling: plain, quoted, flow or block mapping)
#      lives in a workflow that no branch push, pull request or schedule can start (a
#      `push:` without `tags:`, `on: push`, `on: [push, ...]`, `branches:`, `branches-ignore:`,
#      `schedule` and pull_request[_target] all count). prod deploys run from release tags; the environment
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

# Whether the workflow runs on pull requests: `on: pull_request`, an inline list, a bare
# `pull_request:` / `- pull_request` line, or an inline configuration (`pull_request: {}`,
# `pull_request: { branches: [main] }`) at the trigger level of the top-level `on:` block. The
# trigger level keeps `pull_request` as a value (`github.event_name == 'pull_request'`) or as a
# step input out of it.
is_pull_request_workflow() {
  code_has "$1" '^[[:space:]]*-?[[:space:]]*pull_request(_target)?[[:space:]]*:?[[:space:]]*$|^["'"'"']?on["'"'"']?:.*pull_request' && return 0
  [ "$(on_block_of "$1" | awk '
    function indent(l) { match(l, /^[ ]*/); return RLENGTH }
    NR == 1 { next }
    child == "" { child = indent($0) }
    indent($0) == child && $0 ~ /^[[:space:]]*pull_request(_target)?[[:space:]]*:[[:space:]]*\{/ { hit = 1 }
    END { print hit ? 1 : 0 }
  ')" = 1 ]
}

# Whether any job is bound to the environment prod: `environment: prod` (plain or quoted),
# `environment: { name: prod }`, or `environment:` followed by an indented block with `name: prod`.
has_prod_job() {
  code_has "$1" "^[[:space:]]*environment:[[:space:]]*[\"']?prod[\"']?[[:space:]]*\$" && return 0
  code_has "$1" "^[[:space:]]*environment:[[:space:]]*\\{([^}]*,)?[[:space:]]*name:[[:space:]]*[\"']?prod[\"']?[[:space:]]*[,}]" && return 0
  [ "$(code_of "$1" | awk -v q="'" '
    function indent(l) { match(l, /^[ ]*/); return RLENGTH }
    /^[[:space:]]*$/ { next }
    inblock && indent($0) <= base { inblock = 0 }
    inblock && $0 ~ ("^[[:space:]]*name:[[:space:]]*[\"" q "]?prod[\"" q "]?[[:space:]]*$") { found = 1 }
    /^[[:space:]]*environment:[[:space:]]*$/ { inblock = 1; base = indent($0) }
    END { print found ? 1 : 0 }
  ')" = 1 ]
}

# The top-level `on:` block (the `on:` line, quoted or not, up to the next key at indent 0), so
# that a step input such as `with: push: true` or a dispatch input named `branches` is no trigger.
on_block_of() {
  code_of "$1" | awk -v q="'" '
    /^[[:space:]]*$/ { next }
    $0 ~ ("^[\"" q "]?on[\"" q "]?:") { inon = 1; print; next }
    /^[^[:space:]]/ { inon = 0 }
    inon { print }
  '
}

# Whether a branch push, pull request or schedule can start the workflow. A `push:` block
# with `tags:` is tag-only; without it (bare, or only `paths:`) every branch push starts it.
# Only the top-level `on:` block counts.
is_branch_startable() {
  is_pull_request_workflow "$1" && return 0
  local on
  on="$(on_block_of "$1")"
  grep -E '^["'"'"']?on["'"'"']?:[[:space:]]*(push|schedule)[[:space:]]*$' <<<"$on" >/dev/null && return 0
  grep -E '^["'"'"']?on["'"'"']?:[[:space:]]*\[([^]]*,)?[[:space:]]*(push|schedule)[[:space:]]*[],]' <<<"$on" >/dev/null && return 0
  # Block form: `schedule`, `push` (without tags) and `branches[-ignore]` under any trigger but
  # workflow_dispatch / workflow_call (whose inputs may be named anything).
  [ "$(awk '
    function indent(l) { match(l, /^[ ]*/); return RLENGTH }
    /^[[:space:]]*$/ { next }
    NR == 1 { next }
    child == "" { child = indent($0) }
    inblock && indent($0) <= base { if (!tags) hit = 1; inblock = 0 }
    inblock && /^[[:space:]]*tags:/ { tags = 1 }
    indent($0) == child {
      key = $0; sub(/^[[:space:]]*-?[[:space:]]*/, "", key); sub(/[[:space:]]*:.*$/, "", key)
      trigger = key
      if (key == "schedule") hit = 1
      if ($0 ~ /^[[:space:]]*-[[:space:]]*push[[:space:]]*$/) hit = 1
      if (key == "push") {
        rest = $0; sub(/^[[:space:]]*push:[[:space:]]*/, "", rest)
        if (rest == "" || rest ~ /^\{[[:space:]]*\}$/) { inblock = 1; base = indent($0); tags = 0 }
        else if (rest !~ /tags/) hit = 1
      }
    }
    trigger != "workflow_dispatch" && trigger != "workflow_call" && /^[[:space:]]*(branches|branches-ignore):/ { hit = 1 }
    END { if (inblock && !tags) hit = 1; print hit ? 1 : 0 }
  ' <<<"$on")" = 1 ]
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
  if has_prod_job "$file" && is_branch_startable "$file"; then
    report "$file" "prod job in a workflow that a branch push, pull request or schedule can start"
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
