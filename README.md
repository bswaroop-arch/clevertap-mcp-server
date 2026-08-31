# CleverTap MCP Server

An MCP (Model Context Protocol) server that exposes CleverTap as tools you can
call from Claude Desktop, Claude Code, or any MCP-compatible client.

It loads your **event schema CSV** at startup so campaign creation, filtering,
and data extraction are all aware of the exact events and properties tracked
in your CleverTap account.

---

## What it can do

| Category | Tools |
|---|---|
| **Schema discovery** | `list_events`, `search_events`, `get_event_properties` |
| **Campaign creation** | `create_campaign`, `create_whatsapp_campaign`, `estimate_campaign_reach`, `create_campaign_union` |
| **Campaign send (by identity)** | `send_push_to_users`, `send_email_to_users`, `send_sms_to_users`, `send_webpush_to_users`, `send_whatsapp_to_users` |
| **Campaign management** | `list_campaigns`, `get_campaign_report`, `stop_campaign`, `recreate_campaign` |
| **External triggers** | `trigger_external_campaign`, `trigger_external_campaign_multi` |
| **Event data extraction** | `get_event_count`, `poll_event_count`, `get_events_cursor`, `get_events_page`, `upload_events` |
| **Profile data extraction** | `get_profile_count`, `get_profiles_cursor`, `get_profiles_page`, `download_profile`, `upload_profiles`, `upload_device_tokens`, `subscribe_unsubscribe` |
| **Reports & analytics** | `get_realtime_counts`, `get_message_reports`, `get_trends`, `get_top_properties` |
| **Remote Config / Variables** | `create_variables`, `delete_variables`, `get_variables` |

---

## Setup

### 1. Install Node 18+

```bash
brew install node            # macOS
# or: https://nodejs.org
```

### 2. Install dependencies

```bash
cd /Users/saiswaroop/Desktop/clevertap-mcp-server
npm install
npm run build
```

### 3. Create your `.env`

```bash
cp .env.example .env
```

Then edit `.env` with your credentials:

- `CLEVERTAP_ACCOUNT_ID` — from **Settings → Project** in the CleverTap dashboard
- `CLEVERTAP_PASSCODE` — same page
- `CLEVERTAP_REGION` — your region prefix: `in1` (India), `eu1` (Europe),
  `us1` (US), `sg1` (Singapore), `sk1` (Indonesia), `aps3` (Mumbai),
  `mec1` (Middle East)
- `CLEVERTAP_EVENTS_SCHEMA_CSV` — absolute path to the schema CSV
- `CLEVERTAP_TOKEN` — only needed for the v2 multi-campaign external trigger
- `CLEVERTAP_TIMEOUT_MS` — optional per-request timeout (default 30000ms)

### 4. Test the server

```bash
node --env-file=.env dist/index.js
```

You should see:

```
[clevertap-mcp] loaded 653 events (N system, N custom) with X properties. Region=in1
[clevertap-mcp] server ready on stdio
```

Ctrl-C to exit.

---

## Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clevertap": {
      "command": "node",
      "args": [
        "--env-file=/Users/saiswaroop/Desktop/clevertap-mcp-server/.env",
        "/Users/saiswaroop/Desktop/clevertap-mcp-server/dist/index.js"
      ]
    }
  }
}
```

Restart Claude Desktop. The CleverTap tools will appear.

---

## Wire into Claude Code

```bash
claude mcp add clevertap \
  -- node --env-file=/Users/saiswaroop/Desktop/clevertap-mcp-server/.env \
          /Users/saiswaroop/Desktop/clevertap-mcp-server/dist/index.js
```

Then `/mcp` inside Claude Code will show it connected.

---

## Example prompts (once connected)

> Show me the properties tracked on the `product_view` event.

> List all custom events whose name contains "cart".

> Create a push campaign named "Cart abandonment reminder" for users who
> performed `Added to Cart` in the last 7 days but not `Charged`. Title:
> "Forgot something?", body: "Your glasses are waiting." Schedule for tomorrow
> 10:00 AM user time. Estimate reach only.

> Create a WhatsApp campaign named `in_wa_Hustlr_club_26Apr_14` for segment
> `1777101181` using provider `Karix_WA_promo`, template `hustlr_2404_14`,
> personalized media URL `https://...jpeg`, button URL variable `collection/...`,
> and conversion goal `Charged` in `5D` with revenue property `Amount`.

> How many `product_view` events happened between April 1 and April 22 where
> `product_category` equals "sunglasses"?

> Pull a cursor for all users who triggered `loginLenskart` this month and
> give me the first page.

> Get the campaign report for campaign ID 1712345678.

---

## Notes on schema-aware validation

When you call `create_campaign` or `get_event_count` with an `event_name` that
exists in your CSV, the server validates that every property filter references
a known property. If you use a property that isn't on that event, it throws
a helpful error listing the known properties.

To refresh after CleverTap tracks a new event, just replace the CSV and
restart the server.

---

## Project layout

```
clevertap-mcp-server/
├── src/
│   ├── index.ts     # MCP server + tool registry
│   ├── client.ts    # Thin CleverTap HTTP client
│   └── schema.ts    # CSV → events/properties index
├── scripts/
│   └── parse_schema.py   # (optional) dump CSV to JSON for inspection
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```
