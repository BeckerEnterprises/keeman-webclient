<script setup lang="ts">
/**
 * KDBX export: a warning, an export password with the
 * master password rules, then the worker writes the file, a second worker
 * opens it again for the self-check, and only then the download is
 * offered. The model holds secrets and stays in this function.
 */
import {
  kdbxFileName,
  readKdbxInWorker,
  verifyKdbxExport,
  writeKdbxInWorker,
  type KdbxExportReport,
} from "@keeman/core";
import { computed, markRaw, onBeforeUnmount, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import {
  checkNewPassword,
  hasOuterSpace,
  type PasswordProblem,
} from "../../password";
import { spawnKdbxWorker } from "../../services";
import { useSessionStore } from "../../stores/session";
import { useVaultsStore } from "../../stores/vaults";
import { usePasswordStrength } from "../../strength";
import ErrorNotice from "../ErrorNotice.vue";
import PasswordInput from "../PasswordInput.vue";
import type { PasswordField } from "../password-field";
import StrengthMeter from "../StrengthMeter.vue";
import AppDialog from "../ui/AppDialog.vue";

const props = defineProps<{ vaultId: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const session = useSessionStore();
const email = ref(session.email ?? "");
const strength = usePasswordStrength(email);
const next = ref<PasswordField>();
const confirmation = ref<PasswordField>();
const problems = ref<PasswordProblem[]>([]);
const outerSpace = ref(false);
const step = ref<"form" | "working" | "done">("form");
const error = ref<UiError>();
/** Attachments fetched for the export so far. */
const loaded = ref<{ done: number; total: number }>();
const report = shallowRef<KdbxExportReport>();
const fileName = ref("");
const url = ref<string>();
let controller: AbortController | undefined;

const vault = computed(() => vaults.vaults.find((v) => v.id === props.vaultId));
const reportLines = computed(() => {
  const value = report.value;
  if (!value) return [];
  const lines: string[] = [];
  if (value.substituteRoot) lines.push(t("kdbx.export.substituteRoot"));
  if (value.corrupt > 0)
    lines.push(t("kdbx.export.corrupt", { count: value.corrupt }));
  if (value.removedCharacters > 0)
    lines.push(
      t("kdbx.export.removedCharacters", { count: value.removedCharacters }),
    );
  for (const item of value.items) {
    const parts =
      item.title === null
        ? item.path
        : [...item.path, item.title || t("entry.untitled")];
    const where = parts.length > 0 ? parts.join(" › ") : t("kdbx.report.top");
    switch (item.kind) {
      case "field_renamed":
        lines.push(
          t("kdbx.report.field_renamed", {
            where,
            from: item.from,
            to: item.to,
          }),
        );
        break;
      case "attachment_renamed":
        lines.push(
          t("kdbx.export.attachment_renamed", {
            where,
            from: item.from,
            to: item.to,
          }),
        );
        break;
      case "attachment_unreadable":
        lines.push(
          t("kdbx.export.attachment_unreadable", { where, name: item.name }),
        );
        break;
      case "custom_icon_missing":
        lines.push(t("kdbx.export.custom_icon_missing", { where }));
        break;
      case "snapshots_skipped":
        lines.push(
          t("kdbx.export.snapshots_skipped", { where, count: item.count }),
        );
    }
  }
  return lines;
});

function onInput(value: string): void {
  strength.rate(value);
  outerSpace.value = hasOuterSpace(value);
}

function clearAll(): void {
  next.value?.clear();
  confirmation.value?.clear();
  strength.rate("");
}

function download(): void {
  if (url.value === undefined) return;
  const link = document.createElement("a");
  link.href = url.value;
  link.download = fileName.value;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

async function submit(): Promise<void> {
  const scorer = strength.scorer();
  if (!scorer) return;
  const password = next.value?.value() ?? "";
  problems.value = checkNewPassword(
    {
      password,
      confirmation: confirmation.value?.value() ?? "",
      email: email.value,
    },
    scorer,
  );
  if (problems.value.length > 0) return;
  clearAll();
  error.value = undefined;
  step.value = "working";
  controller = new AbortController();
  session.markActivity();
  const timer = setInterval(() => {
    session.markActivity();
  }, 20_000);
  try {
    loaded.value = undefined;
    const { model, report: exported } = await vaults
      .engine()
      .exportKdbx(props.vaultId, {
        signal: controller.signal,
        onProgress: (progress) => {
          session.markActivity();
          loaded.value = progress;
        },
      });
    loaded.value = undefined;
    const bytes = await writeKdbxInWorker(spawnKdbxWorker, model, password, {
      signal: controller.signal,
    });
    // Self-check: the written file must read back as the model.
    const check = await readKdbxInWorker(
      spawnKdbxWorker,
      { data: bytes, password: password.normalize("NFC"), keyFile: null },
      { signal: controller.signal },
    );
    if (!verifyKdbxExport(model, check)) {
      error.value = { key: "kdbx_selfcheck" };
      step.value = "form";
      return;
    }
    fileName.value = kdbxFileName(vault.value?.name ?? "", new Date());
    url.value = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
    );
    report.value = markRaw(exported);
    step.value = "done";
    download();
  } catch (caught) {
    error.value = toUiError(caught);
    step.value = "form";
  } finally {
    clearInterval(timer);
  }
}

function close(): void {
  controller?.abort();
  emit("close");
}

onBeforeUnmount(() => {
  controller?.abort();
  if (url.value !== undefined) URL.revokeObjectURL(url.value);
});
</script>

<template>
  <AppDialog :title="t('kdbx.export.title')" wide @close="close">
    <div data-test="kdbx-export" :data-step="step">
      <p class="notice notice-warning">{{ t("kdbx.export.warning") }}</p>
      <form v-if="step !== 'done'" class="form" @submit.prevent="submit">
        <PasswordInput
          ref="next"
          name="kdbx-export-password"
          :label="t('kdbx.export.password')"
          autocomplete="off"
          @input="onInput"
        />
        <StrengthMeter
          :score="strength.score.value"
          :state="strength.state.value"
        />
        <p v-if="outerSpace" class="text-warning">
          {{ t("rules.outerSpace") }}
        </p>
        <PasswordInput
          ref="confirmation"
          name="kdbx-export-confirm"
          :label="t('kdbx.export.confirm')"
          autocomplete="off"
        />
        <ul
          v-if="problems.length > 0"
          class="problems"
          role="alert"
          data-test="kdbx-export-problems"
        >
          <li v-for="problem in problems" :key="problem">
            {{ t(`rules.${problem}`) }}
          </li>
        </ul>
        <p
          v-if="step === 'working'"
          aria-live="polite"
          data-test="kdbx-working"
        >
          {{
            loaded
              ? t("kdbx.export.loading", {
                  count: loaded.done,
                  entries: loaded.total,
                })
              : t("kdbx.export.working")
          }}
        </p>
        <ErrorNotice :error="error" />
        <div class="actions">
          <button
            type="submit"
            :disabled="step === 'working' || strength.state.value !== 'ready'"
            data-test="kdbx-export-submit"
          >
            {{ t("kdbx.export.submit") }}
          </button>
        </div>
      </form>
      <div v-else class="form" data-test="kdbx-export-done">
        <p class="notice notice-success">
          {{ t("kdbx.export.done", { name: fileName }) }}
        </p>
        <ul v-if="reportLines.length > 0" class="plain-list">
          <li v-for="(text, index) in reportLines" :key="index">{{ text }}</li>
        </ul>
        <button
          type="button"
          class="secondary"
          data-test="kdbx-export-again"
          @click="download"
        >
          {{ t("kdbx.export.again") }}
        </button>
      </div>
    </div>
    <template #actions>
      <button
        type="button"
        class="secondary"
        data-test="kdbx-close"
        @click="close"
      >
        {{ t("common.close") }}
      </button>
    </template>
  </AppDialog>
</template>
