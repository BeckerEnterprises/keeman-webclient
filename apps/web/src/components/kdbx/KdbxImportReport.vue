<script setup lang="ts">
/**
 * The report of a KDBX import: counts, skipped and shortened
 * data, renamed fields and what is not taken over. Titles, paths and field
 * names only, never values; plain text.
 */
import type { KdbxImportReport, KdbxReportItem } from "@keeman/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  report: KdbxImportReport;
  /** Before the import: the same report as a preview. */
  preview?: boolean;
}>();
const { t } = useI18n();

function where(item: KdbxReportItem): string {
  const title =
    "title" in item && item.title !== null
      ? item.title || t("entry.untitled")
      : undefined;
  const parts = [...item.path, ...(title === undefined ? [] : [title])];
  return parts.length > 0 ? parts.join(" › ") : t("kdbx.report.top");
}

function line(item: KdbxReportItem): string {
  const at = where(item);
  switch (item.kind) {
    case "field_renamed":
      return t("kdbx.report.field_renamed", {
        where: at,
        from: item.from,
        to: item.to,
      });
    case "fields_skipped":
      return t("kdbx.report.fields_skipped", {
        where: at,
        names: item.names.join(", "),
      });
    case "otp_unconverted":
      return t("kdbx.report.otp_unconverted", {
        where: at,
        names: item.names.join(", "),
      });
    case "otp_kept":
      return t("kdbx.report.otp_kept", {
        where: at,
        problem: t(`kdbx.otpProblem.${item.problem}`),
      });
    case "history_trimmed":
      return t("kdbx.report.history_trimmed", {
        where: at,
        count: item.dropped,
      });
    case "attachment_too_large":
      return t("kdbx.report.attachment_too_large", {
        where: at,
        name: item.name,
      });
    case "attachments_skipped":
      return t("kdbx.report.attachments_skipped", {
        where: at,
        names: item.names.join(", "),
      });
    case "custom_icon_unreadable":
      return t(
        item.title === null
          ? "kdbx.report.custom_icon_unreadable_group"
          : "kdbx.report.custom_icon_unreadable",
        { where: at },
      );
    default:
      return t(`kdbx.report.${item.kind}`, { where: at });
  }
}

const lines = computed(() => props.report.items.map(line));
const ignored = computed(() =>
  Object.entries(props.report.ignored)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => t(`kdbx.ignored.${kind}`, { count })),
);
</script>

<template>
  <div class="kdbx-report" data-test="kdbx-report">
    <p data-test="kdbx-report-counts">
      {{
        t(preview ? "kdbx.report.willImport" : "kdbx.report.imported", {
          groups: report.groups,
          entries: report.entries,
        })
      }}
    </p>
    <ul class="plain-list">
      <li v-if="report.skippedBin" data-test="kdbx-report-bin">
        {{
          t("kdbx.report.skippedBin", {
            groups: report.skippedBin.groups,
            entries: report.skippedBin.entries,
          })
        }}
      </li>
      <li v-if="report.attachments > 0" data-test="kdbx-report-attachments">
        {{
          t(preview ? "kdbx.report.willUpload" : "kdbx.report.uploaded", {
            count: report.attachments,
          })
        }}
      </li>
      <li v-if="report.icons > 0" data-test="kdbx-report-icons">
        {{
          t(preview ? "kdbx.report.willAddIcons" : "kdbx.report.addedIcons", {
            count: report.icons,
          })
        }}
      </li>
      <li v-if="report.newIds > 0">
        {{ t("kdbx.report.newIds", { count: report.newIds }) }}
      </li>
      <li v-if="report.conflicts > 0" data-test="kdbx-report-conflicts">
        {{ t("kdbx.report.conflicts", { count: report.conflicts }) }}
      </li>
      <li v-if="report.extraRoots > 0">
        {{ t("kdbx.report.extraRoots", { count: report.extraRoots }) }}
      </li>
      <li v-if="report.descriptionTruncated">
        {{ t("kdbx.report.descriptionTruncated") }}
      </li>
    </ul>
    <template v-if="lines.length > 0">
      <h3>{{ t("kdbx.report.notes") }}</h3>
      <ul class="plain-list kdbx-report-items" data-test="kdbx-report-items">
        <li v-for="(text, index) in lines" :key="index">{{ text }}</li>
      </ul>
    </template>
    <h3>{{ t("kdbx.report.notTaken") }}</h3>
    <ul class="plain-list">
      <li v-for="text in ignored" :key="text">{{ text }}</li>
      <li>{{ t("kdbx.report.alwaysIgnored") }}</li>
    </ul>
  </div>
</template>
