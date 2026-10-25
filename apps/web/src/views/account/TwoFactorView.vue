<script setup lang="ts">
/**
 * Second factors of the account: TOTP with QR code, backup codes
 * and passkeys. Every change asks for the master password (local check,
 * then reauth). Secret and codes live only in this page and go when it
 * is left, locked or logged out.
 */
import type { PasskeyInfo, TotpSetup, TwoFactorStatus } from "@keeman/core";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import BackupCodesPanel from "../../components/BackupCodesPanel.vue";
import ErrorNotice from "../../components/ErrorNotice.vue";
import PasswordInput from "../../components/PasswordInput.vue";
import { deviceName } from "../../device";
import { toUiError, type UiError } from "../../errors";
import { formatDate } from "../../format";
import { drawQrCode } from "../../qr-code";
import { useServices } from "../../services";
import { useSessionStore } from "../../stores/session";
import { createPasskey, webauthnSupported } from "../../webauthn";
import type { PasswordField } from "../../components/password-field";

type Action =
  | { kind: "totpSetup" }
  | { kind: "totpDisable" }
  | { kind: "codes" }
  | { kind: "passkeyAdd" }
  | { kind: "passkeyRemove"; passkey: PasskeyInfo };

const { t } = useI18n();
const session = useSessionStore();
const status = ref<TwoFactorStatus>();
const passkeys = ref<PasskeyInfo[]>([]);
const action = ref<Action>();
const password = ref<PasswordField>();
const passkeyName = ref(deviceName(navigator.userAgent));
const busy = ref(false);
const error = ref<UiError>();
const done = ref<string>();
/**
 * The open TOTP setup: secret and key URI, until enabled or left. Shallow:
 * a reactive proxy would hide the private fields of the core object.
 */
const setup = shallowRef<TotpSetup>();
const totpCode = ref("");
const qr = ref<HTMLCanvasElement>();
/** Backup codes shown once; leaving is caught until they are saved. */
const codes = ref<string[]>();
const supported = webauthnSupported();

const anyFactor = computed(
  () => (status.value?.totp ?? false) || (status.value?.passkeys ?? 0) > 0,
);
const secretGroups = computed(
  () => setup.value?.secret.match(/.{1,4}/g)?.join(" ") ?? "",
);

async function load(): Promise<void> {
  const { account } = useServices();
  try {
    const [loaded, list] = await Promise.all([
      account.twoFactorStatus(),
      account.passkeys(),
    ]);
    status.value = loaded;
    passkeys.value = list;
  } catch (caught) {
    error.value = toUiError(caught);
  }
}

onMounted(load);

function choose(next: Action): void {
  action.value = next;
  error.value = undefined;
  done.value = undefined;
}

function cancel(): void {
  action.value = undefined;
  setup.value = undefined;
  totpCode.value = "";
  error.value = undefined;
}

/** Runs the chosen action with the typed master password. */
async function confirm(): Promise<void> {
  const current = action.value;
  if (!current) return;
  const secret = password.value?.value() ?? "";
  password.value?.clear();
  const { account } = useServices();
  busy.value = true;
  error.value = undefined;
  try {
    switch (current.kind) {
      case "totpSetup":
        setup.value = await account.startTotpSetup(secret);
        action.value = undefined;
        await nextTick();
        if (qr.value) await drawQrCode(qr.value, setup.value.otpauthUri);
        break;
      case "totpDisable":
        await account.disableTotp(secret);
        action.value = undefined;
        done.value = t("twoFactor.totpDisabled");
        break;
      case "codes":
        codes.value = await account.regenerateBackupCodes(secret);
        action.value = undefined;
        break;
      case "passkeyAdd": {
        const registration = await account.startPasskeyRegistration(
          secret,
          passkeyName.value.trim(),
        );
        const credential = await createPasskey(registration.publicKey);
        const added = await registration.finish(credential);
        codes.value = added.backupCodes;
        action.value = undefined;
        done.value = t("twoFactor.passkeyAdded");
        break;
      }
      case "passkeyRemove":
        await account.removePasskey(secret, current.passkey.id);
        action.value = undefined;
        done.value = t("twoFactor.passkeyRemoved");
        break;
    }
    await load();
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function enableTotp(): Promise<void> {
  const current = setup.value;
  if (!current) return;
  const code = totpCode.value;
  totpCode.value = "";
  busy.value = true;
  error.value = undefined;
  try {
    codes.value = await current.enable(code);
    setup.value = undefined;
    done.value = t("twoFactor.totpEnabled");
    await load();
  } catch (caught) {
    error.value = toUiError(caught);
    // The setup ended (time out, too many wrong codes): start again.
    if (error.value.key === "challenge_invalid") setup.value = undefined;
  } finally {
    busy.value = false;
  }
}

function codesSaved(): void {
  codes.value = undefined;
}

function nameValid(): boolean {
  const length = Array.from(passkeyName.value.trim()).length;
  return length >= 1 && length <= 64;
}

function pending(): boolean {
  return codes.value !== undefined || setup.value !== undefined;
}

function warnOnUnload(event: BeforeUnloadEvent): void {
  if (pending()) event.preventDefault();
}

onBeforeRouteLeave(() => {
  if (!pending() || session.phase !== "unlocked") return true;
  return window.confirm(t("twoFactor.leave"));
});
onMounted(() => {
  window.addEventListener("beforeunload", warnOnUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnOnUnload);
  setup.value = undefined;
  codes.value = undefined;
});
</script>

<template>
  <section data-test="two-factor">
    <h2>{{ t("twoFactor.title") }}</h2>
    <BackupCodesPanel v-if="codes" :codes="codes" @done="codesSaved" />
    <template v-else-if="setup">
      <h3>{{ t("twoFactor.setupTitle") }}</h3>
      <p>{{ t("twoFactor.setupIntro") }}</p>
      <canvas
        ref="qr"
        class="qr-code"
        :aria-label="t('twoFactor.qrLabel')"
        role="img"
        data-test="totp-qr"
      ></canvas>
      <p>{{ t("twoFactor.secretLabel") }}</p>
      <p class="mono secret-groups" data-test="totp-secret">
        {{ secretGroups }}
      </p>
      <form class="form" @submit.prevent="enableTotp">
        <div class="field">
          <label for="totp-enable-code">{{ t("twoFactor.codeLabel") }}</label>
          <input
            id="totp-enable-code"
            v-model="totpCode"
            class="mono"
            autocomplete="one-time-code"
            inputmode="numeric"
            pattern="[0-9]{6}"
            maxlength="6"
            required
            data-test="totp-enable-code"
          />
        </div>
        <ErrorNotice :error="error" />
        <div class="actions">
          <button type="submit" :disabled="busy" data-test="totp-enable">
            {{ busy ? t("common.working") : t("twoFactor.enable") }}
          </button>
          <button type="button" class="secondary" @click="cancel">
            {{ t("common.cancel") }}
          </button>
        </div>
      </form>
    </template>
    <template v-else>
      <p v-if="done" class="notice notice-success" role="status">{{ done }}</p>
      <p
        v-if="status && !anyFactor"
        class="notice notice-warning"
        data-test="two-factor-none"
      >
        {{ t("twoFactor.recommend") }}
      </p>
      <dl v-if="status" class="facts" data-test="two-factor-status">
        <dt>{{ t("twoFactor.totp") }}</dt>
        <dd data-test="status-totp">
          {{ status.totp ? t("twoFactor.on") : t("twoFactor.off") }}
        </dd>
        <dt>{{ t("twoFactor.passkeys") }}</dt>
        <dd data-test="status-passkeys">{{ status.passkeys }}</dd>
        <dt>{{ t("twoFactor.codesLeft") }}</dt>
        <dd data-test="status-codes">{{ status.backupCodesRemaining }}</dd>
      </dl>

      <form v-if="action" class="form" @submit.prevent="confirm">
        <p>
          {{
            action.kind === "totpSetup"
              ? t("twoFactor.confirmSetup")
              : action.kind === "totpDisable"
                ? t("twoFactor.confirmDisable")
                : action.kind === "codes"
                  ? t("twoFactor.confirmCodes")
                  : action.kind === "passkeyAdd"
                    ? t("twoFactor.confirmPasskey")
                    : t("twoFactor.confirmRemove", {
                        name: action.passkey.name,
                      })
          }}
        </p>
        <p
          v-if="
            (action.kind === 'totpDisable' && status?.passkeys === 0) ||
            (action.kind === 'passkeyRemove' &&
              !status?.totp &&
              status?.passkeys === 1)
          "
          class="notice notice-warning"
        >
          {{ t("twoFactor.lastFactor") }}
        </p>
        <div v-if="action.kind === 'passkeyAdd'" class="field">
          <label for="passkey-name">{{ t("twoFactor.passkeyName") }}</label>
          <input
            id="passkey-name"
            v-model="passkeyName"
            maxlength="64"
            required
            data-test="passkey-name"
          />
        </div>
        <input
          type="email"
          name="email"
          autocomplete="username"
          :value="session.email"
          hidden
          readonly
        />
        <PasswordInput
          ref="password"
          name="password"
          :label="t('twoFactor.password')"
          autocomplete="current-password"
        />
        <ErrorNotice :error="error" />
        <div class="actions">
          <button
            type="submit"
            :disabled="busy || (action.kind === 'passkeyAdd' && !nameValid())"
            data-test="two-factor-confirm"
          >
            {{ busy ? t("common.working") : t("twoFactor.continue") }}
          </button>
          <button type="button" class="secondary" @click="cancel">
            {{ t("common.cancel") }}
          </button>
        </div>
      </form>

      <template v-else>
        <ErrorNotice :error="error" />
        <h3>{{ t("twoFactor.totp") }}</h3>
        <p>{{ t("twoFactor.totpIntro") }}</p>
        <button
          v-if="status && !status.totp"
          type="button"
          data-test="totp-setup"
          @click="choose({ kind: 'totpSetup' })"
        >
          {{ t("twoFactor.setup") }}
        </button>
        <button
          v-else-if="status"
          type="button"
          class="secondary"
          data-test="totp-disable"
          @click="choose({ kind: 'totpDisable' })"
        >
          {{ t("twoFactor.disable") }}
        </button>

        <h3>{{ t("twoFactor.passkeys") }}</h3>
        <p>{{ t("twoFactor.passkeysIntro") }}</p>
        <ul v-if="passkeys.length > 0" class="plain-list">
          <li
            v-for="passkey in passkeys"
            :key="passkey.id"
            data-test="passkey-item"
          >
            <strong>{{ passkey.name }}</strong>
            <span class="muted">
              {{
                t("twoFactor.passkeyDates", {
                  date: formatDate(passkey.created),
                  value: passkey.last_used
                    ? formatDate(passkey.last_used)
                    : t("twoFactor.never"),
                })
              }}
            </span>
            <button
              type="button"
              class="small secondary"
              data-test="passkey-remove"
              @click="choose({ kind: 'passkeyRemove', passkey })"
            >
              {{ t("twoFactor.remove") }}
            </button>
          </li>
        </ul>
        <p v-if="!supported" class="muted" data-test="passkey-unsupported">
          {{ t("twoFactor.passkeyUnsupported") }}
        </p>
        <button
          type="button"
          :disabled="!supported || passkeys.length >= 10"
          data-test="passkey-add"
          @click="choose({ kind: 'passkeyAdd' })"
        >
          {{ t("twoFactor.addPasskey") }}
        </button>

        <h3>{{ t("twoFactor.codesTitle") }}</h3>
        <p>{{ t("twoFactor.codesAbout") }}</p>
        <button
          type="button"
          class="secondary"
          :disabled="!anyFactor"
          data-test="codes-regenerate"
          @click="choose({ kind: 'codes' })"
        >
          {{ t("twoFactor.regenerate") }}
        </button>
      </template>
    </template>
  </section>
</template>
