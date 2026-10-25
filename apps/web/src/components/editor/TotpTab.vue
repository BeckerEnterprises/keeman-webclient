<script setup lang="ts">
/**
 * The TOTP tab of the editor: the current value with a
 * live code, a URI, a QR code (file, drop, paste) or a manual secret.
 * Unsupported stored values stay until replaced or removed. The inputs are
 * masked: the secret is vault content.
 */
import {
  buildTotpUri,
  decodeTotpSecret,
  parseOtpUri,
  TOTP_DEFAULTS,
  TOTP_LIMITS,
  totpFromUri,
  type TotpAlgorithm,
  type TotpResult,
} from "@keeman/core";
import { computed, ref, shallowRef, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { imageOf, QrError, readQrCode } from "../../qr";
import { useVaultsStore } from "../../stores/vaults";
import { groupCode, useServerClock } from "../../totp";
import AppIcon from "../ui/AppIcon";

const props = defineProps<{
  title: string;
  username: string;
  /** A save problem of the core. */
  problem?: string;
}>();
const otp = defineModel<string | null>({ required: true });
const { t } = useI18n();
const vaults = useVaultsStore();
const clock = useServerClock();
const ids = {
  uri: useId(),
  secret: useId(),
  algorithm: useId(),
  digits: useId(),
  period: useId(),
  file: useId(),
};

const uriInput = ref("");
const secretInput = ref("");
const showUri = ref(false);
const showSecret = ref(false);
const algorithm = ref<TotpAlgorithm>(TOTP_DEFAULTS.algorithm);
const digits = ref<number>(TOTP_DEFAULTS.digits);
const period = ref<number>(TOTP_DEFAULTS.period);
const message = ref<string>();
const reading = ref(false);
const preview = shallowRef<TotpResult>();

const parsed = computed(() =>
  otp.value === null ? undefined : parseOtpUri(otp.value),
);

function serverNow(): number {
  try {
    return vaults.engine().serverNow();
  } catch {
    return Date.now();
  }
}

async function refresh(): Promise<void> {
  const value = otp.value;
  preview.value =
    value === null ? undefined : await totpFromUri(value, serverNow());
}

watch(otp, () => void refresh(), { immediate: true });
watch(clock, (time) => {
  const current = preview.value;
  if (current?.ok === true && time >= current.value.validUntil) void refresh();
});

const remaining = computed(() => {
  const current = preview.value;
  return current?.ok === true
    ? Math.max(0, Math.ceil((current.value.validUntil - clock.value) / 1000))
    : 0;
});

/** A URI from the input, a QR code or a paste. */
function apply(text: string): boolean {
  const value = text.trim();
  message.value = undefined;
  if (/^otpauth-migration:/i.test(value)) {
    message.value = t("totpEditor.migration");
    return false;
  }
  const result = parseOtpUri(value);
  if (!result.ok) {
    message.value =
      result.problem === "hotp" || result.problem === "steam"
        ? t("totp.unsupported", { type: t(`totp.kinds.${result.problem}`) })
        : t(`totpEditor.problems.${result.problem}`);
    return false;
  }
  otp.value = result.normalized;
  return true;
}

function applyUri(): void {
  if (apply(uriInput.value)) uriInput.value = "";
}

function applyManual(): void {
  message.value = undefined;
  const key = decodeTotpSecret(secretInput.value);
  if (key === null) {
    message.value = t("totpEditor.problems.secret");
    return;
  }
  try {
    otp.value = buildTotpUri({
      key,
      algorithm: algorithm.value,
      digits: digits.value,
      period: period.value,
      title: props.title,
      username: props.username,
    });
    secretInput.value = "";
  } catch {
    message.value = t("totpEditor.problems.digits");
  } finally {
    key.fill(0);
  }
}

async function readImage(image: Blob): Promise<void> {
  message.value = undefined;
  reading.value = true;
  try {
    apply(await readQrCode(image));
  } catch (error) {
    message.value =
      error instanceof QrError && error.reason === "none"
        ? t("totpEditor.noQr")
        : t("totpEditor.badImage");
  } finally {
    reading.value = false;
  }
}

function onFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void readImage(file);
}

function onDrop(event: DragEvent): void {
  const image = imageOf(event.dataTransfer);
  if (image) void readImage(image);
}

/** Strg+V with an image anywhere in the tab; text pastes stay normal. */
function onPaste(event: ClipboardEvent): void {
  const image = imageOf(event.clipboardData);
  if (!image) return;
  event.preventDefault();
  void readImage(image);
}

function remove(): void {
  otp.value = null;
  message.value = undefined;
}
</script>

<template>
  <div class="form editor-form totp-tab" data-test="totp-tab" @paste="onPaste">
    <section class="totp-current" data-test="totp-current">
      <template v-if="otp !== null">
        <template v-if="parsed?.ok">
          <p class="muted">
            {{
              t("totpEditor.current", {
                type: parsed.params.algorithm,
                count: parsed.params.digits,
                seconds: parsed.params.period,
              })
            }}
          </p>
          <p
            v-if="preview?.ok"
            class="totp-preview mono"
            data-test="totp-preview"
            :data-code="preview.value.code"
          >
            {{ groupCode(preview.value.code).join(" ") }}
            <span class="muted">({{ remaining }} s)</span>
          </p>
          <p class="muted small-text">{{ t("totpEditor.compare") }}</p>
        </template>
        <p v-else class="notice notice-warning" data-test="totp-kept">
          {{
            parsed?.ok === false &&
            (parsed.problem === "hotp" || parsed.problem === "steam")
              ? t("totp.unsupported", {
                  type: t(`totp.kinds.${parsed.problem}`),
                })
              : t("totp.invalid")
          }}
        </p>
        <button
          type="button"
          class="secondary small"
          data-test="totp-remove"
          @click="remove"
        >
          {{ t("totpEditor.remove") }}
        </button>
      </template>
      <p v-else class="muted" data-test="totp-none">
        {{ t("totpEditor.none") }}
      </p>
    </section>

    <p
      v-if="message || problem"
      class="notice notice-error"
      role="alert"
      data-test="totp-error"
    >
      {{ message ?? problem }}
    </p>

    <section>
      <h3>{{ t("totpEditor.uriTitle") }}</h3>
      <div class="field">
        <label :for="ids.uri">{{ t("totpEditor.uri") }}</label>
        <div class="password-row">
          <input
            :id="ids.uri"
            v-model="uriInput"
            :type="showUri ? 'text' : 'password'"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="otpauth://totp/…"
            data-test="totp-uri"
            @keydown.enter.prevent.stop="applyUri"
          />
          <button
            type="button"
            class="icon-button"
            :aria-pressed="showUri"
            :aria-label="showUri ? t('common.hide') : t('common.show')"
            @click="showUri = !showUri"
          >
            <AppIcon :ui="showUri ? 'eyeOff' : 'eye'" />
          </button>
        </div>
      </div>
      <button
        type="button"
        class="small"
        :disabled="uriInput.trim() === ''"
        data-test="totp-uri-apply"
        @click="applyUri"
      >
        {{ t("totpEditor.apply") }}
      </button>
    </section>

    <section>
      <h3>{{ t("totpEditor.qrTitle") }}</h3>
      <div
        class="drop-zone"
        data-test="totp-drop"
        tabindex="0"
        @dragover.prevent
        @drop.prevent="onDrop"
      >
        <label :for="ids.file">{{ t("totpEditor.qrFile") }}</label>
        <input
          :id="ids.file"
          type="file"
          accept="image/*"
          data-test="totp-qr-file"
          @change="onFile"
        />
        <p class="muted small-text">{{ t("totpEditor.qrHint") }}</p>
        <p v-if="reading" aria-live="polite">{{ t("totpEditor.reading") }}</p>
      </div>
    </section>

    <section>
      <h3>{{ t("totpEditor.manualTitle") }}</h3>
      <div class="field">
        <label :for="ids.secret">{{ t("totpEditor.secret") }}</label>
        <div class="password-row">
          <input
            :id="ids.secret"
            v-model="secretInput"
            :type="showSecret ? 'text' : 'password'"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            data-test="totp-secret"
            @keydown.enter.prevent.stop="applyManual"
          />
          <button
            type="button"
            class="icon-button"
            :aria-pressed="showSecret"
            :aria-label="showSecret ? t('common.hide') : t('common.show')"
            @click="showSecret = !showSecret"
          >
            <AppIcon :ui="showSecret ? 'eyeOff' : 'eye'" />
          </button>
        </div>
      </div>
      <details>
        <summary data-test="totp-advanced">
          {{ t("totpEditor.advanced") }}
        </summary>
        <div class="field">
          <label :for="ids.algorithm">{{ t("totpEditor.algorithm") }}</label>
          <select
            :id="ids.algorithm"
            v-model="algorithm"
            data-test="totp-algorithm"
          >
            <option value="SHA1">SHA-1</option>
            <option value="SHA256">SHA-256</option>
            <option value="SHA512">SHA-512</option>
          </select>
        </div>
        <div class="field">
          <label :for="ids.digits">{{ t("totpEditor.digits") }}</label>
          <input
            :id="ids.digits"
            v-model.number="digits"
            type="number"
            :min="TOTP_LIMITS.digits.min"
            :max="TOTP_LIMITS.digits.max"
            data-test="totp-digits"
          />
        </div>
        <div class="field">
          <label :for="ids.period">{{ t("totpEditor.period") }}</label>
          <input
            :id="ids.period"
            v-model.number="period"
            type="number"
            :min="TOTP_LIMITS.period.min"
            :max="TOTP_LIMITS.period.max"
            data-test="totp-period"
          />
        </div>
      </details>
      <button
        type="button"
        class="small"
        :disabled="secretInput.trim() === ''"
        data-test="totp-manual-apply"
        @click="applyManual"
      >
        {{ t("totpEditor.apply") }}
      </button>
    </section>
  </div>
</template>
