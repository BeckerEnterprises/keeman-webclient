<script setup lang="ts">
import type { SessionInfo } from "@keeman/core";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import { toUiError, type UiError } from "../../errors";
import { useServices } from "../../services";
import { useSessionStore } from "../../stores/session";

const { t, locale } = useI18n();
const session = useSessionStore();
const sessions = ref<SessionInfo[]>([]);
const busy = ref(false);
const error = ref<UiError>();

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale.value, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    await action();
    sessions.value = await useServices().account.sessions();
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function revoke(item: SessionInfo): Promise<void> {
  if (item.current) {
    await session.logout().catch(() => undefined);
    return;
  }
  await run(() => useServices().account.revokeSession(item.id));
}

onMounted(() => {
  void run(() => Promise.resolve());
});
</script>

<template>
  <section data-test="sessions">
    <h2>{{ t("sessions.title") }}</h2>
    <p>{{ t("sessions.intro") }}</p>
    <ErrorNotice :error="error" />
    <ul class="session-list">
      <li v-for="item in sessions" :key="item.id" data-test="session">
        <div>
          <strong>{{ item.device_name }}</strong>
          <span v-if="item.current" class="tag">{{
            t("sessions.current")
          }}</span>
        </div>
        <dl class="session-meta">
          <dt>{{ t("sessions.created") }}</dt>
          <dd>{{ formatTime(item.created) }}</dd>
          <dt>{{ t("sessions.lastSeen") }}</dt>
          <dd>{{ formatTime(item.last_seen) }}</dd>
          <dt>{{ t("sessions.ip") }}</dt>
          <dd>{{ item.ip_hint ?? t("sessions.unknownIp") }}</dd>
        </dl>
        <button
          type="button"
          class="secondary small"
          :disabled="busy"
          data-test="session-revoke"
          @click="revoke(item)"
        >
          {{ t("sessions.revoke") }}
        </button>
      </li>
    </ul>
    <p v-if="sessions.length === 1">{{ t("sessions.empty") }}</p>
    <button
      v-if="sessions.length > 1"
      type="button"
      :disabled="busy"
      data-test="sessions-revoke-others"
      @click="run(() => useServices().account.revokeOtherSessions())"
    >
      {{ t("sessions.revokeOthers") }}
    </button>
  </section>
</template>
