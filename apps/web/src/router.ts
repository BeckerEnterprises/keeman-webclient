import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from "vue-router";
import { useSessionStore, type Phase } from "./stores/session";

declare module "vue-router" {
  interface RouteMeta {
    /** Phases in which the route may be shown. */
    phases: Phase[];
    /** Uses the full width (main view). */
    wide?: boolean;
    /** What the detail area of the main view shows. */
    mode?: "view" | "edit" | "new";
  }
}

const main = () => import("./views/main/MainView.vue");
const unlocked: Phase[] = ["unlocked"];

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/vaults", meta: { phases: unlocked } },
  {
    path: "/login",
    component: () => import("./views/LoginView.vue"),
    meta: { phases: ["loggedOut"] },
  },
  {
    path: "/register",
    component: () => import("./views/RegisterView.vue"),
    meta: { phases: ["loggedOut", "unlocked"] },
  },
  {
    // Before the finish the account is logged out; afterwards the app
    // follows the phase to the main view.
    path: "/recover",
    component: () => import("./views/RecoverView.vue"),
    meta: { phases: ["loggedOut"] },
  },
  {
    path: "/unlock",
    component: () => import("./views/UnlockView.vue"),
    meta: { phases: ["locked"] },
  },
  { path: "/home", redirect: "/vaults", meta: { phases: unlocked } },
  { path: "/vaults", component: main, meta: { phases: unlocked, wide: true } },
  {
    path: "/vaults/:vaultId/groups/:groupId",
    component: main,
    meta: { phases: unlocked, wide: true },
  },
  {
    path: "/vaults/:vaultId/groups/:groupId/entries/:entryId",
    component: main,
    meta: { phases: unlocked, wide: true, mode: "view" },
  },
  {
    path: "/vaults/:vaultId/groups/:groupId/entries/:entryId/edit",
    component: main,
    meta: { phases: unlocked, wide: true, mode: "edit" },
  },
  {
    path: "/vaults/:vaultId/groups/:groupId/new",
    component: main,
    meta: { phases: unlocked, wide: true, mode: "new" },
  },
  {
    path: "/databases",
    component: () => import("./views/databases/DatabasesView.vue"),
    meta: { phases: unlocked },
  },
  {
    path: "/databases/:vaultId",
    component: () => import("./views/databases/DatabaseView.vue"),
    meta: { phases: unlocked },
  },
  {
    path: "/account",
    component: () => import("./views/account/AccountLayout.vue"),
    meta: { phases: ["unlocked"] },
    children: [
      {
        path: "",
        redirect: "/account/password",
        meta: { phases: ["unlocked"] },
      },
      {
        path: "password",
        component: () => import("./views/account/PasswordView.vue"),
        meta: { phases: ["unlocked"] },
      },
      {
        path: "kdf",
        component: () => import("./views/account/KdfView.vue"),
        meta: { phases: ["unlocked"] },
      },
      {
        path: "recovery-key",
        component: () => import("./views/account/RecoveryKeyView.vue"),
        meta: { phases: ["unlocked"] },
      },
      {
        path: "two-factor",
        component: () => import("./views/account/TwoFactorView.vue"),
        meta: { phases: ["unlocked"] },
      },
      {
        path: "sessions",
        component: () => import("./views/account/SessionsView.vue"),
        meta: { phases: ["unlocked"] },
      },
      {
        path: "contacts",
        component: () => import("./views/account/ContactsView.vue"),
        meta: { phases: ["unlocked"] },
      },
      {
        path: "confirm",
        component: () => import("./views/account/ConfirmationView.vue"),
        meta: { phases: ["unlocked"] },
      },
      {
        path: "settings",
        component: () => import("./views/account/SettingsView.vue"),
        meta: { phases: ["unlocked"] },
      },
      {
        path: "about",
        component: () => import("./views/account/AboutView.vue"),
        meta: { phases: ["unlocked"] },
      },
      {
        path: "delete",
        component: () => import("./views/account/DeleteAccountView.vue"),
        meta: { phases: ["unlocked"] },
      },
    ],
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/vaults",
    meta: { phases: unlocked },
  },
];

/** Where each phase starts. */
export const HOME: Record<Phase, string> = {
  starting: "/vaults",
  fatal: "/vaults",
  loggedOut: "/login",
  locked: "/unlock",
  unlocked: "/vaults",
};

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const session = useSessionStore();
  if (session.phase === "starting" || session.phase === "fatal") return true;
  // The registration flow stays on its page while the recovery key is shown.
  if (to.path === "/register" && session.phase === "unlocked")
    return session.confirmingRecoveryKey ? true : HOME.unlocked;
  if (to.meta.phases.includes(session.phase)) return true;
  if (session.phase === "locked" && to.meta.phases.includes("unlocked"))
    session.returnTo = to.fullPath;
  return HOME[session.phase];
});
