<script setup lang="ts">
/**
 * Comparing a member's state code, typed or from a QR image, with this
 * device's chain (of the vault, or of an invitation before accepting). A
 * contradiction is shown next to the own code with the differences marked
 * and counts only after "matches as entered", because a typo looks the
 * same as a fork.
 */
import type {
  MemberView,
  StateCodeView,
  StateComparisonView,
} from "@keeman/core";
import { computed, ref, shallowRef, useId } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import QrTextInput from "../ui/QrTextInput.vue";

const props = defineProps<{
  vaultId: string;
  mode: "vault" | "invitation";
  members?: readonly MemberView[];
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const ids = { partner: useId() };
const input = ref("");
const partner = ref("");
const busy = ref(false);
const error = ref<UiError>();
const result = shallowRef<StateComparisonView>();
const unsaved = ref(false);
const entry = ref<InstanceType<typeof QrTextInput>>();

const partners = computed(() =>
  (props.members ?? []).filter((m) => !m.self && m.state === "active"),
);
const otherName = computed(() => {
  const id = result.value?.otherVault;
  return id ? vaults.vaults.find((v) => v.id === id)?.name : undefined;
});

async function check(text: string): Promise<void> {
  busy.value = true;
  error.value = undefined;
  result.value = undefined;
  unsaved.value = false;
  try {
    const engine = vaults.engine();
    result.value =
      props.mode === "vault"
        ? await engine.compareStateCode(props.vaultId, text, {
            ...(partner.value ? { partner: partner.value } : {}),
          })
        : await engine.compareInvitationCode(props.vaultId, text);
    if (result.value.result === "match") emit("changed");
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function confirm(): Promise<void> {
  const current = result.value;
  if (!current) return;
  busy.value = true;
  error.value = undefined;
  try {
    const { saved } = await vaults
      .engine()
      .confirmStateContradiction(props.vaultId, {
        version: current.entered.version,
        code: current.entered.code,
      });
    unsaved.value = !saved;
    result.value = undefined;
    input.value = "";
    emit("changed");
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

/** The code in groups of four, each character marked where it differs. */
function marked(code: StateCodeView, other: StateCodeView) {
  return {
    version: code.version,
    versionDiffers: code.version !== other.version,
    groups: (code.code.match(/.{1,4}/g) ?? []).map((group, g) =>
      Array.from(group).map((c, i) => ({
        c,
        diff: other.code[g * 4 + i] !== c,
      })),
    ),
  };
}

const sides = computed(() => {
  const current = result.value;
  if (!current?.own) return undefined;
  return {
    own: marked(current.own, current.entered),
    entered: marked(current.entered, current.own),
  };
});

defineExpose({
  onPaste(event: ClipboardEvent): void {
    entry.value?.onPaste(event);
  },
});
</script>

<template>
  <div class="state-compare" data-test="state-compare">
    <p v-if="mode === 'vault' && partners.length > 0" class="field">
      <label :for="ids.partner">{{ t("stateCode.partner") }}</label>
      <select
        :id="ids.partner"
        v-model="partner"
        data-test="state-compare-partner"
      >
        <option value="">{{ t("stateCode.partnerNone") }}</option>
        <option v-for="m in partners" :key="m.userId" :value="m.userId">
          {{ m.email }}
        </option>
      </select>
    </p>
    <QrTextInput
      ref="entry"
      v-model="input"
      :label="t('stateCode.input')"
      :submit="t('stateCode.submit')"
      :busy="busy"
      test="state-compare"
      @submit="check"
      @failure="(caught) => (error = toUiError(caught))"
    />
    <ErrorNotice :error="error" />
    <template v-if="result">
      <p
        v-if="result.result === 'match'"
        class="notice notice-success"
        role="status"
        data-test="state-compare-match"
      >
        {{ t("stateCode.match") }}
      </p>
      <div
        v-else-if="result.result === 'behind'"
        class="notice notice-info"
        data-test="state-compare-behind"
      >
        <p>{{ t("stateCode.behind", { version: result.entered.version }) }}</p>
        <p class="mono secret-groups">{{ result.own?.display }}</p>
      </div>
      <div
        v-else-if="result.result === 'withheld'"
        class="notice notice-warning"
        data-test="state-compare-withheld"
      >
        <p>{{ t("stateCode.withheld") }}</p>
        <p v-if="result.own" class="mono secret-groups">
          {{ result.own.display }}
        </p>
      </div>
      <p
        v-else-if="result.result === 'other_vault'"
        class="notice notice-info"
        data-test="state-compare-other"
      >
        {{
          otherName
            ? t("stateCode.otherVaultNamed", { name: otherName })
            : t("stateCode.otherVault")
        }}
      </p>
      <p
        v-else-if="result.result === 'unavailable'"
        class="notice notice-info"
        data-test="state-compare-unavailable"
      >
        {{ t("stateCode.unavailable") }}
      </p>
      <div
        v-else
        class="notice notice-error"
        role="alert"
        data-test="state-compare-contradiction"
      >
        <p>
          {{
            t(
              result.result === "mismatch"
                ? "stateCode.mismatch"
                : "stateCode.missing",
              { version: result.entered.version },
            )
          }}
        </p>
        <div v-if="sides" class="state-codes">
          <div v-for="side in ['own', 'entered'] as const" :key="side">
            <h4>{{ t(`stateCode.${side}`) }}</h4>
            <p class="mono secret-groups" :data-test="`state-compare-${side}`">
              <span :class="{ 'code-diff': sides[side].versionDiffers }"
                >v{{ sides[side].version }}</span
              >
              ·
              <template v-for="(group, gi) in sides[side].groups" :key="gi"
                ><span
                  v-for="(ch, ci) in group"
                  :key="ci"
                  :class="{ 'code-diff': ch.diff }"
                  >{{ ch.c }}</span
                >{{ " " }}</template
              >
            </p>
          </div>
        </div>
        <p>{{ t("stateCode.checkTypo") }}</p>
        <div class="actions">
          <button
            type="button"
            class="danger"
            :disabled="busy"
            data-test="state-compare-confirm"
            @click="confirm"
          >
            {{ t("stateCode.confirm") }}
          </button>
          <button
            type="button"
            class="secondary"
            :disabled="busy"
            data-test="state-compare-correct"
            @click="result = undefined"
          >
            {{ t("stateCode.correct") }}
          </button>
        </div>
      </div>
    </template>
    <p
      v-if="unsaved"
      class="notice notice-warning"
      data-test="state-compare-unsaved"
    >
      {{ t("stateCode.unsaved") }}
    </p>
  </div>
</template>
