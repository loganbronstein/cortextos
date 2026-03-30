#!/usr/bin/env bash
# hello_world.test.sh — basic test structure demo
# Task: task_1774833471_560
# Agent: Spark (worker)

PASS=0
FAIL=0

assert_equals() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $desc"
    ((PASS++))
  else
    echo "  FAIL: $desc"
    echo "        expected: '$expected'"
    echo "        actual:   '$actual'"
    ((FAIL++))
  fi
}

echo "=== Hello World Test Suite ==="
echo ""

echo "Test 1: greeting output"
result=$(echo "Hello, World!")
assert_equals "echo produces correct greeting" "Hello, World!" "$result"

echo ""
echo "Test 2: string operations"
name="cortextOS"
greeting="Hello, $name!"
assert_equals "string interpolation works" "Hello, cortextOS!" "$greeting"

echo ""
echo "Test 3: basic arithmetic"
sum=$((2 + 2))
assert_equals "2 + 2 = 4" "4" "$sum"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
