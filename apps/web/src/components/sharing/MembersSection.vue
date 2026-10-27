<script setup lang="ts">
/**
 * Members of a database: list with role, state and fingerprint
 * status; owners invite verified contacts, withdraw invitations, change
 * roles, remove members and renew the key; everyone may leave.
 */
import {
  SyncError,
  type Candidate,
  type MemberView,
  type VaultView,
} from "@keeman/core";
import { computed, onMounted, ref, shallowRef, toRaw, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { toUiError, type UiError } from "../../errors";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import ConfirmDialog from "../dialogs/ConfirmDialog.vue";
import FingerprintDialog from "./FingerprintDialog.vue";
import RotationDialog from "./RotationDialog.vue";

const props = defineProps<{ vault: VaultView }>();
const { t } = useI18n();
const router = useRouter();
const vaults = useVaultsStore();
// Member views carry candidates; they stay unwrapped for the core.
const members = shallowRef<MemberView[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref<UiError>();
const email = ref("");
const invited = ref<string>();

type Dialog =
  | {
      kind: "fingerprint";
      candidate: Candidate;
      purpose: "invite" | "key" | "contact";
      then: () => Promise<void>;
    }
  | { kind: "rotation"; remove?: string }
  | { kind: "leave" }
  /** The sender of a pending key is not a known owner. */
  | { kind: "owner"; email: string };
const dialog = shallowRef<Dialog>();

const owner = computed(() => props.vault.role === "owner");
const manage = computed(() => owner.value && props.vault.keyStatus === "ok");

async function load(): Promise<void> {
  try {
    members.value = await vaults.engine().members(props.vault.id);
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    loading.value = false;
  }
}

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
  await load();
}

async function sendInvite(candidate: Candidate): Promise<void> {
  await vaults.engine().invite(props.vault.id, toRaw(candidate));
  invited.value = candidate.email;
  email.value = "";
}

function invite(): Promise<void> {
  invited.value = undefined;
  return run(async () => {
    const candidate = await vaults.engine().lookupUser(email.value.trim());
    if (candidate.status === "verified" || candidate.self)
      await sendInvite(candidate);
    else
      dialog.value = {
        kind: "fingerprint",
        candidate,
        purpose: "invite",
        then: () => sendInvite(candidate),
      };
  });
}

async function acceptKey(sender: Candidate): Promise<void> {
  try {
    await vaults.engine().acceptPendingKey(props.vault.id);
  } catch (caught) {
    if (!(caught instanceof SyncError && caught.code === "unknown_owner"))
      throw caught;
    dialog.value = { kind: "owner", email: sender.email };
  }
}

function checkKey(): void {
  const sender = props.vault.pendingSender;
  if (!sender) return;
  if (sender.status === "verified") void run(() => acceptKey(sender));
  else
    dialog.value = {
      kind: "fingerprint",
      candidate: sender,
      purpose: "key",
      then: () => acceptKey(sender),
    };
}

function confirmOwner(): void {
  dialog.value = undefined;
  void run(() =>
    vaults.engine().acceptPendingKey(props.vault.id, { confirmOwner: true }),
  );
}

function verified(): void {
  const current = dialog.value;
  dialog.value = undefined;
  if (current?.kind === "fingerprint") void run(current.then);
}

function setRole(member: MemberView): Promise<void> {
  const role = member.role === "owner" ? "member" : "owner";
  const change = () =>
    vaults.engine().setMemberRole(props.vault.id, member.userId, role);
  // A new owner is signed with keys of a verified contact only.
  if (role === "owner" && member.candidate.status !== "verified") {
    dialog.value = {
      kind: "fingerprint",
      candidate: member.candidate,
      purpose: "contact",
      then: change,
    };
    return Promise.resolve();
  }
  return run(change);
}

/** Why a pending key waits, beyond an unverified sender. */
const keyWait = computed(() =>
  props.vault.pendingReason === "roles_unconfirmed" ||
  props.vault.pendingReason === "roles_invalid"
    ? props.vault.pendingReason
    : undefined,
);

function withdraw(member: MemberView): Promise<void> {
  return run(() =>
    vaults.engine().withdrawInvitation(props.vault.id, member.userId),
  );
}

async function leave(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    await vaults.engine().leaveVault(props.vault.id);
    dialog.value = undefined;
    await router.push("/databases");
  } catch (caught) {
    error.value = toUiError(caught);
    dialog.value = undefined;
  } finally {
    busy.value = false;
  }
}

watch(
  () => [
    props.vault.memberCount,
    props.vault.vaultKeyVersion,
    props.vault.keyStatus,
  ],
  () => void load(),
);
onMounted(() => void load());
</script>

<template>
  <section class="members-section" data-test="members">
    <h2>{{ t("members.title") }}</h2>
    <div
      v-if="vault.keyStatus === 'pending'"
      class="notice notice-warning"
      data-test="members-key-pending"
    >
      <p v-if="keyWait === 'roles_unconfirmed'">
        {{
          t("invitation.keyRolesUnconfirmed", {
            name: vault.name ?? t("invitation.unknownName"),
          })
        }}
      </p>
      <p v-else-if="keyWait === 'roles_invalid'">
        {{
          t("invitation.keyRolesInvalid", {
            name: vault.name ?? t("invitation.unknownName"),
          })
        }}
      </p>
      <p v-else>{{ t("members.keyPending") }}</p>
      <button
        v-if="vault.pendingSender && !keyWait"
        type="button"
        class="small"
        data-test="members-key-check"
        @click="checkKey"
      >
        {{ t("members.keyCheck") }}
      </button>
    </div>
    <p
      v-else-if="vault.keyStatus === 'invalid'"
      class="notice notice-error"
      role="alert"
    >
      {{
        vault.pendingReason === "roles_rejected"
          ? t("invitation.keyRejected", {
              name: vault.name ?? t("invitation.unknownName"),
            })
          : t("members.keyInvalid")
      }}
    </p>
    <p v-else-if="vault.keyStatus === 'missing'" class="notice notice-warning">
      {{ t("members.keyMissing") }}
    </p>
    <p
      v-if="vault.rotationRequired && owner"
      class="notice notice-warning"
      data-test="members-rotation-required"
    >
      {{ t("members.rotationRequired") }}
    </p>
    <ErrorNotice :error="error" />
    <p v-if="invited" class="notice notice-info" data-test="members-invited">
      {{ t("members.invited", { email: invited }) }}
    </p>
    <p v-if="loading" class="muted">{{ t("members.loading") }}</p>
    <ul v-else class="member-list">
      <li v-for="member in members" :key="member.userId" data-test="member">
        <div class="member-row">
          <strong data-test="member-email">{{ member.email }}</strong>
          <span v-if="member.self" class="tag">{{ t("members.me") }}</span>
          <span class="tag" data-test="member-role">{{
            t(`members.${member.role}`)
          }}</span>
          <span
            v-if="member.signed && member.state === 'active'"
            class="tag tag-ok"
            data-test="member-signed"
            >{{ t("members.signed") }}</span
          >
          <span
            v-if="member.roleMismatch"
            class="tag tag-danger"
            data-test="member-role-mismatch"
            >{{ t("members.roleMismatch") }}</span
          >
          <span
            v-if="member.state === 'pending'"
            class="tag"
            data-test="member-pending"
            >{{ t("members.pending") }}</span
          >
          <span
            v-if="!member.self"
            class="tag"
            :class="{
              'tag-ok': member.candidate.status === 'verified',
              'tag-danger':
                member.candidate.status === 'changed' ||
                member.candidate.status === 'conflict',
            }"
            data-test="member-status"
            >{{ t(`members.status.${member.candidate.status}`) }}</span
          >
        </div>
        <div v-if="manage && !member.self" class="actions">
          <button
            v-if="member.state === 'pending'"
            type="button"
            class="secondary small"
            :disabled="busy"
            data-test="member-withdraw"
            @click="withdraw(member)"
          >
            {{ t("members.withdraw") }}
          </button>
          <template v-else>
            <button
              type="button"
              class="secondary small"
              :disabled="busy"
              data-test="member-role-toggle"
              @click="setRole(member)"
            >
              {{
                member.role === "owner"
                  ? t("members.makeMember")
                  : t("members.makeOwner")
              }}
            </button>
            <button
              type="button"
              class="secondary small"
              :disabled="busy"
              data-test="member-remove"
              @click="dialog = { kind: 'rotation', remove: member.userId }"
            >
              {{ t("members.remove") }}
            </button>
          </template>
        </div>
      </li>
    </ul>

    <form v-if="manage" class="inline-form" novalidate @submit.prevent="invite">
      <label>
        {{ t("members.inviteEmail") }}
        <input
          v-model="email"
          type="email"
          autocomplete="off"
          data-test="invite-email"
        />
      </label>
      <button
        type="submit"
        :disabled="busy || email.trim() === ''"
        data-test="invite-submit"
      >
        {{ t("members.inviteSubmit") }}
      </button>
    </form>
    <div class="actions">
      <button
        v-if="manage"
        type="button"
        class="secondary"
        :disabled="busy"
        data-test="rotation-open"
        @click="dialog = { kind: 'rotation' }"
      >
        {{ t("members.renewKey") }}
      </button>
      <button
        type="button"
        class="secondary"
        :disabled="busy"
        data-test="vault-leave"
        @click="dialog = { kind: 'leave' }"
      >
        {{ t("members.leave") }}
      </button>
    </div>

    <FingerprintDialog
      v-if="dialog?.kind === 'fingerprint'"
      :candidate="dialog.candidate"
      :purpose="dialog.purpose"
      @verified="verified"
      @close="dialog = undefined"
    />
    <RotationDialog
      v-if="dialog?.kind === 'rotation'"
      :vault-id="vault.id"
      :remove="dialog.remove"
      @done="load"
      @close="dialog = undefined"
    />
    <ConfirmDialog
      v-if="dialog?.kind === 'owner'"
      :title="t('invitation.ownerTitle')"
      :text="
        t('invitation.ownerText', {
          name: vault.name ?? t('invitation.unknownName'),
          email: dialog.email,
        })
      "
      :confirm="t('invitation.ownerAccept')"
      danger
      :busy="busy"
      @confirm="confirmOwner"
      @close="dialog = undefined"
    />
    <ConfirmDialog
      v-if="dialog?.kind === 'leave'"
      :title="t('members.leaveTitle')"
      :text="t('members.leaveText', { name: vault.name ?? '' })"
      :confirm="t('members.leave')"
      danger
      :busy="busy"
      @confirm="leave"
      @close="dialog = undefined"
    />
  </section>
</template>
