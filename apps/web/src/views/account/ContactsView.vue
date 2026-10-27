<script setup lang="ts">
/**
 * Contacts: the own fingerprint, verifying an account by its
 * e-mail address with the fingerprint dialog, the list with conflicts.
 */
import type { Candidate, ContactView } from "@keeman/core";
import { shallowRef, ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import ConfirmDialog from "../../components/dialogs/ConfirmDialog.vue";
import FingerprintDialog from "../../components/sharing/FingerprintDialog.vue";
import { toUiError, type UiError } from "../../errors";
import { useSessionStore } from "../../stores/session";
import { useVaultsStore } from "../../stores/vaults";

const { t, locale } = useI18n();
const session = useSessionStore();
const vaults = useVaultsStore();
const email = ref("");
const busy = ref(false);
const error = ref<UiError>();
// Candidates stay unwrapped: the core knows only its own objects.
const candidate = shallowRef<Candidate>();
const removing = shallowRef<ContactView>();

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale.value, { dateStyle: "medium" }).format(
        date,
      );
}

async function check(address: string): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    const found = await vaults.engine().lookupUser(address);
    if (found.self) {
      error.value = { key: "contacts_self" };
      return;
    }
    candidate.value = found;
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  const contact = removing.value;
  if (!contact) return;
  busy.value = true;
  try {
    await session.removeContact(contact.userId);
    removing.value = undefined;
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

function verified(): void {
  candidate.value = undefined;
  email.value = "";
}
</script>

<template>
  <section data-test="contacts">
    <h2>{{ t("contacts.title") }}</h2>
    <p>{{ t("contacts.intro") }}</p>
    <h3>{{ t("contacts.ownFingerprint") }}</h3>
    <p class="fingerprint mono" data-test="own-fingerprint">
      {{ session.ownFingerprint }}
    </p>
    <p class="muted">{{ t("contacts.ownHint") }}</p>

    <p v-if="!session.contactsWritable" class="notice notice-warning">
      {{ t("contacts.readOnly") }}
    </p>
    <form class="inline-form" novalidate @submit.prevent="check(email.trim())">
      <label>
        {{ t("contacts.email") }}
        <input
          v-model="email"
          type="email"
          autocomplete="off"
          data-test="contacts-email"
        />
      </label>
      <button
        type="submit"
        :disabled="busy || email.trim() === '' || !session.contactsWritable"
        data-test="contacts-check"
      >
        {{ t("contacts.checkSubmit") }}
      </button>
    </form>
    <ErrorNotice :error="error" />

    <p v-if="session.contacts.length === 0" class="muted">
      {{ t("contacts.empty") }}
    </p>
    <ul v-else class="contact-list">
      <li
        v-for="contact in session.contacts"
        :key="contact.userId"
        data-test="contact"
      >
        <div>
          <strong data-test="contact-email">{{ contact.email }}</strong>
          <span
            v-if="contact.outdated && !contact.conflict"
            class="tag"
            data-test="contact-outdated"
            >{{ t("contacts.outdated") }}</span
          >
          <span
            v-if="contact.conflict"
            class="tag tag-danger"
            data-test="contact-conflict"
            >{{ t("contacts.conflict") }}</span
          >
        </div>
        <p class="fingerprint mono" data-test="contact-fingerprint">
          {{ contact.fingerprint }}
        </p>
        <p class="muted small-text">
          {{
            t("contacts.verifiedAt", { date: formatDate(contact.verifiedAt) })
          }}
        </p>
        <div class="actions">
          <button
            type="button"
            class="secondary small"
            :disabled="busy || !session.contactsWritable"
            data-test="contact-recheck"
            @click="check(contact.email)"
          >
            {{ t("contacts.recheck") }}
          </button>
          <button
            type="button"
            class="secondary small"
            :disabled="busy || !session.contactsWritable"
            data-test="contact-remove"
            @click="removing = contact"
          >
            {{ t("contacts.remove") }}
          </button>
        </div>
      </li>
    </ul>

    <FingerprintDialog
      v-if="candidate"
      :candidate="candidate"
      purpose="contact"
      @verified="verified"
      @close="candidate = undefined"
    />
    <ConfirmDialog
      v-if="removing"
      :title="t('contacts.removeTitle')"
      :text="t('contacts.removeText', { email: removing.email })"
      :confirm="t('contacts.remove')"
      danger
      :busy="busy"
      @confirm="remove"
      @close="removing = undefined"
    />
  </section>
</template>
