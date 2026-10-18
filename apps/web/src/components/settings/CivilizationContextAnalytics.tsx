import {
  type CivilizationContextAnalyticsBucket,
  type CivilizationContextAnalyticsBucketSize,
  type CivilizationContextAnalyticsCompositionTotals,
  type CivilizationContextAnalyticsHistogram,
  type CivilizationContextInspectionOutcome,
  type CivilizationContextSuppressionReason,
  type EnvironmentId,
  type ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  type CivilizationContextAnalyticsFilters,
  type CivilizationContextInspectionFilters,
  useCivilizationContextAnalytics,
} from "../../state/civilization";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { SettingsSection } from "./settingsLayout";

interface CivilizationContextAnalyticsProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly targetLabel: string;
  readonly onInspect: (filters: CivilizationContextInspectionFilters) => void;
}

type PresetId = "24h" | "2d" | "7d" | "30d";
type OutcomeFilter = CivilizationContextInspectionOutcome | "all";
type SuppressionFilter = CivilizationContextSuppressionReason | "all";

interface PresetDefinition {
  readonly label: string;
  readonly durationMs: number;
  readonly bucket: CivilizationContextAnalyticsBucketSize;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PRESETS: Readonly<Record<PresetId, PresetDefinition>> = {
  "24h": { label: "24 hours", durationMs: DAY_MS, bucket: "hour" },
  "2d": { label: "2 days", durationMs: 2 * DAY_MS, bucket: "hour" },
  "7d": { label: "7 days", durationMs: 7 * DAY_MS, bucket: "day" },
  "30d": { label: "30 days", durationMs: 30 * DAY_MS, bucket: "day" },
};

const SUPPRESSION_OPTIONS: ReadonlyArray<{
  readonly value: CivilizationContextSuppressionReason;
  readonly label: string;
}> = [
  { value: "participation_disabled", label: "Participation disabled" },
  { value: "emergency_off", label: "Emergency off" },
  { value: "citizen_not_adopted", label: "Citizen not adopted" },
  { value: "citizen_deleted", label: "Citizen deleted" },
  { value: "citizen_closed", label: "Citizen closed" },
  { value: "observed_agent_read_only", label: "Observed agent read only" },
  { value: "provider_unsupported", label: "Provider unsupported" },
  { value: "provider_continuation", label: "Provider continuation" },
  { value: "provider_command", label: "Provider command" },
  { value: "claude_provider_continuation", label: "Claude continuation" },
  { value: "claude_slash_command", label: "Claude slash command" },
  { value: "packet_budget_zero", label: "Packet budget zero" },
  { value: "packet_budget_too_small", label: "Packet budget too small" },
];

const EMPTY_HISTOGRAM: CivilizationContextAnalyticsHistogram = {
  zero: 0,
  low: 0,
  medium: 0,
  high: 0,
  over: 0,
};

const EMPTY_COMPOSITION: CivilizationContextAnalyticsCompositionTotals = {
  candidates: 0,
  included: 0,
  omitted: 0,
};

const presetRange = (presetId: PresetId, now = Date.now()) => {
  const preset = PRESETS[presetId];
  return {
    bucket: preset.bucket,
    from: new Date(now - preset.durationMs).toISOString(),
    to: new Date(now).toISOString(),
  } satisfies Pick<CivilizationContextAnalyticsFilters, "bucket" | "from" | "to">;
};

const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};

const sumHistogram = (
  buckets: ReadonlyArray<CivilizationContextAnalyticsBucket>,
  select: (bucket: CivilizationContextAnalyticsBucket) => CivilizationContextAnalyticsHistogram,
): CivilizationContextAnalyticsHistogram =>
  buckets.reduce<CivilizationContextAnalyticsHistogram>((total, bucket) => {
    const histogram = select(bucket);
    return {
      zero: total.zero + histogram.zero,
      low: total.low + histogram.low,
      medium: total.medium + histogram.medium,
      high: total.high + histogram.high,
      over: total.over + histogram.over,
    };
  }, EMPTY_HISTOGRAM);

const sumComposition = (
  buckets: ReadonlyArray<CivilizationContextAnalyticsBucket>,
  select: (
    bucket: CivilizationContextAnalyticsBucket,
  ) => CivilizationContextAnalyticsCompositionTotals,
): CivilizationContextAnalyticsCompositionTotals =>
  buckets.reduce<CivilizationContextAnalyticsCompositionTotals>((total, bucket) => {
    const composition = select(bucket);
    return {
      candidates: total.candidates + composition.candidates,
      included: total.included + composition.included,
      omitted: total.omitted + composition.omitted,
    };
  }, EMPTY_COMPOSITION);

function SummaryCard({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-md border border-border/70 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-medium tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function HistogramView({
  title,
  histogram,
  labels,
}: {
  readonly title: string;
  readonly histogram: CivilizationContextAnalyticsHistogram;
  readonly labels: ReadonlyArray<readonly [keyof CivilizationContextAnalyticsHistogram, string]>;
}) {
  return (
    <section className="space-y-2 rounded-md border border-border/70 p-3" aria-label={title}>
      <h4 className="text-sm font-medium">{title}</h4>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {labels.map(([key, label]) => (
          <div key={key}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium tabular-nums">{histogram[key]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CompositionView({
  title,
  totals,
}: {
  readonly title: string;
  readonly totals: CivilizationContextAnalyticsCompositionTotals;
}) {
  return (
    <div className="rounded-md border border-border/70 p-3">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        <span className="tabular-nums">{totals.included}</span> included of{" "}
        <span className="tabular-nums">{totals.candidates}</span> candidates ·{" "}
        <span className="tabular-nums">{totals.omitted}</span> omitted
      </div>
    </div>
  );
}

export function CivilizationContextAnalytics({
  environmentId,
  projectId,
  targetLabel,
  onInspect,
}: CivilizationContextAnalyticsProps) {
  const [presetId, setPresetId] = useState<PresetId>("24h");
  const [range, setRange] = useState(() => presetRange("24h"));
  const [providerDraft, setProviderDraft] = useState("");
  const [threadDraft, setThreadDraft] = useState("");
  const [outcomeDraft, setOutcomeDraft] = useState<OutcomeFilter>("all");
  const [suppressionDraft, setSuppressionDraft] = useState<SuppressionFilter>("all");
  const [metadataFilters, setMetadataFilters] = useState<
    Omit<CivilizationContextAnalyticsFilters, "bucket" | "from" | "to">
  >({});

  const filters: CivilizationContextAnalyticsFilters = { ...range, ...metadataFilters };
  const analytics = useCivilizationContextAnalytics(environmentId, projectId, filters);
  const buckets = analytics.data?.buckets ?? [];
  const totalInspections = buckets.reduce((sum, bucket) => sum + bucket.totalInspections, 0);
  const totalSkipped = buckets.reduce((sum, bucket) => sum + bucket.outcomes.skipped, 0);
  const totalBuilt = buckets.reduce((sum, bucket) => sum + bucket.outcomes.built, 0);
  const totalAccepted = buckets.reduce(
    (sum, bucket) => sum + bucket.outcomes.providerStartAccepted,
    0,
  );
  const totalFailed = buckets.reduce((sum, bucket) => sum + bucket.outcomes.providerStartFailed, 0);
  const suppressionTotals = new Map<CivilizationContextSuppressionReason, number>();
  for (const bucket of buckets) {
    for (const entry of bucket.suppressions) {
      suppressionTotals.set(entry.reason, (suppressionTotals.get(entry.reason) ?? 0) + entry.count);
    }
  }
  const packetSize = sumHistogram(buckets, (bucket) => bucket.packetSize);
  const budgetUtilization = sumHistogram(buckets, (bucket) => bucket.budgetUtilization);
  const roster = sumComposition(buckets, (bucket) => bucket.roster);
  const notes = sumComposition(buckets, (bucket) => bucket.notes);
  const inbox = sumComposition(buckets, (bucket) => bucket.inbox);

  const choosePreset = (nextPresetId: PresetId) => {
    setPresetId(nextPresetId);
    setRange(presetRange(nextPresetId));
  };

  const applyFilters = () => {
    const provider = providerDraft.trim();
    const thread = threadDraft.trim();
    setMetadataFilters({
      ...(provider === "" ? {} : { providerInstanceId: ProviderInstanceId.make(provider) }),
      ...(thread === "" ? {} : { threadId: ThreadId.make(thread) }),
      ...(outcomeDraft === "all" ? {} : { outcome: outcomeDraft }),
      ...(suppressionDraft === "all" ? {} : { suppressionReason: suppressionDraft }),
    });
  };

  const clearFilters = () => {
    setProviderDraft("");
    setThreadDraft("");
    setOutcomeDraft("all");
    setSuppressionDraft("all");
    setMetadataFilters({});
  };

  const inspectMatchingRecords = () => {
    if (analytics.data === null) return;
    onInspect({
      from: analytics.data.from,
      to: analytics.data.to,
      ...(filters.providerInstanceId === undefined
        ? {}
        : { providerInstanceId: filters.providerInstanceId }),
      ...(filters.threadId === undefined ? {} : { threadId: filters.threadId }),
      ...(filters.outcome === undefined ? {} : { outcome: filters.outcome }),
      ...(filters.suppressionReason === undefined
        ? {}
        : { suppressionReason: filters.suppressionReason }),
    });
  };

  return (
    <SettingsSection title="Context analytics" id="civilization-context-analytics">
      <div className="space-y-4 px-1 py-2">
        <p className="text-sm text-muted-foreground">
          Metadata-only context trends for {targetLabel}. Time ranges and bucket sizes are bounded
          to at most 49 buckets.
        </p>

        <div className="flex flex-wrap gap-2" aria-label="Context analytics time range">
          {(Object.entries(PRESETS) as ReadonlyArray<[PresetId, PresetDefinition]>).map(
            ([id, preset]) => (
              <Button
                key={id}
                size="sm"
                variant={presetId === id ? "secondary" : "outline"}
                aria-pressed={presetId === id}
                onClick={() => choosePreset(id)}
              >
                {preset.label} · {preset.bucket}
              </Button>
            ),
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            aria-label="Context analytics provider"
            placeholder="Provider instance ID"
            value={providerDraft}
            onChange={(event) => setProviderDraft(event.currentTarget.value)}
          />
          <Input
            aria-label="Context analytics thread"
            placeholder="Thread ID"
            value={threadDraft}
            onChange={(event) => setThreadDraft(event.currentTarget.value)}
          />
          <Select
            value={outcomeDraft}
            onValueChange={(value) => setOutcomeDraft(value as OutcomeFilter)}
          >
            <SelectTrigger aria-label="Context analytics outcome">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All outcomes</SelectItem>
              <SelectItem value="skipped">Skipped</SelectItem>
              <SelectItem value="built">Built</SelectItem>
              <SelectItem value="provider_start_accepted">Adapter handoff accepted</SelectItem>
              <SelectItem value="provider_start_failed">Adapter handoff failed</SelectItem>
            </SelectPopup>
          </Select>
          <Select
            value={suppressionDraft}
            onValueChange={(value) => setSuppressionDraft(value as SuppressionFilter)}
          >
            <SelectTrigger aria-label="Context analytics suppression">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All suppression reasons</SelectItem>
              {SUPPRESSION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={applyFilters}>
            Apply filters
          </Button>
          <Button size="sm" variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
          <Button size="sm" variant="ghost" onClick={() => analytics.refresh()}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={analytics.data === null}
            onClick={inspectMatchingRecords}
          >
            Inspect matching records
          </Button>
        </div>

        {analytics.error === null ? null : (
          <div className="text-sm text-destructive">Context analytics could not be loaded.</div>
        )}
        {analytics.isPending && analytics.data === null ? (
          <div className="text-sm text-muted-foreground">Loading context analytics…</div>
        ) : null}

        {analytics.data === null ? null : (
          <>
            <div className="text-xs text-muted-foreground">
              {formatDate(analytics.data.from)} to {formatDate(analytics.data.to)} ·{" "}
              {analytics.data.bucketSize} buckets · retention{" "}
              {analytics.data.appliedDiagnosticRetentionDays}d
            </div>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <SummaryCard label="Inspections" value={totalInspections} />
              <SummaryCard label="Skipped" value={totalSkipped} />
              <SummaryCard label="Built" value={totalBuilt} />
              <SummaryCard label="Adapter handoff accepted" value={totalAccepted} />
              <SummaryCard label="Adapter handoff failed" value={totalFailed} />
            </div>

            <section className="space-y-2" aria-labelledby="context-analytics-outcomes">
              <h3 id="context-analytics-outcomes" className="text-sm font-medium">
                Outcome and suppression breakdown
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {SUPPRESSION_OPTIONS.flatMap((option) => {
                  const count = suppressionTotals.get(option.value) ?? 0;
                  return count === 0
                    ? []
                    : [<SummaryCard key={option.value} label={option.label} value={count} />];
                })}
              </div>
              {suppressionTotals.size === 0 ? (
                <div className="text-xs text-muted-foreground">No suppressions in this range.</div>
              ) : null}
            </section>

            <div className="grid gap-3 lg:grid-cols-2">
              <HistogramView
                title="Packet size bands"
                histogram={packetSize}
                labels={[
                  ["zero", "0 B"],
                  ["low", "1 B–1 KiB"],
                  ["medium", ">1–4 KiB"],
                  ["high", ">4–8 KiB"],
                  ["over", ">8 KiB"],
                ]}
              />
              <HistogramView
                title="Packet budget utilization"
                histogram={budgetUtilization}
                labels={[
                  ["zero", "Zero packet"],
                  ["low", "≤50%"],
                  ["medium", ">50–80%"],
                  ["high", ">80–100%"],
                  ["over", ">100% / no budget"],
                ]}
              />
            </div>

            <section className="space-y-2" aria-labelledby="context-analytics-composition">
              <h3 id="context-analytics-composition" className="text-sm font-medium">
                Context composition
              </h3>
              <div className="grid gap-2 sm:grid-cols-3">
                <CompositionView title="Roster" totals={roster} />
                <CompositionView title="Notes" totals={notes} />
                <CompositionView title="Inbox" totals={inbox} />
              </div>
            </section>

            <section className="space-y-2" aria-labelledby="context-analytics-buckets">
              <h3 id="context-analytics-buckets" className="text-sm font-medium">
                Time buckets
              </h3>
              {buckets.length === 0 ? (
                <div className="rounded-md border border-border/70 p-3 text-sm text-muted-foreground">
                  No retained context-inspection metadata matches this range and filter set.
                </div>
              ) : (
                <Table aria-label="Context analytics bucket table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bucket</TableHead>
                      <TableHead>Inspections</TableHead>
                      <TableHead>Skipped</TableHead>
                      <TableHead>Built</TableHead>
                      <TableHead>Adapter handoff accepted</TableHead>
                      <TableHead>Adapter handoff failed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {buckets.map((bucket) => (
                      <TableRow key={bucket.bucketStart}>
                        <TableCell>
                          {formatDate(bucket.bucketStart)} – {formatDate(bucket.bucketEnd)}
                        </TableCell>
                        <TableCell>{bucket.totalInspections}</TableCell>
                        <TableCell>{bucket.outcomes.skipped}</TableCell>
                        <TableCell>{bucket.outcomes.built}</TableCell>
                        <TableCell>{bucket.outcomes.providerStartAccepted}</TableCell>
                        <TableCell>{bucket.outcomes.providerStartFailed}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
