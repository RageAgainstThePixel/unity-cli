#!/usr/bin/env bash
set -uo pipefail

UNITY_PROJECT_PATH=${UNITY_PROJECT_PATH:?UNITY_PROJECT_PATH is required}
BUILD_TARGET=${BUILD_TARGET:?BUILD_TARGET is required}
BUILD_ARGS=${BUILD_ARGS:-}
TESTS_INPUT=${TESTS_INPUT:-}

if printf '%s' "$BUILD_ARGS" | grep -qE '[;&`|]'; then
  echo "::error::BUILD_ARGS contains disallowed shell metacharacters"
  exit 1
fi

build_args=()
if [ -n "$BUILD_ARGS" ]; then
  # Split on whitespace into an array without invoking the shell
  read -r -a build_args <<< "$BUILD_ARGS"
fi

IFS=',' read -ra tests <<< "$TESTS_INPUT"
failures=0

clean_tests() {
  rm -f "$UNITY_PROJECT_PATH/Assets/UnityCliTests"/*.cs 2>/dev/null || true
  rm -f "$UNITY_PROJECT_PATH/Assets/Editor/UnityCliTests"/*.cs 2>/dev/null || true
  rm -f "$UNITY_PROJECT_PATH/Assets/Tests/PlayMode/UnityCliTests"/*.cs 2>/dev/null || true
  rm -f "$UNITY_PROJECT_PATH/Assets/Tests/EditMode/UnityCliTests"/*.cs 2>/dev/null || true
  rm -f "$UNITY_PROJECT_PATH/Assets/Tests/EditMode/UnityCliTests"/*.asmdef 2>/dev/null || true
  rm -f "$UNITY_PROJECT_PATH/Assets/Tests/EditMode/Editor/UnityCliTests"/*.cs 2>/dev/null || true
}

clean_build_outputs() {
  rm -rf "$UNITY_PROJECT_PATH/Builds" 2>/dev/null || true
  mkdir -p "$UNITY_PROJECT_PATH/Builds/Logs"
}

# Expectations for each synthetic test
# expected_status: 0 = should succeed, 1 = should fail
expected_status_for() {
  case "$1" in
    CompilerWarnings) echo 0 ;;
    BuildWarnings) echo 0 ;;
    CompilerErrors) echo 1 ;;
    BuildErrors) echo 1 ;;
    PlaymodeTestsErrors) echo 1 ;;
    EditmodeTestsErrors) echo 1 ;;
    *) echo 0 ;;
  esac
}

expected_message_for() {
  case "$1" in
    CompilerErrors) echo "Intentional compiler error" ;;
    BuildErrors) echo "Intentional build failure" ;;
    PlaymodeTestsErrors) echo "Intentional playmode failure" ;;
    EditmodeTestsErrors) echo "Intentional editmode failure" ;;
    CompilerWarnings) echo "Intentional warning" ;;
    BuildWarnings) echo "Intentional build warning" ;;
    *) echo "" ;;
  esac
}

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

  asmdef_src=""

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
      asmdef_src="$GITHUB_WORKSPACE/unity-tests/UnityCliTests.EditMode.Editor.asmdef"
      ;;
    *)
      echo "::error::Unknown test selection '$test_name'"
      failures=$((failures+1))
      continue
      ;;
  esac

  mkdir -p "$dest"
  if [ -n "$asmdef_src" ]; then
    if [ ! -f "$asmdef_src" ]; then
      echo "::error::Assembly definition for editmode tests not found at $asmdef_src"
      failures=$((failures+1))
      continue
    fi
    cp "$asmdef_src" "$dest/"
  fi
  cp "$src" "$dest/"
  echo "Running test: $test_name (copied to $dest)"

  validate_rc=0
  build_rc=0

  ran_custom_flow=0

  if [ "$test_name" = "EditmodeTestsErrors" ]; then
    unity-cli run --log-name "${test_name}-EditMode" -runTests -testPlatform editmode -assemblyNames "UnityCli.EditMode.EditorTests" -testResults "$UNITY_PROJECT_PATH/Builds/Logs/${test_name}-results.xml" -quit || validate_rc=$?

    results_xml="$UNITY_PROJECT_PATH/Builds/Logs/${test_name}-results.xml"
    if ! grep -q "<test-case " "$results_xml" 2>/dev/null; then
      validate_rc=1
    fi
    build_rc=$validate_rc
    ran_custom_flow=1
  fi

  if [ "$ran_custom_flow" -eq 0 ]; then
    unity-cli run --log-name "${test_name}-Validate" -quit -executeMethod Utilities.Editor.BuildPipeline.UnityPlayerBuildTools.ValidateProject -importTMProEssentialsAsset || validate_rc=$?
    unity-cli run --log-name "${test_name}-Build" -buildTarget "$BUILD_TARGET" -quit -executeMethod Utilities.Editor.BuildPipeline.UnityPlayerBuildTools.StartCommandLineBuild -sceneList Assets/Scenes/SampleScene.unity "${build_args[@]}" || build_rc=$?
  fi

  expected=$(expected_status_for "$test_name")
  exp_msg=$(expected_message_for "$test_name")

  test_failed=0
  message_found=0
  utp_error_found=0

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

  # Look for error-level UTP entries for this test to treat as expected failure evidence.
  while IFS= read -r utp_file; do
    if [ -z "$utp_file" ]; then
      continue
    fi
    if grep -qi '"severity"[[:space:]]*:[[:space:]]*"\(Error\|Exception\|Assert\)"' "$utp_file" 2>/dev/null; then
      utp_error_found=1
      break
    fi
  done < <(find "$UNITY_PROJECT_PATH/Builds/Logs" -maxdepth 1 -type f -name "*${test_name}*-utp-json.log")

  if [ "$expected" -eq 0 ]; then
    if [ "$validate_rc" -ne 0 ] || [ "$build_rc" -ne 0 ]; then
      echo "::error::Test $test_name was expected to succeed but failed (validate_rc=$validate_rc, build_rc=$build_rc)"
      test_failed=1
    fi
    if [ "$utp_error_found" -eq 1 ]; then
      echo "::error::Test $test_name produced UTP errors but was expected to succeed"
      test_failed=1
    fi
    if [ -n "$exp_msg" ] && [ "$message_found" -eq 0 ]; then
      echo "::error::Test $test_name did not emit expected message '$exp_msg'"
      test_failed=1
    fi
  else
    if [ "$validate_rc" -ne 0 ] || [ "$build_rc" -ne 0 ] || [ "$message_found" -eq 1 ] || [ "$utp_error_found" -eq 1 ]; then
      : # Expected failure observed
    else
      echo "::error::Test $test_name was expected to fail but succeeded"
      test_failed=1
    fi

    # Only insist on the expected message if both invocations claimed success.
    if [ -n "$exp_msg" ] && [ "$message_found" -eq 0 ] && [ "$validate_rc" -eq 0 ] && [ "$build_rc" -eq 0 ]; then
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
  find "$GITHUB_WORKSPACE" -path "$test_artifacts" -prune -o -type f -name "*${test_name}*-utp-json.log" -print | while IFS= read -r utp_src; do
    [ -z "$utp_src" ] && continue
    dest_file="$test_artifacts/$(basename "$utp_src")"
    if [ ! -f "$dest_file" ]; then
      cp "$utp_src" "$dest_file" || true
    fi
  done || true

done

if [ "$failures" -gt 0 ]; then
  echo "::error::One or more tests did not meet expectations ($failures)"
  exit 1
fi

exit 0
