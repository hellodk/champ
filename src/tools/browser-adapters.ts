/**
 * Protocol-neutral browser adapters.
 *
 * Champ speaks W3C WebDriver by default. Playwright, CDP and remote WebDriver
 * endpoints are opt-in adapters selected with CHAMP_BROWSER_PROTOCOL. The
 * extension and CLI ship no browser binary and no mandatory browser package.
 */

const PLAYWRIGHT_MODULE = "playwright";
const W3C_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const DEFAULT_WEBDRIVER_URL = "http://127.0.0.1:4444";
const DEFAULT_TIMEOUT_MS = 30_000;

export type BrowserProtocol = "webdriver" | "remote" | "cdp" | "playwright";
export type PlaywrightBrowserName = "chromium" | "firefox" | "webkit";

const VALID_PROTOCOLS: BrowserProtocol[] = [
  "webdriver",
  "remote",
  "cdp",
  "playwright",
];
const VALID_PLAYWRIGHT_BROWSERS: PlaywrightBrowserName[] = [
  "chromium",
  "firefox",
  "webkit",
];

export interface BrowserSettings {
  protocol: BrowserProtocol;
  webdriverUrl: string;
  remoteUrl?: string;
  cdpUrl?: string;
  playwrightBrowser: PlaywrightBrowserName;
  capabilities: Record<string, unknown>;
  timeoutMs: number;
}

export interface BrowserOperationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserAdapter {
  readonly protocol: BrowserProtocol;
  navigate(url: string, options?: BrowserOperationOptions): Promise<void>;
  click(selector: string, options?: BrowserOperationOptions): Promise<void>;
  type(
    selector: string,
    text: string,
    options?: BrowserOperationOptions,
  ): Promise<void>;
  screenshot(options?: BrowserOperationOptions): Promise<string>;
  close(): Promise<void>;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CdpSocket {
  onmessage?: ((event: { data: string }) => void) | null;
  onopen?: (() => void) | null;
  onerror?: ((error: unknown) => void) | null;
  readyState?: number;
  send(payload: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => CdpSocket;

export interface BrowserAdapterDeps {
  fetch?: FetchLike;
  webSocket?: WebSocketFactory;
  importPlaywright?: () => Promise<unknown>;
}

export interface BrowserRuntimeStatus {
  protocol: BrowserProtocol;
  endpoint: string;
  ok: boolean;
  message: string;
}

interface PlaywrightPage {
  goto(url: string): Promise<unknown>;
  screenshot(): Promise<Buffer | string>;
  click(selector: string): Promise<unknown>;
  fill(selector: string, text: string): Promise<unknown>;
  close(): Promise<unknown>;
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<unknown>;
}

interface PlaywrightBrowserType {
  launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
}

type PlaywrightModule = Record<PlaywrightBrowserName, PlaywrightBrowserType>;

interface CdpMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireUrl(raw: string, envName: string, schemes: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${envName} must be a valid URL (got "${raw}")`);
  }
  if (!schemes.includes(parsed.protocol)) {
    throw new Error(
      `${envName} must use ${schemes.map((scheme) => scheme.replace(":", "")).join(" or ")} (got "${parsed.protocol}")`,
    );
  }
  return raw.replace(/\/+$/, "") || raw;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("CHAMP_BROWSER_TIMEOUT_MS must be a positive integer");
  }
  return value;
}

function parseCapabilities(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CHAMP_BROWSER_CAPABILITIES_JSON must be valid JSON");
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new Error("CHAMP_BROWSER_CAPABILITIES_JSON must be a JSON object");
  }
  return record;
}

export function readBrowserSettings(
  env: Record<string, string | undefined> = process.env,
): BrowserSettings {
  const protocolRaw = (env.CHAMP_BROWSER_PROTOCOL ?? "webdriver").toLowerCase();
  if (!VALID_PROTOCOLS.includes(protocolRaw as BrowserProtocol)) {
    throw new Error(
      `CHAMP_BROWSER_PROTOCOL must be one of ${VALID_PROTOCOLS.join(", ")} (got "${protocolRaw}")`,
    );
  }
  const protocol = protocolRaw as BrowserProtocol;

  const playwrightRaw = (
    env.CHAMP_PLAYWRIGHT_BROWSER ?? "chromium"
  ).toLowerCase();
  if (
    !VALID_PLAYWRIGHT_BROWSERS.includes(playwrightRaw as PlaywrightBrowserName)
  ) {
    throw new Error(
      `CHAMP_PLAYWRIGHT_BROWSER must be one of ${VALID_PLAYWRIGHT_BROWSERS.join(", ")}`,
    );
  }

  const settings: BrowserSettings = {
    protocol,
    webdriverUrl: requireUrl(
      env.CHAMP_WEBDRIVER_URL ?? DEFAULT_WEBDRIVER_URL,
      "CHAMP_WEBDRIVER_URL",
      ["http:", "https:"],
    ),
    remoteUrl:
      env.CHAMP_REMOTE_BROWSER_URL === undefined
        ? undefined
        : requireUrl(env.CHAMP_REMOTE_BROWSER_URL, "CHAMP_REMOTE_BROWSER_URL", [
            "http:",
            "https:",
          ]),
    cdpUrl:
      env.CHAMP_CDP_URL === undefined
        ? undefined
        : requireUrl(env.CHAMP_CDP_URL, "CHAMP_CDP_URL", [
            "ws:",
            "wss:",
            "http:",
            "https:",
          ]),
    playwrightBrowser: playwrightRaw as PlaywrightBrowserName,
    capabilities: parseCapabilities(env.CHAMP_BROWSER_CAPABILITIES_JSON),
    timeoutMs: parseTimeout(env.CHAMP_BROWSER_TIMEOUT_MS),
  };

  if (protocol === "remote" && !settings.remoteUrl) {
    throw new Error("CHAMP_REMOTE_BROWSER_URL is required for remote");
  }
  if (protocol === "cdp" && !settings.cdpUrl) {
    throw new Error("CHAMP_CDP_URL is required for cdp");
  }
  return settings;
}

export function browserEndpoint(settings: BrowserSettings): string {
  switch (settings.protocol) {
    case "remote":
      if (!settings.remoteUrl) {
        throw new Error("CHAMP_REMOTE_BROWSER_URL is required for remote");
      }
      return settings.remoteUrl;
    case "cdp":
      if (!settings.cdpUrl) {
        throw new Error("CHAMP_CDP_URL is required for cdp");
      }
      return settings.cdpUrl;
    case "playwright":
      return `optional:${settings.playwrightBrowser}`;
    case "webdriver":
      return settings.webdriverUrl;
  }
}

function endpointUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function describeHttpEndpoint(
  endpoint: string,
  path: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const response = await fetchImpl(endpointUrl(endpoint, path), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

export async function describeBrowserRuntime(
  settings: BrowserSettings,
  deps: BrowserAdapterDeps = {},
): Promise<BrowserRuntimeStatus> {
  const endpoint = browserEndpoint(settings);
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  if (settings.protocol === "playwright") {
    return {
      protocol: settings.protocol,
      endpoint,
      ok: true,
      message:
        "optional Playwright adapter configured. Champ does not bundle browsers; install Playwright separately to use it.",
    };
  }

  const label =
    settings.protocol === "remote"
      ? "Remote WebDriver"
      : settings.protocol === "cdp"
        ? "CDP"
        : "W3C WebDriver";

  if (settings.protocol === "cdp" && /^wss?:/.test(endpoint)) {
    return {
      protocol: settings.protocol,
      endpoint,
      ok: true,
      message: `CDP adapter configured at ${endpoint}. No browser binary is bundled.`,
    };
  }

  const endpointEnv =
    settings.protocol === "remote"
      ? "CHAMP_REMOTE_BROWSER_URL"
      : settings.protocol === "cdp"
        ? "CHAMP_CDP_URL"
        : "CHAMP_WEBDRIVER_URL";
  try {
    await describeHttpEndpoint(
      endpoint,
      settings.protocol === "cdp" ? "/json/version" : "/status",
      fetchImpl,
    );
    return {
      protocol: settings.protocol,
      endpoint,
      ok: true,
      message: `${label} endpoint ready at ${endpoint}`,
    };
  } catch (error) {
    return {
      protocol: settings.protocol,
      endpoint,
      ok: false,
      message: `${label} endpoint unavailable at ${endpoint}: ${errorMessage(error)}. Start an adapter endpoint or set ${endpointEnv}.`,
    };
  }
}

function resolveOptions(
  options: BrowserOperationOptions | undefined,
  timeoutMs: number,
): {
  timeoutMs: number;
  signal?: AbortSignal;
} {
  return {
    timeoutMs: options?.timeoutMs ?? timeoutMs,
    signal: options?.signal,
  };
}

class WebDriverAdapter implements BrowserAdapter {
  readonly protocol: BrowserProtocol;
  private sessionId: string | undefined;

  constructor(
    protocol: BrowserProtocol,
    private readonly baseUrl: string,
    private readonly capabilities: Record<string, unknown>,
    private readonly defaultTimeoutMs: number,
    private readonly fetchImpl: FetchLike,
  ) {
    this.protocol = protocol;
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    options?: BrowserOperationOptions,
  ): Promise<unknown> {
    const resolved = resolveOptions(options, this.defaultTimeoutMs);
    if (resolved.signal?.aborted) {
      throw new Error("operation aborted");
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    resolved.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, resolved.timeoutMs);

    try {
      const response = await this.fetchImpl(endpointUrl(this.baseUrl, path), {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed: { value?: unknown } = text
        ? (JSON.parse(text) as { value?: unknown })
        : {};
      if (!response.ok) {
        throw new Error(`WebDriver HTTP ${response.status}`);
      }
      const value = parsed.value;
      const error = asRecord(value);
      if (error && typeof error.error === "string") {
        const detail = typeof error.message === "string" ? error.message : "";
        throw new Error(
          detail ? `${error.error}: ${detail}` : String(error.error),
        );
      }
      return value;
    } catch (error) {
      if (resolved.signal?.aborted) throw new Error("operation aborted");
      if (timedOut) {
        throw new Error(`operation timed out after ${resolved.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      resolved.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async sessionIdFor(
    options?: BrowserOperationOptions,
  ): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const value = await this.request(
      "POST",
      "/session",
      { capabilities: { alwaysMatch: this.capabilities } },
      options,
    );
    const record = asRecord(value);
    const sessionId = record?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(
        "WebDriver session response did not include a session id",
      );
    }
    this.sessionId = sessionId;
    return sessionId;
  }

  private async elementId(
    selector: string,
    options?: BrowserOperationOptions,
  ): Promise<string> {
    const sessionId = await this.sessionIdFor(options);
    const value = await this.request(
      "POST",
      `/session/${sessionId}/element`,
      { using: "css selector", value: selector },
      options,
    );
    const record = asRecord(value);
    const elementId = record?.[W3C_ELEMENT_KEY] ?? record?.ELEMENT;
    if (typeof elementId !== "string" || elementId.length === 0) {
      throw new Error(
        `WebDriver response did not include an element id for ${selector}`,
      );
    }
    return elementId;
  }

  async navigate(
    url: string,
    options?: BrowserOperationOptions,
  ): Promise<void> {
    const sessionId = await this.sessionIdFor(options);
    await this.request("POST", `/session/${sessionId}/url`, { url }, options);
  }

  async click(
    selector: string,
    options?: BrowserOperationOptions,
  ): Promise<void> {
    const sessionId = await this.sessionIdFor(options);
    const elementId = await this.elementId(selector, options);
    await this.request(
      "POST",
      `/session/${sessionId}/element/${elementId}/click`,
      {},
      options,
    );
  }

  async type(
    selector: string,
    text: string,
    options?: BrowserOperationOptions,
  ): Promise<void> {
    const sessionId = await this.sessionIdFor(options);
    const elementId = await this.elementId(selector, options);
    await this.request(
      "POST",
      `/session/${sessionId}/element/${elementId}/value`,
      { text },
      options,
    );
  }

  async screenshot(options?: BrowserOperationOptions): Promise<string> {
    const sessionId = await this.sessionIdFor(options);
    const value = await this.request(
      "GET",
      `/session/${sessionId}/screenshot`,
      undefined,
      options,
    );
    if (typeof value !== "string") {
      throw new Error("WebDriver screenshot response was not base64 text");
    }
    return value;
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    try {
      await this.request("DELETE", `/session/${sessionId}`, undefined);
    } catch {
      // Best-effort cleanup; a dead driver session needs no further action.
    }
  }
}

class PlaywrightAdapter implements BrowserAdapter {
  readonly protocol: BrowserProtocol = "playwright";
  private browser: PlaywrightBrowser | undefined;
  private page: PlaywrightPage | undefined;

  constructor(
    private readonly browserName: PlaywrightBrowserName,
    private readonly importPlaywright: () => Promise<unknown>,
  ) {}

  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.page) return this.page;
    const imported = await this.importPlaywright();
    const module = imported as PlaywrightModule;
    const browserType = module[this.browserName];
    if (!browserType) {
      throw new Error(
        `Playwright adapter does not provide ${this.browserName}`,
      );
    }
    this.browser = await browserType.launch({ headless: true });
    this.page = await this.browser.newPage();
    return this.page;
  }

  async navigate(
    url: string,
    options?: BrowserOperationOptions,
  ): Promise<void> {
    const page = await this.ensurePage();
    await page.goto(url);
    void options;
  }

  async click(
    selector: string,
    options?: BrowserOperationOptions,
  ): Promise<void> {
    const page = await this.ensurePage();
    await page.click(selector);
    void options;
  }

  async type(
    selector: string,
    text: string,
    options?: BrowserOperationOptions,
  ): Promise<void> {
    const page = await this.ensurePage();
    await page.fill(selector, text);
    void options;
  }

  async screenshot(): Promise<string> {
    const page = await this.ensurePage();
    const data = await page.screenshot();
    return Buffer.isBuffer(data) ? data.toString("base64") : String(data);
  }

  async close(): Promise<void> {
    this.page = undefined;
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await browser.close();
  }
}

class CdpAdapter implements BrowserAdapter {
  readonly protocol: BrowserProtocol = "cdp";
  private socket: CdpSocket | undefined;
  private nextId = 0;

  constructor(
    private readonly cdpUrl: string,
    private readonly defaultTimeoutMs: number,
    private readonly fetchImpl: FetchLike,
    private readonly webSocket: WebSocketFactory,
  ) {}

  private async connect(): Promise<CdpSocket> {
    if (this.socket) return this.socket;

    let socketUrl = this.cdpUrl;
    if (/^https?:/.test(this.cdpUrl)) {
      const response = await this.fetchImpl(
        endpointUrl(this.cdpUrl, "/json/list"),
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) {
        throw new Error(`CDP target list returned HTTP ${response.status}`);
      }
      const targets = JSON.parse(await response.text()) as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" && candidate.webSocketDebuggerUrl,
      );
      if (!target?.webSocketDebuggerUrl) {
        throw new Error("CDP target list has no page WebSocket endpoint");
      }
      socketUrl = target.webSocketDebuggerUrl;
    }

    const socket = this.webSocket(socketUrl);
    if (socket.readyState !== 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("CDP connection timed out"));
        }, this.defaultTimeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          socket.onopen = undefined;
          socket.onerror = undefined;
        };
        socket.onopen = () => {
          cleanup();
          resolve();
        };
        socket.onerror = (error) => {
          cleanup();
          reject(new Error(`CDP connection failed: ${errorMessage(error)}`));
        };
      });
    }
    this.socket = socket;
    return socket;
  }

  private async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const socket = await this.connect();
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.onmessage = undefined;
        reject(new Error(`CDP ${method} timed out`));
      }, this.defaultTimeoutMs);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as {
          id: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.onmessage = undefined;
        if (message.error) {
          reject(new Error(message.error.message ?? `CDP ${method} failed`));
        } else {
          resolve(message.result);
        }
      };
      const payload: CdpMessage = { id, method, params };
      socket.send(JSON.stringify(payload));
    });
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const record = asRecord(result);
    if (record?.exceptionDetails) {
      throw new Error("CDP evaluation failed in the page");
    }
    return asRecord(record?.result)?.value;
  }

  async navigate(
    url: string,
    options?: BrowserOperationOptions,
  ): Promise<void> {
    void options;
    const result = asRecord(await this.send("Page.navigate", { url }));
    if (typeof result?.errorText === "string" && result.errorText) {
      throw new Error(result.errorText);
    }
  }

  async click(
    selector: string,
    options?: BrowserOperationOptions,
  ): Promise<void> {
    void options;
    const literal = JSON.stringify(selector);
    await this.evaluate(
      `(() => { const element = document.querySelector(${literal}); if (!element) throw new Error('element not found: ' + ${literal}); element.click(); return true; })()`,
    );
  }

  async type(
    selector: string,
    text: string,
    options?: BrowserOperationOptions,
  ): Promise<void> {
    void options;
    const selectorLiteral = JSON.stringify(selector);
    const textLiteral = JSON.stringify(text);
    await this.evaluate(
      `(() => { const element = document.querySelector(${selectorLiteral}); if (!element) throw new Error('element not found: ' + ${selectorLiteral}); element.value = ${textLiteral}; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    );
  }

  async screenshot(): Promise<string> {
    const result = asRecord(await this.send("Page.captureScreenshot"));
    if (typeof result?.data !== "string") {
      throw new Error("CDP screenshot response had no data");
    }
    return result.data;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) socket.close();
  }
}

export function createBrowserAdapter(
  settings: BrowserSettings = readBrowserSettings(),
  deps: BrowserAdapterDeps = {},
): BrowserAdapter {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  switch (settings.protocol) {
    case "webdriver":
      return new WebDriverAdapter(
        "webdriver",
        settings.webdriverUrl,
        settings.capabilities,
        settings.timeoutMs,
        fetchImpl,
      );
    case "remote":
      if (!settings.remoteUrl) {
        throw new Error("CHAMP_REMOTE_BROWSER_URL is required for remote");
      }
      return new WebDriverAdapter(
        "remote",
        settings.remoteUrl,
        settings.capabilities,
        settings.timeoutMs,
        fetchImpl,
      );
    case "cdp": {
      if (!settings.cdpUrl) {
        throw new Error("CHAMP_CDP_URL is required for cdp");
      }
      const webSocket =
        deps.webSocket ??
        ((url: string): CdpSocket => {
          const Ctor = (
            globalThis as unknown as {
              WebSocket?: new (socketUrl: string) => CdpSocket;
            }
          ).WebSocket;
          if (!Ctor) {
            throw new Error(
              "CDP adapter requires a WebSocket implementation (Node 22+ global WebSocket)",
            );
          }
          return new Ctor(url);
        });
      return new CdpAdapter(
        settings.cdpUrl,
        settings.timeoutMs,
        fetchImpl,
        webSocket,
      );
    }
    case "playwright": {
      const importPlaywright =
        deps.importPlaywright ??
        (async (): Promise<unknown> => {
          const moduleName: string = PLAYWRIGHT_MODULE;
          return import(moduleName);
        });
      return new PlaywrightAdapter(
        settings.playwrightBrowser,
        importPlaywright,
      );
    }
  }
}
