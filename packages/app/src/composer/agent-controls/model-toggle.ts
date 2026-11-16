import type { ProviderSelectionModelRow } from "@/provider-selection/provider-selection";

type ModelToggleRow = Pick<ProviderSelectionModelRow, "provider" | "modelId" | "isDefault">;

/**
 * Daseo delta 122: the model Cmd/Ctrl+Shift+M switches to.
 *
 * The pair is the first row of the model list (roster order) and its provider's default model
 * (`isDefault`), so the key flips between the two primary models without a model id written into
 * the app. When the default is the first row (or the provider marks none), the second row is the
 * partner. From any other model the key goes to the first row. Null when there is nothing to
 * toggle to.
 */
export function resolveModelToggleTarget<Row extends ModelToggleRow>(input: {
  rows: readonly Row[];
  currentProvider: string;
  currentModelId: string | null | undefined;
}): Row | null {
  const [first] = input.rows;
  if (!first) return null;
  const isFirst = (row: Row) => row.provider === first.provider && row.modelId === first.modelId;
  const providerDefault = input.rows.find(
    (row) => row.provider === first.provider && row.isDefault === true && !isFirst(row),
  );
  const partner = providerDefault ?? input.rows[1];
  if (!partner) return null;
  const isCurrent = (row: Row) =>
    row.provider === input.currentProvider && row.modelId === input.currentModelId;
  if (isCurrent(first)) return partner;
  return first;
}
