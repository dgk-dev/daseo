import type { BrowserAutomationTabEvent } from "@getpaseo/protocol/browser-automation/rpc-schemas";

// Daseo delta 92. A popup a click opened, a popup that closed itself, or a download used to be
// invisible to the agent until it happened to list tabs. Each is queued for its tab and handed out
// once, with the next tool result for that tab or for the agent that last used it (Aside's "agent
// signals").

export type BrowserTabEventInput = Omit<BrowserAutomationTabEvent, "browserId" | "timestamp">;

const MAX_EVENTS_PER_TAB = 20;
const MAX_TABS = 200;
const MAX_EVENTS_PER_DELIVERY = 20;

export class BrowserTabEventQueue {
  private readonly eventsByBrowserId = new Map<string, BrowserAutomationTabEvent[]>();
  private readonly agentByBrowserId = new Map<string, string>();
  private readonly parentByBrowserId = new Map<string, string>();
  private readonly listeners = new Set<(event: BrowserAutomationTabEvent) => void>();

  public constructor(private readonly now: () => number = Date.now) {}

  public record(browserId: string, event: BrowserTabEventInput): void {
    const list = this.eventsByBrowserId.get(browserId) ?? [];
    const recorded = { ...event, browserId, timestamp: this.now() };
    list.push(recorded);
    for (const listener of this.listeners) listener(recorded);
    if (list.length > MAX_EVENTS_PER_TAB) list.splice(0, list.length - MAX_EVENTS_PER_TAB);
    // Re-insert so the map's order is least recently touched first.
    this.eventsByBrowserId.delete(browserId);
    this.eventsByBrowserId.set(browserId, list);
    while (this.eventsByBrowserId.size > MAX_TABS) {
      const oldest = this.eventsByBrowserId.keys().next().value;
      if (oldest === undefined) break;
      this.eventsByBrowserId.delete(oldest);
    }
  }

  /** Daseo delta 100: every event as it is recorded (an observed click waits on them). */
  public subscribe(listener: (event: BrowserAutomationTabEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The agent whose command named this tab last; its next result carries the tab's events. */
  public linkAgent(browserId: string, agentId: string): void {
    this.agentByBrowserId.set(browserId, agentId);
  }

  /** A popup belongs to the agent of the tab that opened it until an agent uses it directly. */
  public linkPopup(popupBrowserId: string, openerBrowserId: string): void {
    this.parentByBrowserId.set(popupBrowserId, openerBrowserId);
  }

  /** Events for the named tab and for every tab the agent uses, oldest first; each is given once. */
  public drain(input: { browserId?: string; agentId?: string }): BrowserAutomationTabEvent[] {
    const taken: BrowserAutomationTabEvent[] = [];
    for (const [browserId, events] of this.eventsByBrowserId) {
      const mine =
        browserId === input.browserId ||
        (input.agentId !== undefined && this.agentOf(browserId) === input.agentId);
      if (!mine) continue;
      taken.push(...events);
      this.eventsByBrowserId.delete(browserId);
    }
    taken.sort((a, b) => a.timestamp - b.timestamp);
    return taken.slice(-MAX_EVENTS_PER_DELIVERY);
  }

  /** Drops the links of a tab that is gone; its queued events stay until delivered. */
  public forgetLinks(browserId: string): void {
    if (this.eventsByBrowserId.has(browserId)) return;
    this.agentByBrowserId.delete(browserId);
    this.parentByBrowserId.delete(browserId);
  }

  private agentOf(browserId: string): string | undefined {
    let current: string | undefined = browserId;
    for (let depth = 0; current !== undefined && depth < 10; depth += 1) {
      const agent = this.agentByBrowserId.get(current);
      if (agent !== undefined) return agent;
      current = this.parentByBrowserId.get(current);
    }
    return undefined;
  }
}

const tabEvents = new BrowserTabEventQueue();

export function getPaseoBrowserTabEvents(): BrowserTabEventQueue {
  return tabEvents;
}
