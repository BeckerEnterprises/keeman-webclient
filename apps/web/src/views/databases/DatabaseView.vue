<script setup lang="ts">
/**
 * Settings of one database: name, description, colour, icon,
 * recycle bin, history length, the list of corrupt objects, custom
 * icons and deleting.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import ErrorNotice from "../../components/ErrorNotice.vue";
import IconsSection from "../../components/IconsSection.vue";
import KdbxExportDialog from "../../components/kdbx/KdbxExportDialog.vue";
import KdbxImportDialog from "../../components/kdbx/KdbxImportDialog.vue";
import MembersSection from "../../components/sharing/MembersSection.vue";
import VaultDeleteDialog from "../../components/VaultDeleteDialog.vue";
import VaultEditForm from "../../components/VaultEditForm.vue";
import WriteNotices from "../../components/WriteNotices.vue";
import { toUiError, type UiError } from "../../errors";
import { describeNotices, useVaultsStore } from "../../stores/vaults";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const vaults = useVaultsStore();
const deleting = ref(false);
const importing = ref(false);
const exporting = ref(false);
const editKey = ref(0);
const error = ref<UiError>();
const notices = ref<ReturnType<typeof describeNotices>>([]);

const vault = computed(() =>
  vaults.vaults.find((v) => v.id === String(route.params.vaultId)),
);

function done(result: ReturnType<typeof describeNotices>): void {
  notices.value = result;
  editKey.value++;
}

async function acknowledge(): Promise<void> {
  if (!vault.value) return;
  try {
    await vaults.engine().acknowledgeRollback(vault.value.id);
  } catch (caught) {
    error.value = toUiError(caught);
  }
}
</script>

<template>
  <section data-test="database-view">
    <RouterLink to="/databases" data-test="back">{{
      t("vault.back")
    }}</RouterLink>
    <template v-if="vault">
      <h1 data-test="vault-title">{{ vault.name ?? t("vaults.unnamed") }}</h1>
      <p>
        <RouterLink
          :to="`/vaults/${vault.id}/groups/${vault.tree.rootId}`"
          data-test="vault-open"
        >
          {{ t("vaults.open") }}
        </RouterLink>
      </p>
      <div
        v-if="vault.rollback"
        class="notice notice-error"
        role="alert"
        data-test="vault-rollback"
      >
        <p>{{ t("vaults.rollback") }}</p>
        <button
          type="button"
          class="small"
          data-test="vault-rollback-ack"
          @click="acknowledge"
        >
          {{ t("common.understood") }}
        </button>
      </div>
      <p
        v-else-if="!vault.writable && vault.status === 'ready'"
        class="notice notice-warning"
        data-test="vault-read-only"
      >
        {{ t("vault.readOnly") }}
      </p>
      <WriteNotices :notices="notices" />
      <ErrorNotice :error="error" />
      <VaultEditForm
        v-if="vault.writable"
        :key="editKey"
        :vault="vault"
        full
        @done="done"
      />

      <section
        v-if="vault.corrupt.length > 0"
        class="corrupt"
        data-test="corrupt-list"
      >
        <h2>{{ t("vault.corruptTitle") }}</h2>
        <p>{{ t("vault.corruptText") }}</p>
        <ul class="plain-list mono">
          <li v-for="item in vault.corrupt" :key="item.id" data-test="corrupt">
            {{
              t("vault.corruptItem", {
                type: item.type,
                id: item.id,
                reason: t(`vault.reasons.${item.reason}`),
              })
            }}
          </li>
        </ul>
      </section>

      <IconsSection :vault="vault" />

      <section class="kdbx-section" data-test="kdbx-section">
        <h2>{{ t("kdbx.title") }}</h2>
        <div class="actions">
          <button
            type="button"
            class="secondary"
            :disabled="!vault.writable"
            data-test="kdbx-import-group-open"
            @click="importing = true"
          >
            {{ t("kdbx.import.openGroupDialog") }}
          </button>
          <button
            type="button"
            class="secondary"
            :disabled="vault.status !== 'ready' || vault.name === undefined"
            data-test="kdbx-export-open"
            @click="exporting = true"
          >
            {{ t("kdbx.export.openDialog") }}
          </button>
        </div>
      </section>
      <KdbxImportDialog
        v-if="importing"
        :vault-id="vault.id"
        @close="importing = false"
      />
      <KdbxExportDialog
        v-if="exporting"
        :vault-id="vault.id"
        @close="exporting = false"
      />

      <MembersSection :vault="vault" />

      <section v-if="vault.role === 'owner'" class="danger-zone">
        <h2>{{ t("vaults.deleteTitle") }}</h2>
        <button
          type="button"
          class="danger"
          data-test="vault-delete-open"
          @click="deleting = true"
        >
          {{ t("common.delete") }}
        </button>
      </section>
      <VaultDeleteDialog
        v-if="deleting"
        :vault="vault"
        @close="
          (deleted) => {
            deleting = false;
            if (deleted) void router.push('/databases');
          }
        "
      />
    </template>
    <p v-else-if="vaults.snapshot?.loaded" data-test="vault-missing">
      {{ t("vault.notFound") }}
    </p>
  </section>
</template>
