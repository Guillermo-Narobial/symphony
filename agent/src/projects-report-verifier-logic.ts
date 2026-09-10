type ReportServiceValues = Record<string, string | undefined>;

export function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", { day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return values.year + "-" + values.month + "-" + values.day;
}

export function timestampDateKey(timestamp: string | undefined): string | undefined {
  return timestamp?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
}

export function isReportHealthy(values: ReportServiceValues, expectedDate = localDateKey(new Date())): boolean {
  return values.Result === "success" && values.ExecMainStatus === "0" && timestampDateKey(values.ActiveExitTimestamp || values.ExecMainExitTimestamp) === expectedDate;
}
