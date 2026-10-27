<script setup lang="ts">
/**
 * The databases of the account: order, hints about corrupt data,
 * rollbacks and the connection, create, edit and delete. Opening one shows
 * it in the main view.
 */
import type { VaultView } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import KdbxImportDialog from "../../components/kdbx/KdbxImportDialog.vue";
import FreshnessWarning from "../../components/FreshnessWarning.vue";
import ManifestWarning from "../../components/ManifestWarning.vue";
import RolesWarning from "../../components/sharing/RolesWarning.vue";
import VaultDeleteDialog from "../../components/VaultDeleteDialog.vue";
import VaultEditForm from "../../components/VaultEditForm.vue";
import WriteNotices from "../../components/WriteNotices.vue";
import { toUiError, type UiError } from "../../errors";
import { describeNotices, useVaultsStore } from "../../stores/vaults";

const { t } = useI18n();
const vaults = useVaultsStore();
const name = ref("");
const busy = ref(false);
const error = ref<UiError>();
const editing = ref<string>();
const deleting = ref<VaultView>();
const importing = ref(false);
const notices = ref<ReturnType<typeof describeNotices>>([]);

const snapshot = computed(() => vaults.snapshot);
const list = computed(() => vaults.vaults);
const empty = computed(
  () =>
    snapshot.value?.loaded === true &&
    list.value.length === 0 &&
    vaults.firstVault === "idle",
);

async function run(task: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    await task();
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function create(): Promise<void> {
  await run(async () => {
    await vaults.engine().createVault({
      name: name.value,
      rootName: name.value,
      recycleBinName: t("vaults.recycleBin"),
    });
    name.value = "";
  });
}

async function move(id: string, direction: -1 | 1): Promise<void> {
  await run(() => vaults.engine().moveVault(id, direction));
}

async function acknowledge(id: string): Promise<void> {
  await run(() => vaults.engine().acknowledgeRollback(id));
}

async function acknowledgeManifest(id: string): Promise<void> {
  await run(() => vaults.engine().acknowledgeManifest(id));
}

function edited(result: ReturnType<typeof describeNotices>): void {
  editing.value = undefined;
  notices.value = result;
}
</script>

<template>
  <section data-test="databases">
    <div class="title-row">
      <h1>{{ t("vaults.title") }}</h1>
      <span
        v-if="snapshot"
        class="connection"
        :class="`connection-${snapshot.connection}`"
        data-test="connection"
        :data-state="snapshot.connection"
      >
        {{ t(`vaults.connection.${snapshot.connection}`) }}
      </span>
    </div>

    <p
      v-if="vaults.firstVault === 'creating'"
      class="notice notice-info"
      data-test="first-vault-creating"
    >
      {{ t("vaults.firstCreating") }}
    </p>
    <div
      v-if="vaults.firstVault === 'failed'"
      class="notice notice-error"
      role="alert"
      data-test="first-vault-failed"
    >
      <p>{{ t("vaults.firstFailed") }}</p>
      <button type="button" class="small" @click="vaults.retryFirstVault()">
        {{ t("common.retry") }}
      </button>
    </div>
    <p
      v-if="snapshot?.error !== undefined"
      class="notice notice-error"
      data-test="vaults-error"
    >
      {{ t(`error.${toUiError(snapshot?.error).key}`, { seconds: 60 }) }}
    </p>
    <p v-if="!snapshot?.loaded" class="muted">{{ t("vaults.loading") }}</p>
    <p v-if="empty" class="notice notice-info" data-test="vaults-empty">
      {{ t("vaults.empty") }}
    </p>

    <WriteNotices :notices="notices" />
    <ErrorNotice :error="error" />

    <ul v-if="list.length > 0" class="vault-list" data-test="vault-list">
      <li
        v-for="(vault, index) in list"
        :key="vault.id"
        class="vault-item"
        data-test="vault"
        :data-vault-id="vault.id"
      >
        <div class="vault-row">
          <span
            class="swatch"
            :style="vault.color ? { backgroundColor: vault.color } : undefined"
            aria-hidden="true"
          ></span>
          <div class="vault-main">
            <RouterLink
              v-if="vault.status !== 'corrupt'"
              :to="`/vaults/${vault.id}/groups/${vault.tree.rootId}`"
              class="vault-name"
              data-test="vault-link"
            >
              {{
                vault.name ??
                (vault.status === "loading"
                  ? t("vaults.loading")
                  : t("vaults.unnamed"))
              }}
            </RouterLink>
            <span v-else class="vault-name text-error">
              {{ t("vaults.status.corrupt") }}
            </span>
            <p v-if="vault.description" class="muted">
              {{ vault.description }}
            </p>
            <p
              v-if="vault.status === 'error'"
              class="text-error"
              data-test="vault-error"
            >
              {{ t("vaults.status.error") }}
            </p>
            <p
              v-if="vault.corrupt.length > 0"
              class="text-error"
              data-test="vault-corrupt"
            >
              {{ t("vaults.corrupt", { count: vault.corrupt.length }) }}
            </p>
            <div
              v-if="vault.rollback"
              class="notice notice-error"
              role="alert"
              data-test="vault-rollback"
            >
              <p>{{ t("vaults.rollback") }}</p>
              <p v-if="vault.keyRollback" data-test="vault-key-rollback">
                {{ t("vaults.keyRollback") }}
              </p>
              <button
                type="button"
                class="small"
                data-test="vault-rollback-ack"
                @click="acknowledge(vault.id)"
              >
                {{ t("common.understood") }}
              </button>
            </div>
            <ManifestWarning
              :vault="vault"
              :busy="busy"
              @acknowledge="acknowledgeManifest(vault.id)"
            />
            <RolesWarning :vault="vault" />
            <FreshnessWarning :vault="vault" />
          </div>
          <div class="actions">
            <button
              type="button"
              class="secondary small"
              :aria-label="t('vaults.moveUp')"
              :disabled="busy || index === 0"
              data-test="vault-up"
              @click="move(vault.id, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              class="secondary small"
              :aria-label="t('vaults.moveDown')"
              :disabled="busy || index === list.length - 1"
              data-test="vault-down"
              @click="move(vault.id, 1)"
            >
              ↓
            </button>
            <button
              type="button"
              class="secondary small"
              :disabled="!vault.writable"
              data-test="vault-edit-open"
              @click="editing = vault.id"
            >
              {{ t("common.edit") }}
            </button>
            <RouterLink
              :to="`/databases/${vault.id}`"
              class="button secondary small"
              data-test="vault-settings"
            >
              {{ t("vaults.settings") }}
            </RouterLink>
            <button
              v-if="vault.role === 'owner'"
              type="button"
              class="secondary small"
              data-test="vault-delete-open"
              @click="deleting = vault"
            >
              {{ t("common.delete") }}
            </button>
          </div>
        </div>
        <VaultEditForm
          v-if="editing === vault.id"
          :vault="vault"
          @done="edited"
        />
      </li>
    </ul>

    <form
      class="form inline-form"
      data-test="vault-create"
      @submit.prevent="create"
    >
      <h2>{{ t("vaults.create") }}</h2>
      <div class="field">
        <label for="vault-create-name">{{ t("vaults.name") }}</label>
        <input
          id="vault-create-name"
          v-model="name"
          maxlength="256"
          required
          data-test="vault-create-name"
        />
      </div>
      <button type="submit" :disabled="busy" data-test="vault-create-submit">
        {{ t("vaults.createSubmit") }}
      </button>
    </form>

    <section class="inline-form" data-test="kdbx-import-section">
      <h2>{{ t("kdbx.import.title") }}</h2>
      <p class="muted">{{ t("kdbx.import.intro") }}</p>
      <button
        type="button"
        class="secondary"
        data-test="kdbx-import-open"
        @click="importing = true"
      >
        {{ t("kdbx.import.openDialog") }}
      </button>
    </section>

    <VaultDeleteDialog
      v-if="deleting"
      :vault="deleting"
      @close="deleting = undefined"
    />
    <KdbxImportDialog v-if="importing" @close="importing = false" />
  </section>
</template>
