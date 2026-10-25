import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPasskey,
  creationOptions,
  credentialJson,
  fromBase64Url,
  getPasskey,
  requestOptions,
  toBase64Url,
  webauthnSupported,
  WebauthnError,
} from "./webauthn";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

function stubWebauthn(extra: Record<string, unknown> = {}) {
  const constructor = Object.assign(function PublicKeyCredential() {}, extra);
  vi.stubGlobal("PublicKeyCredential", constructor);
  const credentials = { create: vi.fn(), get: vi.fn() };
  vi.stubGlobal("navigator", { userAgent: navigator.userAgent, credentials });
  return credentials;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebAuthn helpers", () => {
  it("converts Base64url without padding both ways", () => {
    const data = bytes(0xfb, 0xff, 0x00, 0x01);
    expect(toBase64Url(data)).toBe("-_8AAQ");
    expect(new Uint8Array(fromBase64Url("-_8AAQ"))).toEqual(
      new Uint8Array(data),
    );
    expect(toBase64Url(new Uint8Array([1, 2, 3]).subarray(1))).toBe("AgM");
  });

  it("parses options by hand when the browser lacks the JSON parsers", () => {
    stubWebauthn();
    const created = creationOptions({
      challenge: "AQID",
      rp: { id: "localhost", name: "KeeMan" },
      user: { id: "BAU", name: "a@example.com", displayName: "a@example.com" },
      excludeCredentials: [{ type: "public-key", id: "Bg" }],
    });
    expect(new Uint8Array(created.challenge as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(new Uint8Array(created.user.id as ArrayBuffer)).toEqual(
      new Uint8Array([4, 5]),
    );
    expect(created.rp).toEqual({ id: "localhost", name: "KeeMan" });
    const id = created.excludeCredentials?.[0]?.id as ArrayBuffer;
    expect(new Uint8Array(id)).toEqual(new Uint8Array([6]));
    const requested = requestOptions({
      challenge: "AQID",
      allowCredentials: [{ type: "public-key", id: "Bw" }],
      userVerification: "required",
    });
    expect(requested.userVerification).toBe("required");
    const allowed = requested.allowCredentials?.[0]?.id as ArrayBuffer;
    expect(new Uint8Array(allowed)).toEqual(new Uint8Array([7]));
  });

  it("prefers the browser's JSON parsers", () => {
    const parsed = { challenge: new ArrayBuffer(1) };
    const parseCreationOptionsFromJSON = vi.fn(() => parsed);
    stubWebauthn({ parseCreationOptionsFromJSON });
    expect(creationOptions({ challenge: "AA" })).toBe(parsed);
    expect(parseCreationOptionsFromJSON).toHaveBeenCalledWith({
      challenge: "AA",
    });
  });

  it("serialises like toJSON when the browser lacks it", () => {
    const extensions = () => ({});
    const attestation = credentialJson({
      id: "AQ",
      rawId: bytes(1),
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: extensions,
      response: {
        clientDataJSON: bytes(2),
        attestationObject: bytes(3),
        getTransports: () => ["internal"],
        getAuthenticatorData: () => bytes(4),
        getPublicKey: () => bytes(5),
        getPublicKeyAlgorithm: () => -7,
      } as unknown as AuthenticatorResponse,
    });
    expect(attestation).toEqual({
      id: "AQ",
      rawId: "AQ",
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: "Ag",
        attestationObject: "Aw",
        transports: ["internal"],
        authenticatorData: "BA",
        publicKey: "BQ",
        publicKeyAlgorithm: -7,
      },
    });
    const assertion = credentialJson({
      id: "AQ",
      rawId: bytes(1),
      type: "public-key",
      getClientExtensionResults: extensions,
      response: {
        clientDataJSON: bytes(2),
        authenticatorData: bytes(4),
        signature: bytes(6),
        userHandle: null,
      } as unknown as AuthenticatorResponse,
    });
    expect(assertion).toMatchObject({
      authenticatorAttachment: null,
      response: {
        clientDataJSON: "Ag",
        authenticatorData: "BA",
        signature: "Bg",
        userHandle: null,
      },
    });
    const native = { toJSON: () => ({ native: true }) };
    expect(credentialJson(native as never)).toEqual({ native: true });
  });

  it("maps browser errors to reasons", async () => {
    const credentials = stubWebauthn();
    expect(webauthnSupported()).toBe(true);
    const cases: [string, string][] = [
      ["NotAllowedError", "cancelled"],
      ["AbortError", "cancelled"],
      ["InvalidStateError", "exists"],
      ["NotSupportedError", "unsupported"],
      ["SecurityError", "failed"],
    ];
    for (const [name, reason] of cases) {
      credentials.create.mockRejectedValueOnce(new DOMException("x", name));
      const error = await createPasskey({
        challenge: "AA",
        user: { id: "AA" },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WebauthnError);
      expect((error as WebauthnError).reason).toBe(reason);
    }
    credentials.get.mockResolvedValueOnce(null);
    const none = await getPasskey({ challenge: "AA" }).catch((e: unknown) => e);
    expect((none as WebauthnError).reason).toBe("cancelled");
    credentials.get.mockResolvedValueOnce({ toJSON: () => ({ ok: 1 }) });
    expect(await getPasskey({ challenge: "AA" })).toEqual({ ok: 1 });
  });

  it("reports missing support", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(webauthnSupported()).toBe(false);
    const error = await getPasskey({ challenge: "AA" }).catch(
      (e: unknown) => e,
    );
    expect((error as WebauthnError).reason).toBe("unsupported");
  });
});
