#!/usr/bin/env bash
# Shared helpers for UTP CI batch validation (.github/actions/scripts/run-utp-tests.sh).
# Keep behavior in sync with contract tests: tests/run-utp-tests-contract.sh

# Returns 0 (true) if this UTP JSON log should fail an *expected-success* scenario.
utp_signals_failure_for_expected_success() {
  local test_name="$1"
  local utp_file="$2"
  case "$test_name" in
    CompilerWarnings|BuildWarnings)
      # Engine / allocator assert telemetry is common here; only treat Error/Exception as hard failures.
      grep -qi '"severity"[[:space:]]*:[[:space:]]*"\(Error\|Exception\)"' "$utp_file" 2>/dev/null
      ;;
    *)
      grep -qi '"severity"[[:space:]]*:[[:space:]]*"\(Error\|Exception\|Assert\)"' "$utp_file" 2>/dev/null
      ;;
  esac
}

# Returns 0 if UTP log contains any Error/Exception/Assert (used for expected-failure scenarios).
utp_signals_any_severity_problem() {
  local utp_file="$1"
  grep -qi '"severity"[[:space:]]*:[[:space:]]*"\(Error\|Exception\|Assert\)"' "$utp_file" 2>/dev/null
}

# Prints first path to an NUnit results file containing <test-case>, or nothing.
find_nunit_results_xml() {
  local test_name="$1"
  local f

  for f in \
    "$UNITY_PROJECT_PATH/Builds/Logs/${test_name}-results.xml" \
    "$UNITY_PROJECT_PATH/Builds/Logs/${test_name}-Results.xml"; do
    if [ -f "$f" ] && grep -q "<test-case[[:space:]>]" "$f" 2>/dev/null; then
      printf '%s\n' "$f"
      return 0
    fi
  done

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      */PackageCache/*|*/.git/*) continue ;;
    esac
    if grep -q "<test-case[[:space:]>]" "$f" 2>/dev/null; then
      printf '%s\n' "$f"
      return 0
    fi
  done < <(
    find "$UNITY_PROJECT_PATH" -type f \( \
      -name "${test_name}-results.xml" -o \
      -name "${test_name}-Results.xml" -o \
      -name "*${test_name}*results.xml" -o \
      -name "*${test_name}*Results.xml" \
      \) ! -path "*/PackageCache/*" ! -path "*/.git/*" 2>/dev/null | head -n 80
  )

  return 1
}

# Heuristic: Unity wrote no usable XML but logs show the test runner finished successfully.
edit_play_log_suggests_tests_completed_ok() {
  local test_name="$1"
  local mode="$2"
  local logf
  local saw_success=0

  while IFS= read -r logf; do
    [ -z "$logf" ] && continue
    [ -f "$logf" ] || continue
    # Any explicit failure marker across matching logs should fail the heuristic.
    if grep -qiE 'test run failed|one or more child tests failed|failures:[[:space:]]*[1-9]|errors:[[:space:]]*[1-9]' "$logf" 2>/dev/null; then
      return 1
    fi
    if grep -qiE \
      'test run completed|tests run:.*passed|total tests:.*failed:[[:space:]]*0(\>|[^0-9]|$)|Executed[[:space:]]+[0-9]+[[:space:]]+tests|Test run[[:space:]]+\[.*\][[:space:]]+finished|NUnit[[:space:]]+Engine|UnityEditor\.TestTools\.TestRunner' \
      "$logf" 2>/dev/null; then
      saw_success=1
    fi
  done < <(find "$UNITY_PROJECT_PATH/Builds/Logs" -maxdepth 1 -type f -name "*${test_name}*${mode}*.log" 2>/dev/null)

  [ "$saw_success" -eq 1 ]
}
