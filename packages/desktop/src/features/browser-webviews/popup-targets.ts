export const BROWSER_POPUP_TARGETS_EVENT = "paseo:event:browser-popup-targets";

export type BrowserPopupDisposition =
  | "default"
  | "foreground-tab"
  | "background-tab"
  | "new-window"
  | "other";

export interface BrowserPopupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPopupTargetSummary {
  browserId: string;
  rootBrowserId: string;
  openerBrowserId: string;
  workspaceId: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isVisible: boolean;
  disposition: BrowserPopupDisposition;
  createdAt: number;
}

export interface BrowserPopupTargetsSnapshot {
  revision: number;
  rootBrowserId: string;
  workspaceId: string;
  hostWebContentsId: number;
  targets: BrowserPopupTargetSummary[];
  reason: "bound" | "created" | "updated" | "focused" | "presentation" | "closed";
  activationBrowserId?: string;
  focusedBrowserId?: string;
}

export type BrowserPopupContentsEvent =
  | "destroyed"
  | "did-start-loading"
  | "did-stop-loading"
  | "did-navigate"
  | "did-navigate-in-page"
  | "page-title-updated"
  | "focus";

export interface BrowserPopupContentsPort {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  focus(): void;
  close(): void;
  subscribe(event: BrowserPopupContentsEvent, listener: () => void): void;
}

export interface BrowserPopupViewPort {
  readonly contents: BrowserPopupContentsPort;
  setBounds(bounds: BrowserPopupBounds): void;
}

export interface BrowserPopupHostViewPort {
  addChildView(view: BrowserPopupViewPort): void;
  setChildViewVisible(view: BrowserPopupViewPort, visible: boolean): void;
  removeChildView(view: BrowserPopupViewPort): void;
}

export interface BrowserPopupTargetRegistration {
  browserId: string;
  rootBrowserId: string;
  openerBrowserId: string;
  workspaceId: string;
  hostWebContentsId: number;
  webContentsId: number;
}

interface BrowserPopupTargetRecord {
  browserId: string;
  rootWebContentsId: number;
  openerWebContentsId: number;
  hostWebContentsId: number;
  disposition: BrowserPopupDisposition;
  createdAt: number;
  view: BrowserPopupViewPort;
  hostView: BrowserPopupHostViewPort;
  registered: boolean;
  visible: boolean;
  requestActivation: boolean;
  parkingBounds: BrowserPopupBounds;
  lastBounds: BrowserPopupBounds | null;
}

interface RootBrowserBinding {
  rootWebContentsId: number;
  rootBrowserId: string;
  workspaceId: string;
  hostWebContentsId: number;
}

export interface BrowserPopupTargetManagerOptions {
  createBrowserId(): string;
  now?: () => number;
  maxTargetsPerRoot?: number;
  maxTargetsPerHost?: number;
  openBurstLimit?: number;
  openBurstWindowMs?: number;
  onRegisterTarget?(registration: BrowserPopupTargetRegistration): void;
  onUnregisterTarget?(browserId: string): void;
  onSetActiveTarget?(input: {
    browserId: string;
    workspaceId: string;
    hostWebContentsId: number;
  }): void;
  onSnapshot?(snapshot: BrowserPopupTargetsSnapshot): void;
  /**
   * Second line of defense behind the renderer's per-pane gating: when this
   * returns false, visible presentation requests are downgraded to parking so
   * a background workspace can never paint a popup over the foreground one.
   * Unknown foreground state must return true (fail-open).
   */
  isPresentationAllowed?(input: { workspaceId: string; hostWebContentsId: number }): boolean;
}

const DEFAULT_POPUP_WIDTH = 800;
const DEFAULT_POPUP_HEIGHT = 600;
const DEFAULT_MAX_TARGETS_PER_ROOT = 12;
const DEFAULT_MAX_TARGETS_PER_HOST = 64;
const DEFAULT_OPEN_BURST_LIMIT = 20;
const DEFAULT_OPEN_BURST_WINDOW_MS = 2_000;

export class BrowserPopupTargetManager {
  private readonly createBrowserId: () => string;
  private readonly now: () => number;
  private readonly maxTargetsPerRoot: number;
  private readonly maxTargetsPerHost: number;
  private readonly openBurstLimit: number;
  private readonly openBurstWindowMs: number;
  private readonly onRegisterTarget: (registration: BrowserPopupTargetRegistration) => void;
  private readonly onUnregisterTarget: (browserId: string) => void;
  private readonly onSetActiveTarget: BrowserPopupTargetManagerOptions["onSetActiveTarget"];
  private readonly onSnapshot: (snapshot: BrowserPopupTargetsSnapshot) => void;
  private readonly isPresentationAllowed: BrowserPopupTargetManagerOptions["isPresentationAllowed"];
  private readonly targetsByBrowserId = new Map<string, BrowserPopupTargetRecord>();
  private readonly targetBrowserIdsByWebContentsId = new Map<number, string>();
  private readonly rootBindingsByWebContentsId = new Map<number, RootBrowserBinding>();
  private readonly openAttemptsByRootWebContentsId = new Map<number, number[]>();
  private revision = 0;

  public constructor(options: BrowserPopupTargetManagerOptions) {
    this.createBrowserId = options.createBrowserId;
    this.now = options.now ?? Date.now;
    this.maxTargetsPerRoot = options.maxTargetsPerRoot ?? DEFAULT_MAX_TARGETS_PER_ROOT;
    this.maxTargetsPerHost = options.maxTargetsPerHost ?? DEFAULT_MAX_TARGETS_PER_HOST;
    this.openBurstLimit = options.openBurstLimit ?? DEFAULT_OPEN_BURST_LIMIT;
    this.openBurstWindowMs = options.openBurstWindowMs ?? DEFAULT_OPEN_BURST_WINDOW_MS;
    this.onRegisterTarget = options.onRegisterTarget ?? (() => {});
    this.onUnregisterTarget = options.onUnregisterTarget ?? (() => {});
    this.onSetActiveTarget = options.onSetActiveTarget;
    this.onSnapshot = options.onSnapshot ?? (() => {});
    this.isPresentationAllowed = options.isPresentationAllowed;
  }

  public tryAdmit(input: { rootWebContentsId: number; hostWebContentsId: number }): boolean {
    const rootCount = this.targetsForRootWebContents(input.rootWebContentsId).length;
    if (rootCount >= this.maxTargetsPerRoot) {
      return false;
    }
    const hostCount = Array.from(this.targetsByBrowserId.values()).filter(
      (target) => target.hostWebContentsId === input.hostWebContentsId,
    ).length;
    if (hostCount >= this.maxTargetsPerHost) {
      return false;
    }

    const now = this.now();
    const recentAttempts = (
      this.openAttemptsByRootWebContentsId.get(input.rootWebContentsId) ?? []
    ).filter((timestamp) => now - timestamp < this.openBurstWindowMs);
    if (recentAttempts.length >= this.openBurstLimit) {
      this.openAttemptsByRootWebContentsId.set(input.rootWebContentsId, recentAttempts);
      return false;
    }
    recentAttempts.push(now);
    this.openAttemptsByRootWebContentsId.set(input.rootWebContentsId, recentAttempts);
    return true;
  }

  public adopt(input: {
    rootWebContentsId: number;
    openerWebContentsId: number;
    hostWebContentsId: number;
    disposition: BrowserPopupDisposition;
    view: BrowserPopupViewPort;
    hostView: BrowserPopupHostViewPort;
    initialBounds?: Partial<BrowserPopupBounds>;
    requestActivation?: boolean;
  }): string {
    if (input.view.contents.isDestroyed()) {
      throw new Error("Popup WebContents is unavailable");
    }
    if (this.targetBrowserIdsByWebContentsId.has(input.view.contents.id)) {
      throw new Error("Popup WebContents is already managed");
    }

    const browserId = this.allocateBrowserId();
    const initialBounds = normalizeInitialBounds(input.initialBounds);
    const parkingBounds = { ...initialBounds };
    const target: BrowserPopupTargetRecord = {
      browserId,
      rootWebContentsId: input.rootWebContentsId,
      openerWebContentsId: input.openerWebContentsId,
      hostWebContentsId: input.hostWebContentsId,
      disposition: input.disposition,
      createdAt: this.now(),
      view: input.view,
      hostView: input.hostView,
      registered: false,
      visible: false,
      requestActivation: input.requestActivation === true,
      parkingBounds,
      lastBounds: parkingBounds,
    };

    // A hidden WebContentsView collapses its renderer viewport to 0x0. The host parks the
    // target inside a never-shown native BaseWindow instead, preserving its real viewport
    // for trusted background input and screenshots without painting over the workspace.
    input.view.setBounds(parkingBounds);
    input.hostView.addChildView(input.view);
    this.targetsByBrowserId.set(browserId, target);
    this.targetBrowserIdsByWebContentsId.set(input.view.contents.id, browserId);
    this.subscribeToTarget(target);

    const binding = this.rootBindingsByWebContentsId.get(input.rootWebContentsId);
    if (binding) {
      this.registerTarget(target, binding);
      this.emitSnapshot(
        input.rootWebContentsId,
        "created",
        target.requestActivation ? { activationBrowserId: browserId } : {},
      );
      target.requestActivation = false;
    }
    return browserId;
  }

  public bindRoot(input: RootBrowserBinding): void {
    for (const binding of this.rootBindingsByWebContentsId.values()) {
      if (
        binding.rootWebContentsId !== input.rootWebContentsId &&
        binding.hostWebContentsId === input.hostWebContentsId &&
        binding.rootBrowserId === input.rootBrowserId
      ) {
        this.closeRootByWebContents(binding.rootWebContentsId);
      }
    }

    this.rootBindingsByWebContentsId.set(input.rootWebContentsId, { ...input });
    const targets = this.targetsForRootWebContents(input.rootWebContentsId);
    for (const target of targets) {
      this.registerTarget(target, input);
    }
    let activationTarget: BrowserPopupTargetRecord | undefined;
    for (const target of targets) {
      if (target.requestActivation) activationTarget = target;
    }
    this.emitSnapshot(
      input.rootWebContentsId,
      "bound",
      activationTarget ? { activationBrowserId: activationTarget.browserId } : {},
    );
    for (const target of targets) {
      target.requestActivation = false;
    }
  }

  public getBrowserIdForWebContents(webContentsId: number): string | null {
    return this.targetBrowserIdsByWebContentsId.get(webContentsId) ?? null;
  }

  public getRootWebContentsIdForTarget(browserId: string): number | null {
    return this.targetsByBrowserId.get(browserId)?.rootWebContentsId ?? null;
  }

  public getSnapshot(input: {
    rootBrowserId: string;
    hostWebContentsId: number;
  }): BrowserPopupTargetsSnapshot | null {
    const binding = this.findBinding(input);
    return binding ? this.createSnapshot(binding, "updated") : null;
  }

  public setPresentation(input: {
    rootBrowserId: string;
    hostWebContentsId: number;
    popupBrowserId: string | null;
    visible: boolean;
    bounds?: BrowserPopupBounds;
    focus?: boolean;
  }): boolean {
    const binding = this.findBinding(input);
    if (!binding) {
      return false;
    }
    if (
      input.visible &&
      this.isPresentationAllowed &&
      !this.isPresentationAllowed({
        workspaceId: binding.workspaceId,
        hostWebContentsId: binding.hostWebContentsId,
      })
    ) {
      input = { ...input, visible: false, focus: false };
    }
    const targets = this.targetsForRootWebContents(binding.rootWebContentsId);
    const selection = this.resolvePresentationSelection(binding, input);
    if (!selection) {
      return false;
    }
    const { selected } = selection;

    let changed = false;
    for (const target of targets) {
      changed =
        this.applyTargetPresentation(
          target,
          Boolean(input.visible && selected === target),
          input.bounds,
        ) || changed;
    }

    const activeBrowserId = input.visible && selected ? selected.browserId : binding.rootBrowserId;
    this.onSetActiveTarget?.({
      browserId: activeBrowserId,
      workspaceId: binding.workspaceId,
      hostWebContentsId: binding.hostWebContentsId,
    });
    if (input.visible && selected && input.focus) {
      selected.view.contents.focus();
    }
    if (changed || input.focus) {
      this.emitSnapshot(binding.rootWebContentsId, "presentation");
    }
    return true;
  }

  public resizeTarget(input: {
    browserId: string;
    hostWebContentsId: number;
    width: number;
    height: number;
  }): { width: number; height: number } | null {
    const target = this.targetsByBrowserId.get(input.browserId);
    if (!target || target.hostWebContentsId !== input.hostWebContentsId) {
      return null;
    }
    target.parkingBounds = {
      x: 0,
      y: 0,
      width: normalizeDimension(input.width, DEFAULT_POPUP_WIDTH),
      height: normalizeDimension(input.height, DEFAULT_POPUP_HEIGHT),
    };
    if (!target.visible) {
      target.view.setBounds(target.parkingBounds);
      target.lastBounds = { ...target.parkingBounds };
      this.emitSnapshot(target.rootWebContentsId, "updated");
    }
    const actualBounds = target.lastBounds ?? target.parkingBounds;
    return { width: actualBounds.width, height: actualBounds.height };
  }

  public closeTarget(input: { browserId: string; hostWebContentsId: number }): boolean {
    const target = this.targetsByBrowserId.get(input.browserId);
    if (!target || target.hostWebContentsId !== input.hostWebContentsId) {
      return false;
    }
    target.view.contents.close();
    return true;
  }

  /**
   * Force-parks every visible popup owned by a different workspace on the
   * given host window. Called on foreground-workspace changes so a stale or
   * racing renderer presentation can never linger over another workspace.
   */
  public parkTargetsOutsideWorkspace(input: {
    hostWebContentsId: number;
    workspaceId: string;
  }): void {
    for (const binding of this.rootBindingsByWebContentsId.values()) {
      if (
        binding.hostWebContentsId !== input.hostWebContentsId ||
        binding.workspaceId === input.workspaceId
      ) {
        continue;
      }
      let changed = false;
      for (const target of this.targetsForRootWebContents(binding.rootWebContentsId)) {
        changed = this.applyTargetPresentation(target, false, undefined) || changed;
      }
      if (changed) {
        this.onSetActiveTarget?.({
          browserId: binding.rootBrowserId,
          workspaceId: binding.workspaceId,
          hostWebContentsId: binding.hostWebContentsId,
        });
        this.emitSnapshot(binding.rootWebContentsId, "presentation");
      }
    }
  }

  public closeRoot(input: { rootBrowserId: string; hostWebContentsId: number }): void {
    const binding = this.findBinding(input);
    if (binding) {
      this.closeRootByWebContents(binding.rootWebContentsId);
    }
  }

  public closeRootByWebContents(rootWebContentsId: number): void {
    const targets = this.targetsForRootWebContents(rootWebContentsId);
    for (const target of targets) {
      if (!target.view.contents.isDestroyed()) {
        target.view.contents.close();
      }
      if (this.targetsByBrowserId.has(target.browserId)) {
        this.removeTarget(target, "closed", false);
      }
    }
    const binding = this.rootBindingsByWebContentsId.get(rootWebContentsId);
    this.rootBindingsByWebContentsId.delete(rootWebContentsId);
    this.openAttemptsByRootWebContentsId.delete(rootWebContentsId);
    if (binding) {
      this.onSetActiveTarget?.({
        browserId: binding.rootBrowserId,
        workspaceId: binding.workspaceId,
        hostWebContentsId: binding.hostWebContentsId,
      });
    }
  }

  public closeHost(hostWebContentsId: number): void {
    const roots = Array.from(this.rootBindingsByWebContentsId.values())
      .filter((binding) => binding.hostWebContentsId === hostWebContentsId)
      .map((binding) => binding.rootWebContentsId);
    for (const rootWebContentsId of roots) {
      this.closeRootByWebContents(rootWebContentsId);
    }

    for (const target of Array.from(this.targetsByBrowserId.values())) {
      if (target.hostWebContentsId !== hostWebContentsId) {
        continue;
      }
      if (!target.view.contents.isDestroyed()) {
        target.view.contents.close();
      }
      if (this.targetsByBrowserId.has(target.browserId)) {
        this.removeTarget(target, "closed", false);
      }
    }
  }

  private resolvePresentationSelection(
    binding: RootBrowserBinding,
    input: {
      popupBrowserId: string | null;
      hostWebContentsId: number;
      visible: boolean;
      bounds?: BrowserPopupBounds;
    },
  ): { selected: BrowserPopupTargetRecord | null } | null {
    const selected = input.popupBrowserId
      ? (this.targetsByBrowserId.get(input.popupBrowserId) ?? null)
      : null;
    const belongsToRoot =
      !selected ||
      (selected.rootWebContentsId === binding.rootWebContentsId &&
        selected.hostWebContentsId === input.hostWebContentsId);
    const hasVisibleTarget = !input.visible || Boolean(selected && input.bounds);
    return belongsToRoot && hasVisibleTarget ? { selected } : null;
  }

  private applyTargetPresentation(
    target: BrowserPopupTargetRecord,
    shouldShow: boolean,
    presentedBounds: BrowserPopupBounds | undefined,
  ): boolean {
    const nextBounds = shouldShow && presentedBounds ? presentedBounds : target.parkingBounds;
    let changed = false;
    if (target.visible && !shouldShow) {
      // Reparent first so the parking resize cannot flash over the workspace.
      target.hostView.setChildViewVisible(target.view, false);
      target.visible = false;
      changed = true;
    }
    if (!sameBounds(target.lastBounds, nextBounds)) {
      target.view.setBounds(nextBounds);
      target.lastBounds = { ...nextBounds };
      changed = true;
    }
    if (!target.visible && shouldShow) {
      target.hostView.setChildViewVisible(target.view, true);
      target.visible = true;
      changed = true;
    }
    return changed;
  }

  private subscribeToTarget(target: BrowserPopupTargetRecord): void {
    target.view.contents.subscribe("destroyed", () => {
      if (this.targetsByBrowserId.get(target.browserId) === target) {
        this.removeTarget(target, "closed");
      }
    });
    for (const event of [
      "did-start-loading",
      "did-stop-loading",
      "did-navigate",
      "did-navigate-in-page",
      "page-title-updated",
    ] as const) {
      target.view.contents.subscribe(event, () => {
        if (this.targetsByBrowserId.get(target.browserId) === target) {
          this.emitSnapshot(target.rootWebContentsId, "updated");
        }
      });
    }
    target.view.contents.subscribe("focus", () => {
      if (this.targetsByBrowserId.get(target.browserId) !== target || !target.visible) {
        return;
      }
      const binding = this.rootBindingsByWebContentsId.get(target.rootWebContentsId);
      if (!binding) {
        return;
      }
      this.onSetActiveTarget?.({
        browserId: target.browserId,
        workspaceId: binding.workspaceId,
        hostWebContentsId: binding.hostWebContentsId,
      });
      this.emitSnapshot(target.rootWebContentsId, "focused", {
        focusedBrowserId: target.browserId,
      });
    });
  }

  private registerTarget(target: BrowserPopupTargetRecord, binding: RootBrowserBinding): void {
    if (target.registered) {
      return;
    }
    target.registered = true;
    this.onRegisterTarget({
      browserId: target.browserId,
      rootBrowserId: binding.rootBrowserId,
      openerBrowserId: this.resolveOpenerBrowserId(target, binding),
      workspaceId: binding.workspaceId,
      hostWebContentsId: binding.hostWebContentsId,
      webContentsId: target.view.contents.id,
    });
  }

  private removeTarget(
    target: BrowserPopupTargetRecord,
    reason: BrowserPopupTargetsSnapshot["reason"],
    emit = true,
  ): void {
    if (this.targetsByBrowserId.get(target.browserId) !== target) {
      return;
    }
    const binding = this.rootBindingsByWebContentsId.get(target.rootWebContentsId);
    this.targetsByBrowserId.delete(target.browserId);
    this.targetBrowserIdsByWebContentsId.delete(target.view.contents.id);
    try {
      target.hostView.removeChildView(target.view);
    } catch {
      // The host view may already be gone during BrowserWindow teardown.
    }
    if (target.registered) {
      this.onUnregisterTarget(target.browserId);
    }
    if (target.visible && binding) {
      this.onSetActiveTarget?.({
        browserId: binding.rootBrowserId,
        workspaceId: binding.workspaceId,
        hostWebContentsId: binding.hostWebContentsId,
      });
    }
    if (emit) {
      this.emitSnapshot(target.rootWebContentsId, reason);
    }
  }

  private emitSnapshot(
    rootWebContentsId: number,
    reason: BrowserPopupTargetsSnapshot["reason"],
    extra: Pick<BrowserPopupTargetsSnapshot, "activationBrowserId" | "focusedBrowserId"> = {},
  ): void {
    const binding = this.rootBindingsByWebContentsId.get(rootWebContentsId);
    if (!binding) {
      return;
    }
    this.revision += 1;
    this.onSnapshot({ ...this.createSnapshot(binding, reason), ...extra, revision: this.revision });
  }

  private createSnapshot(
    binding: RootBrowserBinding,
    reason: BrowserPopupTargetsSnapshot["reason"],
  ): BrowserPopupTargetsSnapshot {
    return {
      revision: this.revision,
      rootBrowserId: binding.rootBrowserId,
      workspaceId: binding.workspaceId,
      hostWebContentsId: binding.hostWebContentsId,
      reason,
      targets: this.targetsForRootWebContents(binding.rootWebContentsId)
        .filter((target) => target.registered)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((target) => this.toSummary(target, binding)),
    };
  }

  private toSummary(
    target: BrowserPopupTargetRecord,
    binding: RootBrowserBinding,
  ): BrowserPopupTargetSummary {
    const contents = target.view.contents;
    return {
      browserId: target.browserId,
      rootBrowserId: binding.rootBrowserId,
      openerBrowserId: this.resolveOpenerBrowserId(target, binding),
      workspaceId: binding.workspaceId,
      url: contents.getURL(),
      title: contents.getTitle(),
      isLoading: contents.isLoading(),
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
      isVisible: target.visible,
      disposition: target.disposition,
      createdAt: target.createdAt,
    };
  }

  private resolveOpenerBrowserId(
    target: BrowserPopupTargetRecord,
    binding: RootBrowserBinding,
  ): string {
    const openerTargetId = this.targetBrowserIdsByWebContentsId.get(target.openerWebContentsId);
    return openerTargetId ?? binding.rootBrowserId;
  }

  private findBinding(input: {
    rootBrowserId: string;
    hostWebContentsId: number;
  }): RootBrowserBinding | null {
    for (const binding of this.rootBindingsByWebContentsId.values()) {
      if (
        binding.rootBrowserId === input.rootBrowserId &&
        binding.hostWebContentsId === input.hostWebContentsId
      ) {
        return binding;
      }
    }
    return null;
  }

  private targetsForRootWebContents(rootWebContentsId: number): BrowserPopupTargetRecord[] {
    return Array.from(this.targetsByBrowserId.values()).filter(
      (target) => target.rootWebContentsId === rootWebContentsId,
    );
  }

  private allocateBrowserId(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const browserId = this.createBrowserId();
      if (!this.targetsByBrowserId.has(browserId)) {
        return browserId;
      }
    }
    throw new Error("Unable to allocate a unique popup browser id");
  }
}

function normalizeInitialBounds(
  input: Partial<BrowserPopupBounds> | undefined,
): BrowserPopupBounds {
  return {
    x: 0,
    y: 0,
    width: normalizeDimension(input?.width, DEFAULT_POPUP_WIDTH),
    height: normalizeDimension(input?.height, DEFAULT_POPUP_HEIGHT),
  };
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(4096, Math.max(120, Math.round(value)));
}

function sameBounds(left: BrowserPopupBounds | null, right: BrowserPopupBounds): boolean {
  return (
    left?.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
