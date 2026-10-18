import { useAtomSet } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type CivilizationAdminMailRecord,
  type CivilizationCorrespondenceCursor,
  type CivilizationCorrespondenceReplyRelation,
  type CivilizationCitizenSummary,
  type CivilizationMailSummary,
  type CivilizationMessageId,
  type EnvironmentId,
  type ProjectId,
  ThreadId,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  civilizationSensitiveReadAction,
  useCivilizationCorrespondencePage,
  useCivilizationCorrespondenceThread,
  type CivilizationCorrespondenceFilters,
} from "../../state/civilization";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { CivilizationCitizenLink } from "./CivilizationCitizenLink";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface CivilizationCorrespondenceHistoryProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly pageSize: number;
  readonly allowSensitiveActions: boolean;
  readonly onViewCitizen?: ((threadId: ThreadIdType) => void) | undefined;
  readonly onViewLineage?: ((threadId: ThreadIdType) => void) | undefined;
  readonly citizenOptions?: ReadonlyArray<CivilizationCitizenSummary> | undefined;
  readonly hasMoreCitizenOptions?: boolean | undefined;
  readonly onLoadMoreCitizenOptions?: (() => void) | undefined;
  readonly initialParticipantThreadId?: ThreadIdType | undefined;
  readonly initialMessageId?: CivilizationMessageId | undefined;
  readonly onViewChronicleSource?: ((sourceId: string) => void) | undefined;
}

type BooleanFilter = "any" | "yes" | "no";
const EMPTY_CITIZEN_OPTIONS: ReadonlyArray<CivilizationCitizenSummary> = [];

const formatDate = (value: string | null): string =>
  value === null ? "—" : new Date(value).toLocaleString();

const triState = (value: BooleanFilter): boolean | undefined =>
  value === "any" ? undefined : value === "yes";

function MessageFacts({
  message,
  citizenNames,
  onViewCitizen,
  onViewLineage,
}: {
  readonly message: CivilizationMailSummary;
  readonly citizenNames: ReadonlyMap<ThreadIdType, string>;
  readonly onViewCitizen?: ((threadId: ThreadIdType) => void) | undefined;
  readonly onViewLineage?: ((threadId: ThreadIdType) => void) | undefined;
}) {
  return (
    <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
      <div className="font-medium text-sm text-foreground">
        <CivilizationCitizenLink
          threadId={message.senderThreadId}
          name={message.senderNameAtSend}
          onViewCitizen={onViewCitizen}
          secondary={citizenNames.has(message.senderThreadId) ? "name at send" : undefined}
        />{" "}
        →{" "}
        <CivilizationCitizenLink
          threadId={message.recipientThreadId}
          name={citizenNames.get(message.recipientThreadId) ?? String(message.recipientThreadId)}
          onViewCitizen={onViewCitizen}
          secondary={citizenNames.has(message.recipientThreadId) ? "current" : undefined}
        />
      </div>
      <div className="wrap-anywhere">
        {message.replyToMessageId === null
          ? "Conversation root"
          : `Reply to ${message.replyToMessageId}`}{" "}
        · Sender epoch {message.senderCitizenEpoch}
        {onViewCitizen !== undefined || onViewLineage === undefined ? null : (
          <Button size="xs" variant="ghost" onClick={() => onViewLineage(message.senderThreadId)}>
            Lineage
          </Button>
        )}
      </div>
      <div>
        {formatDate(message.acceptedAt)} · {message.bodyBytes} bytes
      </div>
      <div>
        Delivery epoch {message.recipientDeliveryEpoch} · Offered {message.offerCount}× ·{" "}
        {message.acknowledgedAt === null ? "Not acknowledged" : "Acknowledged"}
        {message.terminalAt === null
          ? " · Active"
          : ` · Terminal${message.terminalReason === null ? "" : ` (${message.terminalReason})`}`}
      </div>
    </div>
  );
}

export function CivilizationCorrespondenceHistory({
  environmentId,
  projectId,
  pageSize,
  allowSensitiveActions,
  onViewCitizen,
  onViewLineage,
  citizenOptions = EMPTY_CITIZEN_OPTIONS,
  hasMoreCitizenOptions = false,
  onLoadMoreCitizenOptions,
  initialParticipantThreadId,
  initialMessageId,
  onViewChronicleSource,
}: CivilizationCorrespondenceHistoryProps) {
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const enabled = allowSensitiveActions && canWrite;
  const readSensitive = useAtomSet(civilizationSensitiveReadAction, { mode: "promise" });
  const initialParticipant = initialParticipantThreadId ?? citizenOptions[0]?.threadId ?? "";
  const [participantDraft, setParticipantDraft] = useState(initialParticipant);
  const [counterpartyDraft, setCounterpartyDraft] = useState("");
  const [senderDraft, setSenderDraft] = useState("");
  const [recipientDraft, setRecipientDraft] = useState("");
  const [replyRelation, setReplyRelation] =
    useState<CivilizationCorrespondenceReplyRelation>("any");
  const [replyToDraft, setReplyToDraft] = useState("");
  const [acknowledged, setAcknowledged] = useState<BooleanFilter>("any");
  const [terminal, setTerminal] = useState<BooleanFilter>("any");
  const [epochDraft, setEpochDraft] = useState("");
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");
  const [filters, setFilters] = useState<CivilizationCorrespondenceFilters>(
    initialParticipant === ""
      ? {}
      : { participantThreadId: ThreadId.make(String(initialParticipant)), replyRelation: "any" },
  );
  const [filterError, setFilterError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CivilizationCorrespondenceCursor | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<CivilizationCorrespondenceCursor | null>>(
    [],
  );
  const [selectedMessageId, setSelectedMessageId] = useState<CivilizationMessageId | null>(
    initialMessageId ?? null,
  );
  const [body, setBody] = useState<CivilizationAdminMailRecord | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);

  const page = useCivilizationCorrespondencePage(
    enabled ? environmentId : null,
    enabled ? projectId : null,
    filters,
    cursor,
    pageSize,
  );
  const thread = useCivilizationCorrespondenceThread(
    enabled ? environmentId : null,
    enabled ? projectId : null,
    selectedMessageId,
    12,
    pageSize,
  );
  const pageCitizenNames = new Map(
    (page.data?.citizenReferences ?? []).map((reference) => [reference.threadId, reference.name]),
  );
  const threadCitizenNames = new Map(
    (thread.data?.citizenReferences ?? []).map((reference) => [reference.threadId, reference.name]),
  );
  const selectorNames = new Map(
    citizenOptions.map((citizen) => [citizen.threadId, citizen.name] as const),
  );
  for (const [threadId, name] of pageCitizenNames) selectorNames.set(threadId, name);
  const sortedCitizenOptions = [...selectorNames.entries()].toSorted((a, b) =>
    a[1].localeCompare(b[1], undefined, { sensitivity: "base" }),
  );

  const applyFilters = () => {
    setFilterError(null);
    const participant = participantDraft.trim();
    const counterparty = counterpartyDraft.trim();
    const sender = senderDraft.trim();
    const recipient = recipientDraft.trim();
    const replyTo = replyToDraft.trim();
    const epoch = epochDraft.trim() === "" ? undefined : Number(epochDraft);
    if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0)) {
      setFilterError("Delivery epoch must be a non-negative integer.");
      return;
    }
    if (replyRelation === "replies_to" && replyTo === "") {
      setFilterError("Choose a parent message when filtering direct replies.");
      return;
    }
    if (counterparty !== "" && participant === "") {
      setFilterError("Choose Citizen A before selecting a correspondent.");
      return;
    }
    if (counterparty !== "" && counterparty === participant) {
      setFilterError("Citizen A and Citizen B must be different citizens.");
      return;
    }
    const from = fromDraft === "" ? undefined : new Date(fromDraft).toISOString();
    const to = toDraft === "" ? undefined : new Date(toDraft).toISOString();
    setFilters({
      ...(participant === "" ? {} : { participantThreadId: ThreadId.make(participant) }),
      ...(counterparty === "" ? {} : { counterpartyThreadId: ThreadId.make(counterparty) }),
      ...(sender === "" ? {} : { senderThreadId: ThreadId.make(sender) }),
      ...(recipient === "" ? {} : { recipientThreadId: ThreadId.make(recipient) }),
      replyRelation,
      ...(replyRelation === "replies_to"
        ? { replyToMessageId: replyTo as CivilizationMessageId }
        : {}),
      ...(triState(acknowledged) === undefined ? {} : { acknowledged: triState(acknowledged) }),
      ...(triState(terminal) === undefined ? {} : { terminal: triState(terminal) }),
      ...(epoch === undefined ? {} : { deliveryEpoch: epoch }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
    setCursor(null);
    setCursorStack([]);
    setSelectedMessageId(null);
  };

  const openBody = (message: CivilizationMailSummary) => {
    if (!enabled || bodyLoading) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setBodyError("Permission changed before body inspection; settings:write is required.");
      return;
    }
    setBodyLoading(true);
    setBodyError(null);
    void readSensitive({ type: "mailBody", environmentId, projectId, messageId: message.messageId })
      .then((result) => {
        setBodyLoading(false);
        setBody(result as CivilizationAdminMailRecord);
      })
      .catch((error: unknown) => {
        setBodyLoading(false);
        setBodyError(
          error instanceof Error ? error.message : "Retained mail body could not be loaded.",
        );
      });
  };

  return (
    <SettingsSection title="Correspondence history" id="civilization-retained-mail">
      {!canWrite ? (
        <SettingsRow
          title="Correspondence history"
          description="Retained correspondence metadata and bodies require settings:write."
          control={
            <span role="status" className="text-sm text-muted-foreground">
              Restricted
            </span>
          }
        />
      ) : !allowSensitiveActions ? (
        <SettingsRow
          title="Correspondence history"
          description="Select one environment before inspecting retained correspondence."
          control={
            <span role="status" className="text-sm text-muted-foreground">
              Choose environment
            </span>
          }
        />
      ) : (
        <div className="space-y-4 px-3 sm:px-4">
          <div className="rounded-lg border border-border/70 p-3">
            <div className="mb-3">
              <div className="font-medium text-sm">Conversation</div>
              <div className="text-xs text-muted-foreground">
                Choose one citizen and optionally one correspondent. Message bodies remain unloaded
                until you explicitly choose View message.
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span>Citizen A</span>
                <Select
                  value={participantDraft === "" ? "__none__" : participantDraft}
                  onValueChange={(value) => {
                    const next = value === null || value === "__none__" ? "" : value;
                    setParticipantDraft(next);
                    if (next === counterpartyDraft) setCounterpartyDraft("");
                  }}
                >
                  <SelectTrigger aria-label="Conversation citizen A">
                    <SelectValue>
                      {participantDraft === ""
                        ? "Choose Citizen A"
                        : (selectorNames.get(ThreadId.make(participantDraft)) ?? participantDraft)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Choose Citizen A</SelectItem>
                    {sortedCitizenOptions.map(([threadId, name]) => (
                      <SelectItem key={threadId} value={threadId}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-sm">
                <span>Citizen B</span>
                <Select
                  value={counterpartyDraft === "" ? "__all__" : counterpartyDraft}
                  onValueChange={(value) =>
                    setCounterpartyDraft(value === null || value === "__all__" ? "" : value)
                  }
                >
                  <SelectTrigger aria-label="Conversation citizen B">
                    <SelectValue>
                      {counterpartyDraft === ""
                        ? "All correspondents"
                        : (selectorNames.get(ThreadId.make(counterpartyDraft)) ??
                          counterpartyDraft)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All correspondents</SelectItem>
                    {sortedCitizenOptions
                      .filter(([threadId]) => threadId !== participantDraft)
                      .map(([threadId, name]) => (
                        <SelectItem key={threadId} value={threadId}>
                          {name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={applyFilters} disabled={participantDraft === ""}>
                Show conversation
              </Button>
              {hasMoreCitizenOptions && onLoadMoreCitizenOptions !== undefined ? (
                <Button size="sm" variant="outline" onClick={onLoadMoreCitizenOptions}>
                  Load more citizens
                </Button>
              ) : null}
              {participantDraft === "" ? (
                <span className="text-xs text-muted-foreground">Choose Citizen A to begin.</span>
              ) : null}
            </div>
          </div>

          <details className="rounded-lg border border-border/70 p-3">
            <summary className="cursor-pointer text-sm font-medium">Advanced filters</summary>
            <p className="mt-1 text-xs text-muted-foreground">
              Filter by raw sender, recipient, message, delivery, or time metadata. Citizen A and
              Citizen B stay selected above.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>Sender thread ID</span>
                <Input
                  aria-label="Correspondence sender thread"
                  placeholder="Sender thread ID"
                  value={senderDraft}
                  onChange={(event) => setSenderDraft(event.currentTarget.value)}
                />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>Recipient thread ID</span>
                <Input
                  aria-label="Correspondence recipient thread"
                  placeholder="Recipient thread ID"
                  value={recipientDraft}
                  onChange={(event) => setRecipientDraft(event.currentTarget.value)}
                />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>Reply relationship</span>
                <Select
                  value={replyRelation}
                  onValueChange={(value) =>
                    setReplyRelation(value as CivilizationCorrespondenceReplyRelation)
                  }
                >
                  <SelectTrigger aria-label="Correspondence reply relation">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any reply relationship</SelectItem>
                    <SelectItem value="root">Conversation roots only</SelectItem>
                    <SelectItem value="replies_to">Direct replies to message…</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {replyRelation === "replies_to" ? (
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Parent message ID</span>
                  <Input
                    aria-label="Correspondence parent message"
                    placeholder="Parent message ID"
                    value={replyToDraft}
                    onChange={(event) => setReplyToDraft(event.currentTarget.value)}
                  />
                </label>
              ) : null}
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>Acknowledgement</span>
                <Select
                  value={acknowledged}
                  onValueChange={(value) => setAcknowledged(value as BooleanFilter)}
                >
                  <SelectTrigger aria-label="Correspondence acknowledged state">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any acknowledgement</SelectItem>
                    <SelectItem value="yes">Acknowledged</SelectItem>
                    <SelectItem value="no">Not acknowledged</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>Terminal state</span>
                <Select
                  value={terminal}
                  onValueChange={(value) => setTerminal(value as BooleanFilter)}
                >
                  <SelectTrigger aria-label="Correspondence terminal state">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any terminal state</SelectItem>
                    <SelectItem value="yes">Terminal</SelectItem>
                    <SelectItem value="no">Not terminal</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>Delivery epoch</span>
                <Input
                  aria-label="Correspondence delivery epoch"
                  inputMode="numeric"
                  placeholder="Delivery epoch"
                  value={epochDraft}
                  onChange={(event) => setEpochDraft(event.currentTarget.value)}
                />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>From</span>
                <Input
                  aria-label="Correspondence from time"
                  type="datetime-local"
                  value={fromDraft}
                  onChange={(event) => setFromDraft(event.currentTarget.value)}
                />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>To</span>
                <Input
                  aria-label="Correspondence to time"
                  type="datetime-local"
                  value={toDraft}
                  onChange={(event) => setToDraft(event.currentTarget.value)}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={applyFilters}>
                Apply advanced filters
              </Button>
            </div>
          </details>
          {filterError === null ? null : (
            <div role="alert" className="text-sm text-destructive">
              {filterError}
            </div>
          )}

          {page.isPending && page.data === null ? (
            <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
              Loading correspondence…
            </div>
          ) : null}
          {page.error === null ? null : (
            <div role="alert" className="text-sm text-destructive">
              {String(page.error)}
            </div>
          )}
          {!page.isPending &&
          page.error === null &&
          page.data !== null &&
          page.data.messages.length === 0 ? (
            <div
              role="status"
              className="rounded-lg border border-border/70 p-3 text-sm text-muted-foreground"
            >
              No retained correspondence matches this conversation and filter set.
            </div>
          ) : null}
          <div className="space-y-3" aria-label="Citizen conversation timeline">
            {page.data?.messages.map((message) => (
              <div
                key={message.messageId}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/70 p-3"
              >
                <MessageFacts
                  message={message}
                  citizenNames={pageCitizenNames}
                  onViewCitizen={onViewCitizen}
                  onViewLineage={onViewLineage}
                />
                <div className="flex gap-2">
                  {onViewChronicleSource === undefined ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onViewChronicleSource(`mail:${message.messageId}:sent`)}
                    >
                      Chronicle
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setSelectedMessageId(message.messageId)}
                  >
                    Reply chain
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={bodyLoading}
                    onClick={() => openBody(message)}
                  >
                    View message
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            {cursorStack.length === 0 ? null : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCursorStack((current) => {
                    setCursor(current.at(-1) ?? null);
                    return current.slice(0, -1);
                  });
                }}
              >
                Previous
              </Button>
            )}
            {page.data?.nextCursor === null || page.data?.nextCursor === undefined ? null : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCursorStack((current) => [...current, cursor]);
                  setCursor(page.data!.nextCursor);
                }}
              >
                Next
              </Button>
            )}
          </div>

          {selectedMessageId === null ? null : (
            <div className="space-y-2 rounded-lg border border-border/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-sm">Reply chain</div>
                  <div className="text-xs text-muted-foreground">
                    {thread.data?.rootStatus === "missing_parent"
                      ? "Earlier parent is no longer retained."
                      : thread.data?.rootStatus === "depth_limit"
                        ? "Earlier history exists beyond this bounded view."
                        : "Root resolved within retained history."}
                  </div>
                </div>
                <Button size="xs" variant="ghost" onClick={() => setSelectedMessageId(null)}>
                  Close
                </Button>
              </div>
              {thread.isPending && thread.data === null ? (
                <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
                  Loading reply chain…
                </div>
              ) : null}
              {thread.error === null ? null : (
                <div role="alert" className="text-sm text-destructive">
                  {String(thread.error)}
                </div>
              )}
              {!thread.isPending &&
              thread.error === null &&
              thread.data !== null &&
              thread.data.entries.length === 0 ? (
                <div
                  role="status"
                  className="rounded-md border border-border/70 p-3 text-sm text-muted-foreground"
                >
                  No retained messages are available for this reply chain.
                </div>
              ) : null}
              <ol className="space-y-2">
                {thread.data?.entries.map((entry) => (
                  <li
                    key={entry.message.messageId}
                    className="rounded-md border border-border/60 p-2"
                    style={{ marginInlineStart: `${Math.max(0, entry.depth) * 12}px` }}
                  >
                    <div className="text-xs font-medium text-muted-foreground">
                      {entry.relation} · depth {entry.depth}
                      {entry.unresolvedParent ? " · missing parent" : ""}
                    </div>
                    <MessageFacts
                      message={entry.message}
                      citizenNames={threadCitizenNames}
                      onViewCitizen={onViewCitizen}
                      onViewLineage={onViewLineage}
                    />
                  </li>
                ))}
              </ol>
              {thread.data?.descendantsTruncated ? (
                <div className="text-xs text-muted-foreground">
                  More descendants exist. Re-anchor on a visible message to continue.
                </div>
              ) : null}
            </div>
          )}

          {bodyError === null ? null : (
            <div role="alert" className="text-sm text-destructive">
              {bodyError}
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            Inspection only. This view cannot send, reply, wake, steer, resume, acknowledge, or
            impersonate another citizen.
          </div>
        </div>
      )}

      <Dialog
        open={body !== null}
        onOpenChange={(open) => {
          if (!open) setBody(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Retained mail body</DialogTitle>
            <DialogDescription>
              Sensitive administrative inspection only. Body text is not added to filters, URLs,
              search, or notifications.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere text-sm">
              {body?.body}
            </pre>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
