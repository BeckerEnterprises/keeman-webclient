/**
 * Response checks with valibot. Responses are open: unknown
 * fields are dropped, the fields this client uses must be valid.
 */
import * as v from "valibot";
import { UUID_PATTERN } from "../crypto/uuid";

const base64url = (length: number) =>
  v.pipe(v.string(), v.regex(new RegExp(`^[A-Za-z0-9_-]{${String(length)}}$`)));

const Uuid = v.pipe(v.string(), v.regex(UUID_PATTERN));
const Token = base64url(43);
// Safe integers only: counters from the server end up in the device's marks.
const PositiveInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const TimeSchema = v.object({
  now_ms: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export const ServerConfigSchema = v.object({
  server_version: v.string(),
  api_version: v.number(),
  registration: v.picklist(["closed", "invite", "open"]),
  features: v.object({
    favicon: v.boolean(),
    /** Absent on servers that do not know the vault manifest. */
    manifest: v.optional(v.boolean()),
    /** Absent on servers without signing keys and roles chains. */
    roles: v.optional(v.boolean()),
    /** Absent on servers that store no freshness attestations. */
    freshness: v.optional(v.boolean()),
    /** Absent on servers without confirmations by another device. */
    confirmation: v.optional(v.boolean()),
  }),
  limits: v.object({ attachment_max_bytes: Count }),
});
export type ServerConfig = v.InferOutput<typeof ServerConfigSchema>;

export const PreloginSchema = v.object({
  kdf: v.unknown(),
  salt: base64url(22),
});

export const AttachmentUploadSchema = v.object({
  part_size: PositiveInteger,
  parts: PositiveInteger,
});
export type AttachmentUpload = v.InferOutput<typeof AttachmentUploadSchema>;

export const SessionSchema = v.object({
  status: v.literal("ok"),
  session_id: Uuid,
  user_id: Uuid,
  access_token: Token,
  access_expires_in: PositiveInteger,
  backup_codes_remaining: v.optional(Count),
});

const SecondFactorMethodSchema = v.picklist([
  "totp",
  "webauthn",
  "backup_code",
]);

export const SecondFactorSchema = v.object({
  status: v.literal("second_factor_required"),
  challenge_token: Token,
  methods: v.pipe(v.array(SecondFactorMethodSchema), v.minLength(1)),
  expires_in: PositiveInteger,
});
export type SecondFactorMethod = v.InferOutput<typeof SecondFactorMethodSchema>;

export const RecoveryPayloadSchema = v.object({
  status: v.literal("recovery_ok"),
  recovery_token: Token,
  user_id: Uuid,
  user_key_recovery_wrapped: base64url(98),
  expires_in: PositiveInteger,
  backup_codes_remaining: v.optional(Count),
});

const BackupCodesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.regex(/^[A-Z2-7]{10}$/))),
  v.length(10),
);

export const TotpSetupSchema = v.object({
  secret: v.pipe(v.string(), v.regex(/^[A-Z2-7]{32}$/)),
  otpauth_uri: v.pipe(v.string(), v.startsWith("otpauth://totp/")),
});

export const TotpEnableSchema = v.object({
  backup_codes: v.optional(BackupCodesSchema),
});

export const BackupCodesResponseSchema = v.object({
  backup_codes: BackupCodesSchema,
});

/** WebAuthn options as an open object (`public_key`). */
const PublicKeyOptionsSchema = v.record(v.string(), v.unknown());

export const WebauthnRequestOptionsSchema = v.object({
  public_key: PublicKeyOptionsSchema,
});

export const WebauthnRegistrationOptionsSchema = v.object({
  registration_token: Token,
  public_key: PublicKeyOptionsSchema,
});

export const WebauthnRegistrationSchema = v.object({
  id: Uuid,
  backup_codes: v.optional(BackupCodesSchema),
});

export const PasskeyListSchema = v.object({
  credentials: v.array(
    v.object({
      id: Uuid,
      name: v.string(),
      created: v.string(),
      last_used: v.nullable(v.string()),
      prf_enabled: v.boolean(),
    }),
  ),
});
export type PasskeyInfo = v.InferOutput<
  typeof PasskeyListSchema
>["credentials"][number];

export const TokenRefreshSchema = v.object({
  access_token: Token,
  access_expires_in: PositiveInteger,
});

export const MeSchema = v.object({
  user_id: Uuid,
  email: v.string(),
  kdf: v.unknown(),
  salt: base64url(22),
  user_key_wrapped: base64url(98),
  public_key: base64url(43),
  private_key_wrapped: base64url(98),
  /** `null` until an older account adds it; absent on older servers. */
  signing_public_key: v.optional(v.nullable(base64url(43))),
  user_data: v.object({
    revision: PositiveInteger,
    data: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/)),
  }),
  two_factor: v.object({
    totp: v.boolean(),
    webauthn_credentials: Count,
    backup_codes_remaining: Count,
  }),
  /** The own attestation of user_data; checked by the caller, never trusted. */
  freshness: v.optional(v.unknown()),
  created: v.string(),
});
export type Me = v.InferOutput<typeof MeSchema>;

const ExpiresIn = v.pipe(v.number(), v.integer(), v.minValue(0));

export const ConfirmationCreatedSchema = v.object({
  request_id: Uuid,
  expires_at: v.string(),
  expires_in: ExpiresIn,
});

/** Open requests of the account; names and nonces are server claims. */
export const ConfirmationListSchema = v.object({
  requests: v.array(
    v.object({
      request_id: Uuid,
      session_id: Uuid,
      device_name: v.string(),
      client_type: v.string(),
      created: v.string(),
      expires_at: v.string(),
      expires_in: ExpiresIn,
      nonce: v.string(),
      own: v.boolean(),
      answered: v.boolean(),
    }),
  ),
});
export type ConfirmationListItem = v.InferOutput<
  typeof ConfirmationListSchema
>["requests"][number];

/** The own request; the answer is checked by the caller, never trusted. */
export const ConfirmationStatusSchema = v.object({
  request_id: Uuid,
  expires_at: v.string(),
  expires_in: ExpiresIn,
  answer: v.optional(v.unknown()),
});

export const ReauthSchema = v.object({ reauth_token: Token });

export const RevisionSchema = v.object({ revision: PositiveInteger });

export const SessionListSchema = v.object({
  sessions: v.array(
    v.object({
      id: Uuid,
      device_name: v.string(),
      client_type: v.string(),
      created: v.string(),
      last_seen: v.string(),
      ip_hint: v.nullable(v.string()),
      current: v.boolean(),
    }),
  ),
});
export type SessionInfo = v.InferOutput<
  typeof SessionListSchema
>["sessions"][number];

const Base64Text = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/));

const KeyGrantSchema = v.object({
  key_box: Base64Text,
  key_version: PositiveInteger,
  sender_id: Uuid,
});

export const VaultListSchema = v.object({
  vaults: v.array(
    v.object({
      vault_id: Uuid,
      role: v.picklist(["owner", "member"]),
      state: v.picklist(["pending", "active"]),
      vault_key_version: PositiveInteger,
      member_key_version: PositiveInteger,
      key_wrapped: v.nullable(base64url(98)),
      pending_key: v.nullable(KeyGrantSchema),
      invitation: v.nullable(KeyGrantSchema),
      revision: PositiveInteger,
      rotation_required: v.boolean(),
      /** Version of the roles chain's head; `null` without a chain. */
      roles_version: v.optional(v.nullable(PositiveInteger)),
      /**
       * The own attestation of this vault; checked by the caller, so a bad
       * one is ignored instead of breaking the list.
       */
      freshness: v.optional(v.unknown()),
      member_count: Count,
      created: v.string(),
    }),
  ),
});
export type VaultSummary = v.InferOutput<
  typeof VaultListSchema
>["vaults"][number];

/** The favicon proxy's answer; the core checks the PNG itself. */
export const FaviconSchema = v.object({
  mime: v.literal("image/png"),
  data: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/)),
  width: v.literal(64),
  height: v.literal(64),
  origin: v.string(),
});
export type Favicon = v.InferOutput<typeof FaviconSchema>;

/** An account as other accounts see it. */
export const PublicUserSchema = v.object({
  user_id: Uuid,
  email: v.string(),
  public_key: base64url(43),
  signing_public_key: v.optional(v.nullable(base64url(43))),
});
export type PublicUser = v.InferOutput<typeof PublicUserSchema>;

export const MemberListSchema = v.object({
  members: v.array(
    v.object({
      user_id: Uuid,
      email: v.string(),
      role: v.picklist(["owner", "member"]),
      state: v.picklist(["pending", "active"]),
      public_key: base64url(43),
      signing_public_key: v.optional(v.nullable(base64url(43))),
      invited_by: v.nullable(Uuid),
      created: v.string(),
    }),
  ),
});
export type Member = v.InferOutput<typeof MemberListSchema>["members"][number];

/** `GET /v1/vaults/{id}/roles`: statements after `since`, ascending. */
export const RoleChainSchema = v.object({
  statements: v.array(
    v.object({
      version: PositiveInteger,
      statement: v.pipe(Base64Text, v.maxLength(65_536)),
      signature: base64url(86),
    }),
  ),
  /** Where the next page starts; missing from servers without pages. */
  next_since: v.optional(v.nullable(PositiveInteger)),
});
export type RoleChain = v.InferOutput<typeof RoleChainSchema>;

export const OpenRotationSchema = v.object({
  rotation_id: Uuid,
  expires_in: PositiveInteger,
});
export type OpenRotation = v.InferOutput<typeof OpenRotationSchema>;

export const OBJECT_TYPES = [
  "vault_meta",
  "group",
  "entry",
  "icon",
  "manifest",
] as const;

export const ChangesPageSchema = v.object({
  vault_revision: PositiveInteger,
  key_version: PositiveInteger,
  objects: v.array(
    v.object({
      id: Uuid,
      type: v.picklist(OBJECT_TYPES),
      revision: PositiveInteger,
      key_version: PositiveInteger,
      deleted: v.boolean(),
      data: v.nullable(Base64Text),
      updated_at: v.string(),
      updated_by: Uuid,
    }),
  ),
  next_cursor: v.nullable(v.pipe(v.string(), v.maxLength(256))),
});
export type ChangesPage = v.InferOutput<typeof ChangesPageSchema>;
export type ChangedObject = ChangesPage["objects"][number];

export const BatchResultSchema = v.object({
  vault_revision: PositiveInteger,
  results: v.array(v.object({ id: Uuid, revision: PositiveInteger })),
});
export type BatchResult = v.InferOutput<typeof BatchResultSchema>;
