#!/usr/bin/env python3
"""Report the container service's health through the management API.

`scripts/dsh-superagent status` inspects processes and tmux panes, which a container
does not have; this script keeps its exit codes (docs/006-deployment.md):

  0  the service runs normally
  1  it does not answer, or its runtime reports an error; a restart may fix it
  2  it answers, but a part other than the runtime reports an error
  3  it runs and waits for setup; a restart does not fix it

Run it inside the container:  docker compose exec superagent dsh-superagent-status
"""

import json
import os
import sys
import urllib.request

URL = os.environ.get('DSH_SUPERAGENT_URL', 'http://127.0.0.1:3082')
PART_ERROR = 2
SETUP_WAITS = 3


def state():
    request = urllib.request.Request(URL.rstrip('/') + '/orchestrator/api/state',
                                     headers={'x-orchestrator-request': '1'})
    with urllib.request.urlopen(request, timeout=5) as response:
        value = json.load(response)
    health, setup = value.get('health') or {}, value.get('setup') or {}
    entries = {name: entry if isinstance(entry, dict) else {} for name, entry in health.items()}
    return {
        'health': {name: entry.get('state') for name, entry in entries.items()},
        'errors': {name: str(entry.get('detail', '')) for name, entry in entries.items() if entry.get('state') == 'error'},
        'setup': setup.get('problem'),
        'feishu': setup.get('feishuProblem'),
    }


def main() -> int:
    try:
        current = state()
    except (OSError, ValueError):
        print(json.dumps({'url': URL, 'reachable': False}, ensure_ascii=False, indent=2))
        return 1
    problems = {name: detail for name, detail in sorted(current['errors'].items()) if name != 'runtime'}
    print(json.dumps({'url': URL, 'reachable': True, **current}, ensure_ascii=False, indent=2))
    if current['health'].get('runtime') not in ('ready', 'paused'):
        return 1
    if current['setup']:
        return SETUP_WAITS
    return PART_ERROR if problems else 0


if __name__ == '__main__':
    sys.exit(main())