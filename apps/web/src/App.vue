<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppFooter from "./components/AppFooter.vue";
import AppHeader from "./components/AppHeader.vue";
import BannerList from "./components/BannerList.vue";
import ConfirmationRequestDialog from "./components/ConfirmationRequestDialog.vue";
import KdfWarningDialog from "./components/KdfWarningDialog.vue";
import ToastHost from "./components/ui/ToastHost.vue";
import { HOME } from "./router";
import { useServices } from "./services";
import { dispatchShortcut, registerShortcut } from "./shortcuts";
import { useConfirmationStore } from "./stores/confirmation";
import { useSessionStore } from "./stores/session";
import StatusView from "./views/StatusView.vue";

const session = useSessionStore();
const router = useRouter();
const route = useRoute();

// Follow phase changes (auto-lock, other tabs, expiry) with the route.
watch(
  () => session.phase,
  async (phase, previous) => {
    if (phase === "starting" || phase === "fatal") return;
    const current = router.currentRoute.value;
    if (
      phase === "locked" &&
      previous === "unlocked" &&
      current.meta.phases.includes("unlocked")
    )
      session.returnTo = current.fullPath;
    if (phase === "unlocked" && session.confirmingRecoveryKey) return;
    let target = HOME[phase];
    if (phase === "unlocked" && session.returnTo) {
      target = session.returnTo;
      session.returnTo = undefined;
    } else if (
      current.meta.phases.includes(phase) &&
      !(phase === "unlocked" && current.path === "/register")
    ) {
      return;
    }
    await router.replace(target);
  },
);

/** Shift+L locks, only outside of input fields. */
registerShortcut({
  scope: "global",
  combos: [{ key: "l", shift: true }],
  label: "shortcuts.lock",
  run: () => {
    if (session.phase === "unlocked") session.lock();
  },
});

/** One dispatcher for all shortcuts. */
function onKeydown(event: KeyboardEvent): void {
  if (session.phase === "unlocked") dispatchShortcut(event);
}

/** Back online or visible again: reconnect and sync now. */
function onWake(): void {
  if (session.phase === "unlocked" && document.visibilityState === "visible") {
    useServices().account.sync?.nudge();
    void useConfirmationStore().refreshIncoming();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("online", onWake);
  document.addEventListener("visibilitychange", onWake);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("online", onWake);
  document.removeEventListener("visibilitychange", onWake);
});
</script>

<template>
  <StatusView
    v-if="session.phase === 'starting' || session.phase === 'fatal'"
  />
  <div v-else class="layout" :class="{ 'layout-fixed': route.meta.wide }">
    <AppHeader
      v-if="session.phase === 'unlocked' && !session.confirmingRecoveryKey"
    />
    <main id="main" class="content" :class="{ wide: route.meta.wide }">
      <BannerList />
      <RouterView />
    </main>
    <AppFooter />
    <KdfWarningDialog v-if="session.kdfWarning" />
    <ConfirmationRequestDialog
      v-if="session.phase === 'unlocked' && session.confirmation"
    />
    <ToastHost />
  </div>
</template>
