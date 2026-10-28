<script setup lang="ts">
/**
 * The signed owner list of a database: warnings about an older or
 * contradictory list with "understood", the one-time take-over of a list
 * this account has no anchor for, the hint to verify co-owners first, a
 * list the server names but this device could not load, and a server that
 * names other owners than the signed list.
 */
import type { VaultView } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import ConfirmDialog from "../dialogs/ConfirmDialog.vue";
import RoleOwnerRow from "./RoleOwnerRow.vue";

const props = defineProps<{ vault: VaultView }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const busy = ref(false);
const asking = ref(false);
const error = ref<UiError>();

const roles = computed(() => props.vault.roles);
const warning = computed(() =>
  roles.value.status === "rollback" ||
  roles.value.status === "fork" ||
  roles.value.status === "invalid"
    ? roles.value.status
    : undefined,
);

/**
 * The contact's address where the core found it verified with the keys of
 * the list, else the server's, else a short form of the ID. Each owner is
 * a line of its own with its own status: in one sentence an address of the
 * server could pass for a verified one.
 */
function ownerName(owner: VaultView["roles"]["owners"][number]): string {
  return owner.email ?? t("entry.member", { id: owner.userId.slice(0, 8) });
}

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    await action();
  } catch (caught) {
    error.value = toUiError(caught);
    // The list changed since it was shown: show the new one.
    if (error.value.key === "sync_roles_changed")
      await vaults.engine().refresh();
  } finally {
    busy.value = false;
    asking.value = false;
  }
}

/** Only the head shown here is taken over. */
function shown(): { head: { version: number; hash: string } | null } {
  return { head: roles.value.head ?? null };
}

function acknowledge(): Promise<void> {
  return run(() => vaults.engine().acknowledgeRoles(props.vault.id, shown()));
}

function take(): Promise<void> {
  return run(() => vaults.engine().confirmRoles(props.vault.id, shown()));
}

function retry(): Promise<void> {
  return run(() => vaults.engine().refresh());
}
</script>

<template>
  <div
    v-if="warning"
    class="notice notice-error"
    role="alert"
    data-test="vault-roles-warning"
  >
    <p v-if="roles.compared" data-test="vault-roles-compared">
      {{
        t(
          roles.compared.kind === "missing"
            ? "vaults.roles.missingCode"
            : "vaults.roles.mismatchCode",
          { code: roles.compared.code.display },
        )
      }}
    </p>
    <p v-else>{{ t(`vaults.roles.${warning}`) }}</p>
    <p>{{ t("vaults.roles.blocked") }}</p>
    <p v-if="roles.compared">{{ t("vaults.roles.otherDevices") }}</p>
    <div v-if="roles.owners.length > 0" data-test="vault-roles-owners">
      <p>{{ t("vaults.roles.owners") }}</p>
      <ul class="member-list">
        <li v-for="owner in roles.owners" :key="owner.userId">
          <RoleOwnerRow :owner="owner" :name="ownerName(owner)" />
        </li>
      </ul>
    </div>
    <div v-if="roles.newOwners.length > 0" data-test="vault-roles-new">
      <p>{{ t("vaults.roles.newOwners") }}</p>
      <ul class="member-list">
        <li v-for="owner in roles.newOwners" :key="owner.userId">
          <RoleOwnerRow :owner="owner" :name="ownerName(owner)" />
        </li>
      </ul>
    </div>
    <button
      type="button"
      class="small"
      :disabled="busy"
      data-test="vault-roles-ack"
      @click="asking = true"
    >
      {{ t("common.understood") }}
    </button>
  </div>
  <div
    v-else-if="roles.status === 'unavailable'"
    class="notice notice-error"
    role="alert"
    data-test="vault-roles-unavailable"
  >
    <p>{{ t("vaults.roles.unavailable") }}</p>
    <button
      type="button"
      class="small"
      :disabled="busy"
      data-test="vault-roles-retry"
      @click="retry"
    >
      {{ t("common.retry") }}
    </button>
  </div>
  <div
    v-else-if="roles.status === 'unanchored'"
    class="notice notice-warning"
    data-test="vault-roles-unanchored"
  >
    <p>{{ t("vaults.roles.unanchored") }}</p>
    <ul class="member-list" data-test="vault-roles-unanchored-owners">
      <li v-for="owner in roles.owners" :key="owner.userId">
        <RoleOwnerRow :owner="owner" :name="ownerName(owner)" />
      </li>
    </ul>
    <button
      type="button"
      class="small"
      :disabled="busy"
      data-test="vault-roles-take"
      @click="take"
    >
      {{ t("vaults.roles.take") }}
    </button>
  </div>
  <p
    v-else-if="roles.verifyOwners"
    class="notice notice-info"
    data-test="vault-roles-verify-owners"
  >
    {{ t("vaults.roles.verifyOwners") }}
  </p>
  <p
    v-if="roles.ownersMismatch"
    class="notice notice-warning"
    data-test="vault-roles-mismatch"
  >
    {{ t("vaults.roles.mismatch") }}
  </p>
  <ErrorNotice :error="error" />
  <ConfirmDialog
    v-if="asking"
    :title="t('vaults.roles.ackTitle')"
    :text="
      roles.compared ? t('vaults.roles.ackCompare') : t('vaults.roles.ackText')
    "
    :confirm="t('common.understood')"
    danger
    :busy="busy"
    @confirm="acknowledge"
    @close="asking = false"
  />
</template>
