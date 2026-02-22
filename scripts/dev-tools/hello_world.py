#!/usr/bin/env python3
"""
Test script to verify PythonRunnerService is working correctly.
Usage: python hello_world.py '{"name": "Test"}'
"""

import sys
import json


def main():
    # Parse input arguments
    if len(sys.argv) > 1:
        try:
            args = json.loads(sys.argv[1])
        except json.JSONDecodeError:
            args = {}
    else:
        args = {}

    name = args.get("name", "World")

    # Return JSON result
    result = {
        "success": True,
        "message": f"Hello, {name}!",
        "received_args": args
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
