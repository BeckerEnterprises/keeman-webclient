<script setup lang="ts">
/**
 * The second factor of a login or a recovery: TOTP code, backup
 * code or passkey, as offered by `methods`. Codes are cleared after each
 * attempt; nothing is retried automatically.
 */
import type { SecondFactorMethod } from "@keeman/core";
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../errors";
import { webauthnSupported } from "../webauthn";
import ErrorNotice from "./ErrorNotice.vue";

type Mode = "totp" | "backup" | "passkey";

const props = defineProps<{
  methods: readonly SecondFactorMethod[];
  totp: (code: string) => Promise<void>;
  backupCode: (code: string) => Promise<void>;
  passkey: () => Promise<void>;
}>();
const emit = defineEmits<{ cancel: [] }>();
const { t } = useI18n();
const passkeys = computed(
  () => props.methods.includes("webauthn") && webauthnSupported(),
);
const modes = computed(() => {
  const list: Mode[] = [];
  if (props.methods.includes("totp")) list.push("totp");
  if (passkeys.value) list.push("passkey");
  if (props.methods.includes("backup_code")) list.push("backup");
  return list;
});
const mode = ref<Mode>(modes.value[0] ?? "totp");
const code = ref("");
const busy = ref(false);
const error = ref<UiError>();
const input = ref<HTMLInputElement>();

async function focus(): Promise<void> {
  await nextTick();
  input.value?.focus();
}

onMounted(focus);

async function attempt(run: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    await run();
  } catch (caught) {
    error.value = toUiError(caught);
    await focus();
  } finally {
    busy.value = false;
  }
}

async function submit(): Promise<void> {
  const value = code.value;
  code.value = "";
  await attempt(() =>
    mode.value === "backup" ? props.backupCode(value) : props.totp(value),
  );
}

async function choose(next: Mode): Promise<void> {
  mode.value = next;
  code.value = "";
  error.value = undefined;
  await focus();
}
</script>

<template>
  <section class="second-factor" data-test="second-factor">
    <h2>{{ t("secondFactor.title") }}</h2>
    <template v-if="mode === 'passkey'">
      <p>{{ t("secondFactor.passkeyIntro") }}</p>
      <button
        type="button"
        :disabled="busy"
        data-test="passkey-login"
        @click="attempt(props.passkey)"
      >
        {{ busy ? t("secondFactor.busy") : t("secondFactor.usePasskeyNow") }}
      </button>
    </template>
    <form v-else class="form" @submit.prevent="submit">
      <div class="field">
        <label for="second-factor-code">{{
          mode === "totp"
            ? t("secondFactor.totpLabel")
            : t("secondFactor.backupLabel")
        }}</label>
        <input
          v-if="mode === 'totp'"
          id="second-factor-code"
          ref="input"
          v-model="code"
          class="mono"
          name="one-time-code"
          autocomplete="one-time-code"
          inputmode="numeric"
          pattern="[0-9]{6}"
          maxlength="6"
          required
          data-test="totp-code"
        />
        <input
          v-else
          id="second-factor-code"
          ref="input"
          v-model="code"
          class="mono"
          name="backup-code"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="32"
          required
          data-test="backup-code"
        />
      </div>
      <button type="submit" :disabled="busy" data-test="second-factor-submit">
        {{ busy ? t("secondFactor.busy") : t("secondFactor.submit") }}
      </button>
    </form>
    <ErrorNotice :error="error" />
    <ul class="second-factor-modes">
      <li v-if="mode !== 'totp' && modes.includes('totp')">
        <button
          type="button"
          class="link"
          data-test="use-totp"
          @click="choose('totp')"
        >
          {{ t("secondFactor.useTotp") }}
        </button>
      </li>
      <li v-if="mode !== 'passkey' && modes.includes('passkey')">
        <button
          type="button"
          class="link"
          data-test="use-passkey"
          @click="choose('passkey')"
        >
          {{ t("secondFactor.usePasskey") }}
        </button>
      </li>
      <li v-if="mode !== 'backup' && modes.includes('backup')">
        <button
          type="button"
          class="link"
          data-test="use-backup-code"
          @click="choose('backup')"
        >
          {{ t("secondFactor.useBackupCode") }}
        </button>
      </li>
    </ul>
    <p
      v-if="methods.includes('webauthn') && !passkeys"
      class="muted"
      data-test="passkey-unsupported"
    >
      {{ t("secondFactor.passkeyUnsupported") }}
    </p>
    <button
      type="button"
      class="secondary"
      data-test="second-factor-cancel"
      @click="emit('cancel')"
    >
      {{ t("common.cancel") }}
    </button>
  </section>
</template>
