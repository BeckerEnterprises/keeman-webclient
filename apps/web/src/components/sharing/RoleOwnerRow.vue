<script setup lang="ts">
/** One owner of a signed list: the name and its status, on its own line. */
import type { VaultView } from "@keeman/core";
import { useI18n } from "vue-i18n";

defineProps<{
  owner: VaultView["roles"]["owners"][number];
  name: string;
}>();
const { t } = useI18n();
</script>

<template>
  <div class="member-row" data-test="role-owner">
    <strong>{{ name }}</strong>
    <span
      class="tag"
      :class="{ 'tag-ok': owner.verified }"
      data-test="role-owner-status"
      >{{
        owner.verified
          ? t("invitationDialog.verified")
          : t("invitationDialog.unverified")
      }}</span
    >
    <span
      v-if="owner.keysDiffer"
      class="tag tag-danger"
      data-test="role-owner-keys-differ"
      >{{ t("invitationDialog.keysDiffer") }}</span
    >
  </div>
</template>
