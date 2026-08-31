#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CleverTapClient } from "./client.js";
import {
  EventDefinition,
  findEvent,
  loadSchema,
  searchEvents,
  SchemaIndex,
} from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
) as { name: string; version: string };

// ---------- Config from env ----------

const cfg = {
  accountId: must("CLEVERTAP_ACCOUNT_ID"),
  passcode: must("CLEVERTAP_PASSCODE"),
  region: process.env.CLEVERTAP_REGION || "in1",
  token: process.env.CLEVERTAP_TOKEN,
  timeoutMs: parseIntEnv("CLEVERTAP_TIMEOUT_MS", 30_000),
};
const csvPath = must("CLEVERTAP_EVENTS_SCHEMA_CSV");

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(
      `[clevertap-mcp] invalid ${name}=${raw}, using default ${fallback}`,
    );
    return fallback;
  }
  return n;
}

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[clevertap-mcp] missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}


const schema: SchemaIndex = loadSchema(csvPath);
const client = new CleverTapClient(cfg);

console.error(
  `[clevertap-mcp] loaded ${schema.meta.total_events} events ` +
    `(${schema.meta.system_events} system, ${schema.meta.custom_events} custom) ` +
    `with ${schema.meta.total_properties} properties. Region=${cfg.region}`,
);

// ---------- Tool schemas (zod) ----------

const dateInt = z
  .number()
  .int()
  .describe("Date in YYYYMMDD integer format, e.g. 20260101");

const EventPropertyFilter = z.object({
  name: z.string().describe("Property name (must exist on the event)"),
  operator: z
    .string()
    .describe(
      "Comparison operator: equals, not_equals, contains, not_contains, " +
        "greater_than, less_than, greater_than_or_equal, less_than_or_equal, between",
    ),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.any())])
    .describe("Value to compare against"),
});

const AdvancedQueryEvent = z.object({
  event_name: z.string(),
  from: dateInt.optional(),
  to: dateInt.optional(),
  operator: z.string().optional().describe("e.g. greater_than_equals, equals"),
  value: z.number().optional(),
  event_properties: z.array(EventPropertyFilter).optional().describe("Property filters on this event (e.g. product_id=246301)"),
});

const DidAnyQuery = z.object({
  any_events: z.array(AdvancedQueryEvent).describe(
    "List of event conditions to OR together. Users matching ANY one of these qualify.",
  ),
  operator: z.string().optional().describe("Count threshold operator, e.g. greater_than_equals"),
  value: z.number().optional().describe("Count threshold value, e.g. 1"),
});

const Technographic = z.object({
  name: z.string().describe('Property name, e.g. "Device"'),
  value: z.union([z.string(), z.array(z.string())]).describe(
    'Single value or list, e.g. "Mobile" or ["Mobile","Tablet","TV"]',
  ),
});

const Where = z.object({
  event_name: z.string().optional(),
  from: dateInt.optional(),
  to: dateInt.optional(),
  profile_fields: z.array(EventPropertyFilter).optional(),
  event_properties: z.array(EventPropertyFilter).optional(),
  segment: z.number().int().optional(),
  common_profile_properties: z.object({
    technographics: z.array(Technographic).optional().describe(
      'Device/platform filters. e.g. [{"name":"Device","value":["Mobile","Tablet","TV"]}]',
    ),
    profile_fields: z.array(EventPropertyFilter).optional().describe(
      "User profile property filters, e.g. [{name:'City', operator:'equals', value:'Mumbai'}]",
    ),
  }).catchall(z.any()).optional(),
  advanced_query: z.object({
    did_all: z.array(AdvancedQueryEvent).optional().describe(
      "Users who DID all these events. Supports operator/value for count thresholds and event_properties for property filters.",
    ),
    did_none: z.array(AdvancedQueryEvent).optional().describe(
      "Users who did NONE of these events — exclusion targeting. NOTE: use did_none, NOT did_not (did_not is silently ignored by CleverTap API).",
    ),
    did_any: DidAnyQuery.optional().describe(
      "OR logic — users who did ANY ONE of these events. Use any_events array with operator/value. e.g. Charged >₹2999 OR Charged with brand=Fossil.",
    ),
  }).optional().describe(
    "Advanced behavioral targeting. did_all=include (AND), did_none=exclude, did_any=OR between events.",
  ),
  prompt: z.string().optional().describe(
    "Natural language segment description. CleverTap parses this into CQL automatically and returns the parsed query alongside the estimate. " +
    "Cannot be combined with other where fields. Good for exploration — review the returned cql before using in production. " +
    "Does NOT support custom profile properties (e.g. wa_optout_stop). Use for event-based and device-type filters only.",
  ),
});

const When = z
  .union([
    z.string().describe('Use "now" for immediate, or "YYYYMMDD HH:MM" for scheduled (e.g. "20260430 22:00")'),
    z.object({
      type: z.enum(["now", "later", "recurring"]),
      delivery_date_time: z
        .string()
        .optional()
        .describe('Format "YYYYMMDD HH:MM" (for type=later)'),
      delivery_timezone: z.enum(["user", "account"]).optional(),
      user_timezone_wrap_around: z.boolean().optional(),
      campaign_cutoff: z.string().optional(),
      repeats_every: z.number().int().optional(),
      repeat_type: z.enum(["day", "week"]).optional(),
      start_time: z.string().optional(),
      repeat_on_days_of_week: z.array(z.number().int().min(1).max(7)).optional(),
      end_by_date: z.string().optional(),
      end_by_occurrences: z.number().int().optional(),
    }),
  ])
  .describe('Either the literal string "now" or a scheduling object');

const ConversionTime = z.enum([
  "30m",
  "1H",
  "2H",
  "4H",
  "6H",
  "8H",
  "12H",
  "1D",
  "2D",
  "3D",
  "5D",
  "1W",
  "2W",
  "1M",
  "2M",
  "5M",
]);

const ConversionGoal = z.object({
  event_name: z.string().describe("Event that counts as a conversion"),
  conversion_time: ConversionTime.describe("Attribution window after delivery"),
  revenue_property: z
    .string()
    .optional()
    .describe("Numeric event property used to sum revenue (optional)"),
  filter_type: z
    .record(z.any())
    .optional()
    .describe("Optional CleverTap conversion filter_type object for event-property/time filters."),
}).passthrough();

const Dnd = z.object({
  message_state: z.enum(["delay", "discard"]),
  dnd_timezone: z.enum(["user_timezone", "account_timezone"]),
  dnd_info: z
    .record(z.array(z.object({ from: z.string(), to: z.string() })))
    .describe('Day-indexed (1=Sun..7=Sat) time ranges, e.g. {"1":[{"from":"22:00","to":"08:00"}]}'),
});

const PushContent = z
  .object({
    title: z.string().describe("Notification title. Liquid tokens OBSERVED BLOCKED on this account — use static text, or use trigger_external_campaign for per-user dynamic content."),
    body: z.string().describe("Notification body. Liquid tokens OBSERVED BLOCKED on this account — use static text, or use trigger_external_campaign for per-user dynamic content."),
    wzrk_dl: z
      .string()
      .optional()
      .describe("Deep link URL opened on notification tap (Android + iOS)"),
    wzrk_cid: z.string().optional().describe("Android O+ notification channel ID"),
    wzrk_bc: z.number().int().optional().describe("Android badge count"),
    large_icon: z.string().url().optional().describe("Large icon URL (publicly hosted image)"),
    background_image: z
      .string()
      .url()
      .optional()
      .describe("Rich push banner image URL (publicly hosted)"),
    enable_rendermax: z.boolean().optional(),
    notification_tray_priority: z.enum(["max", "high", "default"]).optional(),
    delivery_priority: z.enum(["normal", "high"]).optional(),
    android_collapse: z.union([z.string(), z.number()]).optional(),
    ios_collapse: z.union([z.string(), z.number()]).optional(),
    ios_deeplink: z.string().optional(),
    ttl: z
      .object({
        ttl_type: z.enum(["seconds", "minutes", "hours", "days"]),
        value: z.number().int().min(1),
      })
      .optional(),
    sound: z.string().optional().describe("Sound file name (iOS/Android)"),
    cta: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          action_type: z.enum(["deeplink", "url", "dismiss"]).optional(),
          action: z.string().optional(),
        }),
      )
      .max(3)
      .optional()
      .describe("Up to 3 action buttons"),
  })
  .passthrough();

const WhatsAppButton = z.object({
  type: z.enum(["url", "quick_reply", "call"]).optional(),
  replacements: z.array(z.string()).optional().describe(
    "Dynamic values filling {{1}},{{2}}... placeholders in the button. For url buttons: the dynamic URL suffix. Use ${PropertyName} for profile personalization (e.g. '${Name}'). Avoid Liquid {{ }} syntax — blocked by API."
  ),
}).passthrough();

// Flat structure — template_name, locale, header, body, buttons sit directly under content (not nested under a 'template' key)
const WhatsAppContent = z
  .object({
    message_type: z.enum(["template", "Freeform"]).optional(),
    // Template mode fields (flat — do NOT nest under a 'template' object)
    template_name: z.string().optional().describe("BSP-registered template name. Required for message_type=template."),
    locale: z.string().optional().describe('Locale code e.g. "en", "en_IN". Required for message_type=template. Field name is "locale" not "language".'),
    header: z
      .object({
        type: z
          .enum(["Image", "Video", "Document", "Audio", "Location", "text", "Text"])
          .describe("Header type. Dashboard/API examples commonly use text or media types such as Image."),
        media: z
          .object({
            type: z.enum(["Image", "Video", "Document", "Audio"]).describe("Must match header type, capitalized."),
            url: z.string().describe("Public media URL or a personalized media URL expression accepted by CleverTap."),
          })
          .optional(),
        replacements: z.array(z.string()).optional().describe("Values for {{1}}... placeholders in header text."),
      })
      .optional(),
    body: z
      .object({
        replacements: z.array(z.string()).optional().describe(
          "Ordered values for {{1}},{{2}}... body placeholders. Count must exactly match placeholders in registered template. Use ${Name} etc. for profile personalization."
        ),
      })
      .optional(),
    buttons: z.array(WhatsAppButton).optional(),
    // Freeform mode
    msg: z.string().optional().describe("Freeform body text (only when message_type=Freeform). ${Name} personalization works; Liquid {{ }} is blocked."),
  })
  .passthrough();

const EmailContent = z
  .object({
    subject: z.string().describe("Email subject. Supports Liquid tokens."),
    sender_name: z.string().describe("From name shown to recipient"),
    body: z.string().describe("HTML body. Supports Liquid tokens in anchors/text."),
    amp_body: z.string().optional().describe("AMP HTML body for interactive email clients"),
    reply_to: z.string().email().optional(),
    from_email: z.string().email().optional(),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    pre_header: z.string().optional().describe("Preview text shown in inbox"),
  })
  .passthrough();

const SmsContent = z
  .object({
    body: z.string().describe("SMS body. Keep under carrier limits."),
    unicode: z.boolean().optional().describe("Set true for non-Latin character sets"),
    sender_id: z.string().optional().describe("Alphanumeric sender ID (where supported)"),
    message_info: z
      .object({
        template_id: z.string().optional().describe("DLT template ID (required for India)"),
        entity_id: z.string().optional().describe("DLT principal-entity ID (India)"),
        pe_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const WebPushContent = z
  .object({
    title: z.string(),
    body: z.string(),
  })
  .passthrough();

const PlatformSpecific = z
  .object({
    ios: z
      .object({
        deep_link: z.string().optional(),
        sound_file: z.string().optional(),
        badge_count: z.number().int().optional(),
        "mutable-content": z.string().optional().describe('Set "1" to raise Notification Viewed'),
        ct_mediaUrl: z.string().url().optional().describe("Rich push image URL"),
        category: z.string().optional(),
      })
      .passthrough()
      .optional(),
    android: z
      .object({
        deep_link: z.string().optional(),
        background_image: z.string().url().optional(),
        large_icon: z.string().url().optional(),
        enable_rendermax: z.boolean().optional(),
        wzrk_cid: z.string().optional().describe("Notification channel ID (Android O+)"),
      })
      .passthrough()
      .optional(),
    chrome: z
      .object({
        image: z.string().url().optional(),
        icon: z.string().url().optional(),
        deep_link: z.string().optional(),
      })
      .passthrough()
      .optional(),
    safari: z
      .object({
        deep_link: z.string().optional(),
      })
      .passthrough()
      .optional(),
    firefox: z
      .object({
        icon: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------- Tool definitions ----------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  handler: (input: unknown) => Promise<unknown>;
}

const tools: ToolDef[] = [];

function register<T extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: T,
  handler: (input: z.infer<T>) => Promise<unknown>,
) {
  tools.push({
    name,
    description,
    inputSchema: zodToJsonSchema(schema),
    handler: async (raw) => handler(schema.parse(raw ?? {})),
  });
}

// ==================================================================
// 1. SCHEMA DISCOVERY
// ==================================================================

register(
  "list_events",
  "List all tracked events from the loaded CleverTap event schema CSV. " +
    "Supports filtering by source (System|Custom) and status. Returns event names and property counts.",
  z.object({
    source: z.enum(["System", "Custom"]).optional(),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  async ({ source, status, limit }) => {
    const out: Array<Pick<EventDefinition, "name" | "source" | "status" | "total_datapoints"> & { property_count: number }> = [];
    for (const ev of schema.events.values()) {
      if (source && ev.source !== source) continue;
      if (status && ev.status !== status) continue;
      out.push({
        name: ev.name,
        source: ev.source,
        status: ev.status,
        total_datapoints: ev.total_datapoints,
        property_count: ev.properties.length,
      });
      if (out.length >= limit) break;
    }
    return { total_returned: out.length, events: out, meta: schema.meta };
  },
);

register(
  "search_events",
  "Search events by keyword (case-insensitive substring match on event name).",
  z.object({
    keyword: z.string().min(1),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  async ({ keyword, limit }) => {
    const hits = searchEvents(schema, keyword, limit).map((ev) => ({
      name: ev.name,
      source: ev.source,
      status: ev.status,
      property_count: ev.properties.length,
    }));
    return { total_returned: hits.length, events: hits };
  },
);

register(
  "get_event_properties",
  "Get all known properties for a given event from the schema, including data types and required flags.",
  z.object({ event_name: z.string().min(1) }),
  async ({ event_name }) => {
    const ev = findEvent(schema, event_name);
    if (!ev) throw new Error(`Event not found in schema: ${event_name}`);
    return ev;
  },
);

// ==================================================================
// 2. CAMPAIGN CONFIGURATION
// ==================================================================

const CampaignBase = z.object({
  name: z.string(),
  target_mode: z.enum([
    "Push",
    "email",
    "sms",
    "webpush",
    "whatsapp",
    "webhook",
    "notificationinbox",
  ]),
  devices: z
    .array(z.enum(["android", "ios", "web"]))
    .optional()
    .describe("Platforms to target for Push campaigns. e.g. [\"android\",\"ios\"]"),
  provider_nick_name: z.string().optional(),
  segment: z
    .number()
    .int()
    .optional()
    .describe("Saved segment ID. When provided, omit where; CleverTap expects segment at the top level."),
  where: Where.optional(),
  content: z.record(z.any()).describe("Channel-specific message content"),
  when: When,
  estimate_only: z.boolean().optional(),
  upper_cap_for_target_segment: z.number().int().min(1).optional().describe("Cap total users reached in this campaign"),
  users_limit_overall: z.number().int().min(1).optional(),
  users_limit_per_run: z.number().int().optional(),
  skip_estimate: z.boolean().optional().describe("Skip reach estimation — campaign is CREATED immediately with an ID. Use when you want a campaign ID without waiting for the estimate."),
  respect_frequency_caps: z.boolean().optional(),
  control_group: z.union([z.string(), z.number()]).optional(),
  platform_specific: PlatformSpecific.optional().describe("Per-platform overrides (ios/android/chrome/safari/firefox). Use instead of top-level content fields when you need platform-specific values."),
  conversion_goal: ConversionGoal.optional().describe("Attribution goal. Use build_push_content / build_whatsapp_content helpers if unsure of content shape."),
  dnd: Dnd.optional(),
  labels: z.array(z.string()).optional(),
  subscription_groups: z.array(z.string()).optional(),
  send_email_to_opted_out_users: z.boolean().optional(),
  send_to_all_devices: z.boolean().optional(),
});

function requireProviderForTargetMode(input: z.infer<typeof CampaignBase>) {
  if (
    CHANNELS_REQUIRING_PROVIDER.has(input.target_mode) &&
    !input.provider_nick_name
  ) {
    throw new Error(
      `provider_nick_name is required for target_mode=${input.target_mode} (see CleverTap API §3.1).`,
    );
  }
}

register(
  "create_campaign",
  "Create a CleverTap campaign targeting users by event/profile segment. " +
    "POST /1/targets/create.json. Supports push/email/sms/webpush/whatsapp/webhook/notificationinbox. " +
    "Set estimate_only=true to get reach estimate without creating. Set skip_estimate=true to create immediately and get a campaign ID. " +
    "Push campaigns require devices=[android|ios|web]. WhatsApp content requires template_name, locale, and a registered provider_nick_name. " +
    "PERSONALIZATION: Liquid tokens ({{profile.X}}, {{event.X.Y}}) in Push title/body are OBSERVED BLOCKED on this account despite docs claiming support. " +
    "For per-user personalization use trigger_external_campaign (dashboard-built campaign with {{ExternalTrigger.<key>}} placeholders). " +
    "WhatsApp templates use flat content fields: template_name, locale, header/body/buttons replacements. " +
    "For dashboard-style WhatsApp setup prefer create_whatsapp_campaign. Concurrent request limit: 3.",
  CampaignBase,
  async (input) => {
    requireProviderForTargetMode(input);
    if (input.where?.event_name) {
      const ev = findEvent(schema, input.where.event_name);
      if (!ev) {
        return {
          warning: `Event "${input.where.event_name}" not found in local schema. Proceeding anyway.`,
          result: await client.request("POST", "/1/targets/create.json", {
            body: input,
          }),
        };
      }
      validateFilters(ev, input.where.event_properties ?? []);
    }
    return client.request("POST", "/1/targets/create.json", { body: input });
  },
);

register(
  "estimate_campaign_reach",
  "Dry-run a campaign to get reach estimate without creating it. Wraps create_campaign with estimate_only=true.",
  CampaignBase.omit({ estimate_only: true }),
  async (input) => {
    requireProviderForTargetMode(input as z.infer<typeof CampaignBase>);
    return client.request("POST", "/1/targets/create.json", {
      body: { ...input, estimate_only: true },
    });
  },
);

register(
  "estimate_via_prompt",
  "Describe your target audience in plain English and get a reach estimate + the parsed CQL query back. " +
    "CleverTap's built-in NL parser converts the description into a structured where clause and runs the estimate in one call. " +
    "Returns: estimates (android/ios counts) + cql (the exact query CleverTap understood — review before using in production). " +
    "Supports: event filters, exclusions, OR logic, device-type filters, date ranges. " +
    "Does NOT support custom profile properties (e.g. wa_optout_stop) — add those manually to the returned cql. " +
    "Use this to discover the correct query shape, then pass the corrected cql to create_campaign or estimate_campaign_reach.",
  z.object({
    prompt: z.string().describe(
      "Plain English audience description. Examples: " +
      "'users who bought something in last 3 years but not in last 30 days, on Mobile or Tablet' | " +
      "'users who did Charged where Amount > 2999 OR users who did Charged where Items brandName contains Fossil' | " +
      "'exclude users who got a WhatsApp notification in last 15 days'",
    ),
    target_mode: z.enum(["Push", "whatsapp", "sms", "email", "webpush"]).default("Push").describe(
      "Channel to estimate reach for. Defaults to Push.",
    ),
    devices: z.array(z.enum(["android", "ios", "web"])).default(["android", "ios"]).describe(
      "Required for Push. Defaults to android + ios.",
    ),
  }),
  async ({ prompt, target_mode, devices }) => {
    const body: Record<string, unknown> = {
      name: "__prompt_estimate__",
      target_mode,
      estimate_only: true,
      when: "now",
      content: { title: "est", body: "est" },
      where: { prompt },
    };
    if (target_mode === "Push") body.devices = devices;
    const result = await client.request("POST", "/1/targets/create.json", { body }) as any;
    return {
      estimates: result.estimates,
      cql: result.cql,
      note: "Review cql carefully — custom profile properties (e.g. wa_optout_stop) must be added manually. Event names are matched by the NL parser and may sometimes be incorrect.",
    };
  },
);

register(
  "build_conversion_goal",
  "Validate & return a CleverTap conversion_goal object. Use for dashboard-style conversion tracking such as Charged in 5 days with revenue_property=Amount.",
  ConversionGoal,
  async (input) => ({ conversion_goal: input }),
);

const WhatsAppCampaignInput = z
  .object({
    campaign_name: z.string().describe("Campaign name shown in CleverTap"),
    segment_id: z.number().int().describe("Saved segment ID from CleverTap"),
    provider_nick_name: z.string().describe("WhatsApp service provider nickname, e.g. Karix_WA_promo"),
    template_name: z.string().describe("Exact approved WhatsApp template name"),
    locale: z.string().default("en").describe('Template locale, e.g. "en" or "en_IN"'),
    when: When.describe('Schedule. Use "now" or "YYYYMMDD HH:MM". CleverTap Create Campaign API rejects scheduling objects for this endpoint.'),
    personalized_media_url: z
      .string()
      .optional()
      .describe("Dashboard Personalized media URL. Can be a public URL or a CleverTap personalization expression."),
    media_type: z
      .enum(["Image", "Video", "Document", "Audio"])
      .default("Image")
      .describe("Header media type when personalized_media_url is provided."),
    header_replacements: z
      .array(z.string())
      .optional()
      .describe("Header text placeholder replacements, if the template header has {{1}}, {{2}}, etc."),
    body_replacements: z
      .array(z.string())
      .optional()
      .describe("Body placeholder replacements in template order."),
    button_url_variable: z
      .string()
      .optional()
      .describe("Value for the dashboard 'Add URL Variable' field. Usually the dynamic URL suffix, or the full URL if the template expects it."),
    button_replacements: z
      .array(z.string())
      .optional()
      .describe("Advanced: all button replacements in template order. If omitted, button_url_variable is used as the first replacement."),
    custom_key_value_pairs: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Optional custom key-value pairs to pass through in content."),
    conversion_goal: ConversionGoal.optional(),
    conversion_event: z.string().optional().describe("Shortcut for conversion_goal.event_name, e.g. Charged"),
    conversion_time: ConversionTime.optional().describe("Shortcut for conversion_goal.conversion_time, e.g. 5D"),
    revenue_property: z.string().optional().describe("Shortcut for conversion_goal.revenue_property, e.g. Amount"),
    estimate_only: z.boolean().optional(),
    skip_estimate: z.boolean().optional(),
    respect_frequency_caps: z.boolean().optional(),
    labels: z.array(z.string()).optional(),
    subscription_groups: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.conversion_goal && (value.conversion_event || value.conversion_time)) {
      if (!value.conversion_event) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conversion_event"],
          message: "conversion_event is required when conversion_time is provided.",
        });
      }
      if (!value.conversion_time) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conversion_time"],
          message: "conversion_time is required when conversion_event is provided.",
        });
      }
    }
  });

register(
  "create_whatsapp_campaign",
  "Create a WhatsApp campaign from dashboard-style fields: segment, provider, exact template name, personalized media URL, dynamic button URL variable, schedule, and conversion goal. " +
    "This wraps POST /1/targets/create.json with target_mode=whatsapp. It does not upload media or list templates/providers; pass approved template_name and provider_nick_name explicitly.",
  WhatsAppCampaignInput,
  async (input) => {
    const content: Record<string, unknown> = {
      message_type: "template",
      template_name: input.template_name,
      locale: input.locale,
    };

    if (input.personalized_media_url) {
      const mediaType = input.media_type.charAt(0).toUpperCase() + input.media_type.slice(1).toLowerCase();
      content.header = {
        type: mediaType,
        media: {
          url: input.personalized_media_url,
        },
      };
    } else if (input.header_replacements?.length) {
      content.header = {
        type: "text",
        replacements: input.header_replacements,
      };
    }

    if (input.body_replacements?.length) {
      content.body = { replacements: input.body_replacements };
    }

    const buttonReplacements =
      input.button_replacements ??
      (input.button_url_variable ? [input.button_url_variable] : undefined);
    if (buttonReplacements?.length) {
      content.buttons = [{ replacements: buttonReplacements }];
    }

    if (input.custom_key_value_pairs) {
      content.kv = input.custom_key_value_pairs;
    }

    const conversionGoal =
      input.conversion_goal ??
      (input.conversion_event && input.conversion_time
        ? {
            event_name: input.conversion_event,
            filter_type: {},
            conversion_time: input.conversion_time,
            ...(input.revenue_property
              ? { revenue_property: input.revenue_property }
              : {}),
          }
        : undefined);

    const body: z.infer<typeof CampaignBase> = {
      name: input.campaign_name,
      target_mode: "whatsapp",
      provider_nick_name: input.provider_nick_name,
      segment: input.segment_id,
      content,
      when: normalizeCampaignWhen(input.when),
      ...(conversionGoal ? { conversion_goal: conversionGoal } : {}),
      ...(input.estimate_only !== undefined
        ? { estimate_only: input.estimate_only }
        : {}),
      ...(input.skip_estimate !== undefined
        ? { skip_estimate: input.skip_estimate }
        : {}),
      ...(input.respect_frequency_caps !== undefined
        ? { respect_frequency_caps: input.respect_frequency_caps }
        : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.subscription_groups
        ? { subscription_groups: input.subscription_groups }
        : {}),
    };

    return client.request("POST", "/1/targets/create.json", { body });
  },
);

register(
  "create_campaign_union",
  "OR-of-CONDITIONS workaround: creates N campaigns (one per where-clause) sharing the same content/when/name. " +
    "NOTE: for OR logic between events within a single campaign, prefer using advanced_query.did_any in create_campaign instead — it is natively supported. " +
    "Use create_campaign_union only when you need to target entirely separate where objects (e.g. different segment IDs or profile combinations) as separate campaigns. " +
    "ALWAYS forces respect_frequency_caps=true so users matching multiple branches are deduped by CleverTap frequency cap. " +
    "Returns an array of { where_index, campaign } results. Any per-branch failure is returned, not thrown. " +
    "Serializes requests with a small delay to stay within CleverTap's campaign-create concurrency limit.",
  z.object({
    base: CampaignBase.omit({ where: true }).describe("Campaign fields shared by every branch — name, content, when, target_mode, devices, goal, dnd, etc."),
    where_branches: z
      .array(Where)
      .min(2)
      .max(10)
      .describe("Array of where clauses — one campaign is created per entry. Each branch is an INDEPENDENT OR leg."),
    estimate_only: z
      .boolean()
      .optional()
      .describe("If true, runs each branch as a dry-run estimate (no campaigns created). Useful for sizing the union before committing."),
  }),
  async ({ base, where_branches, estimate_only }) => {
    requireProviderForTargetMode(base as z.infer<typeof CampaignBase>);
    const results: Array<{ where_index: number; result?: unknown; error?: string }> = [];
    for (let i = 0; i < where_branches.length; i++) {
      const branch = where_branches[i];
      const body = {
        ...base,
        where: branch,
        respect_frequency_caps: true,
        estimate_only: estimate_only ?? false,
        name: `${base.name} [OR-${i + 1}/${where_branches.length}]`,
      };
      try {
        const res = await client.request("POST", "/1/targets/create.json", { body });
        results.push({ where_index: i, result: res });
      } catch (e: any) {
        results.push({ where_index: i, error: e?.message ?? String(e) });
      }
      if (i < where_branches.length - 1) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    return {
      note: "OR-of-conditions emulated via N campaigns. respect_frequency_caps=true enforces dedupe across branches.",
      branches: results,
    };
  },
);

const IdentityTargets = z.object({
  to: z
    .object({
      Identity: z.array(z.string()).optional(),
      Email: z.array(z.string()).optional(),
      FBID: z.array(z.string()).optional(),
      GPID: z.array(z.string()).optional(),
      objectId: z.array(z.string()).optional(),
    })
    .refine((v) => Object.values(v).some((a) => (a ?? []).length > 0), {
      message: "At least one identity list must be non-empty",
    }),
  tag_group: z.string().optional(),
  campaign_id: z.number().int().optional(),
  content: z.record(z.any()),
  respect_frequency_caps: z.boolean().optional(),
  provider_nick_name: z.string().optional(),
  message_id: z.string().max(8).optional(),
  respect_communication_preference: z.boolean().optional(),
});

const CHANNELS_REQUIRING_PROVIDER = new Set(["email", "sms", "whatsapp"]);

for (const channel of ["push", "email", "sms", "webpush", "whatsapp"] as const) {
  const extraReqs =
    channel === "whatsapp"
      ? " Requires provider_nick_name (registered in CleverTap settings). WhatsApp content should include flat template_name, locale (e.g. 'en'), and replacements arrays on body/header/buttons."
      : channel === "email" || channel === "sms"
        ? " Requires provider_nick_name (must be registered in CleverTap settings)."
        : "";
  register(
    `send_${channel}_to_users`,
    `Send a ${channel} campaign to specific users by identity (up to 1000). ` +
      `POST /1/send/${channel}.json. Include content per channel spec.` +
      extraReqs,
    IdentityTargets,
    async (input) => {
      if (CHANNELS_REQUIRING_PROVIDER.has(channel) && !input.provider_nick_name) {
        throw new Error(
          `provider_nick_name is required for ${channel} sends (see CleverTap API §3.2).`,
        );
      }
      if (channel === "whatsapp" && !input.message_id) {
        throw new Error(
          "message_id is required for WhatsApp sends (see CleverTap API §3.2).",
        );
      }
      return client.request("POST", `/1/send/${channel}.json`, { body: input });
    },
  );
}

register(
  "list_segments",
  "List all saved segments in the CleverTap account. POST /1/segments/list.json. " +
    "Returns segment IDs and names — use the ID in the 'segment' field of create_campaign where clause.",
  z.object({
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  async (input) => client.request("POST", "/1/segments/list.json", { body: input }),
);

register(
  "find_segment_by_name",
  "Find a saved segment by name (case-insensitive substring match). Returns the segment ID, name, status, and definition. " +
    "Use to look up the numeric ID needed for campaign targeting without manually opening the dashboard. " +
    "Searches across all pages until found or exhausted.",
  z.object({
    name: z.string().describe("Segment name or partial name to search for, e.g. 'IN_Country Master'"),
  }),
  async ({ name }) => {
    const lower = name.toLowerCase();
    let page = 1;
    const limit = 100;
    while (true) {
      const resp = await client.request("POST", "/1/segments/list.json", { body: { page, limit } }) as any;
      const segments: any[] = resp.segments ?? [];
      const match = segments.find((s: any) => (s.name ?? "").toLowerCase().includes(lower));
      if (match) {
        const detail = await client.request("POST", "/1/segments/get.json", { body: { segment_id: match.id } }).catch(() => null);
        return { found: true, segment: match, detail };
      }
      if (page >= (resp.total_pages ?? 1)) return { found: false, searched_pages: page, total_count: resp.total_count };
      page++;
    }
  },
);

register(
  "list_campaigns",
  "List campaigns scheduled within a date range. POST /1/targets/list.json.",
  z.object({ from: dateInt, to: dateInt }),
  async (input) => client.request("POST", "/1/targets/list.json", { body: input }),
);

register(
  "get_campaign_report",
  "Get delivery metrics (sent/clicked/etc.) for a specific campaign. POST /1/targets/result.json. " +
    "Concurrent request limit: 3.",
  z.object({ id: z.number().int() }),
  async (input) => client.request("POST", "/1/targets/result.json", { body: input }),
);

register(
  "stop_campaign",
  "Stop a scheduled or running campaign. POST /1/targets/stop.json. Concurrent request limit: 3.",
  z.object({ id: z.number().int() }),
  async (input) => client.request("POST", "/1/targets/stop.json", { body: input }),
);

register(
  "build_push_content",
  "Validate & return a typed Push 'content' object for create_campaign. " +
    "Use this when unsure of Push field names. " +
    "NOTE: Liquid tokens ({{profile.X}}) in title/body are observed BLOCKED on this account — use static text, or trigger_external_campaign for per-user dynamic values. " +
    "Deep links go in wzrk_dl. Images (large_icon, background_image) must be PUBLICLY HOSTED URLs — " +
    "CleverTap has no image-upload API; host on S3/CDN or upload via the dashboard Media Library first.",
  PushContent,
  async (input) => ({ content: input }),
);

register(
  "build_whatsapp_content",
  "Validate & return a typed WhatsApp 'content' object for create_campaign / send_whatsapp_to_users. " +
    "IMPORTANT: All template fields (template_name, locale, header, body, buttons) sit FLAT under content — do NOT nest them under a 'template' key. " +
    "message_type=template requires template_name + locale (NOT 'language'). " +
    "header.type may be text or a media type such as Image, Video, Document, Audio, Location. " +
    "body.replacements count must exactly match {{1}},{{2}}... placeholders in the BSP-registered template. " +
    "buttons[].replacements fills dynamic URL suffix for url-type buttons. " +
    "Use ${Name} etc. for profile personalization where accepted by CleverTap. " +
    "Header media can be a public URL or a personalized media URL expression accepted by CleverTap.",
  WhatsAppContent,
  async (input) => ({ content: input }),
);

register(
  "build_email_content",
  "Validate & return a typed Email 'content' object for create_campaign / send_email_to_users. " +
    "subject, sender_name, and body (HTML) are required. Supports Liquid tokens in subject and body. " +
    "amp_body enables AMP-for-Email. reply_to/from_email must be verified in CleverTap.",
  EmailContent,
  async (input) => ({ content: input }),
);

register(
  "build_sms_content",
  "Validate & return a typed SMS 'content' object for create_campaign / send_sms_to_users. " +
    "For India, message_info.template_id + entity_id are required (DLT compliance). " +
    "Set unicode=true for non-Latin character sets.",
  SmsContent,
  async (input) => ({ content: input }),
);

register(
  "build_webpush_content",
  "Validate & return a typed Web Push 'content' object for create_campaign / send_webpush_to_users. " +
    "title and body are required. Per-browser overrides (image, icon, deep_link) go in the campaign-level " +
    "platform_specific.chrome / .safari / .firefox objects, not in content.",
  WebPushContent,
  async (input) => ({ content: input }),
);

register(
  "recreate_campaign",
  "Update a campaign by stopping the existing one and creating a new one with modified config. " +
    "CleverTap has no update-campaign API — this is the official workaround. " +
    "REQUIRED: pass confirm=true to acknowledge the existing campaign will be STOPPED (irreversible). " +
    "Returns { stopped_id, new_campaign }.",
  z.object({
    existing_campaign_id: z.number().int().describe("ID of the campaign to stop"),
    new_config: CampaignBase.describe("Full config for the replacement campaign (same shape as create_campaign)"),
    confirm: z
      .literal(true)
      .describe("Must be true — confirms the old campaign will be stopped"),
  }),
  async ({ existing_campaign_id, new_config }) => {
    requireProviderForTargetMode(new_config);
    const stopped = await client.request("POST", "/1/targets/stop.json", {
      body: { id: existing_campaign_id },
    });
    const created = await client.request("POST", "/1/targets/create.json", {
      body: new_config,
    });
    return { stopped_id: existing_campaign_id, stopped, new_campaign: created };
  },
);

const ExternalTriggerTo = z
  .object({
    email: z.array(z.string()).optional(),
    identity: z.array(z.string()).optional(),
    objectId: z.array(z.string()).optional(),
  })
  .refine(
    (v) =>
      (v.email?.length ?? 0) +
        (v.identity?.length ?? 0) +
        (v.objectId?.length ?? 0) >
      0,
    { message: "Provide at least one of email, identity, or objectId." },
  );

register(
  "trigger_external_campaign",
  "Trigger an existing external-trigger campaign for specific users with dynamic variables. " +
    "POST /1/send/externaltrigger.json. Use trigger_external_campaign_multi for multiple campaign IDs. " +
    "ExternalTrigger keys map to {{ExternalTrigger.<key>}} placeholders in the campaign template (string values only).",
  z.object({
    to: ExternalTriggerTo,
    campaign_id: z.string(),
    ExternalTrigger: z.record(z.string()),
  }),
  async (input) =>
    client.request("POST", "/1/send/externaltrigger.json", { body: input }),
);

register(
  "trigger_external_campaign_multi",
  "Trigger multiple external-trigger campaigns (up to 5) for users. POST /2/send/externaltrigger.json. " +
    "Requires CLEVERTAP_TOKEN env var.",
  z.object({
    to: ExternalTriggerTo,
    campaign_id_list: z.array(z.number().int()).min(1).max(5),
    ExternalTrigger: z.record(z.string()),
  }),
  async (input) =>
    client.request("POST", "/2/send/externaltrigger.json", {
      body: input,
      requireToken: true,
    }),
);

// ==================================================================
// 3. DATA EXTRACTION — Events
// ==================================================================

register(
  "get_event_count",
  "Count how many times a given event occurred in a date range (optionally filtered by event property). " +
    "POST /1/counts/events.json. Returns {count} or {req_id} (async → poll with poll_event_count).",
  z.object({
    event_name: z.string(),
    from: dateInt,
    to: dateInt,
    event_properties: z.array(EventPropertyFilter).optional(),
  }),
  async (input) => {
    const ev = findEvent(schema, input.event_name);
    if (ev) validateFilters(ev, input.event_properties ?? []);
    return client.request("POST", "/1/counts/events.json", { body: input });
  },
);

register(
  "poll_event_count",
  "Poll a pending event-count query (when get_event_count returned status=partial). GET /1/counts/events.json?req_id=...",
  z.object({ req_id: z.union([z.string(), z.number()]) }),
  async (input) =>
    client.request("GET", "/1/counts/events.json", {
      query: { req_id: String(input.req_id) },
    }),
);

register(
  "get_events_cursor",
  "Step 1 of event data export: get a pagination cursor for events in a date range. POST /1/events.json.",
  z.object({
    event_name: z.string().optional(),
    from: dateInt,
    to: dateInt,
    batch_size: z.number().int().min(1).max(5000).default(1000),
    app: z.boolean().optional(),
    events: z.boolean().optional(),
    profile: z.boolean().optional(),
    identity: z.string().optional().describe("Filter by user identity/ID"),
    email: z.string().optional().describe("Filter by user email"),
    objectId: z.string().optional().describe("Filter by user objectId"),
    FBID: z.string().optional().describe("Filter by user Facebook ID"),
    GPID: z.string().optional().describe("Filter by user Google Plus ID"),
  }),
  async (input) => {
    const { batch_size, app, events, profile, ...body } = input;
    return client.request("POST", "/1/events.json", {
      body,
      query: { batch_size, app, events, profile },
    });
  },
);

register(
  "get_events_page",
  "Step 2: fetch a page of events using the cursor from get_events_cursor. GET /1/events.json?cursor=...",
  z.object({ cursor: z.string() }),
  async (input) =>
    client.request("GET", "/1/events.json", { query: { cursor: input.cursor } }),
);

register(
  "upload_events",
  "Upload custom events for users (max 1000 events per call). POST /1/upload with type=event. " +
    "Each record needs evtName, evtData and one of identity/FBID/GPID/objectId.",
  z.object({
    events: z
      .array(
        z.object({
          type: z.literal("event").default("event"),
          evtName: z.string(),
          evtData: z.record(z.any()),
          ts: z.number().int().optional(),
          identity: z.string().optional(),
          FBID: z.string().optional(),
          GPID: z.string().optional(),
          objectId: z.string().optional(),
        }),
      )
      .min(1)
      .max(1000),
  }),
  async ({ events }) => {
    for (const e of events) {
      const ev = findEvent(schema, e.evtName);
      if (ev) {
        const allowed = new Set(ev.properties.map((p) => p.name));
        const unknown = Object.keys(e.evtData).filter((k) => !allowed.has(k));
        if (unknown.length > 0) {
          // Warning-only; CleverTap itself allows unknown props.
          console.error(
            `[warn] event "${e.evtName}" has properties not in schema: ${unknown.join(", ")}`,
          );
        }
      }
    }
    return client.request("POST", "/1/upload", { body: { d: events } });
  },
);

// ==================================================================
// 4. DATA EXTRACTION — Profiles
// ==================================================================

register(
  "get_profile_count",
  "Count profiles that performed a given event (optionally filtered). POST /1/counts/profiles.json. " +
    "This endpoint is ASYNC — first call usually returns {req_id, status:'partial'}. " +
    "By default this tool auto-polls until status='success' (so you get the final filtered count). " +
    "Set auto_poll=false to return the raw partial response + req_id for manual polling via poll_profile_count.",
  z.object({
    event_name: z.string(),
    from: dateInt,
    to: dateInt,
    event_properties: z.array(EventPropertyFilter).optional(),
    auto_poll: z.boolean().default(true),
    poll_interval_ms: z.number().int().min(250).max(10000).default(1000),
    max_poll_attempts: z.number().int().min(1).max(60).default(20),
  }),
  async (input) => {
    const { auto_poll, poll_interval_ms, max_poll_attempts, ...body } = input;
    const ev = findEvent(schema, body.event_name);
    if (ev) validateFilters(ev, body.event_properties ?? []);
    const first: any = await client.request("POST", "/1/counts/profiles.json", { body });
    if (!auto_poll || first?.status !== "partial" || !first?.req_id) return first;
    let last = first;
    for (let i = 0; i < max_poll_attempts; i++) {
      await new Promise((r) => setTimeout(r, poll_interval_ms));
      last = await client.request("GET", "/1/counts/profiles.json", {
        query: { req_id: String(first.req_id) },
      });
      if (last?.status && last.status !== "partial") return last;
    }
    return { ...last, _warning: `still partial after ${max_poll_attempts} polls; call poll_profile_count with req_id=${first.req_id}` };
  },
);

register(
  "poll_profile_count",
  "Poll a pending profile-count query (when get_profile_count returned status=partial). GET /1/counts/profiles.json?req_id=...",
  z.object({ req_id: z.union([z.string(), z.number()]) }),
  async (input) =>
    client.request("GET", "/1/counts/profiles.json", {
      query: { req_id: String(input.req_id) },
    }),
);

register(
  "get_profiles_cursor",
  "Step 1 of profile data export: get a pagination cursor for profiles who performed an event. " +
    "POST /1/profiles.json. batch_size must be a multiple of 23 (max 5000).",
  z.object({
    event_name: z.string(),
    from: dateInt,
    to: dateInt,
    batch_size: z
      .number()
      .int()
      .min(23)
      .max(5000)
      .default(1012)
      .refine((n) => n % 23 === 0, {
        message: "batch_size must be a multiple of 23 (e.g. 23, 46, 989, 1012).",
      }),
    app: z.boolean().optional(),
    events: z.boolean().optional(),
    profile: z.boolean().optional(),
  }),
  async (input) => {
    const { batch_size, app, events, profile, ...body } = input;
    return client.request("POST", "/1/profiles.json", {
      body,
      query: { batch_size, app, events, profile },
    });
  },
);

register(
  "get_profiles_page",
  "Step 2: fetch a page of profiles using a cursor. GET /1/profiles.json?cursor=...",
  z.object({ cursor: z.string() }),
  async (input) =>
    client.request("GET", "/1/profiles.json", { query: { cursor: input.cursor } }),
);

register(
  "download_profile",
  "Download a single user profile by email, identity, or objectId. GET /1/profile.json.",
  z
    .object({
      email: z.string().optional(),
      identity: z.string().optional(),
      objectId: z.string().optional(),
    })
    .refine((v) => v.email || v.identity || v.objectId, {
      message: "Provide one of email, identity, objectId",
    }),
  async (input) =>
    client.request("GET", "/1/profile.json", { query: input as Record<string, string> }),
);

register(
  "upload_profiles",
  "Upload/update user profile properties (max 1000 per call). POST /1/upload with type=profile. " +
    "Supports $delete, $add, $remove, $incr, $decr operators on profileData values.",
  z.object({
    profiles: z
      .array(
        z.object({
          type: z.literal("profile").default("profile"),
          profileData: z.record(z.any()),
          identity: z.string().optional(),
          FBID: z.string().optional(),
          GPID: z.string().optional(),
          objectId: z.string().optional(),
        }),
      )
      .min(1)
      .max(1000),
  }),
  async ({ profiles }) =>
    client.request("POST", "/1/upload", { body: { d: profiles } }),
);

register(
  "upload_device_tokens",
  "Upload device tokens for users (FCM, APNS, Chrome Web Push, etc.). Max 100 per call. POST /1/upload with type=token.",
  z.object({
    tokens: z
      .array(
        z.object({
          type: z.literal("token").default("token"),
          objectId: z.string(),
          tokenData: z.object({
            id: z.string(),
            type: z.enum(["fcm", "gcm", "apns", "wns", "mpns", "chrome"]),
            keys: z.object({ p256dh: z.string(), auth: z.string() }).optional(),
          }),
        }),
      )
      .min(1)
      .max(100),
    dryRun: z.boolean().optional(),
  }),
  async ({ tokens, dryRun }) =>
    client.request("POST", "/1/upload", {
      body: { d: tokens },
      query: dryRun ? { dryRun: 1 } : undefined,
    }),
);

register(
  "subscribe_unsubscribe",
  "Bulk subscribe / unsubscribe phone / email / whatsapp contacts. POST /1/subscribe. Max 1000 per call.",
  z.object({
    records: z
      .array(
        z.object({
          type: z.enum(["phone", "email", "whatsapp"]),
          value: z.string(),
          status: z.enum(["Unsubscribe", "Resubscribe"]),
        }),
      )
      .min(1)
      .max(1000),
  }),
  async ({ records }) =>
    client.request("POST", "/1/subscribe", { body: { d: records } }),
);

// ==================================================================
// 5. REPORTS & ANALYTICS
// ==================================================================

register(
  "get_realtime_counts",
  "Count of active users in the last 5 minutes. POST /1/now.json. " +
    "Set user_type=true to get new-vs-returning breakdown.",
  z.object({ user_type: z.boolean().optional() }),
  async (input) => client.request("POST", "/1/now.json", { body: input }),
);

register(
  "get_message_reports",
  "List message campaign performance for a date range, filtered by channel/status/type. POST /1/message/report.json.",
  z.object({
    from: z.string().describe("YYYYMMDD"),
    to: z.string().describe("YYYYMMDD"),
    channel: z
      .array(
        z.enum([
          "push",
          "email",
          "sms",
          "browser",
          "audiences",
          "inapp",
          "webhooks",
          "web_pop_up",
          "web_exit_intent",
          "web_native_display",
          "web_inbox",
        ]),
      )
      .optional(),
    delivery: z
      .array(
        z.enum([
          "one_time",
          "inaction",
          "action",
          "recurring",
          "property_time",
          "api",
        ]),
      )
      .optional(),
    daily: z.boolean().optional(),
    status: z
      .array(z.enum(["scheduled", "running", "stopped", "completed"]))
      .optional(),
    message_type: z
      .array(z.enum(["single", "ab", "message_on_user_property"]))
      .optional(),
    label: z.array(z.string()).optional(),
  }),
  async (input) => client.request("POST", "/1/message/report.json", { body: input }),
);

register(
  "get_trends",
  "Get event trend counts bucketed daily/weekly/monthly. POST /1/counts/trends.json.",
  z.object({
    event_name: z.string(),
    from: dateInt,
    to: dateInt,
    groups: z.record(
      z.object({
        trend_type: z.enum(["daily", "weekly", "monthly"]),
        event_properties: z.array(EventPropertyFilter).optional(),
      }),
    ),
    unique: z.boolean().optional(),
    sum_event_prop: z.string().optional(),
  }),
  async (input) => client.request("POST", "/1/counts/trends.json", { body: input }),
);

register(
  "get_top_properties",
  "Get top N values of a property (event/profile/session/etc) for an event. POST /1/counts/top.json.",
  z.object({
    event_name: z.string(),
    from: dateInt,
    to: dateInt,
    groups: z.record(
      z.object({
        property_type: z.enum([
          "event_properties",
          "profile_fields",
          "session_properties",
          "app_fields",
          "demographics",
          "technographics",
          "reachability",
          "geo_fields",
        ]),
        name: z.string(),
      }),
    ),
    top_n: z.number().int().optional(),
    order: z.enum(["asc", "desc"]).optional(),
  }),
  async (input) => client.request("POST", "/1/counts/top.json", { body: input }),
);

// ==================================================================
// 6. REMOTE CONFIG / VARIABLES
// ==================================================================

register(
  "create_variables",
  "Define Remote Config variables. POST /1/createVars. Variables must be published from the dashboard to persist.",
  z.object({
    variableDefinitions: z.record(
      z.object({
        type: z.enum(["string", "boolean", "number"]),
        defaultValue: z.union([z.string(), z.boolean(), z.number()]),
        description: z.string().optional(),
      }),
    ),
  }),
  async (input) => client.request("POST", "/1/createVars", { body: input }),
);

register(
  "delete_variables",
  "Delete Remote Config variables by name. POST /1/deleteVars.",
  z.object({
    variableNames: z.array(z.string()).optional(),
    deleteAllVars: z.boolean().optional(),
  }),
  async (input) => client.request("POST", "/1/deleteVars", { body: input }),
);

register(
  "get_variables",
  "Get Remote Config variables for a specific user/profile. POST /1/getVars.",
  z
    .object({
      identity: z.string().optional(),
      clevertapId: z.string().optional(),
      includeDefaults: z.boolean().optional(),
    })
    .refine((v) => v.identity || v.clevertapId, {
      message: "Provide identity or clevertapId",
    }),
  async (input) => client.request("POST", "/1/getVars", { body: input }),
);

// ==================================================================
// 7. SEGMENT CREATION + REACH ESTIMATION
// ==================================================================

register(
  "create_segment",
  "Create one or more named segments in CleverTap. POST /api/createSegment. " +
    "NOTE: CleverTap's API creates EMPTY named segments only — event/profile logic cannot be set via API (dashboard only). " +
    "Returns CleverTap-generated segment IDs (id field) you can reuse in campaigns, journeys, and update_segment. " +
    "customer_segment_id is your own unique reference string (e.g. 'premium_active_apr26') — must be globally unique across all requests.",
  z.object({
    segments: z.array(z.object({
      segment_name: z.string().describe("Segment name shown in CleverTap dashboard"),
      customer_segment_id: z.string().describe("Your unique identifier, e.g. 'premium_active_apr26'. Must be globally unique."),
    })).min(1).max(100).describe("List of segments to create (max 100 per request)"),
  }),
  async ({ segments }) => {
    const result = await client.request("POST", "/api/createSegment", { body: segments });
    return result;
  },
);

register(
  "add_users_to_segment",
  "Add or remove users from a CleverTap segment. POST /api/updateSegment. " +
    "Use after create_segment to populate a segment with user identities. " +
    "action='ADD' to add users, 'REMOVE' to remove. Max 100 profiles per request. " +
    "Provide either identity (email/phone/custom ID) or guid per user.",
  z.object({
    ct_segment_id: z.number().int().optional().describe("CleverTap-generated segment ID (from create_segment response)"),
    customer_segment_id: z.string().optional().describe("Your own segment reference string"),
    action: z.enum(["ADD", "REMOVE"]).default("ADD"),
    identities: z.array(z.string()).min(1).max(100).describe("User identities (email / phone / custom identity values)"),
  }).refine(v => v.ct_segment_id || v.customer_segment_id, { message: "Provide ct_segment_id or customer_segment_id" }),
  async ({ ct_segment_id, customer_segment_id, action, identities }) => {
    const segmentRef: Record<string, unknown> = { action };
    if (ct_segment_id) segmentRef.ct_segment_id = String(ct_segment_id);
    if (customer_segment_id) segmentRef.customer_segment_id = customer_segment_id;

    const bulk_profiles = identities.map(identity => ({
      user_profiles: [{ identity }],
      segments: [segmentRef],
    }));
    const result = await client.request("POST", "/api/updateSegment", { body: { bulk_profiles } });
    return result;
  },
);

register(
  "estimate_segment_reach",
  "Estimate Push and/or WhatsApp reachability for a saved segment. " +
    "Uses create_campaign with estimate_only=true for each channel. " +
    "Push returns android + ios counts. WhatsApp requires provider_nick_name and a template_name. " +
    "Returns a single JSON with push_android, push_ios, push_total, whatsapp_total.",
  z.object({
    segment_id: z.number().int().describe("CleverTap saved segment ID"),
    channels: z.array(z.enum(["push", "whatsapp"])).default(["push", "whatsapp"]).describe("Channels to estimate"),
    provider_nick_name: z.string().optional().describe("Required for WhatsApp — registered BSP nick name e.g. Karix_WA_promo"),
    template_name: z.string().optional().describe("Required for WhatsApp — approved template name"),
    template_locale: z.string().default("en").describe("WhatsApp template locale. Default: en"),
    template_header_type: z.enum(["Text", "Image", "Video", "Document", "Audio"]).optional().describe("Header media type if template has a header"),
    template_header_replacement: z.string().optional().describe("URL or text for header replacement if header is present"),
    template_body_replacements: z.array(z.string()).default([]).describe("Ordered replacements for {{1}}, {{2}}... in template body"),
    template_button_replacements: z.array(z.string()).default([]).describe("Ordered replacements for dynamic URL buttons"),
  }),
  async (input) => {
    const result: Record<string, unknown> = { segment_id: input.segment_id };
    const when = "20991231 23:59";

    if (input.channels.includes("push")) {
      const pushResp = await client.request("POST", "/1/targets/create.json", {
        body: {
          name: `__reach_est_push_${input.segment_id}`,
          when,
          segment: input.segment_id,
          target_mode: "push",
          devices: ["android", "ios"],
          estimate_only: true,
          content: { title: "est", body: "est" },
        },
      }) as any;
      const est = pushResp?.estimates ?? {};
      result.push_android = est.android ?? 0;
      result.push_ios = est.ios ?? 0;
      result.push_total = (est.android ?? 0) + (est.ios ?? 0);
    }

    if (input.channels.includes("whatsapp")) {
      if (!input.provider_nick_name || !input.template_name) {
        result.whatsapp_total = "skipped — provider_nick_name and template_name required for WhatsApp estimate";
      } else {
        const content: Record<string, unknown> = {
          message_type: "template",
          template_name: input.template_name,
          locale: input.template_locale,
          body: { replacements: input.template_body_replacements },
        };
        if (input.template_header_type && input.template_header_replacement) {
          content.header = { type: input.template_header_type, replacements: [input.template_header_replacement] };
        }
        if (input.template_button_replacements.length > 0) {
          content.buttons = [{ replacements: input.template_button_replacements }];
        }
        const waResp = await client.request("POST", "/1/targets/create.json", {
          body: {
            name: `__reach_est_wa_${input.segment_id}`,
            when,
            segment: input.segment_id,
            target_mode: "whatsapp",
            estimate_only: true,
            provider_nick_name: input.provider_nick_name,
            content,
          },
        }) as any;
        const est = waResp?.estimates ?? {};
        result.whatsapp_total = est.whatsapp ?? est.web ?? 0;
        result.whatsapp_raw_estimates = est;
      }
    }

    return result;
  },
);


// ==================================================================
// Helpers
// ==================================================================

function validateFilters(
  ev: EventDefinition,
  filters: z.infer<typeof EventPropertyFilter>[],
) {
  if (filters.length === 0) return;
  const allowed = new Set(ev.properties.map((p) => p.name));
  const bad = filters.filter((f) => !allowed.has(f.name)).map((f) => f.name);
  if (bad.length > 0) {
    throw new Error(
      `Event "${ev.name}" has no property named: ${bad.join(", ")}. ` +
        `Known properties: ${[...allowed].slice(0, 20).join(", ")}${
          allowed.size > 20 ? ` ... (+${allowed.size - 20} more)` : ""
        }`,
    );
  }
}

function normalizeCampaignWhen(input: z.infer<typeof When>): z.infer<typeof When> {
  if (typeof input === "string") return input;
  if (input.type === "now") return "now";
  if (input.type === "later" && input.delivery_date_time) {
    return input.delivery_date_time;
  }
  return input;
}

// ---------- Minimal zod → JSON Schema ----------
// Good enough for MCP inputSchema (draft-07 compatible).

function zodToJsonSchema(schema: z.ZodTypeAny): Tool["inputSchema"] {
  const s = convert(schema);
  if (s.type !== "object") {
    return { type: "object", properties: { value: s } } as Tool["inputSchema"];
  }
  return s as Tool["inputSchema"];
}

function convert(s: z.ZodTypeAny): any {
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = convert(v);
      if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) {
        required.push(k);
      }
    }
    const out: any = { type: "object", properties };
    if (required.length > 0) out.required = required;
    return out;
  }
  if (s instanceof z.ZodString) return withDesc({ type: "string" }, s);
  if (s instanceof z.ZodNumber) return withDesc({ type: "number" }, s);
  if (s instanceof z.ZodBoolean) return withDesc({ type: "boolean" }, s);
  if (s instanceof z.ZodLiteral)
    return { type: typeof s.value, enum: [s.value] };
  if (s instanceof z.ZodEnum) return { type: "string", enum: [...s.options] };
  if (s instanceof z.ZodArray)
    return withDesc({ type: "array", items: convert(s.element) }, s);
  if (s instanceof z.ZodRecord)
    return withDesc(
      { type: "object", additionalProperties: convert(s.valueSchema) },
      s,
    );
  if (s instanceof z.ZodUnion) {
    return { anyOf: s.options.map((o: z.ZodTypeAny) => convert(o)) };
  }
  if (s instanceof z.ZodOptional) return convert(s.unwrap());
  if (s instanceof z.ZodDefault) return convert(s.removeDefault());
  if (s instanceof z.ZodEffects) return convert(s._def.schema);
  if (s instanceof z.ZodAny) return {};
  return {};
}

function withDesc(obj: any, s: z.ZodTypeAny): any {
  const desc = (s as any)._def?.description;
  if (desc) obj.description = desc;
  return obj;
}

// ==================================================================
// Wire up MCP server
// ==================================================================

const server = new Server(
  { name: pkg.name, version: pkg.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  try {
    const result = await tool.handler(req.params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text:
            typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: msg }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[clevertap-mcp] server ready on stdio");
