#!/usr/bin/env python3
"""
Apply a JSON patch to an existing Sentry dashboard.

Usage: ./sentry/patch-dashboard.py <dashboard_id> <patch.json>

The patch.json file describes EITHER:
  - { "title": "...", "widgets": [...] }   — full replacement (DESTRUCTIVE: overwrites all widgets)
  - { "ops": [ {"op":"replace", "widgetId":"...", "value":{...}}, ... ] }  — surgical edits

Surgical op kinds:
  - { "op": "replace",         "widgetId": "<id>", "value": { ...partial widget update... } }
  - { "op": "patch_query",     "widgetId": "<id>", "queryId": "<id>" | "*", "value": { ...partial query update... } }
  - { "op": "set_description", "widgetId": "<id>", "value": "<description text>" }

Server-only fields (dateCreated, dashboardId, datasetSource, etc.) are stripped
from the live dashboard before PUT, per the spec §15h.
"""

import json
import subprocess

# Keychain item holding the Sentry API token. `sentry-api-token` was the
# original name and no longer exists on current machines.
_KEYCHAIN_ITEM = "sentry-api-token-playground"
import sys
import urllib.error
import urllib.request

SERVER_FIELDS_WIDGET = {
    "dateCreated", "dashboardId", "datasetSource", "changedReason", "axisRange", "legendType"
}
SERVER_FIELDS_QUERY = {"widgetId", "onDemand", "isHidden", "linkedDashboards"}


def get_token() -> str:
    return subprocess.check_output(
        ["security", "find-generic-password", "-s", _KEYCHAIN_ITEM, "-w"]
    ).decode().strip()


def fetch_dashboard(dashboard_id: str, token: str) -> dict:
    req = urllib.request.Request(
        f"https://de.sentry.io/api/0/organizations/paritytech/dashboards/{dashboard_id}/",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def strip_server_fields(dash: dict) -> dict:
    for w in dash.get("widgets", []):
        for k in list(w.keys()):
            if k in SERVER_FIELDS_WIDGET:
                w.pop(k, None)
        for q in w.get("queries", []):
            for k in list(q.keys()):
                if k in SERVER_FIELDS_QUERY:
                    q.pop(k, None)
    return dash


def apply_ops(widgets: list, ops: list) -> list:
    by_id = {w.get("id"): w for w in widgets if "id" in w}
    for op in ops:
        kind = op["op"]
        if kind == "replace":
            target = by_id[op["widgetId"]]
            target.update(op["value"])
        elif kind == "patch_query":
            target = by_id[op["widgetId"]]
            for q in target.get("queries", []):
                if q.get("id") == op.get("queryId") or op.get("queryId") == "*":
                    q.update(op["value"])
        elif kind == "set_description":
            target = by_id[op["widgetId"]]
            target["description"] = op["value"]
        else:
            raise ValueError(f"Unknown op: {kind}")
    return widgets


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    dashboard_id, patch_path = sys.argv[1], sys.argv[2]
    token = get_token()
    dash = strip_server_fields(fetch_dashboard(dashboard_id, token))

    with open(patch_path) as f:
        patch = json.load(f)

    if "widgets" in patch:
        # Full-replacement mode (mind the destructive PUT — the caller is responsible)
        payload = {"title": patch.get("title", dash["title"]), "widgets": patch["widgets"]}
    elif "ops" in patch:
        widgets = apply_ops(dash["widgets"], patch["ops"])
        payload = {"title": patch.get("title", dash["title"]), "widgets": widgets}
    else:
        raise ValueError("patch.json must contain either 'widgets' or 'ops'")

    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"https://de.sentry.io/api/0/organizations/paritytech/dashboards/{dashboard_id}/",
        data=body, method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"✔ {resp.status} dashboard {dashboard_id} updated")
    except urllib.error.HTTPError as e:
        print(f"✖ {e.code}: {e.read().decode()}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
