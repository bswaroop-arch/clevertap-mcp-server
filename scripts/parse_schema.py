"""
One-time script: parse the events schema CSV into a compact JSON.

Input  : path from $CLEVERTAP_EVENTS_SCHEMA_CSV env var, or first CLI arg.
Output : data/events_schema.json

Structure of output:
{
  "events": {
    "<event_name>": {
      "type": "Defined|Undefined",
      "source": "System|Custom",
      "status": "Active|Inactive",
      "total_datapoints": <int>,
      "created_on": "<date>",
      "properties": [
        {
          "name": "<prop_name>",
          "type": "Defined|Undefined",
          "status": "Active|Inactive",
          "required": true|false,
          "data_type": "<type>",
          "data_type_fallback": "<fallback>"
        },
        ...
      ]
    }
  },
  "meta": {
    "total_events": <int>,
    "total_properties": <int>,
    "system_events": <int>,
    "custom_events": <int>
  }
}
"""
import csv
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

OUT_PATH = Path(__file__).parent.parent / "data" / "events_schema.json"


def _resolve_csv_path() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1]).expanduser()
    env = os.environ.get("CLEVERTAP_EVENTS_SCHEMA_CSV")
    if env:
        return Path(env).expanduser()
    sys.exit(
        "error: pass CSV path as first arg or set CLEVERTAP_EVENTS_SCHEMA_CSV"
    )


def parse():
    csv_path = _resolve_csv_path()
    if not csv_path.exists():
        sys.exit(f"error: CSV not found at {csv_path}")

    events = {}
    seen_props = defaultdict(set)

    with csv_path.open(newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        # Column layout (17 cols):
        # 0 Event name | 1 Type | 2 System/Custom | 3 Status | 4 DRP
        # 5 This month | 6 Last month | 7 Data points | 8 Created on
        # 9 Property name | 10 Prop Type | 11 Prop Status | 12 Required
        # 13 Data type | 14 Data type fallback | 15 Prop Data points
        # 16 Prop Created on
        for row in reader:
            if len(row) < 17:
                continue
            ev_name = row[0].strip()
            if not ev_name:
                continue

            if ev_name not in events:
                events[ev_name] = {
                    "type": row[1].strip(),
                    "source": row[2].strip(),
                    "status": row[3].strip(),
                    "total_datapoints": _to_int(row[7]),
                    "created_on": row[8].strip(),
                    "properties": [],
                }

            prop_name = row[9].strip()
            if prop_name and prop_name not in seen_props[ev_name]:
                seen_props[ev_name].add(prop_name)
                events[ev_name]["properties"].append(
                    {
                        "name": prop_name,
                        "type": row[10].strip(),
                        "status": row[11].strip(),
                        "required": row[12].strip().lower() == "yes",
                        "data_type": row[13].strip(),
                        "data_type_fallback": row[14].strip(),
                    }
                )

    total_props = sum(len(ev["properties"]) for ev in events.values())
    system = sum(1 for ev in events.values() if ev["source"] == "System")
    custom = sum(1 for ev in events.values() if ev["source"] == "Custom")

    payload = {
        "events": events,
        "meta": {
            "total_events": len(events),
            "total_properties": total_props,
            "system_events": system,
            "custom_events": custom,
        },
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2))
    print(f"Wrote {OUT_PATH}")
    print(f"  Events        : {len(events)}")
    print(f"  Properties    : {total_props}")
    print(f"  System events : {system}")
    print(f"  Custom events : {custom}")


def _to_int(v):
    try:
        return int(v.strip())
    except (ValueError, AttributeError):
        return 0


if __name__ == "__main__":
    parse()
