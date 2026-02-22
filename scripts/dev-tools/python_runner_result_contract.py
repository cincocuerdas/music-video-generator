#!/usr/bin/env python3
"""
Test helper for PythonRunnerService RESULT_JSON contract.

Usage:
  python scripts/dev-tools/python_runner_result_contract.py <scenario>

Scenarios:
  - latest_valid_wins
  - invalid_then_stdout_fallback
  - invalid_then_valid
"""

import json
import sys


def main():
    scenario = sys.argv[1] if len(sys.argv) > 1 else "latest_valid_wins"

    if scenario == "latest_valid_wins":
        print(json.dumps({"source": "stdout", "selected": "legacy"}))
        print("RESULT_JSON:{\"source\":\"explicit\",\"selected\":\"first\"}", file=sys.stderr)
        print("RESULT_JSON:{\"source\":\"explicit\",\"selected\":\"last\",\"value\":2}", file=sys.stderr)
        return

    if scenario == "invalid_then_stdout_fallback":
        print("RESULT_JSON:{invalid-json", file=sys.stderr)
        print(json.dumps({"source": "stdout", "selected": "fallback"}))
        return

    if scenario == "invalid_then_valid":
        print("RESULT_JSON:{invalid-json", file=sys.stderr)
        print("RESULT_JSON:{\"source\":\"explicit\",\"selected\":\"valid\"}", file=sys.stderr)
        print(json.dumps({"source": "stdout", "selected": "legacy"}))
        return

    print(json.dumps({"error": f"unknown scenario: {scenario}"}))
    sys.exit(1)


if __name__ == "__main__":
    main()
