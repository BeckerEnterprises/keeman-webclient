import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import KdbxImportDialog from "./KdbxImportDialog.vue";

// Locking unmounts the dialog. Whatever it still awaits must not go on
// afterwards, least of all into an account unlocked meanwhile in the tab.

const mocks = vi.hoisted(() => ({
  readKdbxInWorker: vi.fn(),
  encodeIcons: vi.fn(),
  engine: vi.fn(),
}));

vi.mock("@keeman/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@keeman/core")>()),
  readKdbxInWorker: mocks.readKdbxInWorker,
}));
vi.mock("../../icon-image", () => ({ encodeIcons: mocks.encodeIcons }));
vi.mock("../../services", () => ({ spawnKdbxWorker: vi.fn() }));
vi.mock("../../stores/session", () => ({
  useSessionStore: () => ({ markActivity: vi.fn() }),
}));
vi.mock("../../stores/vaults", () => ({
  useVaultsStore: () => ({ vaults: [], engine: mocks.engine }),
}));

const source = {
  meta: { name: "Imported" },
  root: { name: "Root" },
  customIcons: [],
};

function engine() {
  const job = {
    vaultId: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
    report: {},
    progress: { done: 0, total: 1 },
    run: vi.fn(() => Promise.resolve()),
  };
  return { job, prepareKdbxImport: vi.fn(() => Promise.resolve(job)) };
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("KDBX import dialog", () => {
  it("imports nothing when a lock comes while the icons are encoded", async () => {
    const before = engine();
    const after = engine();
    mocks.engine.mockReturnValue(before);
    mocks.readKdbxInWorker.mockResolvedValue(source);
    mocks.encodeIcons.mockResolvedValue([]);
    const wrapper = mount(KdbxImportDialog, {
      attachTo: document.body,
      global: {
        plugins: [i18n],
        stubs: {
          GroupPicker: true,
          KdbxImportReport: true,
          RouterLink: true,
          VaultDeleteDialog: true,
        },
      },
    });

    const input = wrapper.find<HTMLInputElement>('[data-test="kdbx-file"]');
    Object.defineProperty(input.element, "files", {
      value: [new File([new Uint8Array(8)], "export.kdbx")],
    });
    input.element.form?.dispatchEvent(new Event("submit"));
    await flushPromises();
    expect(
      wrapper.find('[data-test="kdbx-import"]').attributes("data-step"),
    ).toBe("preview");
    expect(before.prepareKdbxImport).toHaveBeenCalledTimes(1);

    // "Import" encodes the icons again; the lock comes meanwhile and
    // another unlock gives the store a new engine.
    let encoded!: (icons: never[]) => void;
    mocks.encodeIcons.mockReturnValueOnce(
      new Promise((resolve) => (encoded = resolve)),
    );
    const start = wrapper.find('[data-test="kdbx-start"]').element;
    (start as HTMLButtonElement).form?.dispatchEvent(new Event("submit"));
    await flushPromises();
    mocks.engine.mockReturnValue(after);
    wrapper.unmount();
    encoded([]);
    await flushPromises();

    expect(before.prepareKdbxImport).toHaveBeenCalledTimes(1);
    expect(before.job.run).not.toHaveBeenCalled();
    expect(after.prepareKdbxImport).not.toHaveBeenCalled();
    expect(after.job.run).not.toHaveBeenCalled();
  });
});
