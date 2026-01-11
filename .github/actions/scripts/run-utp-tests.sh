#!/usr/bin/env bash
set -uo pipefail

UNITY_PROJECT_PATH=${UNITY_PROJECT_PATH:?UNITY_PROJECT_PATH is required}
BUILD_TARGET=${BUILD_TARGET:?BUILD_TARGET is required}
BUILD_ARGS=${BUILD_ARGS:-}
TESTS_INPUT=${TESTS_INPUT:-}

IFS=',' read -ra tests <<< "$TESTS_INPUT"
failures=0

clean_tests() {
  rm -f "$UNITY_PROJECT_PATH/Assets/UnityCliTests"/*.cs 2>/dev/null || true
  rm -f "$UNITY_PROJECT_PATH/Assets/Editor/UnityCliTests"/*.cs 2>/dev/null || true
  rm -f "$UNITY_PROJECT_PATH/Assets/Tests/PlayMode/UnityCliTests"/*.cs 2>/dev/null || true
  rm -f "$UNITY_PROJECT_PATH/Assets/Tests/EditMode/UnityCliTests"/*.cs 2>/dev/null || true
}

clean_build_outputs() {
  rm -rf "$UNITY_PROJECT_PATH/Builds" 2>/dev/null || true
  mkdir -p "$UNITY_PROJECT_PATH/Builds/Logs"
}

# Expectations for each synthetic test
# expected_status: 0 = should succeed, 1 = should fail
declare -A expected_status
expected_status[CompilerWarnings]=0
expected_status[BuildWarnings]=0
expected_status[CompilerErrors]=1
expected_status[BuildErrors]=1
expected_status[PlaymodeTestsErrors]=1
expected_status[EditmodeTestsErrors]=1

declare -A expected_message
expected_message[CompilerErrors]="Intentional compiler error"
expected_message[BuildErrors]="Intentional build failure"
expected_message[PlaymodeTestsErrors]="Intentional playmode failure"
expected_message[EditmodeTestsErrors]="Intentional editmode failure"
expected_message[CompilerWarnings]="Intentional warning"
expected_message[BuildWarnings]="Intentional build warning"

mkdir -p "$GITHUB_WORKSPACE/utp-artifacts"

for raw_test in "${tests[@]}"; do
  test_name="$(echo "$raw_test" | xargs)"
  if [ -z "$test_name" ] || [ "$test_name" = "None" ]; then
    echo "Skipping empty/None test entry"
    continue
  fi

  src="$GITHUB_WORKSPACE/unity-tests/${test_name}.cs"
  if [ ! -f "$src" ]; then
    echo "::error::Requested test '$test_name' not found at $src"
    failures=$((failures+1))
    continue
  fi

  clean_tests
  clean_build_outputs

  case "$test_name" in
    CompilerWarnings|CompilerErrors)
      dest="$UNITY_PROJECT_PATH/Assets/UnityCliTests"
      ;;
    BuildWarnings|BuildErrors)
      dest="$UNITY_PROJECT_PATH/Assets/Editor/UnityCliTests"
      ;;
    PlaymodeTestsErrors)
      dest="$UNITY_PROJECT_PATH/Assets/Tests/PlayMode/UnityCliTests"
      ;;
    EditmodeTestsErrors)
      dest="$UNITY_PROJECT_PATH/Assets/Tests/EditMode/UnityCliTests"
      ;;
    *)
      echo "::error::Unknown test selection '$test_name'"
      failures=$((failures+1))
      continue
      ;;
  esac

  mkdir -p "$dest"
  cp "$src" "$dest/"
  echo "Running test: $test_name (copied to $dest)"

  validate_rc=0
  build_rc=0

  unity-cli run --log-name "${test_name}-Validate" -quit -executeMethod Utilities.Editor.BuildPipeline.UnityPlayerBuildTools.ValidateProject -importTMProEssentialsAsset || validate_rc=$?
  unity-cli run --log-name "${test_name}-Build" -buildTarget "$BUILD_TARGET" -quit -executeMethod Utilities.Editor.BuildPipeline.UnityPlayerBuildTools.StartCommandLineBuild -sceneList Assets/Scenes/SampleScene.unity $BUILD_ARGS || build_rc=$?

  expected=${expected_status[$test_name]:-0}
  exp_msg=${expected_message[$test_name]:-}

  test_failed=0
  message_found=0

  if [ -n "$exp_msg" ]; then
    while IFS= read -r log_file; do
      if [ -z "$log_file" ]; then
        continue
      fi
      if grep -qi -- "$exp_msg" "$log_file" 2>/dev/null; then
        message_found=1
        break
      fi
    done < <(find "$UNITY_PROJECT_PATH/Builds/Logs" -maxdepth 1 -type f -name "*${test_name}*.log")
  fi

  if [ "$expected" -eq 0 ]; then
    if [ "$validate_rc" -ne 0 ] || [ "$build_rc" -ne 0 ]; then
      echo "::error::Test $test_name was expected to succeed but failed (validate_rc=$validate_rc, build_rc=$build_rc)"
      test_failed=1
    fi
    if [ -n "$exp_msg" ] && [ "$message_found" -eq 0 ]; then
      echo "::error::Test $test_name did not emit expected message '$exp_msg'"
      test_failed=1
    fi
  else
    if [ "$validate_rc" -ne 0 ] || [ "$build_rc" -ne 0 ] || [ "$message_found" -eq 1 ]; then
      : # Expected failure observed
    else
      echo "::error::Test $test_name was expected to fail but succeeded"
      test_failed=1
    fi
    if [ -n "$exp_msg" ] && [ "$message_found" -eq 0 ]; then
      echo "::error::Test $test_name did not emit expected message '$exp_msg'"
      test_failed=1
    fi
  fi

  if [ "$test_failed" -eq 0 ]; then
    echo "::notice::Test $test_name behaved as expected (validate_rc=$validate_rc, build_rc=$build_rc)"
  else
    failures=$((failures+1))
  fi

  test_artifacts="$GITHUB_WORKSPACE/utp-artifacts/$test_name"
  mkdir -p "$test_artifacts"
  find "$GITHUB_WORKSPACE" -path "$test_artifacts" -prune -o -type f -name "*${test_name}*-utp-json.log" -print -exec cp -n {} "$test_artifacts" \; || true

done

if [ "$failures" -gt 0 ]; then
  echo "::error::One or more tests did not meet expectations ($failures)"
  exit 1
fi

exit 0
