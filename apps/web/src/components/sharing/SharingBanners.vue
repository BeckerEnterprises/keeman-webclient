<script setup lang="ts">
/**
 * Sharing notices after unlocking: invitations with accept
 * and decline, new keys waiting for a verification (of the sender, or that
 * the sender really is an owner), invalid keys and the owner's prompt to
 * renew the key after a member left.
 */
import { SyncError, type Candidate } from "@keeman/core";
import { computed, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import ConfirmDialog from "../dialogs/ConfirmDialog.vue";
import FingerprintDialog from "./FingerprintDialog.vue";

const { t } = useI18n();
const vaults = useVaultsStore();
const busy = ref(false);
const error = ref<UiError>();
const checking = shallowRef<{
  candidate: Candidate;
  purpose: "accept" | "key";
  then: () => Promise<void>;
}>();
/** A pending key whose sender is not a known owner: the user decides. */
const owner = shallowRef<{ vaultId: string; name: string; email: string }>();

const invitations = computed(() => vaults.snapshot?.invitations ?? []);
const pendingKeys = computed(() =>
  vaults.vaults.filter((v) => v.keyStatus === "pending" && v.pendingSender),
);
const invalidKeys = computed(() =>
  vaults.vaults.filter((v) => v.keyStatus === "invalid"),
);
const renewals = computed(() =>
  vaults.vaults.filter((v) => v.rotationRequired && v.role === "owner"),
);

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    await action();
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

function accept(vaultId: string, sender: Candidate | undefined): void {
  const then = () => vaults.engine().acceptInvitation(vaultId);
  if (!sender || sender.status === "verified") void run(then);
  else checking.value = { candidate: sender, purpose: "accept", then };
}

async function acceptKey(
  vaultId: string,
  name: string,
  sender: Candidate,
): Promise<void> {
  try {
    await vaults.engine().acceptPendingKey(vaultId);
  } catch (caught) {
    if (!(caught instanceof SyncError && caught.code === "unknown_owner"))
      throw caught;
    owner.value = { vaultId, name, email: sender.email };
  }
}

function checkKey(vaultId: string, name: string, sender: Candidate): void {
  const then = () => acceptKey(vaultId, name, sender);
  if (sender.status === "verified") void run(then);
  else checking.value = { candidate: sender, purpose: "key", then };
}

function confirmOwner(): void {
  const current = owner.value;
  owner.value = undefined;
  if (current)
    void run(() =>
      vaults.engine().acceptPendingKey(current.vaultId, { confirmOwner: true }),
    );
}

function verified(): void {
  const current = checking.value;
  checking.value = undefined;
  if (current) void run(current.then);
}
</script>

<template>
  <ErrorNotice :error="error" />
  <div
    v-for="invitation in invitations"
    :key="invitation.vaultId"
    class="notice notice-info"
    data-test="banner-invitation"
  >
    <p>
      {{
        t("invitation.text", {
          email: invitation.sender?.email ?? t("invitation.unknownSender"),
          name: invitation.vaultName ?? t("invitation.unknownName"),
        })
      }}
    </p>
    <div class="actions">
      <button
        type="button"
        class="small"
        :disabled="busy"
        data-test="invitation-accept"
        @click="accept(invitation.vaultId, invitation.sender)"
      >
        {{ t("invitation.accept") }}
      </button>
      <button
        type="button"
        class="secondary small"
        :disabled="busy"
        data-test="invitation-decline"
        @click="
          run(() => vaults.engine().declineInvitation(invitation.vaultId))
        "
      >
        {{ t("invitation.decline") }}
      </button>
    </div>
  </div>
  <div
    v-for="vault in pendingKeys"
    :key="vault.id"
    class="notice notice-warning"
    data-test="banner-pending-key"
  >
    <p>
      {{
        t("invitation.keyText", {
          name: vault.name ?? t("invitation.unknownName"),
          email: vault.pendingSender?.email ?? "",
        })
      }}
    </p>
    <button
      v-if="vault.pendingSender"
      type="button"
      class="small"
      :disabled="busy"
      data-test="pending-key-check"
      @click="
        checkKey(
          vault.id,
          vault.name ?? t('invitation.unknownName'),
          vault.pendingSender,
        )
      "
    >
      {{ t("invitation.keyCheck") }}
    </button>
  </div>
  <p
    v-for="vault in invalidKeys"
    :key="vault.id"
    class="notice notice-error"
    role="alert"
    data-test="banner-key-invalid"
  >
    {{
      t("invitation.keyInvalid", {
        name: vault.name ?? t("invitation.unknownName"),
      })
    }}
  </p>
  <p
    v-for="vault in renewals"
    :key="vault.id"
    class="notice notice-warning"
    data-test="banner-rotation-required"
  >
    {{
      t("invitation.rotationRequired", {
        name: vault.name ?? t("invitation.unknownName"),
      })
    }}
    <RouterLink :to="`/databases/${vault.id}`">{{
      t("invitation.rotationAction")
    }}</RouterLink>
  </p>
  <FingerprintDialog
    v-if="checking"
    :candidate="checking.candidate"
    :purpose="checking.purpose"
    @verified="verified"
    @close="checking = undefined"
  />
  <ConfirmDialog
    v-if="owner"
    :title="t('invitation.ownerTitle')"
    :text="t('invitation.ownerText', { name: owner.name, email: owner.email })"
    :confirm="t('invitation.ownerAccept')"
    danger
    :busy="busy"
    @confirm="confirmOwner"
    @close="owner = undefined"
  />
</template>
