import { initCrypto } from "@keeman/core";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { ConfigError, loadConfig } from "./config";
import { i18n, initialLocale, setLocale } from "./i18n";
import { HOME, router } from "./router";
import { createServices } from "./services";
import { useSessionStore } from "./stores/session";
import "./styles/main.css";
import { initTheme } from "./theme";

async function main(): Promise<void> {
  setLocale(initialLocale(), false);
  initTheme();
  const pinia = createPinia();
  const app = createApp(App).use(pinia).use(i18n).use(router);
  const session = useSessionStore(pinia);
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    session.preloadFailed = true;
  });
  app.mount("#app");

  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    session.fail(error instanceof ConfigError ? "config" : "unreachable");
    return;
  }
  try {
    await initCrypto();
  } catch {
    session.fail("crypto");
    return;
  }
  const { api, account, tabs } = createServices(config);
  tabs.listen({
    token: (token) => {
      if (session.phase === "locked" || session.phase === "unlocked")
        api.setAccessToken(token);
    },
    lock: () => {
      session.lock(false);
    },
    logout: () => {
      session.loggedOutElsewhere();
    },
    session: (userId) => {
      if (session.phase === "loggedOut") {
        void session.start();
      } else if (userId !== account.userId) {
        // Another account signed in in this browser profile.
        session.lock(false);
        void session.start();
      }
    },
  });
  await router.isReady();
  await session.start();
  const current = router.currentRoute.value;
  if (!current.meta.phases.includes(session.phase)) {
    if (session.phase === "locked" && current.meta.phases.includes("unlocked"))
      session.returnTo = current.fullPath;
    await router.replace(HOME[session.phase]);
  }
}

void main();
