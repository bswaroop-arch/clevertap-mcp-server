import fs from "node:fs";
import { parse } from "csv-parse/sync";

export interface EventProperty {
  name: string;
  type: string;
  status: string;
  required: boolean;
  data_type: string;
  data_type_fallback: string;
}

export interface EventDefinition {
  name: string;
  type: string;
  source: "System" | "Custom" | string;
  status: string;
  total_datapoints: number;
  created_on: string;
  properties: EventProperty[];
}

export interface SchemaIndex {
  events: Map<string, EventDefinition>;
  meta: {
    total_events: number;
    total_properties: number;
    system_events: number;
    custom_events: number;
  };
}

export function loadSchema(csvPath: string): SchemaIndex {
  if (!fs.existsSync(csvPath)) {
    throw new Error(
      `Event schema CSV not found at: ${csvPath}. ` +
        `Set CLEVERTAP_EVENTS_SCHEMA_CSV in your env.`,
    );
  }

  const raw = fs.readFileSync(csvPath, "utf-8");
  const rows: string[][] = parse(raw, {
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });

  // Expected column layout (17 columns):
  // 0  Event name
  // 1  Type
  // 2  System/Custom
  // 3  Status
  // 4  DRP
  // 5  This month
  // 6  Last month
  // 7  Data points
  // 8  Created on
  // 9  Property name
  // 10 Property Type
  // 11 Property Status
  // 12 Required
  // 13 Data type
  // 14 Data type fallback
  // 15 Property data points
  // 16 Property created on

  const events = new Map<string, EventDefinition>();
  const seenProps = new Map<string, Set<string>>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 15) continue;
    const evName = (row[0] ?? "").trim();
    if (!evName) continue;

    if (!events.has(evName)) {
      events.set(evName, {
        name: evName,
        type: (row[1] ?? "").trim(),
        source: (row[2] ?? "").trim() as "System" | "Custom",
        status: (row[3] ?? "").trim(),
        total_datapoints: toInt(row[7]),
        created_on: (row[8] ?? "").trim(),
        properties: [],
      });
      seenProps.set(evName, new Set());
    }

    const propName = (row[9] ?? "").trim();
    if (!propName) continue;
    const bucket = seenProps.get(evName)!;
    if (bucket.has(propName)) continue;
    bucket.add(propName);

    events.get(evName)!.properties.push({
      name: propName,
      type: (row[10] ?? "").trim(),
      status: (row[11] ?? "").trim(),
      required: (row[12] ?? "").trim().toLowerCase() === "yes",
      data_type: (row[13] ?? "").trim(),
      data_type_fallback: (row[14] ?? "").trim(),
    });
  }

  let totalProps = 0;
  let systemEvents = 0;
  let customEvents = 0;
  for (const ev of events.values()) {
    totalProps += ev.properties.length;
    if (ev.source === "System") systemEvents++;
    else if (ev.source === "Custom") customEvents++;
  }

  return {
    events,
    meta: {
      total_events: events.size,
      total_properties: totalProps,
      system_events: systemEvents,
      custom_events: customEvents,
    },
  };
}

function toInt(v: unknown): number {
  if (typeof v !== "string") return 0;
  const n = parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export function findEvent(
  schema: SchemaIndex,
  name: string,
): EventDefinition | undefined {
  // Exact match first, then case-insensitive fallback.
  const direct = schema.events.get(name);
  if (direct) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of schema.events) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function searchEvents(
  schema: SchemaIndex,
  keyword: string,
  limit = 50,
): EventDefinition[] {
  const q = keyword.toLowerCase();
  const hits: EventDefinition[] = [];
  for (const ev of schema.events.values()) {
    if (ev.name.toLowerCase().includes(q)) {
      hits.push(ev);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
