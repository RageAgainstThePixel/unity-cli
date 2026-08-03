#!/usr/bin/env bash
# Contract tests for UTP CI assertion helpers (bash; run on Linux CI or Git Bash).
# Requires dist/utp.js (npm run build) — helpers parse UTP via normalizeTelemetryEntry.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$ROOT/dist/utp.js" ]; then
  echo "Building dist/ for UTP normalize…" >&2
  (cd "$ROOT" && npm run build)
fi
# shellcheck source=../.github/actions/scripts/utp-ci-assertion-helpers.sh
source "$ROOT/.github/actions/scripts/utp-ci-assertion-helpers.sh"

fail() {
  echo "::error::$1" >&2
  exit 1
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# --- UTP severity: warning scenarios ignore Assert-only noise ---
printf '%s\n' '{"type":"Log","severity":"Assert","message":"StackAllocator"}' >"$tmpdir/warn-assert.json"
if utp_signals_failure_for_expected_success CompilerWarnings "$tmpdir/warn-assert.json"; then
  fail "CompilerWarnings + Assert-only should not signal failure for expected-success check"
fi

printf '%s\n' '{"type":"Log","severity":"Error","message":"boom"}' >"$tmpdir/warn-err.json"
if ! utp_signals_failure_for_expected_success CompilerWarnings "$tmpdir/warn-err.json"; then
  fail "CompilerWarnings + Error should signal failure for expected-success check"
fi

# Windows GHA multicast permission noise — remapped to Info by normalizeTelemetryEntry.
printf '%s\n' '{"type":"Log","severity":"Error","message":"Unable to join player connection multicast group (err: 10013)."}' >"$tmpdir/multicast.json"
if utp_signals_failure_for_expected_success CompilerWarnings "$tmpdir/multicast.json"; then
  fail "CompilerWarnings + player-connection multicast Error should be remapped (not actionable)"
fi

# Unity 2019-style sibling WSAEACCES line (same CI failure mode as multicast).
printf '%s\n' '{"type":"Log","severity":"Error","message":"Socket: bind failed, error: An attempt was made to access a socket in a way forbidden by its access permissions."}' >"$tmpdir/socket-bind.json"
if utp_signals_failure_for_expected_success CompilerWarnings "$tmpdir/socket-bind.json"; then
  fail "CompilerWarnings + Socket bind failed should be remapped (not actionable)"
fi
if utp_signals_failure_for_expected_success BuildWarnings "$tmpdir/socket-bind.json"; then
  fail "BuildWarnings + Socket bind failed should be remapped (not actionable)"
fi
if utp_signals_failure_for_expected_success BuildWarnings "$tmpdir/multicast.json"; then
  fail "BuildWarnings + player-connection multicast Error should be remapped (not actionable)"
fi
if utp_signals_failure_for_expected_success EditmodeTestsPassing "$tmpdir/multicast.json"; then
  fail "Expected-success scenarios should treat remapped multicast as non-actionable"
fi
if utp_signals_any_severity_problem "$tmpdir/multicast.json"; then
  fail "utp_signals_any_severity_problem should treat remapped multicast as non-actionable"
fi

# Pretty-printed CLI artifact shape (writeUtpTelemetryLog) must parse + remap the same way.
cat >"$tmpdir/multicast-pretty.json" <<'EOF'
[
  {
    "type": "LogEntry",
    "severity": "Error",
    "message": "Unable to join player connection multicast group (err: 10013)."
  }
]
EOF
if utp_signals_failure_for_expected_success CompilerWarnings "$tmpdir/multicast-pretty.json"; then
  fail "Pretty-printed multicast UTP artifact should remap Error → Info"
fi

# Mixed: multicast noise + real Error still fails.
printf '%s\n' \
  '{"type":"Log","severity":"Error","message":"Unable to join player connection multicast group (err: 10013)."}' \
  '{"type":"Log","severity":"Error","message":"boom"}' >"$tmpdir/multicast-plus-real.json"
if ! utp_signals_failure_for_expected_success CompilerWarnings "$tmpdir/multicast-plus-real.json"; then
  fail "Real Error alongside multicast noise should still signal failure"
fi

# Pretty mixed array
cat >"$tmpdir/multicast-plus-real-pretty.json" <<'EOF'
[
  {
    "type": "LogEntry",
    "severity": "Error",
    "message": "Unable to join player connection multicast group (err: 10013)."
  },
  {
    "type": "LogEntry",
    "severity": "Error",
    "message": "boom"
  }
]
EOF
if ! utp_signals_failure_for_expected_success CompilerWarnings "$tmpdir/multicast-plus-real-pretty.json"; then
  fail "Pretty-printed real Error alongside multicast should still signal failure"
fi

printf '%s\n' '{"severity":"Assert"}' >"$tmpdir/nonwarn-assert.json"
if ! utp_signals_failure_for_expected_success EditmodeTestsPassing "$tmpdir/nonwarn-assert.json"; then
  fail "Non-warning scenario should still treat Assert as failure for expected-success check"
fi

# --- UTP any-signal (expected-failure branch) ---
if ! utp_signals_any_severity_problem "$tmpdir/nonwarn-assert.json"; then
  fail "utp_signals_any_severity_problem should match Assert"
fi

# --- NUnit XML discovery ---
export UNITY_PROJECT_PATH="$tmpdir/proj"
mkdir -p "$UNITY_PROJECT_PATH/Builds/Logs"
printf '<test-case name="x"/>\n' >"$UNITY_PROJECT_PATH/Builds/Logs/EditmodeTestsPassing-results.xml"
found="$(find_nunit_results_xml EditmodeTestsPassing)"
if [ "$found" != "$UNITY_PROJECT_PATH/Builds/Logs/EditmodeTestsPassing-results.xml" ]; then
  fail "find_nunit_results_xml should resolve default Builds/Logs path (got: $found)"
fi

mkdir -p "$UNITY_PROJECT_PATH/Builds/Alt"
printf '<test-case name="y"/>\n' >"$UNITY_PROJECT_PATH/Builds/Alt/EditmodeTestsPassing-results.xml"
rm -f "$UNITY_PROJECT_PATH/Builds/Logs/EditmodeTestsPassing-results.xml"
found2="$(find_nunit_results_xml EditmodeTestsPassing)"
if [ "$found2" != "$UNITY_PROJECT_PATH/Builds/Alt/EditmodeTestsPassing-results.xml" ]; then
  fail "find_nunit_results_xml should discover alternate path under project (got: $found2)"
fi

# --- Log completion heuristic ---
printf '%s\n' 'Some noise' 'Test run completed.' 'more' >"$UNITY_PROJECT_PATH/Builds/Logs/EditmodeTestsPassing-EditMode-Unity-1.log"
if ! edit_play_log_suggests_tests_completed_ok EditmodeTestsPassing EditMode; then
  fail "edit_play_log_suggests_tests_completed_ok should match Test run completed marker"
fi

printf '%s\n' 'Test run completed.' 'test run failed' >"$UNITY_PROJECT_PATH/Builds/Logs/EditmodeTestsPassing-EditMode-Unity-2.log"
if edit_play_log_suggests_tests_completed_ok EditmodeTestsPassing EditMode; then
  fail "edit_play_log_suggests_tests_completed_ok should reject logs that also contain failure markers"
fi

echo "run-utp-tests-contract: OK"
