/**
 * Sharing: two accounts share a database and edit it, a
 * removed member reads nothing new, a substituted public key is detected on
 * both sides, keys follow the signed owner list, a database over 20 MiB gets
 * a new key, and declining, withdrawing, roles and leaving work. Test data
 * only.
 */
import { generateKeyPairSync } from "node:crypto";
import { emptyDraft, type SyncEngine } from "@keeman/core";
import type { Page } from "@playwright/test";
import {
  createAccount,
  createAccountWithVault,
  entryRow,
  forgetSigningKey,
  loginViaUi,
  nodeDevice,
  openAccount,
  openDatabases,
  openMain,
  openVault,
  rootOf,
  unlockViaUi,
  type NodeDevice,
} from "./helpers";
import { expect, test } from "./fixtures";

/** An X25519 public key nobody verified, as the server could slip it in. */
function attackerKey(): string {
  const { publicKey } = generateKeyPairSync("x25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64url");
}

async function openDatabasePage(page: Page, vaultId: string): Promise<void> {
  await openDatabases(page);
  await page
    .locator(`[data-test=vault][data-vault-id="${vaultId}"]`)
    .getByTestId("vault-settings")
    .click();
  await expect(page.getByTestId("database-view")).toBeVisible();
}

/** The host verifies and invites, the guest verifies and accepts (Node). */
async function shareNode(
  host: NodeDevice,
  guest: NodeDevice,
  guestEmail: string,
  vaultId: string,
): Promise<void> {
  const candidate = await host.engine.lookupUser(guestEmail);
  if (candidate.status !== "verified")
    await host.account.verifyContact(candidate);
  await host.engine.invite(vaultId, candidate);
  await guest.engine.refresh();
  const sender = guest.engine.snapshot.invitations.find(
    (i) => i.vaultId === vaultId,
  )?.sender;
  if (!sender) throw new Error("invitation missing");
  if (sender.status !== "verified") await guest.account.verifyContact(sender);
  await guest.engine.acceptInvitation(
    vaultId,
    await guest.engine.invitationDetails(vaultId),
  );
}

function view(engine: SyncEngine, vaultId: string) {
  const found = engine.snapshot.vaults.find((v) => v.id === vaultId);
  if (!found) throw new Error("vault missing");
  return found;
}

test.describe("sharing", () => {
  test("two accounts share a database and edit it together", async ({
    page,
    otherContext,
    guard,
  }) => {
    const alice = await createAccountWithVault("share-a");
    const bob = await createAccount("share-b");
    guard.secrets.push(alice.password, bob.password);
    const second = await otherContext.newPage();
    await loginViaUi(second, bob);
    await openAccount(second, "contacts");
    const bobFingerprint =
      (await second.getByTestId("own-fingerprint").textContent())?.trim() ?? "";
    expect(bobFingerprint).toMatch(/^([0-9A-F]{4} ){9}[0-9A-F]{4}$/);

    await loginViaUi(page, alice);
    await openAccount(page, "contacts");
    const aliceFingerprint =
      (await page.getByTestId("own-fingerprint").textContent())?.trim() ?? "";
    await openDatabasePage(page, alice.vaultId);
    await page.getByTestId("invite-email").fill(bob.email);
    await page.getByTestId("invite-submit").click();
    const dialog = page.getByTestId("fingerprint-dialog");
    await expect(dialog.getByTestId("fingerprint-other")).toHaveText(
      bobFingerprint,
    );
    await expect(dialog.getByTestId("fingerprint-own")).toHaveText(
      aliceFingerprint,
    );
    await dialog.getByTestId("fingerprint-confirm").click();
    await expect(page.getByTestId("members-invited")).toBeVisible();
    await expect(page.getByTestId("member")).toHaveCount(2);

    // Bob compares Alice's fingerprint and accepts in the banner.
    const banner = second.getByTestId("banner-invitation");
    await expect(banner).toContainText(alice.email);
    await expect(banner).toContainText("Persönlich");
    await banner.getByTestId("invitation-accept").click();
    const check = second.getByTestId("fingerprint-dialog");
    await expect(check.getByTestId("fingerprint-other")).toHaveText(
      aliceFingerprint,
    );
    await check.getByTestId("fingerprint-confirm").click();
    const accepting = second.getByTestId("invitation-dialog");
    await expect(
      accepting.getByTestId("invitation-dialog-owner"),
    ).toContainText(alice.email);
    await accepting.getByTestId("invitation-dialog-accept").click();
    await expect(banner).toHaveCount(0);
    await second.getByTestId("nav-entries").click();
    await openVault(second, "Persönlich");

    // Alice adds an entry; Bob sees it within 2 seconds.
    await page.getByTestId("nav-entries").click();
    await openVault(page, "Persönlich");
    await page.getByTestId("new-entry").click();
    await page.getByTestId("editor-title").fill("Gemeinsam");
    await page.getByTestId("editor-save").click();
    await expect(entryRow(second, "Gemeinsam")).toBeVisible({ timeout: 2000 });

    // Both edit at the same time, different fields: both changes stay.
    await page.getByTestId("entry-detail").getByTestId("detail-edit").click();
    await entryRow(second, "Gemeinsam").click();
    await second.getByTestId("entry-detail").getByTestId("detail-edit").click();
    await second.getByTestId("editor-username").fill("bob-user");
    await second.getByTestId("editor-save").click();
    await expect(
      second.getByTestId("entry-detail").getByTestId("detail-username-value"),
    ).toHaveText("bob-user");
    await page.getByTestId("editor-url").fill("https://example.com/gemeinsam");
    await page.getByTestId("editor-save").click();
    const detail = page.getByTestId("entry-detail");
    await expect(detail.getByTestId("detail-username-value")).toHaveText(
      "bob-user",
      { timeout: 2000 },
    );
    await expect(
      second.getByTestId("entry-detail").getByTestId("detail-url"),
    ).toContainText("example.com/gemeinsam", { timeout: 2000 });
    // "By whom" shows the contact's address.
    await expect(second.getByTestId("entry-detail")).toContainText(alice.email);
  });

  test("a removed member reads nothing new; verified members get the key", async ({
    page,
    otherContext,
  }) => {
    test.slow();
    const alice = await createAccountWithVault("rot-a");
    const bob = await createAccount("rot-b");
    const carol = await createAccount("rot-c");
    const dave = await createAccount("rot-d");
    const [bobDevice, carolDevice, daveDevice] = await Promise.all([
      nodeDevice(bob),
      nodeDevice(carol),
      nodeDevice(dave),
    ]);
    for (const [device, email] of [
      [bobDevice, bob.email],
      [carolDevice, carol.email],
      [daveDevice, dave.email],
    ] as const)
      await shareNode(alice.device, device, email, alice.vaultId);
    // Dave no longer counts Alice as verified.
    await daveDevice.account.removeContact(alice.device.account.userId ?? "");
    // What Carol's device saw before her removal, for a lying server later.
    const carolList = await carolDevice.api.vaults();

    await loginViaUi(page, alice);
    await openDatabasePage(page, alice.vaultId);
    await page
      .getByTestId("member")
      .filter({ hasText: carol.email })
      .getByTestId("member-remove")
      .click();
    const rotation = page.getByTestId("rotation-dialog");
    await expect(rotation.getByTestId("rotation-recipient")).toHaveCount(3);
    await rotation.getByTestId("rotation-run").click();
    await expect(rotation.getByTestId("rotation-done")).toBeVisible({
      timeout: 60_000,
    });
    await rotation.getByTestId("rotation-close").click();
    await expect(page.getByTestId("member")).toHaveCount(3);

    // Bob verified Alice: the new key is taken without asking; Dave waits.
    await bobDevice.engine.refresh();
    expect(view(bobDevice.engine, alice.vaultId).keyStatus).toBe("ok");
    await daveDevice.engine.refresh();
    expect(view(daveDevice.engine, alice.vaultId).keyStatus).toBe("pending");
    // Carol has lost the database.
    await expect(
      carolDevice.api.changes(alice.vaultId, 0),
    ).rejects.toMatchObject({ status: 404 });

    // Alice writes after the renewal.
    await alice.device.engine.refresh();
    await alice.device.engine.createEntry(
      alice.vaultId,
      rootOf(alice.device, alice.vaultId),
      { ...emptyDraft(), title: "Nach der Erneuerung" },
    );
    await bobDevice.engine.pull(alice.vaultId);
    // The rotation renewed the manifest with the new key.
    expect(view(bobDevice.engine, alice.vaultId).manifest).toBe("verified");
    expect(
      [...view(bobDevice.engine, alice.vaultId).entries.values()].map(
        (e) => e.title,
      ),
    ).toContain("Nach der Erneuerung");

    // A lying server keeps Carol in the database and serves Alice's data:
    // nothing decrypts, the new title never appears.
    const second = await otherContext.newPage();
    await second.routeWebSocket(/\/v1\/events$/, () => undefined);
    await second.route("**/v1/vaults", (route) =>
      route.fulfill({ json: { vaults: carolList } }),
    );
    await second.route(
      `**/v1/vaults/${alice.vaultId}/changes**`,
      async (route) => {
        const url = new URL(route.request().url());
        const page_ = await alice.device.api.changes(
          alice.vaultId,
          Number(url.searchParams.get("since")),
          url.searchParams.get("cursor") ?? undefined,
        );
        await route.fulfill({ json: page_ });
      },
    );
    await loginViaUi(second, carol);
    await openDatabasePage(second, alice.vaultId);
    await expect(second.getByTestId("corrupt-list")).toBeVisible();
    await expect(second.getByTestId("corrupt").first()).toContainText(
      "Schlüssel fehlt",
    );
    await expect(second.getByText("Nach der Erneuerung")).toHaveCount(0);
  });

  test("a substituted public key is detected on both sides", async ({
    page,
    otherContext,
  }) => {
    const alice = await createAccountWithVault("forge-a");
    const bob = await createAccount("forge-b");
    const bobDevice = await nodeDevice(bob);
    const invites: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/members"))
        invites.push(request.url());
    });
    // The server names a wrong key for Bob: the fingerprint is not his.
    await page.route("**/v1/users/lookup", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      body.public_key = attackerKey();
      await route.fulfill({ response, json: body });
    });
    await loginViaUi(page, alice);
    await openDatabasePage(page, alice.vaultId);
    await page.getByTestId("invite-email").fill(bob.email);
    await page.getByTestId("invite-submit").click();
    const dialog = page.getByTestId("fingerprint-dialog");
    await expect(dialog.getByTestId("fingerprint-other")).not.toHaveText(
      bobDevice.account.ownFingerprint ?? "",
    );
    await dialog.getByTestId("fingerprint-cancel").click();
    expect(invites).toEqual([]);
    await expect(page.getByTestId("member")).toHaveCount(1);
    await page.unroute("**/v1/users/lookup");

    // A wrong "own" key from the server ends in the integrity screen.
    await page.route("**/v1/me", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      body.public_key = attackerKey();
      await route.fulfill({ response, json: body });
    });
    await page.getByTestId("lock").click();
    await unlockViaUi(page, alice.password);
    await expect(page.getByText("Daten passen nicht zusammen")).toBeVisible();

    // Bob knows Alice; the server substitutes her key on his side.
    const aliceCandidate = await bobDevice.engine.lookupUser(alice.email);
    await bobDevice.account.verifyContact(aliceCandidate);
    const bobCandidate = await alice.device.engine.lookupUser(bob.email);
    await alice.device.account.verifyContact(bobCandidate);
    await alice.device.engine.invite(alice.vaultId, bobCandidate);
    const second = await otherContext.newPage();
    const accepts: string[] = [];
    second.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/accept"))
        accepts.push(request.url());
    });
    await second.route("**/v1/users/*/public-key", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      body.public_key = attackerKey();
      await route.fulfill({ response, json: body });
    });
    await loginViaUi(second, bob);
    const banner = second.getByTestId("banner-invitation");
    await banner.getByTestId("invitation-accept").click();
    const check = second.getByTestId("fingerprint-dialog");
    await expect(check.getByTestId("fingerprint-warning")).toBeVisible();
    await expect(check.getByTestId("fingerprint-other")).not.toHaveText(
      aliceCandidate.fingerprint,
    );
    // Confirming anyway does not help: the box never opens.
    await check.getByTestId("fingerprint-confirm").click();
    const accepting = second.getByTestId("invitation-dialog");
    await expect(
      accepting.getByTestId("invitation-dialog-problem"),
    ).toBeVisible();
    await expect(
      accepting.getByTestId("invitation-dialog-accept"),
    ).toBeDisabled();
    expect(accepts).toEqual([]);
  });

  test("a new owner's key arrives without asking when the signed owner list covers it", async ({
    page,
  }) => {
    test.slow();
    const alice = await createAccountWithVault("owner-a");
    const bob = await createAccount("owner-b");
    const carol = await createAccount("owner-c");
    const [bobDevice, carolDevice] = await Promise.all([
      nodeDevice(bob),
      nodeDevice(carol),
    ]);
    await shareNode(alice.device, bobDevice, bob.email, alice.vaultId);
    await shareNode(alice.device, carolDevice, carol.email, alice.vaultId);
    await bobDevice.account.verifyContact(
      await bobDevice.engine.lookupUser(carol.email),
    );
    for (const email of [alice.email, bob.email])
      await carolDevice.account.verifyContact(
        await carolDevice.engine.lookupUser(email),
      );
    // Bob's browser checked the owner list with Alice alone and hears no
    // events.
    await page.routeWebSocket(/\/v1\/events$/, () => undefined);
    await loginViaUi(page, bob);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("new-group")).toBeEnabled();

    // Meanwhile Alice makes Carol owner (signed) and Carol renews the key:
    // the chain from Bob's anchor covers both steps.
    const carolId = carolDevice.account.userId ?? "";
    await alice.device.engine.refresh();
    await alice.device.engine.setMemberRole(alice.vaultId, carolId, "owner");
    await carolDevice.engine.refresh();
    const review = await carolDevice.engine.prepareRotation(alice.vaultId);
    await carolDevice.engine.runRotation(review, {
      remove: [],
      dropCorrupt: false,
    });

    const accepted: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/v1/vaults/${alice.vaultId}/key`)
      )
        accepted.push(request.url());
    });
    await page.reload();
    await unlockViaUi(page, bob.password);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("new-group")).toBeEnabled();
    expect(accepted).toHaveLength(1);
    await expect(page.getByTestId("banner-pending-key")).toHaveCount(0);
    await openDatabasePage(page, alice.vaultId);
    const carolRow = page
      .getByTestId("member")
      .filter({ hasText: carol.email });
    await expect(carolRow.getByTestId("member-role")).toHaveText("Eigentümer");
    await expect(carolRow.getByTestId("member-signed")).toBeVisible();
  });

  test("an older owner list blocks new keys until understood", async ({
    page,
  }) => {
    test.slow();
    const alice = await createAccountWithVault("older-a");
    const bob = await createAccount("older-b");
    const bobDevice = await nodeDevice(bob);
    await shareNode(alice.device, bobDevice, bob.email, alice.vaultId);
    await alice.device.account.verifyContact(
      await alice.device.engine.lookupUser(bob.email),
    );
    const rotate = async () => {
      await alice.device.engine.refresh();
      const review = await alice.device.engine.prepareRotation(alice.vaultId);
      await alice.device.engine.runRotation(review, {
        remove: [],
        dropCorrupt: false,
      });
    };
    // Bob's browser takes key version 2 with statement 2 of the chain.
    await rotate();
    await page.routeWebSocket(/\/v1\/events$/, () => undefined);
    await loginViaUi(page, bob);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("new-group")).toBeEnabled();
    await page.getByTestId("lock").click();

    // Key version 3 follows; the server delivers only the first statement.
    await rotate();
    const accepted: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/v1/vaults/${alice.vaultId}/key`)
      )
        accepted.push(request.url());
    });
    const rolesPath = (url: URL) =>
      url.pathname === `/v1/vaults/${alice.vaultId}/roles`;
    await page.route(rolesPath, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { statements: unknown[] };
      await route.fulfill({
        response,
        json: { statements: body.statements.slice(0, 1) },
      });
    });
    await unlockViaUi(page, bob.password);
    const banner = page.getByTestId("banner-pending-key");
    await expect(banner).toContainText("nicht geprüft");
    await expect(banner.getByTestId("pending-key-check")).toHaveCount(0);
    await openDatabasePage(page, alice.vaultId);
    const warning = page.getByTestId("vault-roles-warning");
    await expect(warning).toContainText("ältere Eigentümerliste");
    // Understood takes the older list; as the server still names a newer
    // head than it delivers, nothing is accepted until the list loads.
    await warning.getByTestId("vault-roles-ack").click();
    await page.getByTestId("confirm-yes").click();
    await expect(warning).toHaveCount(0);
    await expect(page.getByTestId("vault-roles-unavailable")).toBeVisible();
    await expect(banner).toContainText("bis sich die Eigentümerliste");
    await expect(banner.getByTestId("pending-key-check")).toHaveCount(0);
    expect(accepted).toEqual([]);

    // With the whole chain again, the key is covered.
    await page.unroute(rolesPath);
    await page.getByTestId("lock").click();
    await unlockViaUi(page, bob.password);
    await openMain(page);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("new-group")).toBeEnabled();
    expect(accepted).toHaveLength(1);
  });

  test("an account from before signing keys adds one and is verified after", async ({
    page,
  }) => {
    const alice = await createAccountWithVault("signing-a");
    const bob = await createAccount("signing-b");
    forgetSigningKey(alice.email);
    await loginViaUi(page, bob);
    await openAccount(page, "contacts");
    await page.getByTestId("contacts-email").fill(alice.email);
    await page.getByTestId("contacts-check").click();
    const dialog = page.getByTestId("fingerprint-dialog");
    await expect(dialog.getByTestId("fingerprint-unverifiable")).toBeVisible();
    await expect(dialog.getByTestId("fingerprint-confirm")).toBeDisabled();
    await dialog.getByTestId("fingerprint-cancel").click();

    // Alice unlocks again: her client adds the key derived from her user key.
    alice.device.account.lock();
    await alice.device.account.unlock(alice.password);
    expect((await alice.device.api.me()).signing_public_key).toEqual(
      expect.any(String),
    );
    await page.getByTestId("contacts-email").fill(alice.email);
    await page.getByTestId("contacts-check").click();
    await expect(dialog.getByTestId("fingerprint-unverifiable")).toHaveCount(0);
    await expect(dialog.getByTestId("fingerprint-other")).toHaveText(
      alice.device.account.ownFingerprint ?? "",
    );
    await dialog.getByTestId("fingerprint-confirm").click();
    await expect(
      page.getByTestId("contact").filter({ hasText: alice.email }),
    ).toBeVisible();
  });

  test("renews the key of a database over 20 MiB", async ({ page }) => {
    test.setTimeout(300_000);
    const alice = await createAccountWithVault("big-a");
    const bob = await createAccount("big-b");
    const bobDevice = await nodeDevice(bob);
    await shareNode(alice.device, bobDevice, bob.email, alice.vaultId);
    const notes = "x".repeat(950_000);
    for (let i = 0; i < 22; i++)
      await alice.device.engine.createEntry(
        alice.vaultId,
        rootOf(alice.device, alice.vaultId),
        {
          ...emptyDraft(),
          title: `Groß ${String(i)}`,
          notes: `${notes}${String(i)}`,
        },
      );
    await loginViaUi(page, alice);
    await openDatabasePage(page, alice.vaultId);
    await page.getByTestId("rotation-open").click();
    const rotation = page.getByTestId("rotation-dialog");
    await rotation.getByTestId("rotation-run").click();
    await expect(rotation.getByTestId("rotation-done")).toBeVisible({
      timeout: 240_000,
    });
    await bobDevice.engine.refresh();
    expect(view(bobDevice.engine, alice.vaultId)).toMatchObject({
      keyStatus: "ok",
      vaultKeyVersion: 2,
    });
    expect(view(bobDevice.engine, alice.vaultId).entries.size).toBe(22);
  });

  test("a re-invitation that contradicts what the account knew is accepted only anyway", async ({
    page,
  }) => {
    const alice = await createAccountWithVault("again-a");
    const bob = await createAccount("again-b");
    const bobDevice = await nodeDevice(bob);
    await shareNode(alice.device, bobDevice, bob.email, alice.vaultId);
    await loginViaUi(page, bob);
    await openVault(page, "Persönlich");
    await bobDevice.engine.leaveVault(alice.vaultId);
    // This browser knew another first statement of the list than the
    // chain has: what a fork below the old anchor looks like.
    await page.evaluate((vaultId) => {
      const key = "keeman.syncSeen";
      const marks = JSON.parse(localStorage.getItem(key) ?? "{}") as {
        users: Record<string, { vaults: Record<string, { rl?: unknown }> }>;
      };
      for (const user of Object.values(marks.users)) {
        const vault = user.vaults[vaultId];
        if (vault) vault.rl = [1, "A".repeat(43)];
      }
      localStorage.setItem(key, JSON.stringify(marks));
    }, alice.vaultId);
    const accepts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/accept"))
        accepts.push(request.url());
    });
    await alice.device.engine.invite(
      alice.vaultId,
      await alice.device.engine.lookupUser(bob.email),
    );
    const banner = page.getByTestId("banner-invitation");
    await banner.getByTestId("invitation-accept").click();
    const dialog = page.getByTestId("invitation-dialog");
    await expect(
      dialog.getByTestId("invitation-dialog-former-conflict"),
    ).toBeVisible();
    await expect(dialog.getByTestId("invitation-dialog-accept")).toHaveCount(0);
    await dialog.getByTestId("invitation-dialog-accept-anyway").click();
    // The question focuses "cancel"; only "accept anyway" accepts.
    await expect(page.getByTestId("confirm-no")).toBeFocused();
    expect(accepts).toEqual([]);
    await page.getByTestId("confirm-yes").click();
    await expect(dialog).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    expect(accepts).toHaveLength(1);
  });

  test("declining, withdrawing, roles and leaving", async ({ page }) => {
    const alice = await createAccountWithVault("roles-a");
    const bob = await createAccount("roles-b");
    const carol = await createAccount("roles-c");
    const dave = await createAccount("roles-d");
    const [bobDevice, daveDevice] = await Promise.all([
      nodeDevice(bob),
      nodeDevice(dave),
    ]);
    for (const email of [bob.email, carol.email]) {
      const candidate = await alice.device.engine.lookupUser(email);
      await alice.device.account.verifyContact(candidate);
      await alice.device.engine.invite(alice.vaultId, candidate);
    }
    await shareNode(alice.device, daveDevice, dave.email, alice.vaultId);
    await bobDevice.engine.refresh();
    await bobDevice.engine.declineInvitation(alice.vaultId);

    await loginViaUi(page, alice);
    await openDatabasePage(page, alice.vaultId);
    const members = page.getByTestId("member");
    await expect(members).toHaveCount(3);
    await members
      .filter({ hasText: carol.email })
      .getByTestId("member-withdraw")
      .click();
    await expect(members).toHaveCount(2);
    const daveRow = members.filter({ hasText: dave.email });
    await daveRow.getByTestId("member-role-toggle").click();
    await expect(daveRow.getByTestId("member-role")).toHaveText("Eigentümer");
    await expect(daveRow.getByTestId("member-signed")).toBeVisible();
    await daveDevice.engine.refresh();
    expect(view(daveDevice.engine, alice.vaultId)).toMatchObject({
      role: "owner",
      roles: { status: "ok" },
    });

    // Dave leaves, stepping down first: Alice is asked to renew the key.
    await daveDevice.engine.leaveVault(alice.vaultId);
    await expect(page.getByTestId("banner-rotation-required")).toBeVisible();
    await expect(page.getByTestId("members-rotation-required")).toBeVisible();
    await page.getByTestId("rotation-open").click();
    const rotation = page.getByTestId("rotation-dialog");
    await rotation.getByTestId("rotation-run").click();
    await expect(rotation.getByTestId("rotation-done")).toBeVisible();
    await rotation.getByTestId("rotation-close").click();
    await expect(page.getByTestId("banner-rotation-required")).toHaveCount(0);
  });
});
