// Azure region names (`koreacentral`, `southeastasia`); anything else is a typo that would send the
// subscription key to a host Azure does not own.
export const AZURE_SPEECH_REGION_PATTERN = /^[a-z][a-z0-9]{1,39}$/u;

export function isAzureSpeechRegion(region: string): boolean {
  return AZURE_SPEECH_REGION_PATTERN.test(region);
}
