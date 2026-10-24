// @effect-diagnostics-next-line nodeBuiltinImport:off -- S8 reads bounded T3-owned attachment bytes before handing them to the private provider feature channel.
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Attachment bytes are read from the T3-owned resolved path before the private provider transfer.
import { promises as NodeFs } from "node:fs";

import type { ChatAttachment, ModelSelection } from "@t3tools/contracts";
import type {
  ChatGptBrowserProviderOperationId,
  ChatGptBrowserProviderV1Error,
  ChatGptBrowserProviderV1FeatureMessage,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import type * as Effect from "effect/Effect";

export const CHATGPT_BROWSER_S8_FEATURE = "chatgpt-browser.s8" as const;
export const CHATGPT_BROWSER_REASONING_OPTION = "reasoningEffort" as const;

export type ChatGptBrowserReasoningEffort = "none" | "medium";

// Exact choices observed on the migration qualification account/profile. S8 never rounds a
// request outside this catalog, and the native DOM path independently requires the same exact pair
// to remain available before Send.
const observedModels = {
  "gpt-6-thinking": "medium",
  "gpt-6": "none",
} as const satisfies Record<string, ChatGptBrowserReasoningEffort>;

export const CHATGPT_BROWSER_OBSERVED_MODELS = Object.entries(observedModels).map(
  ([model, reasoningEffort]) => ({ model, reasoningEffort }),
);

export interface ChatGptBrowserS8SelectionEvidence {
  readonly requestedModel: string;
  readonly selectedModel: string;
  readonly requestedReasoningEffort?: string;
  readonly selectedReasoningEffort: ChatGptBrowserReasoningEffort;
  readonly sendModel?: string;
  readonly resolvedModel?: string;
}

export interface ChatGptBrowserS8AttachmentPayload {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytesBase64: string;
}

export interface ChatGptBrowserS8OperationConfigurePayload {
  readonly kind: "operation.configure";
  readonly selection: ChatGptBrowserS8SelectionEvidence;
  readonly attachments: ReadonlyArray<ChatGptBrowserS8AttachmentPayload>;
}

export interface ChatGptBrowserS8ApprovalObservePayload {
  readonly kind: "approval.observe";
  readonly documentId: string;
  readonly conversationId: string;
  readonly card?: {
    readonly id: string;
    readonly lines: ReadonlyArray<string>;
    readonly allow: boolean;
  };
  readonly result?: { readonly token: string; readonly outcome: string };
}

export interface ChatGptBrowserS8ApprovalReadPayload {
  readonly kind: "approval.read";
}

export interface ChatGptBrowserS8OperationReadPayload {
  readonly kind: "operation.read";
}

export interface ChatGptBrowserS8ApprovalAnswerPayload {
  readonly kind: "approval.answer";
  readonly documentId: string;
  readonly cardId: string;
  readonly token: string;
  readonly choice: "allow" | "deny";
}

export type ChatGptBrowserS8FeaturePayload =
  | ChatGptBrowserS8OperationConfigurePayload
  | ChatGptBrowserS8OperationReadPayload
  | ChatGptBrowserS8ApprovalObservePayload
  | ChatGptBrowserS8ApprovalReadPayload
  | ChatGptBrowserS8ApprovalAnswerPayload;

export interface ChatGptBrowserS8ApprovalSnapshot {
  readonly generation: number;
  readonly approval?: {
    readonly documentId: string;
    readonly cardId: string;
    readonly lines: ReadonlyArray<string>;
    readonly allow: boolean;
    readonly outcome?: string;
  };
  readonly approvalAnswer?: {
    readonly cardId: string;
    readonly token: string;
    readonly choice: "allow" | "deny";
  };
}

export interface ChatGptBrowserS8FeatureTransport {
  readonly feature: (
    message: ChatGptBrowserProviderV1FeatureMessage<
      typeof CHATGPT_BROWSER_S8_FEATURE,
      ChatGptBrowserS8FeaturePayload
    >,
  ) => Effect.Effect<unknown, ChatGptBrowserProviderV1Error>;
}

function requestedReasoning(selection: ModelSelection): string | undefined {
  const values = (selection.options ?? [])
    .filter((entry) => entry.id === CHATGPT_BROWSER_REASONING_OPTION)
    .map((entry) => entry.value);
  if (values.length > 1 || (values.length === 1 && typeof values[0] !== "string")) {
    throw new Error("chatgpt_browser_reasoning_selection_invalid");
  }
  return values.length === 1 ? String(values[0]) : undefined;
}

export function resolveChatGptBrowserSelection(
  selection: ModelSelection,
): ChatGptBrowserS8SelectionEvidence {
  const selectedModel = selection.model === "default" ? "gpt-6-thinking" : selection.model;
  const selectedReasoningEffort = observedModels[selectedModel as keyof typeof observedModels];
  if (selectedReasoningEffort === undefined) {
    throw new Error(`chatgpt_browser_model_unsupported:${selection.model}`);
  }
  const requestedReasoningEffort = requestedReasoning(selection);
  if (
    requestedReasoningEffort !== undefined &&
    requestedReasoningEffort !== selectedReasoningEffort
  ) {
    throw new Error(`chatgpt_browser_reasoning_unsupported:${requestedReasoningEffort}`);
  }
  return {
    requestedModel: selection.model,
    selectedModel,
    ...(requestedReasoningEffort === undefined ? {} : { requestedReasoningEffort }),
    selectedReasoningEffort,
  };
}

export async function prepareChatGptBrowserAttachments(input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly resolvePath: (attachment: ChatAttachment) => string | null;
}): Promise<ReadonlyArray<ChatGptBrowserS8AttachmentPayload>> {
  const prepared: ChatGptBrowserS8AttachmentPayload[] = [];
  for (const attachment of input.attachments) {
    if (attachment.type !== "image" && attachment.type !== "file") {
      throw new Error(`chatgpt_browser_attachment_unsupported:${attachment.type}`);
    }
    const path = input.resolvePath(attachment);
    if (path === null) throw new Error(`chatgpt_browser_attachment_missing:${attachment.id}`);
    const bytes = await NodeFs.readFile(path);
    if (bytes.byteLength !== attachment.sizeBytes) {
      throw new Error(`chatgpt_browser_attachment_size_changed:${attachment.id}`);
    }
    prepared.push({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.sizeBytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytesBase64: bytes.toString("base64"),
    });
  }
  return prepared;
}

export function s8FeatureMessage(
  providerOperationId: ChatGptBrowserProviderOperationId,
  payload: ChatGptBrowserS8FeaturePayload,
): ChatGptBrowserProviderV1FeatureMessage<
  typeof CHATGPT_BROWSER_S8_FEATURE,
  ChatGptBrowserS8FeaturePayload
> {
  return {
    type: "feature.message",
    feature: CHATGPT_BROWSER_S8_FEATURE,
    providerOperationId,
    payload,
  };
}
