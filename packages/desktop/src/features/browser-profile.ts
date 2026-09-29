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
  setUserAgent(userAgent: string): void;
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
 * Applies to the browser profile session only, so browser webviews and popups get the
 * plain Chrome user agent while Paseo's own renderer keeps Electron's default. Must run
 * before any browser webview is created: existing WebContents keep the old value.
 */
export function applyPaseoBrowserProfileUserAgent(
  sessions: { fromPartition(partition: string): UserAgentSession },
  appName: string,
): void {
  const profileSession = sessions.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
  profileSession.setUserAgent(plainChromeUserAgent(profileSession.getUserAgent(), appName));
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
