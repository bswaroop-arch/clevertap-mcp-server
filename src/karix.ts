// Karix RCM WhatsApp API — template management client
// Base URL: https://rcsgui.karix.solutions
// Auth header is "Authentication: Bearer <key>" (not "Authorization")
// All template endpoints: /api/v1.0/template/{wabaId}[/{templateId}]

export interface KarixConfig {
  baseUrl: string;     // https://rcsgui.karix.solutions
  accessKey: string;   // API key from Karix portal (KARIX_API_KEY in .env)
  wabaNumber?: string; // sender WABA number e.g. 918886629738
}

export interface TemplateButton {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
  text: string;
  url?: string;
  phone_number?: string;
}

export interface TemplateHeader {
  format: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
  text?: string; // only when format=TEXT, may contain {{1}}
}

export interface CreateTemplateInput {
  name: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language: string;
  body: string;
  header?: TemplateHeader;
  header_image_handle?: string; // pre-uploaded file handle for IMAGE/VIDEO/DOCUMENT headers
  footer?: string;
  buttons?: TemplateButton[];
  ttl_days?: number;
  ttl_hours?: number;
  waba_number?: string;
}

export interface KarixTemplateResponse {
  templateId?: string;
  status?: string;
  [key: string]: unknown;
}

export class KarixClient {
  private cfg: KarixConfig;

  constructor(cfg: KarixConfig) {
    this.cfg = cfg;
  }

  private headers(): Record<string, string> {
    return {
      Authentication: `Bearer ${this.cfg.accessKey}`,
      "Content-Type": "application/json",
    };
  }

  private wabaPath(waba?: string): string {
    const id = waba ?? this.cfg.wabaNumber;
    if (!id) throw new Error("KARIX_WABA_NUMBER is not set and no waba_number provided.");
    return `${this.cfg.baseUrl}/api/v1.0/template/${encodeURIComponent(id)}`;
  }

  private buildComponents(input: CreateTemplateInput): object[] {
    const components: object[] = [];

    if (input.header) {
      const header: Record<string, unknown> = {
        type: "HEADER",
        format: input.header.format,
      };
      if (input.header.text) header.text = input.header.text;
      if (input.header_image_handle) {
        header.example = { header_handle: [input.header_image_handle] };
      }
      components.push(header);
    }

    const varCount = (input.body.match(/\{\{\d+\}\}/g) ?? []).length;
    const bodyComp: Record<string, unknown> = { type: "BODY", text: input.body };
    if (varCount > 0) {
      bodyComp.example = { body_text: [Array(varCount).fill("sample")] };
    }
    components.push(bodyComp);

    if (input.footer) {
      components.push({ type: "FOOTER", text: input.footer });
    }

    if (input.buttons && input.buttons.length > 0) {
      components.push({
        type: "BUTTONS",
        buttons: input.buttons.map((b) => {
          const btn: Record<string, unknown> = { type: b.type, text: b.text };
          if (b.url) {
            btn.url = b.url;
            if (b.url.includes("{{")) btn.example = ["sample"];
          }
          if (b.phone_number) btn.phone_number = b.phone_number;
          return btn;
        }),
      });
    }

    return components;
  }

  async createFileHandle(imageBuffer: Buffer, fileName: string, fileType: string, waba_number?: string): Promise<string> {
    const wabaId = waba_number ?? this.cfg.wabaNumber;
    if (!wabaId) throw new Error("KARIX_WABA_NUMBER not set.");
    const url = `${this.cfg.baseUrl}/api/v1.0/template/${encodeURIComponent(wabaId)}/media`;

    const boundary = "----KarixBoundary" + Math.random().toString(36).slice(2);
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\n${fileType}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}.jpg"\r\nContent-Type: ${fileType}\r\n\r\n`,
    ].join("\r\n");
    const body = Buffer.concat([Buffer.from(parts), imageBuffer, Buffer.from(`\r\n--${boundary}--\r\n`)]);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authentication: `Bearer ${this.cfg.accessKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    });
    let data: unknown;
    try { data = await resp.json(); } catch { data = await resp.text(); }
    if (!resp.ok) throw new Error(`Karix ${resp.status}: ${JSON.stringify(data)}\nPOST ${url}`);
    const handle = (data as Record<string, Record<string, unknown>>)?.response?.fileHandle;
    if (!handle) throw new Error(`No fileHandle in response: ${JSON.stringify(data)}`);
    return String(handle);
  }

  async createTemplate(input: CreateTemplateInput): Promise<KarixTemplateResponse> {
    const url = this.wabaPath(input.waba_number);
    const payload: Record<string, unknown> = {
      template_name: input.name,
      language: input.language,
      category: input.category,
      components: this.buildComponents(input),
    };
    if (input.ttl_days !== undefined || input.ttl_hours !== undefined) {
      payload.ttl = { days: input.ttl_days ?? 30, hours: input.ttl_hours ?? 0 };
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    let data: unknown;
    try { data = await resp.json(); } catch { data = await resp.text(); }

    if (!resp.ok) {
      throw new Error(
        `Karix ${resp.status}: ${JSON.stringify(data)}\nPOST ${url}\n${JSON.stringify(payload, null, 2)}`
      );
    }
    return data as KarixTemplateResponse;
  }

  async listTemplates(waba_number?: string, page = 0): Promise<unknown> {
    const url = `${this.wabaPath(waba_number)}?page=${page}`;
    const resp = await fetch(url, { method: "GET", headers: this.headers() });
    let data: unknown;
    try { data = await resp.json(); } catch { data = await resp.text(); }
    if (!resp.ok) throw new Error(`Karix ${resp.status}: ${JSON.stringify(data)}`);
    return data;
  }

  async getTemplate(templateId: string, waba_number?: string): Promise<unknown> {
    const url = `${this.wabaPath(waba_number)}/${encodeURIComponent(templateId)}`;
    const resp = await fetch(url, { method: "GET", headers: this.headers() });
    let data: unknown;
    try { data = await resp.json(); } catch { data = await resp.text(); }
    if (!resp.ok) throw new Error(`Karix ${resp.status}: ${JSON.stringify(data)}`);
    return data;
  }

  async deleteTemplate(templateId: string, waba_number?: string): Promise<void> {
    const url = `${this.wabaPath(waba_number)}/${encodeURIComponent(templateId)}`;
    const resp = await fetch(url, { method: "DELETE", headers: this.headers() });
    if (!resp.ok) {
      let data: unknown;
      try { data = await resp.json(); } catch { data = await resp.text(); }
      throw new Error(`Karix ${resp.status}: ${JSON.stringify(data)}`);
    }
  }
}
