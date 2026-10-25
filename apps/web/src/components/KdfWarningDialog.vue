<script setup lang="ts">
/** Weaker KDF than last seen on this device. */
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useSessionStore } from "../stores/session";

const { t } = useI18n();
const session = useSessionStore();
const router = useRouter();
const dialog = ref<HTMLDialogElement>();

onMounted(() => {
  dialog.value?.showModal();
});

function understood(): void {
  session.acknowledgeKdf();
}

async function raise(): Promise<void> {
  session.kdfWarning = undefined;
  await router.push("/account/kdf");
}
</script>

<template>
  <dialog ref="dialog" class="dialog" data-test="kdf-warning" @cancel.prevent>
    <h2>{{ t("kdf.weakerTitle") }}</h2>
    <p>
      {{
        t("kdf.weakerText", {
          old: session.kdfWarning?.old ?? "",
          new: session.kdfWarning?.new ?? "",
        })
      }}
    </p>
    <div class="actions">
      <button type="button" @click="raise">{{ t("kdf.raise") }}</button>
      <button type="button" class="secondary" @click="understood">
        {{ t("kdf.understood") }}
      </button>
    </div>
  </dialog>
</template>
