<script setup lang="ts">
/**
 * Earlier states of an entry: when and by whom, changed fields
 * highlighted, secrets masked until shown, restore with confirmation.
 */
import type { EntryDetail, HistoryItem } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { formatDate } from "../../format";
import { useServices } from "../../services";
import { describeNotices, useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import WriteNotices from "../WriteNotices.vue";
import AppDialog from "../ui/AppDialog.vue";
import SecretValue from "../ui/SecretValue.vue";
import AttachmentList from "./AttachmentList.vue";

const props = defineProps<{
  vaultId: string;
  entryId: string;
  detail: EntryDetail;
}>();
const { t } = useI18n();
const vaults = useVaultsStore();
const chosen = ref(0);
const confirming = ref(false);
const busy = ref(false);
const error = ref<UiError>();
const notices = ref<ReturnType<typeof describeNotices>>([]);

const item = computed<HistoryItem | undefined>(
  () => props.detail.history[chosen.value],
);
const fieldNames: Record<string, string> = {
  title: "entry.title",
  username: "entry.username",
  password: "entry.password",
  url: "entry.url",
  notes: "entry.notes",
  fields: "entry.fields",
  tags: "entry.tags",
  expires: "entry.expires",
  icon: "entry.icon",
  otp: "totp.label",
  attachments: "attachments.title",
};

function changed(field: string): boolean {
  return item.value?.changed.includes(field) ?? false;
}

function changedLabel(history: HistoryItem): string {
  return history.changed
    .map((field) => (fieldNames[field] ? t(fieldNames[field]) : field))
    .join(", ");
}

function author(id: string | undefined): string {
  if (!id) return t("entry.unknown");
  const { account } = useServices();
  if (id === account.userId) return t("entry.me");
  // A contact's address, else a short form of the ID.
  return account.contactEmail(id) ?? t("entry.member", { id: id.slice(0, 8) });
}

async function restore(): Promise<void> {
  confirming.value = false;
  busy.value = true;
  error.value = undefined;
  try {
    const result = await vaults
      .engine()
      .restoreHistory(props.vaultId, props.entryId, chosen.value);
    notices.value = describeNotices(result.notices);
    chosen.value = 0;
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="entry-history" data-test="entry-history">
    <WriteNotices :notices="notices" />
    <ErrorNotice :error="error" />
    <p
      v-if="detail.history.length === 0"
      class="muted"
      data-test="history-empty"
    >
      {{ t("history.empty") }}
    </p>
    <ol v-else class="history-list" :aria-label="t('history.label')">
      <li v-for="history in detail.history" :key="history.index">
        <button
          type="button"
          class="history-item"
          :class="{ selected: history.index === chosen }"
          :aria-pressed="history.index === chosen"
          data-test="history-item"
          @click="chosen = history.index"
        >
          <span
            >{{ formatDate(history.modified) || t("entry.unknown") }} ·
            {{ author(history.modifiedBy) }}</span
          >
          <span
            v-if="history.conflict"
            class="tag text-warning"
            data-test="history-conflict"
            >{{ t("history.conflict") }}</span
          >
          <span class="muted small-text">{{ changedLabel(history) }}</span>
        </button>
      </li>
    </ol>
    <template v-if="item">
      <p v-if="item.unreadable" class="notice notice-warning">
        {{ t("history.unreadable") }}
      </p>
      <dl
        v-else
        class="detail-fields history-values"
        data-test="history-values"
      >
        <SecretValue
          :class="{ changed: changed('title') }"
          :label="t('entry.title')"
          :value="item.values.title"
          test="history-title"
        />
        <SecretValue
          :class="{ changed: changed('username') }"
          :label="t('entry.username')"
          :value="item.values.username"
        />
        <SecretValue
          :class="{ changed: changed('password') }"
          :label="t('entry.password')"
          :value="item.values.password"
          secret
          test="history-password"
        />
        <SecretValue
          v-if="item.values.otp !== null || changed('otp')"
          :class="{ changed: changed('otp') }"
          :label="t('totp.label')"
          :value="item.values.otp ?? ''"
          secret
          test="history-otp"
        />
        <SecretValue
          :class="{ changed: changed('url') }"
          :label="t('entry.url')"
          :value="item.values.url"
        />
        <SecretValue
          v-for="field in item.values.fields"
          :key="field.id"
          :class="{ changed: changed('fields') }"
          :label="field.name"
          :value="field.value"
          :secret="field.protected"
        />
        <AttachmentList
          v-if="item.values.attachments.length > 0"
          :class="{ changed: changed('attachments') }"
          :vault-id="vaultId"
          :entry-id="entryId"
          :attachments="item.values.attachments"
        />
        <div
          v-if="item.values.notes"
          class="secret-value"
          :class="{ changed: changed('notes') }"
        >
          <dt>{{ t("entry.notes") }}</dt>
          <dd class="notes">{{ item.values.notes }}</dd>
        </div>
      </dl>
      <div class="actions">
        <button
          type="button"
          :disabled="!item.restorable || !detail.summary.writable || busy"
          data-test="history-restore"
          @click="confirming = true"
        >
          {{ t("history.restore") }}
        </button>
        <span v-if="!item.restorable" class="muted small-text">{{
          t("history.notRestorable")
        }}</span>
      </div>
    </template>
    <AppDialog
      v-if="confirming"
      :title="t('history.restoreTitle')"
      @close="confirming = false"
    >
      <p>
        {{
          t("history.restoreText", {
            date: formatDate(item?.modified) || t("entry.unknown"),
          })
        }}
      </p>
      <template #actions>
        <button
          type="button"
          data-test="history-restore-confirm"
          @click="restore"
        >
          {{ t("history.restore") }}
        </button>
        <button type="button" class="secondary" @click="confirming = false">
          {{ t("common.cancel") }}
        </button>
      </template>
    </AppDialog>
  </section>
</template>
