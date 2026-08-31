# CleverTap MCP Server — Rules & Validations

---

## Connection & Transport

| Rule | Detail |
|---|---|
| Protocol | stdio MCP |
| Server name/version | Pulled from `package.json` at runtime |
| Base URL | `https://{CLEVERTAP_REGION}.api.clevertap.com` |
| Required headers on every request | `X-CleverTap-Account-Id`, `X-CleverTap-Passcode`, `Content-Type: application/json; charset=utf-8` |
| Request timeout | 30 seconds default (configurable via `CLEVERTAP_TIMEOUT_MS`). Hung calls are aborted cleanly. |
| HTTP 200 with `status:"fail"` | Treated as a real error and surfaced to Claude |
| Non-2xx responses | Throw with method / path / status / body |
| v2 External Trigger | Refuses to run without `CLEVERTAP_TOKEN` |

---

## Environment Variables

### Required (server exits immediately if missing)

| Variable | Description |
|---|---|
| `CLEVERTAP_ACCOUNT_ID` | Your CleverTap Account ID |
| `CLEVERTAP_PASSCODE` | Your CleverTap Passcode |
| `CLEVERTAP_EVENTS_SCHEMA_CSV` | Absolute path to the exported events schema CSV |

### Optional

| Variable | Default | Description |
|---|---|---|
| `CLEVERTAP_REGION` | `in1` | Region: `in1`, `eu1`, `us1`, `sg1`, `sk1`, `aps3`, `mec1` |
| `CLEVERTAP_TOKEN` | — | Required only for v2 multi-campaign external trigger |
| `CLEVERTAP_TIMEOUT_MS` | `30000` | Per-request timeout in milliseconds |

---

## Schema-Aware Validation (CSV-Driven)

The server loads your events schema CSV at startup and uses it to validate requests.

| Scenario | Behaviour |
|---|---|
| `create_campaign` with known `where.event_name` | Every `event_properties[].name` must exist on that event — throws with allowed list if not |
| `create_campaign` with unknown `where.event_name` | Proceeds with a warning |
| `get_event_count` | Same property-filter validation against CSV |
| `upload_events` with unknown property keys | stderr warning only — not rejected (CleverTap accepts them) |
| Event lookup | Exact match first, then case-insensitive fallback |

---

## Per-Tool Input Rules

### Campaign Create (`create_campaign`, `estimate_campaign_reach`)

| Rule | Detail |
|---|---|
| `target_mode` | Must be one of: `Push`, `email`, `sms`, `webpush`, `whatsapp`, `webhook`, `notificationinbox` |
| `provider_nick_name` | **Required** when `target_mode` is `email`, `sms`, or `whatsapp` |
| `upper_cap_for_target_segment` | Minimum 100 |
| `users_limit_overall` | Minimum 100 |
| `when` | Either the string `"now"` or an object with `type ∈ {now, later, recurring}` |
| `repeat_on_days_of_week` | Values must be 1–7 (1 = Sunday, 7 = Saturday) |

### WhatsApp Campaign Create (`create_whatsapp_campaign`)

| Rule | Detail |
|---|---|
| `template_name` | Exact approved WhatsApp template name; the MCP does not list or create templates |
| `provider_nick_name` | Exact CleverTap WhatsApp service provider nickname |
| `segment_id` | Maps to top-level `segment` in the Create Campaign API; do not send `where` for saved segments |
| `personalized_media_url` | Maps to dashboard Personalized media; pass a public URL or CleverTap-accepted personalization expression |
| `button_url_variable` | Maps to the dashboard Add URL Variable field and is sent as `content.buttons[0].replacements[0]` |
| `conversion_event` + `conversion_time` | Both are required when using conversion shortcut fields; alternatively pass full `conversion_goal`. Shortcut goals include `filter_type: {}` because CleverTap requires the key. |
| `conversion_time` | Supports `30m`, `1H`, `2H`, `4H`, `6H`, `8H`, `12H`, `1D`, `2D`, `3D`, `5D`, `1W`, `2W`, `1M`, `2M`, `5M` |

### Identity Sends (`send_{push,email,sms,webpush,whatsapp}_to_users`)

| Rule | Detail |
|---|---|
| `to` | At least one of `Identity / Email / FBID / GPID / objectId` must be non-empty |
| `provider_nick_name` | **Required** for `email`, `sms`, `whatsapp` |
| `message_id` | **Required** for `whatsapp` — max 8 characters |
| Max users | 1000 per call (enforced by CleverTap) |

### External Triggers

| Rule | Detail |
|---|---|
| `to` | At least one of `email / identity / objectId` must be non-empty |
| `trigger_external_campaign_multi` | `campaign_id_list` length 1–5, requires `CLEVERTAP_TOKEN` |

### Event Data Extraction

| Tool | Rule |
|---|---|
| `get_events_cursor` | `batch_size` 1–5000, default 1000 |
| `get_profiles_cursor` | `batch_size` 23–5000, **must be a multiple of 23**, default 1012 |
| `upload_events` | 1–1000 records per call; each needs `evtName` + `evtData` + one identity field |
| `upload_profiles` | 1–1000 records per call |
| `upload_device_tokens` | 1–100 per call; `type` must be one of `fcm`, `gcm`, `apns`, `wns`, `mpns`, `chrome` |
| `subscribe_unsubscribe` | 1–1000 per call; `type ∈ {phone, email, whatsapp}`; `status ∈ {Unsubscribe, Resubscribe}` |
| `download_profile` | Exactly one of `email`, `identity`, or `objectId` must be provided |

### Reports & Analytics

| Tool | Rule |
|---|---|
| `get_message_reports` | `channel`, `delivery`, `status`, `message_type` constrained to documented enums |
| `get_trends` | `trend_type ∈ {daily, weekly, monthly}` |
| `get_top_properties` | `property_type` must be one of 8 values: `event_properties`, `profile_fields`, `session_properties`, `app_fields`, `demographics`, `technographics`, `reachability`, `geo_fields` |

### Remote Config

| Tool | Rule |
|---|---|
| `create_variables` | `type` must be one of `string`, `boolean`, `number` |
| `get_variables` | Requires `identity` or `clevertapId` |

---

## Date Format Rules

| Format | Used by |
|---|---|
| `YYYYMMDD` integer (e.g. `20260423`) | All tools except `get_message_reports` |
| `YYYYMMDD` string (e.g. `"20260423"`) | `get_message_reports` only (per API spec) |

---

## Error Handling

All tool-call failures return a structured MCP error response:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "<error message>" }]
}
```

This ensures Claude surfaces a readable message instead of crashing.

---

## Multiple-of-23 Rule (Plain English)

When downloading a large list of user profiles, CleverTap sends them in pages.
The page size (`batch_size`) must divide evenly by 23 — because of how CleverTap
stores data internally.

**Valid examples:** 23, 46, 230, 989, 1012, 2300, 4991  
**Invalid examples:** 100, 500, 1000, 2000 (do not divide evenly by 23)  
**Default used:** 1012 (= 23 × 44)  
**Maximum valid:** 4991 (= 23 × 217)
