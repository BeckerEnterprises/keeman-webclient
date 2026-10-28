<script setup lang="ts">
/**
 * The state code of a database: the code of its checked owner list with a
 * QR code, when it last matched another member's, and "check a member's
 * code". Without a checked list there is no code, only a hint.
 */
import type { MemberView, VaultView } from "@keeman/core";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { formatDate } from "../../format";
import { drawQrCode } from "../../qr-code";
import StateCompareDialog from "./StateCompareDialog.vue";

const props = defineProps<{
  vault: VaultView;
  members: readonly MemberView[];
}>();
const { t } = useI18n();
const qr = ref<HTMLCanvasElement>();
const comparing = ref(false);

const roles = computed(() => props.vault.roles);
const hint = computed(() => {
  if (roles.value.code) return undefined;
  switch (roles.value.status) {
    case "none":
      return t("stateCode.none");
    case "unanchored":
      return t("stateCode.unanchored");
    case "unsupported":
      return t("stateCode.unsupported");
    case "unavailable":
      return t("stateCode.listUnavailable");
    default:
      return t("stateCode.warning");
  }
});
const last = computed(() => {
  const match = roles.value.lastMatch;
  if (!match) return undefined;
  // Named by the contact only if verified with the member's keys.
  const partner = match.partner;
  const plain = partner
    ? (partner.email ?? t("entry.member", { id: partner.userId.slice(0, 8) }))
    : undefined;
  const name =
    partner && plain && !partner.verified
      ? t("vaults.roles.ownerUnverified", { name: plain })
      : plain;
  const date = formatDate(match.at);
  return {
    text: name
      ? t("stateCode.lastMatch", { date, name, version: match.version })
      : t("stateCode.lastMatchAnon", { date, version: match.version }),
    changed: (roles.value.code?.version ?? 0) > match.version,
  };
});

async function draw(): Promise<void> {
  await nextTick();
  const code = roles.value.code;
  if (qr.value && code) await drawQrCode(qr.value, code.uri, 3);
}

watch(
  () => roles.value.code?.uri,
  () => void draw(),
);
onMounted(() => void draw());
</script>

<template>
  <section class="state-code" data-test="state-code-section">
    <h3>{{ t("stateCode.title") }}</h3>
    <template v-if="roles.code">
      <p class="muted">{{ t("stateCode.intro") }}</p>
      <p class="mono secret-groups" data-test="state-code">
        {{ roles.code.display }}
      </p>
      <canvas
        ref="qr"
        class="qr-code"
        role="img"
        :aria-label="t('stateCode.qr')"
        data-test="state-code-qr"
      />
      <p v-if="last" class="muted" data-test="state-code-last">
        {{ last.text }}
        <template v-if="last.changed">{{
          t("stateCode.changedSince")
        }}</template>
      </p>
      <p v-else class="muted" data-test="state-code-never">
        {{ t("stateCode.never") }}
      </p>
      <button
        type="button"
        class="secondary"
        data-test="state-code-check"
        @click="comparing = true"
      >
        {{ t("stateCode.check") }}
      </button>
    </template>
    <p v-else class="muted" data-test="state-code-none">{{ hint }}</p>
    <StateCompareDialog
      v-if="comparing"
      :vault-id="vault.id"
      :members="members"
      @close="comparing = false"
    />
  </section>
</template>
