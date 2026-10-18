#!/bin/bash
set -eu
# The runner starts in the sandbox root; keep workspace-relative fixtures in that sandbox.
cd "${MUTATION_TEST_DIRECTORY:-.}"
if [ -n "${MUTATION_DRY_RUN_LOG:-}" ] && [ -z "${__STRYKER_ACTIVE_MUTANT__:-}" ] && [ "$1" = "test" ]; then
  mkdir -p "$(dirname "$MUTATION_DRY_RUN_LOG")"
  exec bun --no-env-file "$@" 2> >(tee "$MUTATION_DRY_RUN_LOG" >&2)
fi
exec bun --no-env-file "$@"
