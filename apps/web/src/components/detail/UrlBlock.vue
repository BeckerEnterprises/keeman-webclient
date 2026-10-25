<script setup lang="ts">
/**
 * A resolved URL: secret parts masked, a warning when a
 * secret goes into the URL, and messages for errors, cycles and schemes.
 * In the detail with "Open" (allowed schemes only) and "Copy" (the
 * resolved URL, also for schemes that may not be opened); in the editor a
 * preview without buttons. Everything is plain text.
 */
import type { ResolvedUrl } from "@keeman/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { copySecret } from "../../clipboard";
import { openUrl, urlProblem } from "../../open-url";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import AppIcon from "../ui/AppIcon";

const props = defineProps<{
  result: ResolvedUrl;
  /** The stored template, shown when it cannot be resolved. */
  template: string;
  preview?: boolean;
  test: string;
}>();
const { t } = useI18n();
const session = useSessionStore();
const problem = computed(() =>
  urlProblem(props.result, session.settings.allowedUrlSchemes),
);
const shown = computed(() =>
  props.result.ok ? props.result.display : props.template,
);

function open(): void {
  const refused = openUrl(props.result, session.settings.allowedUrlSchemes);
  if (refused) useToastStore().show(`url.problem.${refused}`);
}

async function copy(): Promise<void> {
  if (props.result.ok)
    await copySecret(props.result.url, session.settings.clipboardClearSeconds);
}
</script>

<template>
  <div class="secret-value url-block" :data-test="test">
    <dt>{{ preview ? t("url.preview") : t("entry.url") }}</dt>
    <dd>
      <span class="value" :data-test="`${test}-value`">{{ shown }}</span>
      <template v-if="!preview">
        <button
          type="button"
          class="icon-button"
          :aria-label="t('url.open')"
          :disabled="problem !== undefined"
          :data-test="`${test}-open`"
          @click="open"
        >
          <AppIcon ui="open" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('url.copy')"
          :disabled="!result.ok"
          :data-test="`${test}-copy`"
          @click="copy"
        >
          <AppIcon ui="copy" />
        </button>
      </template>
    </dd>
    <dd
      v-if="result.ok && result.secret"
      class="url-note text-warning"
      :data-test="`${test}-secret`"
    >
      <AppIcon ui="warning" /> {{ t("url.secret") }}
    </dd>
    <dd
      v-if="problem"
      class="url-note text-error"
      :data-test="`${test}-problem`"
    >
      <AppIcon ui="warning" /> {{ t(`url.problem.${problem}`) }}
    </dd>
    <dd
      v-else-if="result.warnings.includes('missing')"
      class="url-note muted"
      :data-test="`${test}-missing`"
    >
      {{ t("url.missing") }}
    </dd>
  </div>
</template>
