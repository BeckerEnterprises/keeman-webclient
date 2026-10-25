/**
 * WebAuthn in the browser: the options of the server go
 * to `navigator.credentials`, the result goes back as `toJSON()`. Nothing is
 * checked or stored here; the server verifies.
 */

export type WebauthnFailure = "cancelled" | "exists" | "unsupported" | "failed";

export class WebauthnError extends Error {
  constructor(readonly reason: WebauthnFailure) {
    super(`WebAuthn: ${reason}`);
    this.name = "WebauthnError";
  }
}

type Json = Record<string, unknown>;

interface JsonParsers {
  parseCreationOptionsFromJSON?: (
    options: Json,
  ) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (
    options: Json,
  ) => PublicKeyCredentialRequestOptions;
}

export function webauthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    // Missing outside secure contexts, whatever the types say.
    "credentials" in navigator &&
    typeof navigator.credentials.create === "function"
  );
}

export function fromBase64Url(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function toBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function descriptors(
  list: unknown,
): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map((item: Json) => ({
    ...item,
    type: "public-key",
    id: fromBase64Url(String(item.id)),
  }));
}

/** `parseCreationOptionsFromJSON` where the browser has it, else by hand. */
export function creationOptions(
  json: Json,
): PublicKeyCredentialCreationOptions {
  const parsers = window.PublicKeyCredential as unknown as JsonParsers;
  if (typeof parsers.parseCreationOptionsFromJSON === "function")
    return parsers.parseCreationOptionsFromJSON(json);
  const user = json.user as Json;
  return {
    ...json,
    challenge: fromBase64Url(String(json.challenge)),
    user: { ...user, id: fromBase64Url(String(user.id)) },
    excludeCredentials: descriptors(json.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
}

export function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  const parsers = window.PublicKeyCredential as unknown as JsonParsers;
  if (typeof parsers.parseRequestOptionsFromJSON === "function")
    return parsers.parseRequestOptionsFromJSON(json);
  return {
    ...json,
    challenge: fromBase64Url(String(json.challenge)),
    allowCredentials: descriptors(json.allowCredentials),
  };
}

interface CredentialLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  response: AuthenticatorResponse;
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs;
  toJSON?: () => unknown;
}

/** `PublicKeyCredential.toJSON()`, or the same format by hand. */
export function credentialJson(credential: CredentialLike): unknown {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const response = credential.response as AuthenticatorResponse &
    Partial<AuthenticatorAttestationResponse> &
    Partial<AuthenticatorAssertionResponse>;
  const json: Json = {
    clientDataJSON: toBase64Url(response.clientDataJSON),
  };
  if (response.attestationObject) {
    json.attestationObject = toBase64Url(response.attestationObject);
    json.transports = response.getTransports?.() ?? [];
    const authData = response.getAuthenticatorData?.();
    if (authData) json.authenticatorData = toBase64Url(authData);
    const publicKey = response.getPublicKey?.();
    if (publicKey) json.publicKey = toBase64Url(publicKey);
    const algorithm = response.getPublicKeyAlgorithm?.();
    if (algorithm !== undefined) json.publicKeyAlgorithm = algorithm;
  } else {
    if (response.authenticatorData)
      json.authenticatorData = toBase64Url(response.authenticatorData);
    if (response.signature) json.signature = toBase64Url(response.signature);
    json.userHandle = response.userHandle
      ? toBase64Url(response.userHandle)
      : null;
  }
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    response: json,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

function failure(error: unknown): WebauthnError {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError")
    return new WebauthnError("cancelled");
  if (name === "InvalidStateError") return new WebauthnError("exists");
  if (name === "NotSupportedError") return new WebauthnError("unsupported");
  return new WebauthnError("failed");
}

async function run(call: () => Promise<Credential | null>): Promise<unknown> {
  if (!webauthnSupported()) throw new WebauthnError("unsupported");
  let credential: Credential | null;
  try {
    credential = await call();
  } catch (error) {
    throw failure(error);
  }
  if (!credential) throw new WebauthnError("cancelled");
  return credentialJson(credential as unknown as CredentialLike);
}

/** Registration: `navigator.credentials.create` with the server's options. */
export function createPasskey(options: Json): Promise<unknown> {
  return run(() =>
    navigator.credentials.create({ publicKey: creationOptions(options) }),
  );
}

/** Second factor: `navigator.credentials.get` with the server's options. */
export function getPasskey(options: Json): Promise<unknown> {
  return run(() =>
    navigator.credentials.get({ publicKey: requestOptions(options) }),
  );
}
