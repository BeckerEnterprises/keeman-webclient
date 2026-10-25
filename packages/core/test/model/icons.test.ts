import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_ICONS,
  DEFAULT_ICONS,
  iconName,
  isBuiltinIcon,
  KEEPASS_ICONS,
} from "../../src/model/icons";

interface IconsFile {
  defaults: Record<string, string>;
  keepass: string[];
  names: string[];
}

// The list of built-in icon names shared by all KeeMan clients; names are
// only ever added, never removed or renamed.
const shared = JSON.parse(
  readFileSync(new URL("./icons.json", import.meta.url), "utf8"),
) as IconsFile;

describe("built-in icons", () => {
  it("match the shared icons.json", () => {
    expect(BUILTIN_ICONS).toEqual(shared.names);
    expect(KEEPASS_ICONS).toEqual(shared.keepass);
    expect(DEFAULT_ICONS).toEqual(shared.defaults);
  });

  it("map 69 KeePass icons to distinct names", () => {
    expect(new Set(KEEPASS_ICONS).size).toBe(69);
    expect(KEEPASS_ICONS.every(isBuiltinIcon)).toBe(true);
  });

  it("fall back for unknown names, custom icons and none", () => {
    expect(iconName({ type: "builtin", name: "server" }, "folder")).toBe(
      "server",
    );
    expect(iconName({ type: "builtin", name: "nope" }, "folder")).toBe(
      "folder",
    );
    expect(iconName({ type: "builtin", name: "__proto__" }, "folder")).toBe(
      "folder",
    );
    expect(iconName({ type: "custom", id: "x" }, "key-round")).toBe(
      "key-round",
    );
    expect(iconName(null, "key-round")).toBe("key-round");
  });
});
