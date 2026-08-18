export function disableFocusOnNavigation<T>(webPreferences: T): T & { focusOnNavigation: false } {
  const preferences = webPreferences as T & { focusOnNavigation: false };
  preferences.focusOnNavigation = false;
  return preferences;
}

export function shouldRequestBrowserPopupActivation(input: {
  disposition: string;
  hostWindowFocused: boolean;
  openerFocused: boolean;
  openerIsAuthoritativeTarget: boolean;
  recentlyAutomated: boolean;
}): boolean {
  return (
    input.disposition !== "background-tab" &&
    input.hostWindowFocused &&
    input.openerFocused &&
    input.openerIsAuthoritativeTarget &&
    !input.recentlyAutomated
  );
}

export function shouldRestoreUnexpectedPopupFocus(input: {
  currentFocusedContentsId: number | null;
  hostWindowFocused: boolean;
  popupContentsId: number;
  previousFocusedContentsId: number | null;
  requestActivation: boolean;
}): boolean {
  return (
    !input.requestActivation &&
    input.hostWindowFocused &&
    input.previousFocusedContentsId !== null &&
    input.previousFocusedContentsId !== input.popupContentsId &&
    input.currentFocusedContentsId === input.popupContentsId
  );
}
