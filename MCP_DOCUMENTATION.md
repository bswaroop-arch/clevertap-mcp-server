# CleverTap MCP Server — Full Documentation

Comprehensive capability reference for the `clevertap-mcp-server`. For setup/install see [README.md](./README.md). For CleverTap API field-level schemas see [../CleverTap-API-Reference/CleverTap_API_Reference.md](../CleverTap-API-Reference/CleverTap_API_Reference.md).

---

## Table of Contents
1. [What this MCP does](#1-what-this-mcp-does)
2. [Tool catalog (43 tools)](#2-tool-catalog)
3. [End-to-end workflows](#3-end-to-end-workflows)
4. [Personalization reference](#4-personalization-reference)
5. [Known limitations](#5-known-limitations)
6. [Endpoint → Tool map](#6-endpoint--tool-map)
7. [Official CleverTap references](#7-official-clevertap-references)

---

## 1. What this MCP does

Exposes **43 tools** across 8 capability groups wrapping the CleverTap REST API, with typed Zod schemas and local validation against an event-schema CSV loaded at startup.

| Group | Count | Purpose |
|---|---|---|
| Schema discovery | 3 | Browse tracked events/properties from local CSV |
| Campaign creation | 4 | Create / dry-run segment-targeted campaigns, including WhatsApp dashboard-style creation and OR-branch creation |
| Identity-based sends | 5 | Send Push/Email/SMS/WebPush/WhatsApp to specific users |
| Campaign management | 4 | List, report, stop, recreate (update) |
| Content builders | 6 | Typed validators for each channel's content object plus conversion goals |
| External triggers | 2 | Fire pre-built campaigns with per-user variables |
| Event data | 5 | Count, paginate, upload events |
| Profile data | 7 | Count, paginate, download, upload, tokens, subscribe |
| Reports & analytics | 4 | Real-time, message reports, trends, top properties |
| Remote Config | 3 | Create/delete/get Remote Config variables |

**Design notes**
- Channel `content` objects are typed via dedicated `build_*_content` tools so LLMs don't guess field names.
- Liquid / `replacements` / `ExternalTrigger` personalization paths are documented inline in tool descriptions.
- `create_campaign` validates the `where.event_name` and `event_properties` against the loaded CSV schema before hitting the API.

---

## 2. Tool catalog

### 2.1 Schema discovery (local, no API calls)

| Tool | Purpose | Key inputs |
|---|---|---|
| `list_events` | List tracked events from the schema CSV | `source?`, `status?`, `limit` |
| `search_events` | Keyword substring search on event names | `keyword`, `limit` |
| `get_event_properties` | Properties + types + required flags for one event | `event_name` |

### 2.2 Campaign creation (segment-targeted)

| Tool | Endpoint | Notes |
|---|---|---|
| `create_campaign` | `POST /1/targets/create.json` | Full segment-based campaign. Concurrent request limit 3. Supports `estimate_only`, `skip_estimate`. |
| `estimate_campaign_reach` | same | Convenience wrapper with `estimate_only: true`. |
| `create_whatsapp_campaign` | same | Dashboard-style WhatsApp wrapper for top-level segment, provider, template, personalized media URL, dynamic button URL variable, schedule, and conversion goal. |
| `create_campaign_union` | same | OR-of-conditions workaround that creates one campaign per where-branch. |
| `recreate_campaign` | stop + create | CleverTap has no update API — this stops the old campaign and creates a new one. Requires `confirm: true`. |

### 2.3 Identity-based sends (up to 1000 users/call)

| Tool | Endpoint | Required extras |
|---|---|---|
| `send_push_to_users` | `POST /1/send/push.json` | — |
| `send_email_to_users` | `POST /1/send/email.json` | `provider_nick_name` |
| `send_sms_to_users` | `POST /1/send/sms.json` | `provider_nick_name` |
| `send_webpush_to_users` | `POST /1/send/webpush.json` | — |
| `send_whatsapp_to_users` | `POST /1/send/whatsapp.json` | `provider_nick_name`, `message_id` (≤8 chars) |

### 2.4 Campaign management

| Tool | Endpoint | Notes |
|---|---|---|
| `list_segments` | `POST /1/segments/list.json` | **Undocumented endpoint** — observed to work; no public docs. |
| `list_campaigns` | `POST /1/targets/list.json` | By date range |
| `get_campaign_report` | `POST /1/targets/result.json` | Concurrent request limit 3 |
| `stop_campaign` | `POST /1/targets/stop.json` | Concurrent request limit 3 |

### 2.5 Content builders (validate + echo)

Use these to construct a typed `content` object before calling `create_campaign` or `send_*_to_users`.

| Tool | Channel | Key fields |
|---|---|---|
| `build_push_content` | Push | `title`, `body`, `wzrk_dl`, `large_icon`, `background_image`, `wzrk_cid`, `wzrk_bc`, `ttl`, `cta[]`, priorities, collapse IDs |
| `build_whatsapp_content` | WhatsApp | Flat `template_name`, `locale`, `header/body/buttons` with `replacements` arrays and header `media` |
| `build_email_content` | Email | `subject`, `sender_name`, `body` (HTML), `amp_body`, `reply_to`, `from_email`, `cc`, `bcc`, `pre_header` |
| `build_sms_content` | SMS | `body`, `unicode`, `sender_id`, `message_info.template_id / entity_id / pe_id` (India DLT) |
| `build_webpush_content` | Web Push | `title`, `body`. Browser overrides → campaign-level `platform_specific.chrome/safari/firefox` |
| `build_conversion_goal` | Conversion | `event_name`, `conversion_time`, optional `revenue_property`, optional `filter_type` |

### 2.6 External triggers (per-user personalization for pre-built campaigns)

| Tool | Endpoint | Notes |
|---|---|---|
| `trigger_external_campaign` | `POST /1/send/externaltrigger.json` | Single campaign; `ExternalTrigger` keys map to `{{ExternalTrigger.<key>}}` placeholders |
| `trigger_external_campaign_multi` | `POST /2/send/externaltrigger.json` | Up to 5 campaigns per call; requires `X-CleverTap-Token` |

### 2.7 Event data

| Tool | Endpoint | Purpose |
|---|---|---|
| `get_event_count` | `POST /1/counts/events.json` | Count occurrences with optional property filters |
| `poll_event_count` | `GET /1/counts/events.json?req_id=` | Poll async query |
| `get_events_cursor` | `POST /1/events.json` | Step 1: get pagination cursor |
| `get_events_page` | `GET /1/events.json?cursor=` | Step 2: fetch page |
| `upload_events` | `POST /1/upload` (type=event) | Bulk upload, max 1000/call, 15 concurrent |

### 2.8 Profile data

| Tool | Endpoint | Purpose |
|---|---|---|
| `get_profile_count` | `POST /1/counts/profiles.json` | Count profiles matching event+filters |
| `get_profiles_cursor` | `POST /1/profiles.json` | Step 1: cursor |
| `get_profiles_page` | `GET /1/profiles.json?cursor=` | Step 2: page |
| `download_profile` | `GET /1/profile.json` | Single profile by email/identity/objectId |
| `upload_profiles` | `POST /1/upload` (type=profile) | Bulk upsert, max 1000/call |
| `upload_device_tokens` | `POST /1/upload` (type=token) | FCM/APNS/Chrome/etc., max 100/call |
| `subscribe_unsubscribe` | `POST /1/subscribe` | Bulk subscribe/unsubscribe phone/email/whatsapp |

### 2.9 Reports & analytics

| Tool | Endpoint | Purpose |
|---|---|---|
| `get_realtime_counts` | `POST /1/now.json` | Active users last 5 min |
| `get_message_reports` | `POST /1/message/report.json` | Channel performance by date range |
| `get_trends` | `POST /1/counts/trends.json` | Event trends daily/weekly/monthly |
| `get_top_properties` | `POST /1/counts/top.json` | Top N values of a property |

### 2.10 Remote Config / Variables

| Tool | Endpoint |
|---|---|
| `create_variables` | `POST /1/createVars` |
| `delete_variables` | `POST /1/deleteVars` |
| `get_variables` | `POST /1/getVars` |

---

## 3. End-to-end workflows

### 3.1 Push campaign (segment-targeted)

```
1. search_events / get_event_properties    → validate event & property names
2. list_segments                            → pick segment ID
3. build_push_content                       → typed content w/ Liquid + deep link
4. estimate_campaign_reach                  → verify reach
5. create_campaign                          → returns campaign ID
6. get_campaign_report                      → monitor
7. stop_campaign | recreate_campaign        → adjust
```

### 3.2 WhatsApp campaign (segment-targeted)

```
1. list_segments                            → pick segment ID
2. create_whatsapp_campaign                 → template_name, locale, media URL, button URL variable, conversion goal
3. estimate_campaign_reach                  → optional reach check
4. get_campaign_report
```

### 3.3 Direct send (specific identities)

```
1. build_push_content | build_whatsapp_content | ...
2. send_push_to_users | send_whatsapp_to_users | ...
```

### 3.4 Per-user dynamic content (any channel)

```
1. Build a campaign in the CleverTap dashboard with
   {{ExternalTrigger.<key>}} placeholders.
2. trigger_external_campaign with a per-user ExternalTrigger map.
```

### 3.5 Data export

```
Events:   get_events_cursor  → get_events_page  (loop until empty)
Profiles: get_profiles_cursor → get_profiles_page (loop)
```

### 3.6 Data upload

```
upload_profiles        — upsert profile properties
upload_events          — record custom events
upload_device_tokens   — register FCM/APNS tokens
subscribe_unsubscribe  — bulk consent management
```

---

## 4. Personalization reference

Three mutually-exclusive mechanisms depending on channel and call site.

| Channel × Call site | Mechanism | Status |
|---|---|---|
| Push × `create_campaign` (segment) | Liquid `{{profile.*}}` / `{{event.*}}` | ⚠️ **Observed BLOCKED on this account (2026-04-24)** despite docs claiming support. Use External Trigger instead. |
| Push × `send_push_to_users` (identity) | — | Use `trigger_external_campaign` with dashboard-built campaign |
| WhatsApp × `create_campaign` / `send_whatsapp_to_users` | Template `replacements` arrays | ✅ `content.body.replacements: ["John","ORDER123"]` fills `{{1}}`, `{{2}}`; `content.buttons[].replacements` fills dynamic URL variables |
| Any × `trigger_external_campaign` | ExternalTrigger map | ✅ `ExternalTrigger: {"FirstName":"John"}` → `{{ExternalTrigger.FirstName}}` (string values only) |

**Recommended pattern for per-user Push personalization:**
1. Build campaign template in CleverTap dashboard with `{{ExternalTrigger.<key>}}` placeholders.
2. Fire via `trigger_external_campaign` with per-user variable map.

Details, examples, and support matrix: [../CleverTap-API-Reference/CleverTap_API_Reference.md#7-personalization](../CleverTap-API-Reference/CleverTap_API_Reference.md).

---

## 5. Known limitations

| Limitation | Reason | Workaround |
|---|---|---|
| **No image upload** | CleverTap exposes no image-upload API | Host on S3/CDN, pass URL; or upload via dashboard Media Library |
| **No campaign update** | CleverTap API-level limitation | `recreate_campaign` stops + creates |
| **No campaign content preview/render** | Not exposed | Test with `send_*_to_users` to a test identity |
| **WhatsApp template creation** | BSP-managed, not via CleverTap API | Register templates with your BSP; MCP only injects variables |
| **`list_segments` undocumented** | Public docs don't describe it | Works in practice; treat as best-effort |
| **`did_any` advanced query** | Not supported by the API | Use `did_all` / `did_not` combinations |
| **Missing endpoint groups** | Not yet implemented: Delete/Demerge/Disassociate Profile, Wallet/Coupon/Voucher (Promo Mgmt), Bulletins, Catalog, Custom List, Settings, Token Vault | Add on demand |

---

## 6. Endpoint → Tool map

| # | CleverTap endpoint | Tool(s) |
|---|---|---|
| 1 | `POST /1/upload` (type=event) | `upload_events` |
| 2 | `POST /1/upload` (type=profile) | `upload_profiles` |
| 3 | `POST /1/upload` (type=token) | `upload_device_tokens` |
| 4 | `POST /1/events.json` | `get_events_cursor` |
| 5 | `GET  /1/events.json?cursor=` | `get_events_page` |
| 6 | `POST /1/counts/events.json` | `get_event_count` |
| 7 | `GET  /1/counts/events.json?req_id=` | `poll_event_count` |
| 8 | `POST /1/profiles.json` | `get_profiles_cursor` |
| 9 | `GET  /1/profiles.json?cursor=` | `get_profiles_page` |
| 10 | `GET  /1/profile.json` | `download_profile` |
| 11 | `POST /1/counts/profiles.json` | `get_profile_count` |
| 12 | `POST /1/subscribe` | `subscribe_unsubscribe` |
| 13 | `POST /1/targets/create.json` | `create_campaign`, `estimate_campaign_reach`, `recreate_campaign` |
| 14 | `POST /1/send/push.json` | `send_push_to_users` |
| 15 | `POST /1/send/email.json` | `send_email_to_users` |
| 16 | `POST /1/send/sms.json` | `send_sms_to_users` |
| 17 | `POST /1/send/webpush.json` | `send_webpush_to_users` |
| 18 | `POST /1/send/whatsapp.json` | `send_whatsapp_to_users` |
| 19 | `POST /1/targets/list.json` | `list_campaigns` |
| 20 | `POST /1/targets/result.json` | `get_campaign_report` |
| 21 | `POST /1/targets/stop.json` | `stop_campaign`, `recreate_campaign` |
| 22 | `POST /1/segments/list.json` | `list_segments` (undocumented) |
| 23 | `POST /1/now.json` | `get_realtime_counts` |
| 24 | `POST /1/message/report.json` | `get_message_reports` |
| 25 | `POST /1/counts/trends.json` | `get_trends` |
| 26 | `POST /1/counts/top.json` | `get_top_properties` |
| 27 | `POST /1/createVars` | `create_variables` |
| 28 | `POST /1/deleteVars` | `delete_variables` |
| 29 | `POST /1/getVars` | `get_variables` |
| 30 | `POST /1/send/externaltrigger.json` | `trigger_external_campaign` |
| 31 | `POST /2/send/externaltrigger.json` | `trigger_external_campaign_multi` |

---

## 7. Official CleverTap references

| Topic | URL |
|---|---|
| API overview | https://developer.clevertap.com/docs/api-overview |
| API quickstart | https://developer.clevertap.com/docs/api-quickstart-guide |
| Common API components | https://developer.clevertap.com/docs/common-api-components |
| Create Campaign | https://developer.clevertap.com/docs/create-campaign-api |
| Campaign object schema | https://developer.clevertap.com/docs/campaign_object |
| Get Campaigns | https://developer.clevertap.com/docs/get-campaigns-api |
| Get Campaign Report | https://developer.clevertap.com/docs/get-campaign-report-api |
| Stop Campaign | https://developer.clevertap.com/docs/stop-campaign-api |
| Upload Events | https://developer.clevertap.com/docs/upload-events-api |
| Get Events | https://developer.clevertap.com/docs/get-events-api |
| Get Event Count | https://developer.clevertap.com/docs/get-event-count-api |
| Upload User Profiles | https://developer.clevertap.com/docs/upload-user-profiles-api |
| Get User Profiles | https://developer.clevertap.com/docs/get-user-profiles-api |
| Upload Device Tokens | https://developer.clevertap.com/docs/upload-device-tokens-api |
| Get Profile Count | https://developer.clevertap.com/docs/get-profile-count-api |
| Subscribe | https://developer.clevertap.com/docs/subscribe-api |
| Real-Time Counts | https://developer.clevertap.com/docs/real-time-counts-api |
| Message Reports | https://developer.clevertap.com/docs/get-message-reports-api |
| Top Property Counts | https://developer.clevertap.com/docs/top-property-counts-api |
| Trends | https://developer.clevertap.com/docs/trends-api |
| External Trigger | https://developer.clevertap.com/docs/external-trigger-api |
| Create Variables | https://developer.clevertap.com/docs/create-variables-api |
| Delete Variables | https://developer.clevertap.com/docs/delete-variables-api |
| Get Variables | https://developer.clevertap.com/docs/get-variables-api |

---

## Appendix: tool count by file

- `src/index.ts` registers **43 tools** via `register(...)`.
- Content builders and `recreate_campaign` are MCP-only helpers (no direct 1:1 CleverTap endpoint).
