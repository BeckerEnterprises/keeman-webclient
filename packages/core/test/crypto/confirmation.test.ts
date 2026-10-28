import { describe, expect, it } from "vitest";
import {
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from "../../src/crypto/bytes";
import {
  CONFIRMATION_MAX_VAULTS,
  CONFIRMATION_NONCE_BYTES,
  CONFIRMATION_STATEMENT_MAX_BYTES,
  decodeConfirmation,
  encodeConfirmation,
  encodeConfirmationContent,
  readConfirmation,
  signConfirmation,
  validateConfirmationContent,
  type ConfirmationContent,
} from "../../src/crypto/confirmation";
import { sign, SIGNATURE_CONTEXT } from "../../src/crypto/signing";
import { deriveSigningKeyPair } from "../../src/crypto/signing";
import { expectCryptoError, IDS } from "../helpers";
import { tv } from "../../src/crypto/internal/test-values";

const NONCE = toBase64Url(tv("confirmation-nonce", CONFIRMATION_NONCE_BYTES));
const TIME = "2026-10-28T08:42:00.000Z";
const HASH = toBase64Url(tv("confirmation-head", 32));
const CODE = "K3QF6XMA2PLRTB6WQH4N7ZDEXA";
const keys = deriveSigningKeyPair(tv("confirmation-user-key", 32));
const otherKeys = deriveSigningKeyPair(tv("confirmation-other-key", 32));

const CONTENT: ConfirmationContent = {
  userData: { rev: 13, seq: 9, at: TIME },
  vaults: [
    {
      vaultId: IDS.vault,
      rev: 412,
      kv: 3,
      mf: 57,
      rl: { version: 4, hash: HASH },
      cp: [{ version: 5, code: CODE }],
      at: TIME,
    },
    {
      vaultId: IDS.object,
      rev: 0,
      kv: null,
      mf: null,
      rl: null,
      cp: [],
      at: null,
    },
  ],
};

function signed(
  overrides: { userId?: string; nonce?: string; content?: string } = {},
  secretKey = keys.secretKey,
  context: (typeof SIGNATURE_CONTEXT)[keyof typeof SIGNATURE_CONTEXT] = SIGNATURE_CONTEXT.confirmation,
) {
  const bytes = encodeConfirmation({
    userId: overrides.userId ?? IDS.user,
    nonce: overrides.nonce ?? NONCE,
    time: TIME,
    content:
      overrides.content ?? toBase64Url(encodeConfirmationContent(CONTENT)),
  });
  return {
    statement: toBase64Url(bytes),
    signature: toBase64Url(sign(secretKey, context, bytes)),
  };
}

const expected = { userId: IDS.user, nonce: NONCE };

describe("confirmation statement", () => {
  it("is canonical ASCII JSON in the fixed field order", () => {
    const content = toBase64Url(encodeConfirmationContent(CONTENT));
    const bytes = encodeConfirmation({
      userId: IDS.user,
      nonce: NONCE,
      time: TIME,
      content,
    });
    expect(utf8Decode(bytes)).toBe(
      `{"v":1,"type":"device_confirmation","user_id":"${IDS.user}","nonce":"${NONCE}","time":"${TIME}","content":"${content}"}`,
    );
    expect(decodeConfirmation(bytes)).toEqual({
      userId: IDS.user,
      nonce: NONCE,
      time: TIME,
      content,
    });
  });

  it("rejects bytes that are not exactly the canonical form", () => {
    const good = utf8Decode(signedBytes());
    for (const text of [
      good.replace(`"v":1,`, `"v":1, `),
      good
        .replace(`"type":"device_confirmation",`, "")
        .replace(`"nonce"`, `"type":"device_confirmation","nonce"`),
      good.replace(`"v":1,`, `"v":1,"v":1,`),
      good.replace(`}`, `,"extra":1}`),
      good.replace(`"v":1`, `"v":2`),
      good.replace("device_confirmation", "vault_freshness"),
    ])
      expectCryptoError(
        () => decodeConfirmation(utf8Encode(text)),
        "validation",
      );
  });

  it("checks every field", () => {
    const base = {
      userId: IDS.user,
      nonce: NONCE,
      time: TIME,
      content: "e30",
    };
    for (const bad of [
      { userId: IDS.user.toUpperCase() },
      { nonce: toBase64Url(tv("short", 31)) },
      { nonce: `${NONCE}=` },
      { time: "2026-10-28T08:42:00Z" },
      { content: "" },
      { content: "e30=" },
    ])
      expectCryptoError(
        () => encodeConfirmation({ ...base, ...bad }),
        "validation",
      );
  });

  it("is read with the own key, account and nonce", () => {
    const read = readConfirmation(signed(), keys.publicKey, expected);
    expect(read.time).toBe(TIME);
    expect(read.content).toEqual(CONTENT);
  });

  it("is signed by signConfirmation like by hand", () => {
    const made = signConfirmation(
      { userId: IDS.user, nonce: NONCE, time: TIME, content: CONTENT },
      keys.secretKey,
    );
    expect(made).toEqual(signed());
  });

  it("does not verify with another key or context", () => {
    expectCryptoError(
      () => readConfirmation(signed(), otherKeys.publicKey, expected),
      "auth",
    );
    for (const context of [
      SIGNATURE_CONTEXT.freshness,
      SIGNATURE_CONTEXT.roles,
    ])
      expectCryptoError(
        () =>
          readConfirmation(
            signed({}, keys.secretKey, context),
            keys.publicKey,
            expected,
          ),
        "auth",
      );
  });

  it("belongs to the own account and the own nonce only", () => {
    expectCryptoError(
      () =>
        readConfirmation(
          signed({ userId: IDS.other }),
          keys.publicKey,
          expected,
        ),
      "validation",
    );
    const other = toBase64Url(tv("other-nonce", CONFIRMATION_NONCE_BYTES));
    expectCryptoError(
      () =>
        readConfirmation(signed({ nonce: other }), keys.publicKey, expected),
      "validation",
    );
  });

  it("rejects a changed statement under the old signature", () => {
    const good = signed();
    const forged = signed({
      content: toBase64Url(
        encodeConfirmationContent({ ...CONTENT, userData: null }),
      ),
    });
    expectCryptoError(
      () =>
        readConfirmation(
          { statement: forged.statement, signature: good.signature },
          keys.publicKey,
          expected,
        ),
      "auth",
    );
  });

  it("rejects malformed wire forms", () => {
    const good = signed();
    for (const bad of [
      null,
      { statement: good.statement },
      { statement: good.statement, signature: 1 },
      { statement: `${good.statement}=`, signature: good.signature },
      { statement: good.statement, signature: good.signature.slice(1) },
      { statement: "A".repeat(1_398_103), signature: good.signature },
    ])
      expectCryptoError(
        () => readConfirmation(bad, keys.publicKey, expected),
        "format",
      );
  });

  it("rejects signed content that is not valid", () => {
    for (const json of ["[]", `{"schema":2,"user_data":null,"vaults":{}}`]) {
      const answer = signed({ content: toBase64Url(utf8Encode(json)) });
      let code: string | undefined;
      try {
        readConfirmation(answer, keys.publicKey, expected);
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(["encoding", "validation"]).toContain(code);
    }
  });
});

function signedBytes(): Uint8Array {
  return fromBase64Url(signed().statement);
}

describe("confirmation content", () => {
  const wire = () =>
    JSON.parse(utf8Decode(encodeConfirmationContent(CONTENT))) as Record<
      string,
      unknown
    >;

  it("writes cp only when there are points and reads back the same", () => {
    const json = wire();
    expect(json).toEqual({
      schema: 1,
      user_data: { rev: 13, seq: 9, at: TIME },
      vaults: {
        [IDS.vault]: {
          rev: 412,
          kv: 3,
          mf: 57,
          rl: [4, HASH],
          cp: [[5, CODE]],
          at: TIME,
        },
        [IDS.object]: { rev: 0, kv: null, mf: null, rl: null, at: null },
      },
    });
    expect(validateConfirmationContent(json)).toEqual(CONTENT);
  });

  it("ignores unknown fields, also fd of the former pairing", () => {
    const json = { ...wire(), fd: 7, extra: true };
    expect(validateConfirmationContent(json)).toEqual(CONTENT);
  });

  it("rejects every invalid field", () => {
    const vault = (patch: Record<string, unknown>) => {
      const json = wire();
      const vaults = json.vaults as Record<string, Record<string, unknown>>;
      vaults[IDS.vault] = { ...vaults[IDS.vault], ...patch };
      return json;
    };
    const cases: Record<string, unknown>[] = [
      { ...wire(), schema: 2 },
      { ...wire(), user_data: { rev: 0, seq: 1, at: null } },
      { ...wire(), user_data: { rev: 1, seq: 1 } },
      { ...wire(), user_data: { rev: 1, seq: 1, at: "yesterday" } },
      { schema: 1, vaults: {} },
      { schema: 1, user_data: null, vaults: [] },
      { schema: 1, user_data: null, vaults: { "not-a-uuid": {} } },
      vault({ rev: -1 }),
      vault({ kv: 0 }),
      vault({ mf: 1.5 }),
      vault({ rl: [0, HASH] }),
      vault({ rl: [4, "short"] }),
      vault({ cp: [[5, CODE.toLowerCase()]] }),
      vault({ cp: [[5, `${CODE.slice(0, 25)}B`]] }),
      vault({ cp: [[0, CODE]] }),
      vault({ cp: [5, CODE] }),
      vault({ cp: Array.from({ length: 17 }, () => [5, CODE]) }),
      vault({ at: 0 }),
      (() => {
        const json = wire();
        const vaults = json.vaults as Record<string, Record<string, unknown>>;
        delete vaults[IDS.vault]?.at;
        return json;
      })(),
    ];
    for (const json of cases)
      expectCryptoError(() => validateConfirmationContent(json), "validation");
  });

  it("carries at most the vaults that fit into one answer", () => {
    const vaults = Array.from(
      { length: CONFIRMATION_MAX_VAULTS + 1 },
      (_, i) => ({
        vaultId: `0192b3a4-5c6d-7e8f-9a0b-${i.toString(16).padStart(12, "0")}`,
        rev: 1,
        kv: 1,
        mf: 1,
        rl: null,
        cp: [],
        at: null,
      }),
    );
    expectCryptoError(
      () => encodeConfirmationContent({ userData: null, vaults }),
      "validation",
    );
    const fits = { userData: null, vaults: vaults.slice(1) };
    expect(
      validateConfirmationContent(
        JSON.parse(utf8Decode(encodeConfirmationContent(fits))) as Record<
          string,
          unknown
        >,
      ).vaults,
    ).toHaveLength(CONFIRMATION_MAX_VAULTS);
  });

  it("fits the largest content without points into 1 MiB", () => {
    const big = 9_007_199_254_740_991;
    const vaults = Array.from({ length: CONFIRMATION_MAX_VAULTS }, (_, i) => ({
      vaultId: `0192b3a4-5c6d-7e8f-9a0b-${i.toString(16).padStart(12, "0")}`,
      rev: big,
      kv: big,
      mf: big,
      rl: { version: big, hash: HASH },
      cp: [] as { version: number; code: string }[],
      at: TIME,
    }));
    const statement = {
      userId: IDS.user,
      nonce: NONCE,
      time: TIME,
      content: { userData: { rev: big, seq: big, at: TIME }, vaults },
    };
    const answer = signConfirmation(statement, keys.secretKey);
    expect(fromBase64Url(answer.statement).length).toBeLessThanOrEqual(
      CONFIRMATION_STATEMENT_MAX_BYTES,
    );
    // Points can make it larger; the confirming device then refuses.
    const points = Array.from({ length: 16 }, () => ({
      version: big,
      code: CODE,
    }));
    expectCryptoError(
      () =>
        signConfirmation(
          {
            ...statement,
            content: {
              ...statement.content,
              vaults: vaults.map((v) => ({ ...v, cp: points })),
            },
          },
          keys.secretKey,
        ),
      "validation",
    );
  });
});
