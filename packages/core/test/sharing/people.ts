/** Several accounts on one fake server, for the sharing tests. */
import { FakeServer } from "../account/fake-server";
import type { SyncEngine } from "../../src/sync/engine";
import { NAMES, newAccount, PASSWORD } from "../sync/devices";

export type Person = Awaited<ReturnType<typeof person>>;

let invites = 0;

export async function person(server: FakeServer, email: string) {
  const code = `INVITE-${String(++invites)}`;
  server.invites.add(code);
  const device = newAccount(server);
  const pending = await device.account.startRegistration({
    email,
    password: PASSWORD,
    inviteCode: code,
    language: "de",
  });
  await pending.submit();
  const engine = device.account.startSync();
  await engine.refresh();
  return { email, server, ...device, engine };
}

/** An owner with a vault of their own. */
export async function owner(
  server = new FakeServer(),
  email = "alice@example.com",
) {
  const someone = await person(server, email);
  const vaultId = await someone.engine.createVault(NAMES);
  return { ...someone, vaultId };
}

/** Accepts an invitation with the head the accept dialog shows. */
export async function acceptShown(
  engine: SyncEngine,
  vaultId: string,
): Promise<void> {
  const details = await engine.invitationDetails(vaultId);
  await engine.acceptInvitation(vaultId, details);
}

/** The owner verifies and invites; the member verifies and accepts. */
export async function share(
  host: Person,
  guest: Person,
  vaultId: string,
): Promise<void> {
  const candidate = await host.engine.lookupUser(guest.email);
  if (candidate.status !== "verified")
    await host.account.verifyContact(candidate);
  await host.engine.invite(vaultId, candidate);
  await guest.engine.refresh();
  const invitation = guest.engine.snapshot.invitations.find(
    (i) => i.vaultId === vaultId,
  );
  if (!invitation?.sender) throw new Error("invitation missing");
  if (invitation.sender.status !== "verified")
    await guest.account.verifyContact(invitation.sender);
  await acceptShown(guest.engine, vaultId);
}

export function posts(server: FakeServer, suffix: string): number {
  return server.log.filter(
    (r) => r.method === "POST" && r.path.endsWith(suffix),
  ).length;
}
