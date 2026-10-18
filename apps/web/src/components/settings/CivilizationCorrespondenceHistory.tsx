import { useAtomSet } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type CivilizationAdminMailRecord,
  type CivilizationCorrespondenceCursor,
  type CivilizationCorrespondenceReplyRelation,
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
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface CivilizationCorrespondenceHistoryProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly pageSize: number;
  readonly allowSensitiveActions: boolean;
  readonly onViewLineage?: ((threadId: ThreadIdType) => void) | undefined;
  readonly initialParticipantThreadId?: ThreadIdType | undefined;
  readonly initialMessageId?: CivilizationMessageId | undefined;
  readonly onViewChronicleSource?: ((sourceId: string) => void) | undefined;
}

type BooleanFilter = "any" | "yes" | "no";

const formatDate = (value: string | null): string =>
  value === null ? "—" : new Date(value).toLocaleString();

const triState = (value: BooleanFilter): boolean | undefined =>
  value === "any" ? undefined : value === "yes";

function CitizenLink({
  threadId,
  onViewLineage,
}: {
  readonly threadId: ThreadIdType;
  readonly onViewLineage?: ((threadId: ThreadIdType) => void) | undefined;
}) {
  return onViewLineage === undefined ? (
    <span className="wrap-anywhere">{threadId}</span>
  ) : (
    <Button size="xs" variant="ghost" onClick={() => onViewLineage(threadId)}>
      {threadId}
    </Button>
  );
}

function MessageFacts({
  message,
  onViewLineage,
}: {
  readonly message: CivilizationMailSummary;
  readonly onViewLineage?: ((threadId: ThreadIdType) => void) | undefined;
}) {
  return (
    <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
      <div className="font-medium text-sm text-foreground">
        {message.senderNameAtSend} →{" "}
        <CitizenLink threadId={message.recipientThreadId} onViewLineage={onViewLineage} />
      </div>
      <div className="wrap-anywhere">
        sender <CitizenLink threadId={message.senderThreadId} onViewLineage={onViewLineage} /> ·
        epoch {message.senderCitizenEpoch}
      </div>
      <div>
        recipient delivery epoch {message.recipientDeliveryEpoch} · {message.bodyBytes} bytes
      </div>
      <div>accepted {formatDate(message.acceptedAt)}</div>
      <div>
        acknowledged {message.acknowledgedAt === null ? "no" : formatDate(message.acknowledgedAt)}
      </div>
      <div>
        terminal {message.terminalAt === null ? "no" : formatDate(message.terminalAt)}
        {message.terminalReason === null ? "" : ` · ${message.terminalReason}`}
      </div>
      <div>
        offered {message.offerCount}× · last {formatDate(message.lastOfferedAt)}
      </div>
      {message.replyToMessageId === null ? null : (
        <div className="wrap-anywhere">reply to {message.replyToMessageId}</div>
      )}
    </div>
  );
}

export function CivilizationCorrespondenceHistory({
  environmentId,
  projectId,
  pageSize,
  allowSensitiveActions,
  onViewLineage,
  initialParticipantThreadId,
  initialMessageId,
  onViewChronicleSource,
}: CivilizationCorrespondenceHistoryProps) {
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const enabled = allowSensitiveActions && canWrite;
  const readSensitive = useAtomSet(civilizationSensitiveReadAction, { mode: "promise" });
  const [participantDraft, setParticipantDraft] = useState(initialParticipantThreadId ?? "");
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
    initialParticipantThreadId === undefined
      ? {}
      : { participantThreadId: initialParticipantThreadId, replyRelation: "any" },
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

  const applyFilters = () => {
    setFilterError(null);
    const participant = participantDraft.trim();
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
    const from = fromDraft === "" ? undefined : new Date(fromDraft).toISOString();
    const to = toDraft === "" ? undefined : new Date(toDraft).toISOString();
    setFilters({
      ...(participant === "" ? {} : { participantThreadId: ThreadId.make(participant) }),
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
          control={<span className="text-sm text-muted-foreground">Restricted</span>}
        />
      ) : !allowSensitiveActions ? (
        <SettingsRow
          title="Correspondence history"
          description="Select one environment before inspecting retained correspondence."
          control={<span className="text-sm text-muted-foreground">Choose environment</span>}
        />
      ) : (
        <div className="space-y-4 px-3 sm:px-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              aria-label="Correspondence participant thread"
              placeholder="Participant thread"
              value={participantDraft}
              onChange={(event) => setParticipantDraft(event.currentTarget.value)}
            />
            <Input
              aria-label="Correspondence sender thread"
              placeholder="Sender thread"
              value={senderDraft}
              onChange={(event) => setSenderDraft(event.currentTarget.value)}
            />
            <Input
              aria-label="Correspondence recipient thread"
              placeholder="Recipient thread"
              value={recipientDraft}
              onChange={(event) => setRecipientDraft(event.currentTarget.value)}
            />
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
                <SelectItem value="any">Any reply relation</SelectItem>
                <SelectItem value="root">Roots only</SelectItem>
                <SelectItem value="replies_to">Direct replies to…</SelectItem>
              </SelectContent>
            </Select>
            {replyRelation === "replies_to" ? (
              <Input
                aria-label="Correspondence parent message"
                placeholder="Parent message id"
                value={replyToDraft}
                onChange={(event) => setReplyToDraft(event.currentTarget.value)}
              />
            ) : null}
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
            <Select value={terminal} onValueChange={(value) => setTerminal(value as BooleanFilter)}>
              <SelectTrigger aria-label="Correspondence terminal state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any terminal state</SelectItem>
                <SelectItem value="yes">Terminal</SelectItem>
                <SelectItem value="no">Not terminal</SelectItem>
              </SelectContent>
            </Select>
            <Input
              aria-label="Correspondence delivery epoch"
              inputMode="numeric"
              placeholder="Delivery epoch"
              value={epochDraft}
              onChange={(event) => setEpochDraft(event.currentTarget.value)}
            />
            <Input
              aria-label="Correspondence from time"
              type="datetime-local"
              value={fromDraft}
              onChange={(event) => setFromDraft(event.currentTarget.value)}
            />
            <Input
              aria-label="Correspondence to time"
              type="datetime-local"
              value={toDraft}
              onChange={(event) => setToDraft(event.currentTarget.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={applyFilters}>
              Apply filters
            </Button>
            {filterError === null ? null : (
              <span className="text-sm text-destructive">{filterError}</span>
            )}
          </div>

          {page.isPending && page.data === null ? (
            <div className="text-sm text-muted-foreground">Loading correspondence…</div>
          ) : null}
          {page.error === null ? null : (
            <div className="text-sm text-destructive">{String(page.error)}</div>
          )}
          <div className="space-y-2">
            {page.data?.messages.map((message) => (
              <div
                key={message.messageId}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/70 p-3"
              >
                <MessageFacts message={message} onViewLineage={onViewLineage} />
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
                    Thread
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={bodyLoading}
                    onClick={() => openBody(message)}
                  >
                    Open body
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
                <div className="text-sm text-muted-foreground">Loading reply chain…</div>
              ) : null}
              {thread.error === null ? null : (
                <div className="text-sm text-destructive">{String(thread.error)}</div>
              )}
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
                    <MessageFacts message={entry.message} onViewLineage={onViewLineage} />
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

          {bodyError === null ? null : <div className="text-sm text-destructive">{bodyError}</div>}
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
