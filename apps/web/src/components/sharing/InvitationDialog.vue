<script setup lang="ts">
/**
 * Accepting an invitation: the owners of the owner list the invitation
 * names, the state code the account would have, and the advice to compare
 * it with a member other than the inviter, which can be done right here.
 * Accepting is blocked when a code contradicts, the box does not fit the
 * signed list, or the sender owns no part of it. A list that contradicts
 * what the account knew of the database before is accepted only anyway.
 */
import {
  SyncError,
  type InvitationDetails,
  type InvitationView,
} from "@keeman/core";
import { computed, onMounted, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import ConfirmDialog from "../dialogs/ConfirmDialog.vue";
import AppDialog from "../ui/AppDialog.vue";
import StateComparePanel from "./StateComparePanel.vue";

const props = defineProps<{ invitation: InvitationView }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const details = shallowRef<InvitationDetails>();
const busy = ref(false);
const error = ref<UiError>();
const changed = ref(false);
const comparing = ref(false);
const asking = ref(false);
const panel = ref<InstanceType<typeof StateComparePanel>>();

const acceptable = computed(
  () => details.value?.status === "ok" || details.value?.status === "no_chain",
);
const problem = computed(() => {
  switch (details.value?.status) {
    case "rejected":
      return t("invitationDialog.rejected");
    case "contradicted":
      return t("invitationDialog.contradicted");
    case "sender_not_owner":
      return t("invitationDialog.senderNotOwner");
    default:
      return undefined;
  }
});

/** The core names a contact only if verified with the keys of the list. */
function ownerName(owner: InvitationDetails["owners"][number]): string {
  return owner.email ?? t("entry.member", { id: owner.userId.slice(0, 8) });
}

async function load(): Promise<void> {
  try {
    details.value = await vaults
      .engine()
      .invitationDetails(props.invitation.vaultId);
  } catch (caught) {
    error.value = toUiError(caught);
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    await action();
    emit("close");
  } catch (caught) {
    if (caught instanceof SyncError && caught.code === "roles_changed") {
      changed.value = true;
      await load();
    } else {
      error.value = toUiError(caught);
      // Show the contradiction the core found, with "accept anyway".
      if (caught instanceof SyncError && caught.code === "former_conflict")
        await load();
    }
  } finally {
    busy.value = false;
  }
}

/**
 * Accepts the head shown; a contradiction with what the account knew
 * before only after "accept anyway".
 */
function accept(anyway = false): Promise<void> {
  const shown = details.value;
  if (!shown) return Promise.resolve();
  changed.value = false;
  asking.value = false;
  return run(() =>
    vaults.engine().acceptInvitation(props.invitation.vaultId, {
      head: shown.head,
      formerConflict: anyway,
    }),
  );
}

function decline(): Promise<void> {
  return run(() => vaults.engine().declineInvitation(props.invitation.vaultId));
}

onMounted(() => void load());
</script>

<template>
  <AppDialog
    :title="t('invitationDialog.title')"
    wide
    data-test="invitation-dialog"
    @close="emit('close')"
    @paste="(event: ClipboardEvent) => panel?.onPaste(event)"
  >
    <p>
      {{
        t("invitation.text", {
          email: invitation.sender?.email ?? t("invitation.unknownSender"),
          name:
            details?.vaultName ??
            invitation.vaultName ??
            t("invitation.unknownName"),
        })
      }}
    </p>
    <ErrorNotice :error="error" />
    <p v-if="!details && !error" class="muted">
      {{ t("invitationDialog.loading") }}
    </p>
    <template v-if="details">
      <p
        v-if="changed"
        class="notice notice-warning"
        data-test="invitation-dialog-changed"
      >
        {{ t("invitationDialog.changed") }}
      </p>
      <p
        v-if="problem"
        class="notice notice-error"
        role="alert"
        data-test="invitation-dialog-problem"
      >
        {{ problem }}
      </p>
      <p
        v-if="details.formerConflict"
        class="notice notice-error"
        role="alert"
        data-test="invitation-dialog-former-conflict"
      >
        {{ t("invitationDialog.formerConflict") }}
      </p>
      <p
        v-if="details.status === 'no_chain'"
        class="notice notice-info"
        data-test="invitation-dialog-no-chain"
      >
        {{ t("invitationDialog.noChain") }}
      </p>
      <template v-if="details.owners.length > 0">
        <h3>{{ t("invitationDialog.owners") }}</h3>
        <ul class="member-list" data-test="invitation-dialog-owners">
          <li
            v-for="owner in details.owners"
            :key="owner.userId"
            data-test="invitation-dialog-owner"
          >
            <div class="member-row">
              <strong>{{ ownerName(owner) }}</strong>
              <span v-if="owner.sender" class="tag">{{
                t("invitationDialog.sender")
              }}</span>
              <span
                class="tag"
                :class="{ 'tag-ok': owner.verified }"
                data-test="invitation-dialog-owner-status"
                >{{
                  owner.verified
                    ? t("invitationDialog.verified")
                    : t("invitationDialog.unverified")
                }}</span
              >
              <span
                v-if="owner.keysDiffer"
                class="tag tag-danger"
                data-test="invitation-dialog-keys-differ"
                >{{ t("invitationDialog.keysDiffer") }}</span
              >
            </div>
          </li>
        </ul>
      </template>
      <template v-if="details.code">
        <h3>{{ t("invitationDialog.code") }}</h3>
        <p class="mono secret-groups" data-test="invitation-dialog-code">
          {{ details.code.display }}
        </p>
        <p class="muted">{{ t("invitationDialog.advice") }}</p>
        <StateComparePanel
          v-if="comparing"
          ref="panel"
          :vault-id="invitation.vaultId"
          mode="invitation"
          @changed="load"
        />
        <button
          v-else
          type="button"
          class="secondary"
          data-test="invitation-dialog-check"
          @click="comparing = true"
        >
          {{ t("invitationDialog.check") }}
        </button>
      </template>
    </template>
    <template #actions>
      <button
        v-if="details?.formerConflict"
        type="button"
        class="danger"
        :disabled="busy || !acceptable"
        data-test="invitation-dialog-accept-anyway"
        @click="asking = true"
      >
        {{ t("invitationDialog.acceptAnyway") }}
      </button>
      <button
        v-else
        type="button"
        :disabled="busy || !acceptable"
        data-test="invitation-dialog-accept"
        @click="accept()"
      >
        {{ t("invitationDialog.accept") }}
      </button>
      <button
        type="button"
        class="secondary"
        :disabled="busy"
        data-test="invitation-dialog-decline"
        @click="decline"
      >
        {{ t("invitationDialog.decline") }}
      </button>
      <!-- Focused first: "decline" acts without asking. -->
      <button
        type="button"
        class="secondary"
        autofocus
        data-test="invitation-dialog-close"
        @click="emit('close')"
      >
        {{ t("common.close") }}
      </button>
    </template>
  </AppDialog>
  <ConfirmDialog
    v-if="asking"
    :title="t('invitationDialog.acceptAnywayTitle')"
    :text="t('invitationDialog.acceptAnywayText')"
    :confirm="t('invitationDialog.acceptAnyway')"
    danger
    :busy="busy"
    @confirm="accept(true)"
    @close="asking = false"
  />
</template>
