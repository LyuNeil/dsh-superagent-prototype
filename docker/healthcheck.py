#!/usr/bin/env python3
"""Container health check: the management API answers and the runtime is ready or paused.

Mirrors the first half of `scripts/dsh-superagent status` (see docs/006-deployment.md):
exit 0 when the runtime is `ready` or `paused`, exit 1 otherwise. A source or policy
sync that reports an error does not fail the check; setup problems are reported by the
status script and the panel, not by the orchestrator.
"""

import json
import os
import sys
import urllib.request

URL = os.environ.get('DSH_SUPERAGENT_URL', 'http://127.0.0.1:3082')


def main() -> int:
    request = urllib.request.Request(URL.rstrip('/') + '/orchestrator/api/state',
                                     headers={'x-orchestrator-request': '1'})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            value = json.load(response)
    except (OSError, ValueError):
        return 1
    health = value.get('health') or {}
    runtime = health.get('runtime') or {}
    state = runtime.get('state') if isinstance(runtime, dict) else None
    if state not in ('ready', 'paused'):
        print(f'runtime is {state!r}: {runtime.get("detail", "") if isinstance(runtime, dict) else ""}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())