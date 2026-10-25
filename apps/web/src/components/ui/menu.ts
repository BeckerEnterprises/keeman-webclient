import type { UiIcon } from "../../icons";

/** An entry of a context menu. */
export interface MenuItem {
  key: string;
  label: string;
  ui?: UiIcon;
  disabled?: boolean;
  danger?: boolean;
}
