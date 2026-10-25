<script setup lang="ts">
/**
 * Key renewal: loads the database, shows who keeps
 * access and what is corrupt; unverified recipients are verified or
 * removed, corrupt objects are dropped only after a confirmation.
 */
import {
  SyncError,
  type Candidate,
  type RotationRecipient,
  type RotationReview,
} from "@keeman/core";
import { computed, onMounted, ref, shallowRef, toRaw } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import AppDialog from "../ui/AppDialog.vue";
import FingerprintDialog from "./FingerprintDialog.vue";

const props = defineProps<{ vaultId: string; remove?: string }>();
const emit = defineEmits<{ done: []; close: [] }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const phase = ref<"loading" | "review" | "running" | "done">("loading");
const review = shallowRef<RotationReview>();
const removed = ref<string[]>(props.remove ? [props.remove] : []);
const verified = ref<string[]>([]);
const dropConfirmed = ref(false);
const progress = ref({ done: 0, total: 0 });
const error = ref<UiError>();
const checking = shallowRef<Candidate>();

function statusOf(recipient: RotationRecipient): string {
  return verified.value.includes(recipient.candidate.userId)
    ? "verified"
    : recipient.candidate.status;
}

const blocked = computed(() => {
  const current = review.value;
  if (!current) return true;
  const unverified = current.recipients.some(
    (r) =>
      !removed.value.includes(r.candidate.userId) && statusOf(r) !== "verified",
  );
  return unverified || (current.corrupt.length > 0 && !dropConfirmed.value);
});

async function load(): Promise<void> {
  phase.value = "loading";
  try {
    review.value = await vaults.engine().prepareRotation(props.vaultId);
  } catch (caught) {
    error.value = toUiError(caught);
  }
  phase.value = "review";
}

async function run(): Promise<void> {
  const current = review.value;
  if (!current) return;
  phase.value = "running";
  error.value = undefined;
  progress.value = { done: 0, total: current.objects };
  try {
    await vaults
      .engine()
      .runRotation(
        toRaw(current),
        { remove: [...removed.value], dropCorrupt: dropConfirmed.value },
        (next) => {
          progress.value = next;
        },
      );
    phase.value = "done";
    emit("done");
  } catch (caught) {
    error.value = toUiError(caught);
    // A changed vault needs a new review.
    if (caught instanceof SyncError && caught.code === "rotation_conflict")
      await load();
    else phase.value = "review";
  }
}

function toggle(userId: string): void {
  removed.value = removed.value.includes(userId)
    ? removed.value.filter((id) => id !== userId)
    : [...removed.value, userId];
}

function confirmed(): void {
  const candidate = checking.value;
  if (candidate) verified.value = [...verified.value, candidate.userId];
  checking.value = undefined;
}

onMounted(() => void load());
</script>

<template>
  <AppDialog
    :title="t('rotation.title')"
    wide
    data-test="rotation-dialog"
    @close="phase !== 'running' && emit('close')"
  >
    <p v-if="phase === 'loading'" class="muted">{{ t("rotation.loading") }}</p>
    <template v-else-if="review">
      <p>{{ t("rotation.explain") }}</p>
      <h3>{{ t("rotation.recipients") }}</h3>
      <p v-if="review.recipients.length === 0" class="muted">
        {{ t("rotation.none") }}
      </p>
      <ul v-else class="recipient-list">
        <li
          v-for="recipient in review.recipients"
          :key="recipient.candidate.userId"
          data-test="rotation-recipient"
        >
          <div class="member-row">
            <strong>{{ recipient.candidate.email }}</strong>
            <span v-if="recipient.state === 'pending'" class="tag">{{
              t("members.pending")
            }}</span>
            <span
              class="tag"
              :class="{
                'tag-ok': statusOf(recipient) === 'verified',
                'tag-danger':
                  statusOf(recipient) === 'changed' ||
                  statusOf(recipient) === 'conflict',
              }"
              data-test="rotation-status"
              >{{ t(`members.status.${statusOf(recipient)}`) }}</span
            >
          </div>
          <div class="actions">
            <label class="choice">
              <input
                type="checkbox"
                :checked="removed.includes(recipient.candidate.userId)"
                :disabled="phase === 'running'"
                data-test="rotation-remove"
                @change="toggle(recipient.candidate.userId)"
              />
              {{
                recipient.state === "pending"
                  ? t("rotation.discard")
                  : t("rotation.remove")
              }}
            </label>
            <button
              v-if="
                statusOf(recipient) !== 'verified' &&
                !removed.includes(recipient.candidate.userId)
              "
              type="button"
              class="secondary small"
              :disabled="phase === 'running'"
              data-test="rotation-check"
              @click="checking = recipient.candidate"
            >
              {{ t("rotation.check") }}
            </button>
          </div>
        </li>
      </ul>
      <section v-if="review.corrupt.length > 0" class="corrupt">
        <h3>{{ t("rotation.corruptTitle") }}</h3>
        <p>{{ t("rotation.corruptText") }}</p>
        <ul class="plain-list mono">
          <li
            v-for="item in review.corrupt"
            :key="item.id"
            data-test="rotation-corrupt"
          >
            {{ item.type }} {{ item.id }}
          </li>
        </ul>
        <label class="choice">
          <input
            v-model="dropConfirmed"
            type="checkbox"
            :disabled="phase === 'running'"
            data-test="rotation-drop-confirm"
          />
          {{ t("rotation.corruptConfirm") }}
        </label>
      </section>
      <p v-if="blocked && phase === 'review'" class="muted">
        {{ t("rotation.unverifiedLeft") }}
      </p>
      <div v-if="phase === 'running'">
        <progress
          :value="progress.done"
          :max="Math.max(progress.total, 1)"
          data-test="rotation-progress"
        />
        <p class="muted small-text">{{ t("rotation.progress", progress) }}</p>
      </div>
      <p
        v-if="phase === 'done'"
        class="notice notice-info"
        data-test="rotation-done"
      >
        {{ t("rotation.done") }}
      </p>
    </template>
    <ErrorNotice :error="error" />
    <template #actions>
      <button
        v-if="phase !== 'done'"
        type="button"
        :disabled="blocked || phase !== 'review'"
        data-test="rotation-run"
        @click="run"
      >
        {{ t("rotation.run") }}
      </button>
      <button
        type="button"
        class="secondary"
        :disabled="phase === 'running'"
        data-test="rotation-close"
        @click="emit('close')"
      >
        {{ phase === "done" ? t("common.close") : t("common.cancel") }}
      </button>
    </template>
    <FingerprintDialog
      v-if="checking"
      :candidate="checking"
      purpose="rotation"
      @verified="confirmed"
      @close="checking = undefined"
    />
  </AppDialog>
</template>
