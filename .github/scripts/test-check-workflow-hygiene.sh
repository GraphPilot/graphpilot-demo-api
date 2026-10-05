#!/usr/bin/env bash
# Tests for check-workflow-hygiene.sh. Each case writes one workflow into a fresh temporary
# .github tree and asserts the exit code and a fragment of the output.
# Usage: .github/scripts/test-check-workflow-hygiene.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
check="$here/check-workflow-hygiene.sh"
passed=0
failed=0

expect() { # name, expected exit code, expected output fragment, workflow text
  local name="$1" want="$2" fragment="$3" body="$4" dir out code
  dir="$(mktemp -d)"
  mkdir -p "$dir/workflows"
  printf '%s\n' "$body" > "$dir/workflows/case.yml"
  out="$("$check" "$dir" 2>&1)"
  code=$?
  rm -rf "$dir"
  if [ "$code" = "$want" ] && printf '%s' "$out" | grep -qF -- "$fragment"; then
    passed=$((passed + 1))
    echo "ok   $name"
  else
    failed=$((failed + 1))
    echo "FAIL $name (exit $code, wanted $want and '$fragment')"
    printf '%s\n' "$out" | sed 's/^/       /'
  fi
}

expect clean 0 "workflow hygiene: OK" 'on:
  pull_request:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ${{ vars.RUNNER_MEDIUM }}
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v6.1.0
      - uses: ./.github/actions/setup
      - run: cargo test --workspace'

expect literal_blacksmith 1 "runner label must come from vars.RUNNER_*: blacksmith-4vcpu-ubuntu-2404" 'on: workflow_dispatch
jobs:
  a:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps:
      - run: true'

expect literal_github 1 "runner label must come from vars.RUNNER_*: ubuntu-latest" 'on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: true'

expect macos_14_allowed 0 "workflow hygiene: OK" 'on: workflow_dispatch
jobs:
  a:
    runs-on: macos-14
    steps:
      - run: true'

expect windows_2025_allowed 0 "workflow hygiene: OK" 'on: workflow_dispatch
jobs:
  a:
    runs-on: windows-2025
    steps:
      - run: true'

expect matrix_literal 1 "runner label must come from vars.RUNNER_*: blacksmith-6vcpu-macos-15" 'on: workflow_dispatch
jobs:
  a:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        include:
          - target: aarch64-apple-darwin
            os: blacksmith-6vcpu-macos-15
    steps:
      - run: true'

expect matrix_variable 0 "workflow hygiene: OK" 'on: workflow_dispatch
jobs:
  a:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        include:
          - target: aarch64-unknown-linux-musl
            os: ${{ vars.RUNNER_ARM }}
    steps:
      - run: true'

expect tag_pin 1 "action not pinned to a full commit SHA: actions/checkout@v6" 'on: workflow_dispatch
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - uses: actions/checkout@v6'

expect sha_without_comment 1 "pinned action without a version comment" 'on: workflow_dispatch
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567'

expect reusable_local 0 "workflow hygiene: OK" 'on: workflow_dispatch
jobs:
  a:
    uses: ./.github/workflows/promote.yml'

expect pr_without_cancel 1 "pull_request workflow without cancel-in-progress: true" 'on:
  pull_request:
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - run: true'

expect pr_release_profile 1 "pull_request workflow builds Rust in a release profile" 'on:
  pull_request:
concurrency:
  group: x
  cancel-in-progress: true
jobs:
  a:
    runs-on: ${{ vars.RUNNER_HEAVY }}
    steps:
      - run: cargo build --release -p gp-compute-fastly'

expect prod_job_on_branch_push 1 "prod job in a workflow that a branch push" 'on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_job_on_schedule 1 "prod job in a workflow that a branch push" 'on:
  schedule:
    - cron: "0 6 * * 1"
jobs:
  benchmark:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_job_on_tag 0 "workflow hygiene: OK" 'on:
  push:
    tags: ["platform-v*"]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_mapping_on_branch 1 "prod job in a workflow that a branch push" 'on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment:
      name: prod
      url: https://example.com
    steps:
      - run: true'

expect prod_flow_mapping_on_branch 1 "prod job in a workflow that a branch push" 'on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: { name: prod, url: https://example.com }
    steps:
      - run: true'

expect prod_quoted_on_branch 1 "prod job in a workflow that a branch push" 'on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: "prod"
    steps:
      - run: true'

expect prod_single_quoted_on_branch 1 "prod job in a workflow that a branch push" 'on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: '\''prod'\''
    steps:
      - run: true'

expect prod_on_bare_push 1 "prod job in a workflow that a branch push" 'on:
  push:
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_on_inline_push 1 "prod job in a workflow that a branch push" 'on: [push, workflow_dispatch]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_on_push_paths_only 1 "prod job in a workflow that a branch push" 'on:
  push:
    paths: ["src/**"]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_on_branches_ignore 1 "prod job in a workflow that a branch push" 'on:
  push:
    branches-ignore: [dev]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_on_inline_schedule 1 "prod job in a workflow that a branch push" 'on: [schedule, workflow_dispatch]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_mapping_on_tag 0 "workflow hygiene: OK" 'on:
  push:
    tags: ["v*"]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment:
      name: "prod"
    steps:
      - run: true'

expect prod_on_tag_with_paths 0 "workflow hygiene: OK" 'on:
  push:
    tags: ["v*"]
    paths: ["src/**"]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_ops_on_branch 0 "workflow hygiene: OK" 'on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod-ops
    steps:
      - run: true'

expect production_on_branch 0 "workflow hygiene: OK" 'on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: production
    steps:
      - run: true'

expect prod_on_dispatch_only 0 "workflow hygiene: OK" 'on:
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect prod_on_tag_with_docker_push_input 0 "workflow hygiene: OK" 'on:
  push:
    tags: ["v*"]
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true
      - uses: docker/build-push-action@0123456789abcdef0123456789abcdef01234567 # v6.1.0
        with:
          push: true'

expect prod_on_dispatch_with_docker_push_input 0 "workflow hygiene: OK" 'on: workflow_dispatch
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true
      - uses: docker/build-push-action@0123456789abcdef0123456789abcdef01234567 # v6.1.0
        with:
          push: true'

expect prod_on_dispatch_with_branches_input 0 "workflow hygiene: OK" 'on:
  workflow_dispatch:
    inputs:
      branches:
        description: which
        required: false
jobs:
  deploy:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true
'

expect comment_is_not_code 0 "workflow hygiene: OK" '# runs-on: ubuntu-latest used to be here
on: workflow_dispatch
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }} # was blacksmith-4vcpu-ubuntu-2404
    steps:
      - run: true'

expect pr_inline_empty_without_cancel 1 "pull_request workflow without cancel-in-progress: true" 'on:
  pull_request: {}
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - run: true'

expect pr_inline_branches_without_cancel 1 "pull_request workflow without cancel-in-progress: true" 'on:
  pull_request: { branches: [main] }
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - run: true'

expect pr_inline_types_without_cancel 1 "pull_request workflow without cancel-in-progress: true" 'on:
  pull_request: {types: [opened]}
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - run: true'

expect pr_target_inline_without_cancel 1 "pull_request workflow without cancel-in-progress: true" 'on:
  pull_request_target: { branches: [main] }
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - run: true'

expect pr_inline_with_cancel_clean 0 "workflow hygiene: OK" 'on:
  pull_request: { branches: [main] }
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - run: true'

expect pr_inline_release_profile 1 "builds Rust in a release profile" 'on:
  pull_request: {}
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - run: cargo build --release'

expect prod_on_inline_pull_request 1 "prod job in a workflow" 'on:
  pull_request: {}
  workflow_dispatch:
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  a:
    runs-on: ${{ vars.RUNNER_LIGHT }}
    environment: prod
    steps:
      - run: true'

expect event_name_expression_is_not_a_trigger 0 "workflow hygiene: OK" 'on: workflow_dispatch
jobs:
  a:
    if: github.event_name == '\''pull_request'\''
    runs-on: ${{ vars.RUNNER_LIGHT }}
    steps:
      - run: true
        env:
          pull_request: { x: 1 }'

echo "${passed} passed, ${failed} failed"
[ "$failed" = 0 ]
