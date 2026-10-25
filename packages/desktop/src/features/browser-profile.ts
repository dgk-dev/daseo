export const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";
const LEGACY_BROWSER_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{13,}-[0-9a-f]+)$/i;
const MAX_LEGACY_BROWSER_PROFILES = 1000;

const PASEO_BROWSER_STORAGE_TYPES = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "serviceworkers",
  "cachestorage",
  "websql",
] as const;

interface BrowserProfileSession {
  clearStorageData(options: {
    storages: Array<(typeof PASEO_BROWSER_STORAGE_TYPES)[number]>;
  }): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

interface BrowserProfileGuest {
  readonly id: number;
  isDestroyed(): boolean;
  reload(): void;
}

interface BrowserProfileWebContents extends BrowserProfileGuest {
  readonly session: object;
  getType(): string;
}

interface ListBrowserProfileGuestsInput {
  profileSession: object;
  webContents: BrowserProfileWebContents[];
}

interface ClearBrowserProfileInput {
  profileSessions: BrowserProfileSession[];
  listGuests(): BrowserProfileGuest[];
  logReloadError(guestId: number, error: unknown): void;
}

interface ElectronSessions {
  fromPartition(partition: string): BrowserProfileSession;
}

export function getPaseoBrowserProfileSession(sessions: ElectronSessions): BrowserProfileSession {
  return sessions.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
}

interface UserAgentSession {
  getUserAgent(): string;
  setUserAgent(userAgent: string, acceptLanguages?: string): void;
}

/**
 * Electron's default user agent carries `<app name>/<version>` and `Electron/<version>`
 * tokens after the Chrome token. Sites read them as an embedded or automated client, so
 * the browser profile presents the Chrome string it is built from. The Chrome version
 * token stays as is, and UA client hints already report only Chromium brands.
 */
export function plainChromeUserAgent(userAgent: string, appName: string): string {
  const escapedAppName = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return userAgent
    .replace(new RegExp(`\\s${escapedAppName}/\\S+`, "g"), "")
    .replace(/\sElectron\/\S+/g, "");
}

/**
 * The languages Electron puts in every WebContents' renderer preferences, which is where
 * `navigator.languages` comes from: the app locale, then the system's preferred languages
 * (electron_api_web_contents.cc). The network stack's Accept-Language defaults to the app locale
 * alone, so the session is given this same list and Chromium derives the header's q-values.
 */
export function rendererAcceptLanguages(locale: string, preferredLanguages: string[]): string {
  return [locale, ...preferredLanguages.filter((language) => language !== locale)].join(",");
}

/**
 * Applies to the browser profile session only, so browser webviews and popups get the
 * plain Chrome user agent and an Accept-Language that matches `navigator.languages`, while
 * Paseo's own renderer keeps Electron's defaults. Must run before any browser webview is
 * created: existing WebContents keep the old value.
 */
export function applyPaseoBrowserProfileUserAgent(
  sessions: { fromPartition(partition: string): UserAgentSession },
  appName: string,
  acceptLanguages: string,
): void {
  const profileSession = sessions.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
  profileSession.setUserAgent(
    plainChromeUserAgent(profileSession.getUserAgent(), appName),
    acceptLanguages,
  );
}

export interface UserAgentBrandVersion {
  brand: string;
  version: string;
}

export interface ClientHintMetadata {
  brands: UserAgentBrandVersion[];
  mobile: boolean;
  platform: string;
}

// Chromium's updated GREASE brand (components/embedder_support/user_agent_utils.cc,
// GetGreasedUserAgentBrandVersion), seeded by the major version.
const GREASE_CHARACTERS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];

/**
 * The brand list `navigator.userAgentData` reports for a Chromium build without a product
 * brand: the GREASE brand and Chromium, ordered by the seeded shuffle in GenerateBrandVersionList
 * ({0, 1} for an even major version, {1, 0} for an odd one). `full` gives fullVersionList.
 */
export function chromiumBrandVersionList(
  chromeVersion: string,
  versionKind: "major" | "full",
): UserAgentBrandVersion[] {
  const majorVersion = chromeVersion.split(".")[0] ?? chromeVersion;
  const seed = Number.parseInt(majorVersion, 10);
  const greaseCharacter = (index: number) =>
    GREASE_CHARACTERS[index % GREASE_CHARACTERS.length] ?? " ";
  const greaseMajorVersion = GREASE_VERSIONS[seed % GREASE_VERSIONS.length] ?? "99";
  const grease = {
    brand: `Not${greaseCharacter(seed)}A${greaseCharacter(seed + 1)}Brand`,
    version: versionKind === "full" ? `${greaseMajorVersion}.0.0.0` : greaseMajorVersion,
  };
  const chromium = {
    brand: "Chromium",
    version: versionKind === "full" ? chromeVersion : majorVersion,
  };
  return seed % 2 === 0 ? [grease, chromium] : [chromium, grease];
}

/** Chromium's `GetPlatformForUAMetadata` names. */
export function userAgentDataPlatform(nodePlatform: string): string {
  if (nodePlatform === "darwin") return "macOS";
  if (nodePlatform === "win32") return "Windows";
  if (nodePlatform === "linux") return "Linux";
  return "Unknown";
}

function structuredHeaderString(value: string): string {
  return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

/** The three low-entropy client hints Chrome sends on every secure request, in its format. */
export function clientHintHeaders(metadata: ClientHintMetadata): Record<string, string> {
  return {
    "Sec-CH-UA": metadata.brands
      .map(
        ({ brand, version }) =>
          `${structuredHeaderString(brand)};v=${structuredHeaderString(version)}`,
      )
      .join(", "),
    "Sec-CH-UA-Mobile": metadata.mobile ? "?1" : "?0",
    "Sec-CH-UA-Platform": structuredHeaderString(metadata.platform),
  };
}

// Client hints go to potentially trustworthy URLs only. The filter keeps plain-http requests out
// of JavaScript; sendsClientHints makes the exact call.
const CLIENT_HINT_URL_PATTERNS = [
  "https://*/*",
  "wss://*/*",
  "http://localhost/*",
  "http://*.localhost/*",
  "http://127.0.0.1/*",
  "http://[::1]/*",
  "ws://localhost/*",
  "ws://*.localhost/*",
  "ws://127.0.0.1/*",
  "ws://[::1]/*",
];

export function sendsClientHints(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "ws:") return false;
  const host = parsed.hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

// Per-tab overrides from device emulation; null means the emulated user agent sends none.
const clientHintOverrides = new Map<number, Record<string, string> | null>();

export function setPaseoBrowserClientHintOverride(
  webContentsId: number,
  metadata: ClientHintMetadata | null,
): void {
  clientHintOverrides.set(webContentsId, metadata ? clientHintHeaders(metadata) : null);
}

export function clearPaseoBrowserClientHintOverride(webContentsId: number): void {
  clientHintOverrides.delete(webContentsId);
}

interface ClientHintRequest {
  url: string;
  webContentsId?: number;
  requestHeaders: Record<string, string>;
}

/** Null leaves the request untouched. Headers already on the request are never replaced. */
export function requestHeadersWithClientHints(
  request: ClientHintRequest,
  defaultHints: Record<string, string>,
): Record<string, string> | null {
  if (!sendsClientHints(request.url)) return null;
  const hints =
    request.webContentsId !== undefined && clientHintOverrides.has(request.webContentsId)
      ? clientHintOverrides.get(request.webContentsId)
      : defaultHints;
  if (!hints) return null;
  const present = new Set(Object.keys(request.requestHeaders).map((name) => name.toLowerCase()));
  const missing = Object.entries(hints).filter(([name]) => !present.has(name.toLowerCase()));
  if (missing.length === 0) return null;
  return { ...request.requestHeaders, ...Object.fromEntries(missing) };
}

interface ClientHintSession {
  webRequest: {
    onBeforeSendHeaders(
      filter: { urls: string[] },
      listener: (
        details: ClientHintRequest,
        callback: (response: { requestHeaders?: Record<string, string> }) => void,
      ) => void,
    ): void;
  };
}

/**
 * Electron has no client-hints delegate, so the browser profile sends no Sec-CH-UA headers at
 * all while its user agent and `navigator.userAgentData` say Chromium. The headers are added here
 * from the same metadata the renderer reports. Electron allows one onBeforeSendHeaders listener
 * per session; this is the browser profile's.
 */
export function installPaseoBrowserClientHints(
  sessions: { fromPartition(partition: string): ClientHintSession },
  defaults: ClientHintMetadata,
): void {
  const defaultHints = clientHintHeaders(defaults);
  sessions
    .fromPartition(PASEO_BROWSER_PROFILE_PARTITION)
    .webRequest.onBeforeSendHeaders({ urls: CLIENT_HINT_URL_PATTERNS }, (details, callback) => {
      const requestHeaders = requestHeadersWithClientHints(details, defaultHints);
      callback(requestHeaders ? { requestHeaders } : {});
    });
}

export function readLegacyPaseoBrowserIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const browserIds = new Set<string>();
  for (const value of input) {
    if (typeof value === "string" && LEGACY_BROWSER_ID_PATTERN.test(value)) {
      browserIds.add(value);
      if (browserIds.size >= MAX_LEGACY_BROWSER_PROFILES) {
        break;
      }
    }
  }
  return [...browserIds];
}

export function getPaseoBrowserProfileSessions(
  sessions: ElectronSessions,
  legacyBrowserIds: string[],
): [BrowserProfileSession, ...BrowserProfileSession[]] {
  return [
    getPaseoBrowserProfileSession(sessions),
    // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
    ...legacyBrowserIds.map((browserId) =>
      sessions.fromPartition(`${PASEO_BROWSER_PROFILE_PARTITION}-${browserId}`),
    ),
  ];
}

export function getLegacyPaseoBrowserProfileSession(
  sessions: ElectronSessions,
  browserId: string,
): BrowserProfileSession | null {
  const [legacyBrowserId] = readLegacyPaseoBrowserIds([browserId]);
  return legacyBrowserId
    ? sessions.fromPartition(`${PASEO_BROWSER_PROFILE_PARTITION}-${legacyBrowserId}`)
    : null;
}

export function listPaseoBrowserProfileGuests(
  input: ListBrowserProfileGuestsInput,
): BrowserProfileGuest[] {
  return input.webContents.filter(
    (contents) =>
      !contents.isDestroyed() &&
      (contents.getType() === "webview" || contents.getType() === "window") &&
      contents.session === input.profileSession,
  );
}

export async function clearPaseoBrowserProfile(input: ClearBrowserProfileInput): Promise<void> {
  await Promise.all(
    input.profileSessions.flatMap((profileSession) => [
      profileSession.clearStorageData({ storages: [...PASEO_BROWSER_STORAGE_TYPES] }),
      profileSession.clearCache(),
      profileSession.clearAuthCache(),
    ]),
  );

  for (const guest of input.listGuests()) {
    if (guest.isDestroyed()) {
      continue;
    }
    try {
      guest.reload();
    } catch (error) {
      input.logReloadError(guest.id, error);
    }
  }
}
