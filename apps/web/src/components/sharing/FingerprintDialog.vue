<script setup lang="ts">
/**
 * Fingerprint dialog: the own and the other fingerprint side by
 * side, a red warning for a changed key or a conflict. "Matches" stores the
 * contact, then the caller continues its action; cancel sends nothing.
 */
import type { Candidate } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { useSessionStore } from "../../stores/session";
import ErrorNotice from "../ErrorNotice.vue";
import AppDialog from "../ui/AppDialog.vue";

const props = defineProps<{
  candidate: Candidate;
  purpose: "invite" | "accept" | "key" | "rotation" | "contact";
}>();
const emit = defineEmits<{ verified: []; close: [] }>();
const { t } = useI18n();
const session = useSessionStore();
const busy = ref(false);
const error = ref<UiError>();
const warning = computed(() =>
  props.candidate.status === "changed" || props.candidate.status === "conflict"
    ? props.candidate.status
    : undefined,
);

async function confirm(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    await session.verifyContact(props.candidate);
    emit("verified");
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppDialog
    :title="t('fingerprint.title')"
    wide
    data-test="fingerprint-dialog"
    @close="emit('close')"
  >
    <p>{{ t(`fingerprint.intro.${purpose}`, { email: candidate.email }) }}</p>
    <p
      v-if="warning"
      class="notice notice-error"
      role="alert"
      data-test="fingerprint-warning"
    >
      {{ t(`fingerprint.${warning}`) }}
    </p>
    <div class="fingerprints">
      <div>
        <h3>{{ t("fingerprint.own") }}</h3>
        <p class="fingerprint mono" data-test="fingerprint-own">
          {{ session.ownFingerprint }}
        </p>
      </div>
      <div>
        <h3>{{ t("fingerprint.other", { email: candidate.email }) }}</h3>
        <p class="fingerprint mono" data-test="fingerprint-other">
          {{ candidate.fingerprint }}
        </p>
      </div>
    </div>
    <p v-if="!session.contactsWritable" class="notice notice-warning">
      {{ t("fingerprint.readOnly") }}
    </p>
    <ErrorNotice :error="error" />
    <template #actions>
      <button
        type="button"
        :disabled="busy || !session.contactsWritable"
        data-test="fingerprint-confirm"
        @click="confirm"
      >
        {{ t("fingerprint.confirm") }}
      </button>
      <button
        type="button"
        class="secondary"
        data-test="fingerprint-cancel"
        @click="emit('close')"
      >
        {{ t("common.cancel") }}
      </button>
    </template>
  </AppDialog>
</template>
