import { describe, expect, it } from "vitest";
import { emptyDraft } from "../../src/model/entry";
import { firstDevice, rootOf } from "./devices";

function ref(field: string, id: string): string {
  return `{REF:${field}@I:${id}}`;
}

describe("placeholders in the engine", () => {
  it("previews the URL of a draft against the vault", async () => {
    const { engine, vaultId } = await firstDevice();
    const root = rootOf(engine, vaultId);
    const [mail = "", link = ""] = await engine.createEntries(vaultId, root, [
      { ...emptyDraft(), title: "Mail", username: "bob" },
      { ...emptyDraft(), title: "Link" },
    ]);

    const draft = {
      ...emptyDraft(),
      password: "a&b",
      url: `example.com/${ref("U", mail)}?pw={PASSWORD}`,
    };
    expect(engine.previewUrl(vaultId, undefined, draft)).toEqual({
      ok: true,
      url: "https://example.com/bob?pw=a%26b",
      display: "https://example.com/bob?pw=••••••",
      secret: true,
      warnings: [],
    });

    // The edited entry is seen with the draft's values, also from others.
    const edit = engine.editEntry(vaultId, link);
    if (!edit) throw new Error("no draft");
    await engine.saveEntry(edit.base, {
      ...edit.draft,
      url: `https://link.example/${ref("U", mail)}`,
    });
    expect(
      engine.previewUrl(vaultId, mail, {
        ...emptyDraft(),
        username: "carol",
        url: ref("A", link),
      }),
    ).toMatchObject({ url: "https://link.example/carol" });
    expect(
      engine.previewUrl(vaultId, mail, { ...emptyDraft(), url: "{URL}" }),
    ).toMatchObject({ warnings: ["cycle"] });

    expect(engine.previewUrl(vaultId, mail, emptyDraft())).toBeUndefined();
    expect(
      engine.previewUrl("0192b3a4-0000-7000-8000-000000000000", mail, draft),
    ).toBeUndefined();
  });

  it("counts references that break when entries leave the vault", async () => {
    const { engine, vaultId } = await firstDevice();
    const root = rootOf(engine, vaultId);
    const group = await engine.createGroup(vaultId, root, { name: "Move" });
    const [inside = ""] = await engine.createEntries(vaultId, group.id, [
      { ...emptyDraft(), title: "Inside", username: "in" },
    ]);
    const [outside = ""] = await engine.createEntries(vaultId, root, [
      { ...emptyDraft(), title: "Outside", username: ref("U", inside) },
    ]);
    await engine.createEntries(vaultId, group.id, [
      {
        ...emptyDraft(),
        title: "Back",
        fields: [{ name: "Peer", value: ref("T", outside), protected: false }],
      },
      { ...emptyDraft(), title: "Sibling", notes: ref("U", inside) },
      {
        ...emptyDraft(),
        title: "Dangling",
        url: ref("A", "0192b3a4-0000-7000-8000-0000000000ff"),
      },
    ]);
    // "Outside" points in, "Back" points out; "Sibling" moves along.
    expect(
      engine.brokenReferences(vaultId, [{ kind: "group", id: group.id }]),
    ).toBe(2);
    // Moving only "Inside": "Outside" and "Sibling" point to it.
    expect(
      engine.brokenReferences(vaultId, [{ kind: "entry", id: inside }]),
    ).toBe(2);
    expect(
      engine.brokenReferences(vaultId, [{ kind: "entry", id: outside }]),
    ).toBe(2);
  });
});
