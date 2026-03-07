#!/usr/bin/env python3
"""
Test helper for PythonRunnerService bounded stdout/stderr buffering.

Usage:
  python scripts/dev-tools/python_runner_buffer_contract.py <scenario>

Scenarios:
  - huge_stdout_raw
  - huge_stdout_then_result_json
"""

import json
import sys


def main():
    scenario = sys.argv[1] if len(sys.argv) > 1 else "huge_stdout_raw"
    payload = "0123456789" * 400

    if scenario == "huge_stdout_raw":
        for idx in range(20):
            print(f"log-{idx}:{payload}")
        return

    if scenario == "huge_stdout_then_result_json":
        for idx in range(10):
            print(f"prelude-{idx}:{payload}")
        print('RESULT_JSON:{"source":"explicit","selected":"buffer-safe"}', file=sys.stderr)
        return

    print(json.dumps({"error": f"unknown scenario: {scenario}"}))
    sys.exit(1)


if __name__ == "__main__":
    main()
