<script setup lang="ts">
/**
 * The selected entry. Its values come from the core on request and
 * are dropped when another entry is shown; everything is plain text.
 * Values are shown and copied with `{REF}` resolved, the URL fully.
 */
import type { EntryDetail } from "@keeman/core";
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { formatDate } from "../../format";
import { useServices } from "../../services";
import { customIconSrc } from "../../custom-icons";
import { useVaultsStore } from "../../stores/vaults";
import { useActions } from "../../views/main/actions";
import AppIcon from "../ui/AppIcon";
import SecretValue from "../ui/SecretValue.vue";
import EntryHistory from "./EntryHistory.vue";
import AttachmentList from "./AttachmentList.vue";
import TotpBlock from "./TotpBlock.vue";
import UrlBlock from "./UrlBlock.vue";

const props = defineProps<{ vaultId: string; entryId: string }>();
const emit = defineEmits<{ repaired: [] }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const actions = useActions();
const tab = ref<"details" | "history">("details");
const detail = shallowRef<EntryDetail>();

watch(
  () => [vaults.snapshot, props.vaultId, props.entryId] as const,
  () => {
    detail.value = vaults.snapshot
      ? vaults.engine().entry(props.vaultId, props.entryId)
      : undefined;
  },
  { immediate: true },
);
watch(
  () => props.entryId,
  () => {
    tab.value = "details";
  },
);

const vault = computed(() => vaults.vaults.find((v) => v.id === props.vaultId));
const path = computed(() => {
  const tree = vault.value?.tree;
  return (detail.value?.path ?? [])
    .map((id) =>
      id === tree?.rootId
        ? (vault.value?.name ?? "")
        : (tree?.nodes.get(id)?.name ?? ""),
    )
    .join(" › ");
});
const expired = computed(() => {
  const expires = detail.value?.values.expires;
  return (
    expires !== null &&
    expires !== undefined &&
    expires <= new Date().toISOString()
  );
});

function author(id: string | undefined): string {
  if (!id) return t("entry.unknown");
  const { account } = useServices();
  if (id === account.userId) return t("entry.me");
  // A contact's address, else a short form of the ID.
  return account.contactEmail(id) ?? t("entry.member", { id: id.slice(0, 8) });
}

const ref_ = () => [{ kind: "entry" as const, id: props.entryId }];
</script>

<template>
  <article v-if="detail" class="entry-detail" data-test="entry-detail">
    <header class="detail-head">
      <AppIcon
        :name="detail.values.icon"
        :src="customIconSrc(vault, detail.values.customIcon)"
        :size="28"
      />
      <div>
        <h2 data-test="detail-title">
          {{ detail.resolved.title.display || t("entry.untitled")
          }}<span
            v-if="detail.resolved.title.refs"
            class="tag"
            data-test="detail-title-ref"
            >{{ t("entry.reference") }}</span
          >
        </h2>
        <p class="muted small-text" data-test="detail-path">{{ path }}</p>
      </div>
      <div class="actions detail-actions">
        <template v-if="detail.summary.inTrash">
          <button
            type="button"
            class="small"
            :disabled="!detail.summary.writable"
            data-test="detail-restore"
            @click="actions.restore(vaultId, ref_())"
          >
            {{ t("tree.restore") }}
          </button>
          <button
            type="button"
            class="danger small"
            :disabled="!detail.summary.writable"
            data-test="detail-delete"
            @click="actions.remove(vaultId, ref_(), true)"
          >
            {{ t("tree.deletePermanently") }}
          </button>
        </template>
        <template v-else>
          <button
            type="button"
            class="small"
            :disabled="!detail.summary.writable"
            data-test="detail-edit"
            @click="actions.editEntry(vaultId, entryId)"
          >
            <AppIcon ui="edit" /> {{ t("entry.edit") }}
          </button>
          <button
            type="button"
            class="secondary small"
            :disabled="!detail.summary.writable"
            data-test="detail-delete"
            @click="actions.remove(vaultId, ref_())"
          >
            <AppIcon ui="delete" /> {{ t("tree.delete") }}
          </button>
        </template>
      </div>
    </header>

    <p
      v-if="detail.summary.rollback"
      class="notice notice-error"
      data-test="detail-rollback"
    >
      {{ t("entry.rollback") }}
    </p>
    <p
      v-else-if="detail.summary.readOnly === 'schema'"
      class="notice notice-warning"
    >
      {{ t("entry.newerSchema") }}
    </p>
    <p
      v-else-if="detail.summary.readOnly === 'superseded'"
      class="notice notice-error"
      data-test="detail-superseded"
    >
      {{ t("entry.superseded") }}
    </p>
    <div
      v-else-if="detail.summary.readOnly === 'invalid'"
      class="notice notice-warning"
      data-test="detail-invalid"
    >
      <p>{{ t("entry.invalid", { count: detail.summary.invalid }) }}</p>
      <button
        type="button"
        class="small"
        data-test="detail-repair"
        @click="emit('repaired')"
      >
        {{ t("entry.removeInvalid") }}
      </button>
    </div>

    <div class="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'details'"
        :class="{ secondary: tab !== 'details' }"
        data-test="tab-details"
        @click="tab = 'details'"
      >
        {{ t("entry.details") }}
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'history'"
        :class="{ secondary: tab !== 'history' }"
        data-test="tab-history"
        @click="tab = 'history'"
      >
        {{ t("entry.history", { count: detail.history.length }) }}
      </button>
    </div>

    <dl v-if="tab === 'details'" class="detail-fields">
      <SecretValue
        :label="t('entry.username')"
        :value="detail.resolved.username.value"
        :secret="detail.resolved.username.secret"
        :reference="detail.resolved.username.refs"
        :warnings="detail.resolved.username.warnings"
        test="detail-username"
      />
      <SecretValue
        :label="t('entry.password')"
        :value="detail.resolved.password.value"
        secret
        :reference="detail.resolved.password.refs"
        :warnings="detail.resolved.password.warnings"
        test="detail-password"
      />
      <TotpBlock
        v-if="detail.summary.totp !== 'none'"
        :vault-id="vaultId"
        :entry-id="entryId"
      />
      <UrlBlock
        v-if="detail.resolved.url"
        :result="detail.resolved.url"
        :template="detail.values.url"
        test="detail-url"
      />
      <SecretValue
        v-for="(field, index) in detail.values.fields"
        :key="field.id"
        :label="field.name"
        :value="detail.resolved.fields[index]?.value ?? field.value"
        :secret="field.protected || detail.resolved.fields[index]?.secret"
        :reference="detail.resolved.fields[index]?.refs"
        :warnings="detail.resolved.fields[index]?.warnings"
        test="detail-field"
      />
      <AttachmentList
        v-if="detail.attachments.length > 0"
        :vault-id="vaultId"
        :entry-id="entryId"
        :attachments="detail.attachments"
      />
      <div v-if="detail.values.tags.length > 0" class="secret-value">
        <dt>{{ t("entry.tags") }}</dt>
        <dd class="tag-list" data-test="detail-tags">
          <span v-for="tag in detail.values.tags" :key="tag" class="tag">{{
            tag
          }}</span>
        </dd>
      </div>
      <div v-if="detail.values.expires" class="secret-value">
        <dt>{{ t("entry.expires") }}</dt>
        <dd :class="{ 'text-error': expired }" data-test="detail-expires">
          {{ formatDate(detail.values.expires) }}
          <span v-if="expired">({{ t("entry.expired") }})</span>
        </dd>
      </div>
      <div v-if="detail.values.notes" class="secret-value">
        <dt>
          {{ t("entry.notes")
          }}<span
            v-if="detail.resolved.notes.refs"
            class="tag"
            data-test="detail-notes-ref"
            >{{ t("entry.reference") }}</span
          >
        </dt>
        <dd class="notes" data-test="detail-notes">
          {{ detail.resolved.notes.display }}
        </dd>
      </div>
      <div class="secret-value meta">
        <dt>{{ t("entry.metadata") }}</dt>
        <dd class="muted small-text">
          {{
            t("entry.created", {
              date: formatDate(detail.summary.created) || t("entry.unknown"),
            })
          }}<br />
          {{
            t("entry.modified", {
              date: formatDate(detail.summary.modified) || t("entry.unknown"),
              name: author(detail.summary.modifiedBy),
            })
          }}
        </dd>
      </div>
    </dl>
    <EntryHistory
      v-else
      :vault-id="vaultId"
      :entry-id="entryId"
      :detail="detail"
    />
  </article>
  <p v-else class="muted" data-test="detail-missing">
    {{ t("entry.missing") }}
  </p>
</template>
