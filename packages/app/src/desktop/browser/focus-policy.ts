export function resolveWorkspaceActiveBrowserId(input: {
  focusedBrowserId: string | null;
  isRouteFocused: boolean;
}): string | null {
  return input.isRouteFocused ? input.focusedBrowserId : null;
}

export function shouldRepelBrowserSurfaceFocus(input: {
  isInteractive: boolean;
  isPresented: boolean;
}): boolean {
  return !input.isInteractive || !input.isPresented;
}

export function shouldClaimBrowserSurfaceFocus(input: {
  isInteractive: boolean;
  isPresented: boolean;
  isTrustedPointerEvent: boolean;
}): boolean {
  return input.isInteractive && input.isPresented && input.isTrustedPointerEvent;
}
