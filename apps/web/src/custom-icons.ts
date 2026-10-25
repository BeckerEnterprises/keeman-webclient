/** Custom icons of the projection for `AppIcon`. */
import type { VaultView } from "@keeman/core";

/** `data:` URL of a valid custom icon of the vault, if any. */
export function customIconSrc(
  vault: VaultView | undefined,
  id: string | undefined,
): string | undefined {
  return id === undefined ? undefined : vault?.icons.get(id)?.src;
}
