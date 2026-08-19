export type ComposerOwnerLeaseToken = symbol;

interface ComposerOwnerLease {
  token: ComposerOwnerLeaseToken;
  agentId: string;
}

const ownerByScope = new Map<string, ComposerOwnerLease>();

export function claimComposerOwnerLease(input: {
  scopeId: string;
  agentId: string;
  token: ComposerOwnerLeaseToken;
}): void {
  ownerByScope.set(input.scopeId, { token: input.token, agentId: input.agentId });
}

export function releaseComposerOwnerLease(input: {
  scopeId: string;
  token: ComposerOwnerLeaseToken;
}): void {
  if (ownerByScope.get(input.scopeId)?.token === input.token) {
    ownerByScope.delete(input.scopeId);
  }
}

export function ownsComposerOwnerLease(input: {
  scopeId: string;
  agentId: string;
  token: ComposerOwnerLeaseToken;
}): boolean {
  const owner = ownerByScope.get(input.scopeId);
  return owner?.token === input.token && owner.agentId === input.agentId;
}

export function createComposerOwnerLeaseToken(): ComposerOwnerLeaseToken {
  return Symbol("composer-owner");
}
