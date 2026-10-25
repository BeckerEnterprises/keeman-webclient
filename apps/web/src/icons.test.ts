import { BUILTIN_ICONS } from "@keeman/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_ICON_NODES, UI_ICONS, type IconNode } from "./icons";

const TAGS = new Set([
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
]);
const ATTRIBUTES = new Set([
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "width",
  "height",
  "points",
  "key",
]);

describe("icon data", () => {
  it("has data for every built-in name", () => {
    expect([...BUILTIN_ICON_NODES.keys()]).toEqual(BUILTIN_ICONS);
  });

  it("contains only drawing elements with geometry attributes", () => {
    const nodes: IconNode[] = [
      ...BUILTIN_ICON_NODES.values(),
      ...Object.values(UI_ICONS),
    ];
    for (const node of nodes) {
      expect(node.length).toBeGreaterThan(0);
      for (const [tag, attrs] of node) {
        expect(TAGS.has(tag), tag).toBe(true);
        for (const [name, value] of Object.entries(attrs)) {
          // Filled dots use the text colour, nothing else.
          if (name === "fill") {
            expect(value).toBe("currentColor");
            continue;
          }
          expect(ATTRIBUTES.has(name), name).toBe(true);
          expect(String(value)).not.toMatch(/[<>]|javascript:|url\(/i);
        }
      }
    }
  });
});
