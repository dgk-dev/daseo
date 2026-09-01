export async function applyAcknowledgedFeatureMutation(input: {
  acceptRuntimeValue: () => Promise<void>;
  persistPreference: () => Promise<void>;
}): Promise<void> {
  await input.acceptRuntimeValue();
  await input.persistPreference();
}
