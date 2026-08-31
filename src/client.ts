export interface CleverTapConfig {
  accountId: string;
  passcode: string;
  region: string;
  token?: string;
  timeoutMs?: number;
}

export class CleverTapClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(private cfg: CleverTapConfig) {
    this.baseUrl = `https://${cfg.region}.api.clevertap.com`;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  async request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      requireToken?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      "X-CleverTap-Account-Id": this.cfg.accountId,
      "X-CleverTap-Passcode": this.cfg.passcode,
      "Content-Type": "application/json; charset=utf-8",
    };
    if (opts.requireToken) {
      if (!this.cfg.token) {
        throw new Error(
          "This endpoint requires X-CleverTap-Token; set CLEVERTAP_TOKEN in env.",
        );
      }
      headers["X-CleverTap-Token"] = this.cfg.token;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? this.timeoutMs,
    );

    const init: RequestInit = { method, headers, signal: controller.signal };
    if (opts.body !== undefined && method !== "GET") {
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), init);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(
          `CleverTap ${method} ${path} timed out after ${opts.timeoutMs ?? this.timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // leave as text
    }
    if (!res.ok) {
      throw new Error(
        `CleverTap ${method} ${path} failed [${res.status}]: ${
          typeof parsed === "string" ? parsed : JSON.stringify(parsed)
        }`,
      );
    }

    // CleverTap often returns HTTP 200 with status="fail" in the body.
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { status?: string }).status === "fail"
    ) {
      const body = parsed as { error?: string; code?: number | string };
      const msg = body.error ?? JSON.stringify(parsed);
      const code = body.code !== undefined ? ` (code ${body.code})` : "";
      throw new Error(
        `CleverTap ${method} ${path} returned status=fail${code}: ${msg}`,
      );
    }

    return parsed as T;
  }
}
