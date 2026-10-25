<script setup lang="ts">
/**
 * Editing an entry: General, TOTP, Fields, Attachments, Icon. The save rules of the
 * core apply; unsaved changes are asked about only while
 * unlocked, because locking discards them.
 */
import {
  emptyDraft,
  faviconTarget,
  validateEntryDraft,
  type DraftProblem,
  type EntryBase,
  type EntryDraft,
  type Notice,
  type SyncError,
} from "@keeman/core";
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import { toUiError, type UiError } from "../../errors";
import { loadScorer, type Scorer } from "../../password";
import { useSessionStore } from "../../stores/session";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import StrengthMeter from "../StrengthMeter.vue";
import UrlBlock from "../detail/UrlBlock.vue";
import AppIcon from "../ui/AppIcon";
import IconPicker from "../ui/IconPicker.vue";
import AttachmentsTab from "./AttachmentsTab.vue";
import GeneratorPanel from "./GeneratorPanel.vue";
import TagInput from "./TagInput.vue";
import TotpTab from "./TotpTab.vue";

const props = defineProps<{
  vaultId: string;
  groupId: string;
  entryId?: string;
}>();
const emit = defineEmits<{
  saved: [id: string, notices: Notice[]];
  cancel: [];
}>();
const { t } = useI18n();
const session = useSessionStore();
const vaults = useVaultsStore();
const ids = {
  title: useId(),
  username: useId(),
  password: useId(),
  url: useId(),
  expires: useId(),
  notes: useId(),
};

/** A plain copy; reactive proxies cannot be cloned structurally. */
function copyDraft(source: EntryDraft): EntryDraft {
  return {
    ...source,
    icon: source.icon ? { ...source.icon } : null,
    tags: [...source.tags],
    fields: source.fields.map((field) => ({ ...field })),
    attachments: [...source.attachments],
  };
}

const tab = ref<"general" | "totp" | "fields" | "attachments" | "icon">(
  "general",
);
/** A new entry gets its ID now, so attachments can go up before saving. */
const entryId = props.entryId ?? vaults.engine().newEntryId();
const storedAttachments = props.entryId
  ? (vaults.engine().entry(props.vaultId, props.entryId)?.attachments ?? [])
  : [];
const uploading = ref(0);
let base: EntryBase | undefined;
const opened = props.entryId
  ? vaults.engine().editEntry(props.vaultId, props.entryId)
  : undefined;
base = opened?.base;
const original: EntryDraft = opened?.draft ?? emptyDraft();
const draft = ref<EntryDraft>(copyDraft(original));
const showPassword = ref(false);
const shownFields = ref(new Set<number>());
const generator = ref(false);
const problems = ref<DraftProblem[]>([]);
const busy = ref(false);
const error = ref<UiError>();
let retry: (() => Promise<unknown>) | undefined;
let done = false;
/** The URL as it will be resolved, against the vault as it is now. */
const urlPreview = computed(() =>
  vaults.snapshot
    ? vaults.engine().previewUrl(props.vaultId, props.entryId, draft.value)
    : undefined,
);
/**
 * Origin for "Fetch favicon": only if scheme and host hold no
 * secret parts, i.e. the masked display has the same origin.
 */
const faviconUrl = computed(() => {
  const preview = urlPreview.value;
  if (!preview?.ok) return "";
  const target = faviconTarget(preview.url);
  return target !== undefined && target === faviconTarget(preview.display)
    ? target
    : "";
});
const scorer = ref<Scorer>();
const scorerState = ref<"loading" | "ready" | "failed">("loading");

const dirty = computed(
  () => JSON.stringify(draft.value) !== JSON.stringify(original),
);
const score = computed(() =>
  scorer.value && draft.value.password !== ""
    ? scorer.value(draft.value.password, [])
    : undefined,
);
const fieldProblems = computed(() => {
  const map = new Map<number, string>();
  for (const p of problems.value)
    if ("index" in p && p.kind.startsWith("field_")) map.set(p.index, p.kind);
  return map;
});
const tagProblems = computed(
  () =>
    new Set(
      problems.value
        .filter((p) => p.kind.startsWith("tag_"))
        .map((p) => ("index" in p ? p.index : -1)),
    ),
);
const expiresLocal = computed({
  get: () => {
    const value = draft.value.expires;
    if (!value) return "";
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  },
  set: (value: string) => {
    draft.value.expires = value === "" ? null : new Date(value).toISOString();
  },
});

function addField(): void {
  draft.value.fields.push({ name: "", value: "", protected: false });
  shownFields.value.add(draft.value.fields.length - 1);
}

function moveField(index: number, step: -1 | 1): void {
  const list = draft.value.fields;
  const target = index + step;
  if (target < 0 || target >= list.length) return;
  const [field] = list.splice(index, 1);
  if (field) list.splice(target, 0, field);
}

async function save(): Promise<void> {
  if (busy.value || uploading.value > 0) return;
  problems.value = validateEntryDraft(draft.value, base ? original : undefined);
  if (problems.value.length > 0) {
    tab.value = problems.value.some((p) => p.kind.startsWith("otp_"))
      ? "totp"
      : problems.value.some(
            (p) => p.kind.startsWith("field_") || p.kind === "too_many_fields",
          )
        ? "fields"
        : problems.value.some((p) => p.kind === "too_many_attachments")
          ? "attachments"
          : "general";
    return;
  }
  busy.value = true;
  error.value = undefined;
  try {
    const engine = vaults.engine();
    let id = props.entryId ?? "";
    let notices: Notice[] = [];
    if (retry) {
      const result = (await retry()) as
        { notices?: Notice[]; id?: string } | undefined;
      notices = result?.notices ?? [];
      id = result?.id ?? id;
    } else if (base) {
      notices = (await engine.saveEntry(base, copyDraft(draft.value))).notices;
    } else {
      id = (
        await engine.createEntry(
          props.vaultId,
          props.groupId,
          copyDraft(draft.value),
          entryId,
        )
      ).id;
    }
    retry = undefined;
    done = true;
    emit("saved", id, notices);
  } catch (caught) {
    error.value = toUiError(caught);
    retry = (caught as Partial<SyncError>).retry;
  } finally {
    busy.value = false;
  }
}

function cancel(): void {
  emit("cancel");
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (
    event.key === "Enter" &&
    target.tagName === "INPUT" &&
    !(target as HTMLInputElement).type.match(/checkbox|radio/)
  ) {
    event.preventDefault();
    void save();
  } else if (event.key === "Escape" && !generator.value) {
    event.preventDefault();
    cancel();
  }
}

function warnUnload(event: BeforeUnloadEvent): void {
  if (dirty.value && !done) event.preventDefault();
}

onBeforeRouteLeave(() => {
  if (!dirty.value || done || session.phase !== "unlocked") return true;
  return window.confirm(t("editor.leave"));
});

onMounted(async () => {
  window.addEventListener("beforeunload", warnUnload);
  document.getElementById(ids.title)?.focus();
  try {
    scorer.value = await loadScorer();
    scorerState.value = "ready";
  } catch {
    scorerState.value = "failed";
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnUnload);
});

const problemText = (kind: string) => t(`editor.problems.${kind}`);
const otpProblem = computed(() => {
  const found = problems.value.find((p) => p.kind.startsWith("otp_"));
  return found ? problemText(found.kind) : undefined;
});
</script>

<template>
  <section
    class="entry-editor"
    data-test="entry-editor"
    :aria-label="entryId ? t('editor.edit') : t('editor.new')"
    @keydown="onKeydown"
  >
    <h2>{{ entryId ? t("editor.edit") : t("editor.new") }}</h2>
    <div class="tabs" role="tablist">
      <button
        v-for="name in [
          'general',
          'totp',
          'fields',
          'attachments',
          'icon',
        ] as const"
        :key="name"
        type="button"
        role="tab"
        :aria-selected="tab === name"
        :class="{ secondary: tab !== name }"
        :data-test="`editor-tab-${name}`"
        @click="tab = name"
      >
        {{ t(`editor.tabs.${name}`) }}
      </button>
    </div>

    <div v-show="tab === 'general'" class="form editor-form">
      <div class="field">
        <label :for="ids.title">{{ t("entry.title") }}</label>
        <input
          :id="ids.title"
          v-model="draft.title"
          autocomplete="off"
          data-test="editor-title"
        />
      </div>
      <div class="field">
        <label :for="ids.username">{{ t("entry.username") }}</label>
        <input
          :id="ids.username"
          v-model="draft.username"
          autocomplete="off"
          data-test="editor-username"
        />
      </div>
      <div class="field">
        <label :for="ids.password">{{ t("entry.password") }}</label>
        <div class="password-row">
          <input
            :id="ids.password"
            v-model="draft.password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            spellcheck="false"
            data-test="editor-password"
          />
          <button
            type="button"
            class="icon-button"
            :aria-pressed="showPassword"
            :aria-label="
              showPassword
                ? t('entry.hide', { field: t('entry.password') })
                : t('entry.show', { field: t('entry.password') })
            "
            data-test="editor-password-show"
            @click="showPassword = !showPassword"
          >
            <AppIcon :ui="showPassword ? 'eyeOff' : 'eye'" />
          </button>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('generator.open')"
            :aria-expanded="generator"
            data-test="editor-generate"
            @click="generator = !generator"
          >
            <AppIcon ui="generate" />
          </button>
        </div>
        <StrengthMeter
          v-if="draft.password !== ''"
          :score="score"
          :state="scorerState"
        />
      </div>
      <GeneratorPanel
        v-if="generator"
        @use="
          (value) => {
            draft.password = value;
            generator = false;
          }
        "
        @close="generator = false"
      />
      <div class="field">
        <label :for="ids.url">{{ t("entry.url") }}</label>
        <input
          :id="ids.url"
          v-model="draft.url"
          autocomplete="off"
          spellcheck="false"
          data-test="editor-url"
        />
      </div>
      <dl v-if="urlPreview" class="url-preview">
        <UrlBlock
          :result="urlPreview"
          :template="draft.url"
          preview
          test="editor-url-preview"
        />
      </dl>
      <div class="field">
        <label :for="ids.expires">{{ t("entry.expires") }}</label>
        <input
          :id="ids.expires"
          v-model="expiresLocal"
          type="datetime-local"
          data-test="editor-expires"
        />
        <p
          v-if="problems.some((p) => p.kind === 'expires_invalid')"
          class="text-error small-text"
        >
          {{ problemText("expires_invalid") }}
        </p>
      </div>
      <TagInput v-model="draft.tags" :invalid="tagProblems" />
      <p
        v-for="p in problems.filter((x) => x.kind.startsWith('tag_'))"
        :key="`${p.kind}-${'index' in p ? p.index : 0}`"
        class="text-error small-text"
        data-test="editor-tag-problem"
      >
        {{ problemText(p.kind) }}
      </p>
      <div class="field">
        <label :for="ids.notes">{{ t("entry.notes") }}</label>
        <textarea
          :id="ids.notes"
          v-model="draft.notes"
          rows="5"
          data-test="editor-notes"
        ></textarea>
      </div>
    </div>

    <div
      v-show="tab === 'fields'"
      class="editor-fields"
      data-test="editor-fields"
    >
      <p
        v-if="problems.some((p) => p.kind === 'too_many_fields')"
        class="text-error"
      >
        {{ problemText("too_many_fields") }}
      </p>
      <div
        v-for="(field, index) in draft.fields"
        :key="index"
        class="field-row"
        data-test="editor-field"
      >
        <input
          v-model="field.name"
          :aria-label="t('editor.fieldName')"
          :placeholder="t('editor.fieldName')"
          maxlength="128"
          data-test="editor-field-name"
        />
        <input
          v-model="field.value"
          :type="
            field.protected && !shownFields.has(index) ? 'password' : 'text'
          "
          autocomplete="off"
          :aria-label="t('editor.fieldValue', { name: field.name })"
          :placeholder="t('editor.fieldValue', { name: '' })"
          data-test="editor-field-value"
        />
        <label class="choice small-text"
          ><input
            v-model="field.protected"
            type="checkbox"
            data-test="editor-field-protected"
          />
          {{ t("editor.protected") }}</label
        >
        <button
          v-if="field.protected"
          type="button"
          class="icon-button"
          :aria-pressed="shownFields.has(index)"
          :aria-label="t('entry.show', { field: field.name })"
          @click="
            shownFields.has(index)
              ? shownFields.delete(index)
              : shownFields.add(index)
          "
        >
          <AppIcon :ui="shownFields.has(index) ? 'eyeOff' : 'eye'" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('editor.fieldUp', { name: field.name })"
          :disabled="index === 0"
          @click="moveField(index, -1)"
        >
          <AppIcon ui="up" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('editor.fieldDown', { name: field.name })"
          :disabled="index === draft.fields.length - 1"
          @click="moveField(index, 1)"
        >
          <AppIcon ui="down" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('editor.fieldRemove', { name: field.name })"
          data-test="editor-field-remove"
          @click="draft.fields.splice(index, 1)"
        >
          <AppIcon ui="delete" />
        </button>
        <p
          v-if="fieldProblems.get(index)"
          class="text-error small-text field-problem"
          data-test="editor-field-problem"
        >
          {{ problemText(fieldProblems.get(index) ?? "") }}
        </p>
      </div>
      <button
        type="button"
        class="secondary small"
        data-test="editor-field-add"
        @click="addField"
      >
        <AppIcon ui="plus" /> {{ t("editor.addField") }}
      </button>
    </div>

    <TotpTab
      v-show="tab === 'totp'"
      v-model="draft.otp"
      :title="draft.title"
      :username="draft.username"
      :problem="otpProblem"
    />

    <AttachmentsTab
      v-show="tab === 'attachments'"
      v-model="draft.attachments"
      :vault-id="vaultId"
      :entry-id="entryId"
      :stored="storedAttachments"
      @uploading="uploading = $event"
    />
    <p
      v-if="problems.some((p) => p.kind === 'too_many_attachments')"
      class="text-error small-text"
    >
      {{ problemText("too_many_attachments") }}
    </p>

    <div v-show="tab === 'icon'">
      <IconPicker
        v-model="draft.icon"
        :label="t('entry.icon')"
        :none-label="t('editor.iconDefault')"
        fallback="key-round"
        :vault-id="vaultId"
        :favicon-url="faviconUrl"
      />
    </div>

    <ErrorNotice :error="error" />
    <div class="actions editor-actions">
      <button
        type="button"
        :disabled="busy || uploading > 0"
        data-test="editor-save"
        @click="save"
      >
        {{ retry ? t("common.retry") : t("common.save") }}
      </button>
      <span
        v-if="uploading > 0"
        class="muted small-text"
        aria-live="polite"
        data-test="editor-uploading"
        >{{ t("attachments.waiting") }}</span
      >
      <button
        type="button"
        class="secondary"
        data-test="editor-cancel"
        @click="cancel"
      >
        {{ t("common.cancel") }}
      </button>
    </div>
  </section>
</template>
