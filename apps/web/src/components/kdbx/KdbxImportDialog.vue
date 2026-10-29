<script setup lang="ts">
/**
 * KDBX import: file, password and key file → open in
 * the worker (cancellable) → preview → import with progress → report. The
 * decrypted file and the job hold secrets: they live in plain variables of
 * this component, never in reactive state. Without `vaultId` the
 * import creates a new database, otherwise it goes below a group of it.
 */
import {
  KDBX_LIMITS,
  KdbxError,
  readKdbxInWorker,
  type KdbxFile,
  type KdbxHeaderInfo,
  type KdbxImportJob,
  type KdbxImportProgress,
  type KdbxImportReport as Report,
  type KdbxImportTarget,
  type VaultView,
} from "@keeman/core";
import {
  computed,
  markRaw,
  onBeforeUnmount,
  ref,
  shallowRef,
  useId,
} from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { spawnKdbxWorker } from "../../services";
import { useSessionStore } from "../../stores/session";
import { useVaultsStore } from "../../stores/vaults";
import { encodeIcons } from "../../icon-image";
import ErrorNotice from "../ErrorNotice.vue";
import PasswordInput from "../PasswordInput.vue";
import type { PasswordField } from "../password-field";
import VaultDeleteDialog from "../VaultDeleteDialog.vue";
import GroupPicker from "../dialogs/GroupPicker.vue";
import AppDialog from "../ui/AppDialog.vue";
import KdbxImportReport from "./KdbxImportReport.vue";

const props = defineProps<{ vaultId?: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const session = useSessionStore();
const id = useId();

type Step =
  | "choose"
  | "opening"
  | "preview"
  | "importing"
  | "failed"
  | "cancelled"
  | "done";

const step = ref<Step>("choose");
const fileInput = ref<HTMLInputElement>();
const keyInput = ref<HTMLInputElement>();
const password = ref<PasswordField>();
const header = ref<KdbxHeaderInfo>();
const report = shallowRef<Report>();
const progress = ref<KdbxImportProgress>({ done: 0, total: 0 });
const vaultName = ref("");
const groupKey = ref<string>();
const error = ref<UiError>();
const deleting = ref<VaultView>();
const importedVault = ref<string>();
// Secrets: not reactive.
let file: KdbxFile | undefined;
let job: KdbxImportJob | undefined;
let controller: AbortController | undefined;
// Locking unmounts the dialog; what is still awaited then must not go on,
// least of all into an account unlocked meanwhile.
let disposed = false;

function ensureOpen(): void {
  if (disposed) throw new KdbxError("cancelled");
}

const intoGroup = computed(() => props.vaultId !== undefined);
const vault = computed(() =>
  vaults.vaults.find((v) => v.id === (props.vaultId ?? importedVault.value)),
);
const slow = computed(
  () =>
    (header.value?.memoryBytes ?? 0) > KDBX_LIMITS.argon2HintBytes &&
    step.value === "opening",
);
const percent = computed(() =>
  progress.value.total === 0
    ? 0
    : Math.round((progress.value.done / progress.value.total) * 100),
);
const openLink = computed(() => {
  const target = vault.value;
  if (!target) return undefined;
  const group = intoGroup.value
    ? (groupKey.value?.split("/")[1] ?? target.tree.rootId)
    : target.tree.rootId;
  return `/vaults/${target.id}/groups/${group}`;
});

/** A long task counts as activity for the auto-lock. */
function keepAwake(): () => void {
  session.markActivity();
  const timer = setInterval(() => {
    session.markActivity();
  }, 20_000);
  return () => {
    clearInterval(timer);
  };
}

function target(): KdbxImportTarget {
  if (props.vaultId === undefined)
    return { kind: "vault", name: vaultName.value };
  const groupId = groupKey.value?.split("/")[1] ?? vault.value?.tree.rootId;
  return { kind: "group", vaultId: props.vaultId, groupId: groupId ?? "" };
}

async function prepare(source: KdbxFile): Promise<KdbxImportJob> {
  // The engine of this unlock, before anything is awaited.
  const engine = vaults.engine();
  // The app re-encodes the custom icons; the core gets PNG bytes.
  const icons = await encodeIcons(source.customIcons);
  ensureOpen();
  const next = await engine.prepareKdbxImport(source, target(), {
    emptyFieldName: t("kdbx.field"),
    icons,
  });
  ensureOpen();
  report.value = markRaw(next.report);
  return next;
}

async function open(): Promise<void> {
  error.value = undefined;
  const chosen = fileInput.value?.files?.[0];
  const typed = password.value?.value() ?? "";
  password.value?.clear();
  if (!chosen) return;
  if (chosen.size > KDBX_LIMITS.fileBytes) {
    error.value = toUiError(new KdbxError("too_large"));
    return;
  }
  const keyFile = keyInput.value?.files?.[0];
  controller = new AbortController();
  step.value = "opening";
  header.value = undefined;
  const stop = keepAwake();
  try {
    const read = await readKdbxInWorker(
      spawnKdbxWorker,
      {
        data: new Uint8Array(await chosen.arrayBuffer()),
        password: typed,
        keyFile: keyFile ? new Uint8Array(await keyFile.arrayBuffer()) : null,
      },
      {
        signal: controller.signal,
        onHeader: (info) => {
          header.value = info;
        },
      },
    );
    file = read;
    vaultName.value = (
      read.meta.name ||
      read.root.name ||
      chosen.name.replace(/\.kdbx$/i, "")
    ).slice(0, 256);
    job = await prepare(read);
    step.value = "preview";
  } catch (caught) {
    if (!(caught instanceof KdbxError && caught.code === "cancelled"))
      error.value = toUiError(caught);
    step.value = "choose";
  } finally {
    stop();
  }
}

async function run(): Promise<void> {
  if (!job || disposed) return;
  error.value = undefined;
  controller = new AbortController();
  step.value = "importing";
  progress.value = job.progress;
  const stop = keepAwake();
  try {
    await job.run({
      signal: controller.signal,
      onProgress: (next) => {
        progress.value = next;
        session.markActivity();
      },
    });
    importedVault.value = job.vaultId;
    report.value = markRaw({ ...job.report });
    file = undefined;
    step.value = "done";
  } catch (caught) {
    importedVault.value = job.vaultId;
    if (caught instanceof KdbxError && caught.code === "cancelled")
      step.value = "cancelled";
    else {
      error.value = toUiError(caught);
      step.value = "failed";
    }
  } finally {
    stop();
  }
}

async function start(): Promise<void> {
  if (!file) return;
  error.value = undefined;
  try {
    // The name or target group may have changed since the preview.
    job = await prepare(file);
  } catch (caught) {
    if (!disposed) error.value = toUiError(caught);
    return;
  }
  await run();
}

function cancel(): void {
  controller?.abort();
}

function removeNew(): void {
  deleting.value = vault.value;
}

function close(): void {
  controller?.abort();
  emit("close");
}

onBeforeUnmount(() => {
  // Locking unmounts the dialog: the worker or import stops.
  disposed = true;
  controller?.abort();
  file = undefined;
  job = undefined;
});
</script>

<template>
  <AppDialog
    :title="intoGroup ? t('kdbx.import.titleGroup') : t('kdbx.import.title')"
    wide
    @close="close"
  >
    <div data-test="kdbx-import" :data-step="step">
      <form
        v-if="step === 'choose' || step === 'opening'"
        class="form"
        @submit.prevent="open"
      >
        <div class="field">
          <label :for="`${id}-file`">{{ t("kdbx.import.file") }}</label>
          <input
            :id="`${id}-file`"
            ref="fileInput"
            type="file"
            accept=".kdbx"
            required
            :disabled="step === 'opening'"
            data-test="kdbx-file"
          />
        </div>
        <PasswordInput
          ref="password"
          name="kdbx-password"
          :label="t('kdbx.import.password')"
          autocomplete="off"
          optional
        />
        <div class="field">
          <label :for="`${id}-key`">{{ t("kdbx.import.keyFile") }}</label>
          <input
            :id="`${id}-key`"
            ref="keyInput"
            type="file"
            :disabled="step === 'opening'"
            data-test="kdbx-key-file"
          />
        </div>
        <p
          v-if="step === 'opening'"
          aria-live="polite"
          data-test="kdbx-opening"
        >
          {{ t("kdbx.import.opening") }}
        </p>
        <p v-if="slow" class="notice notice-info" data-test="kdbx-slow">
          {{
            t("kdbx.import.slow", {
              size: Math.round((header?.memoryBytes ?? 0) / 1048576),
            })
          }}
        </p>
        <ErrorNotice :error="error" />
        <div class="actions">
          <button v-if="step === 'choose'" type="submit" data-test="kdbx-open">
            {{ t("kdbx.import.open") }}
          </button>
          <button
            v-else
            type="button"
            class="secondary"
            data-test="kdbx-cancel"
            @click="cancel"
          >
            {{ t("common.cancel") }}
          </button>
        </div>
      </form>

      <form v-else-if="step === 'preview'" class="form" @submit.prevent="start">
        <p class="muted" data-test="kdbx-version">
          {{ t("kdbx.import.version", { version: header?.version ?? "" }) }}
        </p>
        <div v-if="!intoGroup" class="field">
          <label :for="`${id}-name`">{{ t("kdbx.import.name") }}</label>
          <input
            :id="`${id}-name`"
            v-model="vaultName"
            maxlength="256"
            required
            data-test="kdbx-name"
          />
        </div>
        <div v-else-if="vault" class="field">
          <span>{{ t("kdbx.import.group") }}</span>
          <GroupPicker
            v-model="groupKey"
            :vaults="[vault]"
            :allowed="() => vault?.writable === true"
            :legend="t('kdbx.import.group')"
            test-id="kdbx-group"
            @confirm="start"
          />
        </div>
        <KdbxImportReport v-if="report" :report="report" preview />
        <ErrorNotice :error="error" />
        <div class="actions">
          <button type="submit" data-test="kdbx-start">
            {{ t("kdbx.import.start") }}
          </button>
        </div>
      </form>

      <div v-else-if="step === 'importing'" class="form">
        <progress
          :value="progress.done"
          :max="progress.total"
          data-test="kdbx-progress"
        ></progress>
        <p aria-live="polite">
          {{
            t("kdbx.import.progress", {
              count: progress.done,
              entries: progress.total,
              value: percent,
            })
          }}
        </p>
        <div class="actions">
          <button
            type="button"
            class="secondary"
            data-test="kdbx-cancel"
            @click="cancel"
          >
            {{ t("common.cancel") }}
          </button>
        </div>
      </div>

      <div
        v-else-if="step === 'failed' || step === 'cancelled'"
        class="form"
        role="alert"
      >
        <p data-test="kdbx-stopped">
          {{
            step === "failed"
              ? t("kdbx.import.failed")
              : t("kdbx.import.cancelled")
          }}
        </p>
        <ErrorNotice :error="error" />
        <div class="actions">
          <button type="button" data-test="kdbx-retry" @click="run">
            {{
              step === "failed" ? t("common.retry") : t("kdbx.import.resume")
            }}
          </button>
          <button
            v-if="!intoGroup && vault"
            type="button"
            class="danger"
            data-test="kdbx-delete-new"
            @click="removeNew"
          >
            {{ t("kdbx.import.deleteNew") }}
          </button>
        </div>
      </div>

      <div v-else class="form" data-test="kdbx-done">
        <p class="notice notice-success">{{ t("kdbx.import.done") }}</p>
        <KdbxImportReport v-if="report" :report="report" />
        <RouterLink
          v-if="openLink"
          :to="openLink"
          class="button"
          data-test="kdbx-open-result"
          @click="emit('close')"
        >
          {{ t("kdbx.import.openResult") }}
        </RouterLink>
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
    <VaultDeleteDialog
      v-if="deleting"
      :vault="deleting"
      @close="
        (deleted) => {
          deleting = undefined;
          if (deleted) emit('close');
        }
      "
    />
  </AppDialog>
</template>
