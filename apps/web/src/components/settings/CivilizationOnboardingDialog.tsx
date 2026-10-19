import { useAtomSet } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type CivilizationOnboardingContentPreviewResult,
  type CivilizationOnboardingPreviewResult,
  type CivilizationProviderCapability,
  type EnvironmentId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import {
  civilizationConfigAction,
  civilizationOnboardingAction,
  refreshCivilizationOnboardingPresets,
  useCivilizationCensusPage,
  useCivilizationOnboardingPresets,
} from "../../state/civilization";
import { readEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  buildCivilizationOnboardingPreviewRequest,
  CIVILIZATION_ONBOARDING_TARGET_ID,
  civilizationOnboardingSafeSearch,
  clampCivilizationOnboardingStage,
  isCivilizationOnboardingConflict,
  onboardingApplyBinding,
  onboardingCanReveal,
  overlayCivilizationOnboardingChoices,
  selectCivilizationOnboardingCandidate,
} from "./civilizationOnboarding.logic";
import type {
  CivilizationNavigationSearch,
  CivilizationOnboardingStage,
} from "./civilizationNavigation";

const FUTURE_CITIZEN = "__future_citizen__";
const CENSUS_LIMIT = 50;
const STAGES: ReadonlyArray<CivilizationOnboardingStage> = [
  "target",
  "providers",
  "preset",
  "adoption",
  "privacy",
  "preview",
  "apply",
];

const describeError = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Civilization onboarding operation could not be completed.";
};

const formatDiffValue = (value: unknown) =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  value === null
    ? String(value)
    : JSON.stringify(value);

function DiffList({
  changes,
}: {
  readonly changes: CivilizationOnboardingPreviewResult["changes"];
}) {
  if (changes.length === 0) {
    return <div className="text-sm text-muted-foreground">No effective configuration changes.</div>;
  }
  return (
    <div className="space-y-2">
      {changes.map((change) => (
        <div key={change.path} className="rounded-lg border border-border/70 p-3 text-sm">
          <div className="font-medium">{change.path}</div>
          <div className="mt-1 grid min-w-0 gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            <div className="wrap-anywhere">Before: {formatDiffValue(change.before)}</div>
            <div className="wrap-anywhere">After: {formatDiffValue(change.after)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface Props {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly targetLabel: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly providers: ReadonlyArray<CivilizationProviderCapability>;
  readonly search: CivilizationNavigationSearch;
  readonly onNavigate: (
    next: CivilizationNavigationSearch,
    options?: { readonly replace?: boolean; readonly hash?: string },
  ) => void;
  readonly onApplied: () => void;
}

function CivilizationOnboardingDialogInner({
  environmentId,
  projectId,
  targetLabel,
  canRead,
  canWrite,
  providers,
  search,
  onNavigate,
  onApplied,
}: Props) {
  const runOnboardingAction = useAtomSet(civilizationOnboardingAction, { mode: "promise" });
  const runConfigAction = useAtomSet(civilizationConfigAction, { mode: "promise" });
  const presets = useCivilizationOnboardingPresets(
    canRead ? environmentId : null,
    canRead ? projectId : null,
  );
  const requestedStage = search.onboarding ?? "target";
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const [preview, setPreview] = useState<CivilizationOnboardingPreviewResult | null>(null);
  const [contentPreview, setContentPreview] =
    useState<CivilizationOnboardingContentPreviewResult | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageRole, setMessageRole] = useState<"status" | "alert">("status");
  const applyInFlight = useRef(false);

  const clampedStage = clampCivilizationOnboardingStage({
    requested: requestedStage,
    presetId: search.onboardingPreset,
    adoption: search.onboardingAdoption,
    titlePolicy: search.onboardingTitlePolicy,
    hasReviewedPreview: preview !== null,
  });
  useEffect(() => {
    if (clampedStage === requestedStage) return;
    onNavigate(
      civilizationOnboardingSafeSearch({
        stage: clampedStage,
        presetId: search.onboardingPreset,
        adoption: search.onboardingAdoption,
        titlePolicy: search.onboardingTitlePolicy,
      }),
      { replace: true, hash: CIVILIZATION_ONBOARDING_TARGET_ID },
    );
  }, [
    clampedStage,
    onNavigate,
    requestedStage,
    search.onboardingAdoption,
    search.onboardingPreset,
    search.onboardingTitlePolicy,
  ]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document
      .querySelector<HTMLElement>(
        `[data-onboarding-stage="${clampedStage}"] #civilization-onboarding-primary`,
      )
      ?.focus({ preventScroll: true });
  }, [clampedStage]);

  const needsCensus = clampedStage === "preview" || clampedStage === "apply";
  const census = useCivilizationCensusPage(
    canRead && needsCensus ? environmentId : null,
    canRead && needsCensus ? projectId : null,
    null,
    CENSUS_LIMIT,
  );

  const serverCandidate =
    search.onboardingPreset === undefined
      ? null
      : selectCivilizationOnboardingCandidate(presets.data?.presets ?? [], search.onboardingPreset);
  const candidate =
    serverCandidate === null ||
    search.onboardingAdoption === undefined ||
    search.onboardingTitlePolicy === undefined
      ? null
      : overlayCivilizationOnboardingChoices(serverCandidate, {
          adoption: search.onboardingAdoption,
          titlePolicy: search.onboardingTitlePolicy,
        });

  const safeSearch = (stage?: CivilizationOnboardingStage) =>
    civilizationOnboardingSafeSearch({
      stage,
      presetId: search.onboardingPreset,
      adoption: search.onboardingAdoption,
      titlePolicy: search.onboardingTitlePolicy,
    });
  const pushStage = (stage: CivilizationOnboardingStage) =>
    onNavigate(safeSearch(stage), { hash: CIVILIZATION_ONBOARDING_TARGET_ID });
  const replaceChoice = (next: Parameters<typeof civilizationOnboardingSafeSearch>[0]) =>
    onNavigate(
      civilizationOnboardingSafeSearch({
        stage: clampedStage,
        presetId: next.presetId ?? search.onboardingPreset,
        adoption: next.adoption ?? search.onboardingAdoption,
        titlePolicy: next.titlePolicy ?? search.onboardingTitlePolicy,
      }),
      { replace: true, hash: CIVILIZATION_ONBOARDING_TARGET_ID },
    );
  const close = () =>
    onNavigate(civilizationOnboardingSafeSearch({}), {
      replace: true,
      hash: CIVILIZATION_ONBOARDING_TARGET_ID,
    });

  const runPreview = () => {
    if (working || candidate === null) return;
    setWorking(true);
    setMessage(null);
    setMessageRole("status");
    void runOnboardingAction({
      environmentId,
      type: "preview",
      preview: buildCivilizationOnboardingPreviewRequest({ projectId, candidate, threadId }),
    })
      .then((result) => {
        setWorking(false);
        setPreview(result as CivilizationOnboardingPreviewResult);
        setContentPreview(null);
      })
      .catch((error: unknown) => {
        setWorking(false);
        setPreview(null);
        setContentPreview(null);
        setMessageRole("alert");
        setMessage(describeError(error));
      });
  };

  const revealPacket = () => {
    if (
      working ||
      candidate === null ||
      !onboardingCanReveal(preview, threadId) ||
      threadId === null
    )
      return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMessageRole("alert");
      setMessage("Permission changed before Reveal; settings:write is required.");
      return;
    }
    const revealThreadId = threadId;
    setWorking(true);
    setMessage(null);
    void runOnboardingAction({
      environmentId,
      type: "reveal",
      preview: {
        projectId,
        threadId: revealThreadId,
        candidateOverride: candidate.candidateOverride,
      },
    })
      .then((result) => {
        const revealed = result as CivilizationOnboardingContentPreviewResult;
        setWorking(false);
        if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
          setContentPreview(null);
          setMessageRole("alert");
          setMessage("Permission changed during Reveal; settings:write is required.");
          return;
        }
        setContentPreview(revealed);
        if (
          preview === null ||
          revealed.projectRevision !== preview.projectRevision ||
          revealed.environmentRevision !== preview.environmentRevision
        ) {
          setPreview(null);
          setMessageRole("alert");
          setMessage("Configuration changed after preview. Preview again before Apply.");
        }
      })
      .catch((error: unknown) => {
        setWorking(false);
        setContentPreview(null);
        setMessageRole("alert");
        setMessage(describeError(error));
      });
  };

  const apply = () => {
    if (working || applyInFlight.current || candidate === null || preview === null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setPreview(null);
      setContentPreview(null);
      setMessageRole("alert");
      setMessage("Permission changed before Apply; settings:write is required. Preview again.");
      return;
    }
    const binding = onboardingApplyBinding(projectId, candidate, preview);
    if (binding === null) return;
    applyInFlight.current = true;
    setWorking(true);
    setMessage(null);
    void runConfigAction({ environmentId, type: "set", ...binding })
      .then(() => {
        applyInFlight.current = false;
        setWorking(false);
        refreshCivilizationOnboardingPresets(environmentId, projectId);
        onApplied();
        close();
      })
      .catch((error: unknown) => {
        applyInFlight.current = false;
        setWorking(false);
        setPreview(null);
        setContentPreview(null);
        setMessageRole("alert");
        setMessage(
          isCivilizationOnboardingConflict(error)
            ? "Configuration changed elsewhere. Your choices are preserved; preview again before Apply."
            : describeError(error),
        );
      });
  };

  const liveCitizens =
    census.data?.citizens.filter(
      (citizen) => !citizen.observedOnly && !citizen.closed && !citizen.deleted,
    ) ?? [];
  const stepNumber = STAGES.indexOf(clampedStage) + 1;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup
        className="w-[min(48rem,calc(100vw-2rem))] max-w-3xl"
        initialFocus={() => document.getElementById("civilization-onboarding-primary") ?? true}
        finalFocus={() => document.getElementById("civilization-onboarding-open") ?? true}
      >
        <DialogHeader>
          <DialogTitle>Set up Civilization</DialogTitle>
          <DialogDescription>
            {targetLabel} · project {projectId}. Step {stepNumber} of {STAGES.length}. Only stage
            and non-sensitive choices are kept in the URL; previews and packet content stay in
            memory.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel data-onboarding-stage={clampedStage}>
          {!canRead ? (
            <div role="alert" className="text-sm text-destructive">
              orchestration:read is required.
            </div>
          ) : presets.isPending && presets.data === null ? (
            <div role="status" className="text-sm text-muted-foreground">
              Loading server-described presets…
            </div>
          ) : presets.error !== null ? (
            <div role="alert" className="text-sm text-destructive">
              {presets.error}
            </div>
          ) : clampedStage === "target" ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-border/70 p-4 text-sm">
                <div className="font-medium">Exact physical target</div>
                <div className="mt-1 text-muted-foreground">
                  {targetLabel} · {projectId}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  This wizard never fans out across checkouts or environments.
                </div>
              </div>
              <Button id="civilization-onboarding-primary" onClick={() => pushStage("providers")}>
                Continue
              </Button>
            </div>
          ) : clampedStage === "providers" ? (
            <div className="space-y-3">
              <div className="text-sm font-medium">Server-described provider capabilities</div>
              {providers.map((provider) => (
                <div
                  key={provider.providerInstanceId}
                  className="rounded-lg border border-border/70 p-3 text-sm"
                >
                  <div className="font-medium">{provider.providerInstanceId}</div>
                  <div className="text-xs text-muted-foreground">
                    {provider.support} · runtime and interaction mode are resolved by the server for
                    exact citizen previews.
                  </div>
                </div>
              ))}
              <Button id="civilization-onboarding-primary" onClick={() => pushStage("preset")}>
                Continue
              </Button>
            </div>
          ) : clampedStage === "preset" ? (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Server-described preset</legend>
              {(presets.data?.presets ?? []).map((preset, index) => (
                <label
                  key={preset.id}
                  className="flex gap-3 rounded-lg border border-border/70 p-3"
                >
                  <input
                    id={index === 0 ? "civilization-onboarding-primary" : undefined}
                    type="radio"
                    name="civilization-onboarding-preset"
                    value={preset.id}
                    checked={search.onboardingPreset === preset.id}
                    onChange={() => replaceChoice({ presetId: preset.id })}
                  />
                  <span>
                    <span className="block text-sm font-medium">{preset.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {preset.description}
                    </span>
                  </span>
                </label>
              ))}
              <Button
                disabled={search.onboardingPreset === undefined}
                onClick={() => pushStage("adoption")}
              >
                Continue
              </Button>
            </fieldset>
          ) : clampedStage === "adoption" ? (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Adoption scope</legend>
              {(["future_only", "all_existing"] as const).map((value, index) => (
                <label
                  key={value}
                  className="flex gap-3 rounded-lg border border-border/70 p-3 text-sm"
                >
                  <input
                    id={index === 0 ? "civilization-onboarding-primary" : undefined}
                    type="radio"
                    name="civilization-onboarding-adoption"
                    value={value}
                    checked={search.onboardingAdoption === value}
                    onChange={() => replaceChoice({ adoption: value })}
                  />
                  <span>
                    {value === "future_only"
                      ? "Future citizens only"
                      : "Include eligible existing threads"}
                  </span>
                </label>
              ))}
              <Button
                disabled={search.onboardingAdoption === undefined}
                onClick={() => pushStage("privacy")}
              >
                Continue
              </Button>
            </fieldset>
          ) : clampedStage === "privacy" ? (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Adopted thread title policy</legend>
              {(["preserve", "managed"] as const).map((value, index) => (
                <label
                  key={value}
                  className="flex gap-3 rounded-lg border border-border/70 p-3 text-sm"
                >
                  <input
                    id={index === 0 ? "civilization-onboarding-primary" : undefined}
                    type="radio"
                    name="civilization-onboarding-title-policy"
                    value={value}
                    checked={search.onboardingTitlePolicy === value}
                    onChange={() => replaceChoice({ titlePolicy: value })}
                  />
                  <span>
                    {value === "preserve"
                      ? "Preserve existing titles"
                      : "Use Civilization-managed titles"}
                  </span>
                </label>
              ))}
              <div className="text-xs text-muted-foreground">
                Packet text is never prefetched. An exact packet Reveal later requires a fresh
                settings:write check.
              </div>
              <Button
                disabled={search.onboardingTitlePolicy === undefined}
                onClick={() => pushStage("preview")}
              >
                Continue
              </Button>
            </fieldset>
          ) : clampedStage === "preview" ? (
            <div className="space-y-4">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Preview citizen</span>
                <Select
                  value={threadId ?? FUTURE_CITIZEN}
                  onValueChange={(value) => {
                    setThreadId(
                      value === FUTURE_CITIZEN || value === null ? null : ThreadId.make(value),
                    );
                    setPreview(null);
                    setContentPreview(null);
                  }}
                >
                  <SelectTrigger
                    aria-label="Civilization onboarding preview citizen"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={FUTURE_CITIZEN}>
                      Future citizen · configuration only
                    </SelectItem>
                    {liveCitizens.map((citizen) => (
                      <SelectItem key={citizen.threadId} value={citizen.threadId}>
                        {citizen.name} · {citizen.profileLabel}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <Button
                id="civilization-onboarding-primary"
                disabled={working || candidate === null}
                onClick={runPreview}
              >
                {working ? "Previewing…" : preview === null ? "Preview" : "Preview again"}
              </Button>
              {preview === null ? null : (
                <>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="rounded-lg border border-border/70 p-3 text-sm">
                      Project revision <strong>{preview.projectRevision}</strong>
                    </div>
                    <div className="rounded-lg border border-border/70 p-3 text-sm">
                      Environment revision <strong>{preview.environmentRevision}</strong>
                    </div>
                    <div className="rounded-lg border border-border/70 p-3 text-sm">
                      Packet {preview.budget.packetBytes}/{preview.budget.limitBytes} bytes
                    </div>
                  </div>
                  <DiffList changes={preview.changes} />
                  {preview.selectedCapability === null ? null : (
                    <div className="text-sm text-muted-foreground">
                      Server-resolved provider: {preview.selectedCapability.providerInstanceId} ·{" "}
                      {preview.selectedCapability.support}
                    </div>
                  )}
                  <Button onClick={() => pushStage("apply")}>Continue to Apply</Button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {preview === null ? (
                <div role="status" className="text-sm text-muted-foreground">
                  A reviewed in-memory preview is required before Apply.
                </div>
              ) : (
                <>
                  <div className="text-sm">
                    Apply the reviewed candidate exactly once at project revision{" "}
                    <strong>{preview.projectRevision}</strong> and environment revision{" "}
                    <strong>{preview.environmentRevision}</strong>.
                  </div>
                  <DiffList changes={preview.changes} />
                  {onboardingCanReveal(preview, threadId) ? (
                    <div className="space-y-2 rounded-lg border border-border/70 p-3">
                      <div className="text-xs text-muted-foreground">
                        Exact packet text is provisional, memory-only, and never prefetched.
                      </div>
                      <Button
                        variant="outline"
                        disabled={working || !canWrite}
                        onClick={revealPacket}
                      >
                        {contentPreview === null ? "Reveal packet" : "Reveal again"}
                      </Button>
                      {canWrite && contentPreview?.packet ? (
                        <>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border/70 p-3 text-xs">
                            {contentPreview.packet.text}
                          </pre>
                          <div className="text-xs text-muted-foreground">
                            Authority: {contentPreview.authority.providerInstanceId} ·{" "}
                            {contentPreview.authority.runtimeMode} ·{" "}
                            {contentPreview.authority.interactionMode}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <Button
                    id="civilization-onboarding-primary"
                    disabled={working || !canWrite}
                    onClick={apply}
                  >
                    {working ? "Applying…" : canWrite ? "Apply once" : "settings:write required"}
                  </Button>
                </>
              )}
            </div>
          )}
          {message === null ? null : (
            <div role={messageRole} className="mt-4 text-sm text-muted-foreground">
              {message}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={working} onClick={close}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CivilizationOnboardingDialog(props: Props) {
  return (
    <CivilizationOnboardingDialogInner
      key={props.canWrite ? "settings-write" : "read-only"}
      {...props}
    />
  );
}
