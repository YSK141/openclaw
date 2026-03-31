import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Message } from "@grammyjs/types";
import type { TelegramInlineButtons } from "./button-types.js";

type ExternalChatErrorCode =
  | "not_linked"
  | "invalid_code"
  | "expired_code"
  | "session_expired"
  | "invalid_candidate"
  | "invalid_state"
  | "invalid_price"
  | "validation_error"
  | "internal_error";

type SearchCandidate = {
  candidateIndex: number;
  title: string;
  imageUrl?: string;
  priceLabel?: string;
  channelLabel?: string;
  ebayStateLabel?: string;
};

type SearchResponse =
  | {
      ok: true;
      sessionId: string;
      candidates: SearchCandidate[];
    }
  | { ok: false; errorCode: ExternalChatErrorCode; message?: string };

type SelectResponse =
  | {
      ok: true;
      sessionId: string;
      candidateTitle: string;
      requiresEndListingChoice: boolean;
    }
  | { ok: false; errorCode: ExternalChatErrorCode; message?: string };

type ConfirmResponse =
  | {
      ok: true;
      resultCode: "sold_marked" | "sold_marked_end_listing_failed";
      messageCode: "marked_as_sold" | "marked_as_sold_end_listing_failed";
    }
  | { ok: false; errorCode: ExternalChatErrorCode; message?: string };

type LinkResponse =
  | { ok: true; bindingId: string }
  | { ok: false; errorCode: ExternalChatErrorCode; message?: string };

type ChatStage =
  | "idle"
  | "awaiting-price"
  | "awaiting-channel"
  | "awaiting-endlist"
  | "awaiting-confirm";

type ChatFlowState = {
  token: string;
  chatId: string;
  sessionId: string;
  stage: ChatStage;
  candidateTitle?: string;
  soldPrice?: number;
  soldChannel?: "store" | "flea" | "other";
  endListing?: boolean;
  requiresEndListingChoice: boolean;
};

type MessageHandlerParams = {
  chatId: string;
  message: Message;
  media: Array<{ path: string; contentType?: string }>;
  sendMessage: (
    text: string,
    options?: {
      buttons?: TelegramInlineButtons;
      replyToMessageId?: number;
    },
  ) => Promise<void>;
  sendPhoto?: (
    imageUrl: string,
    caption: string,
    options?: {
      replyToMessageId?: number;
    },
  ) => Promise<void>;
};

type CallbackHandlerParams = {
  chatId: string;
  data: string;
  sendMessage: (text: string, options?: { buttons?: TelegramInlineButtons }) => Promise<void>;
  editMessage: (text: string, options?: { buttons?: TelegramInlineButtons }) => Promise<void>;
  clearButtons: () => Promise<void>;
};

class ExternalChatRequestError extends Error {
  code: "network_error" | "invalid_response";
  status?: number;

  constructor(code: "network_error" | "invalid_response", message: string, status?: number) {
    super(message);
    this.name = "ExternalChatRequestError";
    this.code = code;
    this.status = status;
  }
}

const LINK_CODE_RE = /^[A-Z0-9]{4,32}$/i;
const PRICE_RE = /^\d+(?:\.\d{1,2})?$/;
const CALLBACK_PREFIX = "v1";
const chatStates = new Map<string, ChatFlowState>();
const tokenIndex = new Map<string, string>();

export function isTelegramExternalChatEnabled(): boolean {
  return (
    Boolean(process.env.SUPABASE_FUNCTION_BASE_URL?.trim()) &&
    Boolean(process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET?.trim())
  );
}

function buildCallbackData(action: string, token: string, value?: string | number): string {
  return [CALLBACK_PREFIX, action, token, value].filter((entry) => entry !== undefined).join("|");
}

function parseCallbackData(data: string): { action: string; token: string; value?: string } | null {
  const parts = data.trim().split("|");
  if (parts.length < 3 || parts[0] !== CALLBACK_PREFIX) {
    return null;
  }
  const [, action, token, value] = parts;
  if (!action || !token) {
    return null;
  }
  return { action, token, value };
}

function createToken(): string {
  return crypto.randomBytes(6).toString("base64url");
}

function buildSignatureHeaders(body: string): HeadersInit {
  const timestamp = String(Date.now());
  const secret = process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET?.trim() ?? "";
  const payload = `${timestamp}.${body}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    "Content-Type": "application/json",
    "x-openclaw-timestamp": timestamp,
    "x-openclaw-signature": signature,
  };
}

function resolveBaseUrl(): string {
  const base = process.env.SUPABASE_FUNCTION_BASE_URL?.trim();
  if (!base) {
    throw new Error("SUPABASE_FUNCTION_BASE_URL is not configured");
  }
  return base.replace(/\/$/, "");
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  console.warn(
    `[telegram][external-chat] request path=${path} bodyBytes=${Buffer.byteLength(body, "utf8")}`,
  );
  let response: Response;
  try {
    response = await fetch(`${resolveBaseUrl()}${path}`, {
      method: "POST",
      headers: buildSignatureHeaders(body),
      body,
    });
  } catch (error) {
    throw new ExternalChatRequestError(
      "network_error",
      error instanceof Error ? error.message : "Network request failed",
    );
  }
  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ExternalChatRequestError(
      "invalid_response",
      raw.trim() || `HTTP ${response.status}`,
      response.status,
    );
  }
}

function resolveRequestFailureMessage(error: unknown): string {
  if (error instanceof ExternalChatRequestError) {
    if (error.code === "network_error") {
      return "Could not reach InventoryManager. Check SUPABASE_FUNCTION_BASE_URL and network access.";
    }
    return error.status === 401 || error.status === 403
      ? "InventoryManager rejected the request. Check OPENCLAW_TO_SUPABASE_SHARED_SECRET."
      : "InventoryManager returned an invalid response. Check the function logs and configuration.";
  }
  return "Something went wrong. Please try again.";
}

function buildSelectButtons(token: string, candidates: SearchCandidate[]): TelegramInlineButtons {
  const rows = candidates.map((candidate) => [
    {
      text: `Select ${candidate.candidateIndex + 1}`,
      callback_data: buildCallbackData("sel", token, candidate.candidateIndex),
    },
  ]);
  rows.push([{ text: "Cancel", callback_data: buildCallbackData("x", token) }]);
  return rows;
}

function buildChannelButtons(token: string): TelegramInlineButtons {
  return [
    [
      { text: "Store", callback_data: buildCallbackData("ch", token, "store") },
      { text: "Flea", callback_data: buildCallbackData("ch", token, "flea") },
      { text: "Other", callback_data: buildCallbackData("ch", token, "other") },
    ],
    [{ text: "Cancel", callback_data: buildCallbackData("x", token) }],
  ];
}

function buildEndListingButtons(token: string): TelegramInlineButtons {
  return [
    [
      { text: "Yes", callback_data: buildCallbackData("end", token, "yes") },
      { text: "No", callback_data: buildCallbackData("end", token, "no") },
    ],
    [{ text: "Cancel", callback_data: buildCallbackData("x", token) }],
  ];
}

function buildConfirmButtons(token: string): TelegramInlineButtons {
  return [
    [{ text: "Confirm", callback_data: buildCallbackData("ok", token) }],
    [{ text: "Cancel", callback_data: buildCallbackData("x", token) }],
  ];
}

function formatCandidates(candidates: SearchCandidate[]): string {
  const lines = ["I found these possible matches:"];
  for (const candidate of candidates) {
    lines.push(`${candidate.candidateIndex + 1}. ${candidate.title}`);
    const details = [candidate.priceLabel, candidate.channelLabel, candidate.ebayStateLabel].filter(
      Boolean,
    );
    if (details.length > 0) {
      lines.push(details.join(" | "));
    }
  }
  return lines.join("\n");
}

function formatCandidateDetails(candidate: SearchCandidate): string[] {
  return [candidate.priceLabel, candidate.channelLabel, candidate.ebayStateLabel].filter(
    (value): value is string => Boolean(value),
  );
}

function formatCandidateCaption(candidate: SearchCandidate): string {
  const lines = [`${candidate.candidateIndex + 1}. ${candidate.title}`];
  const details = formatCandidateDetails(candidate);
  if (details.length > 0) {
    lines.push(details.join(" | "));
  }
  return lines.join("\n");
}

function clearChatState(chatId: string): void {
  const existing = chatStates.get(chatId);
  if (existing) {
    tokenIndex.delete(existing.token);
  }
  chatStates.delete(chatId);
}

function setChatState(state: ChatFlowState): void {
  clearChatState(state.chatId);
  chatStates.set(state.chatId, state);
  tokenIndex.set(state.token, state.chatId);
}

function getChatStateByToken(token: string): ChatFlowState | null {
  const chatId = tokenIndex.get(token);
  if (!chatId) {
    return null;
  }
  return chatStates.get(chatId) ?? null;
}

function resolveErrorMessage(code: ExternalChatErrorCode, fallback?: string): string {
  switch (code) {
    case "invalid_code":
      return "That link code is invalid. Generate a new code in the app and try again.";
    case "expired_code":
      return "That link code expired. Generate a new code in the app and try again.";
    case "not_linked":
      return "This Telegram account is not linked. Open the app and connect External chat first.";
    case "session_expired":
      return "This session expired. Send the photo again to restart.";
    case "invalid_candidate":
      return "That selection is no longer available. Send the photo again to restart.";
    case "invalid_state":
      return "Please pick a candidate first.";
    case "invalid_price":
      return "Enter sold price.";
    case "validation_error":
      return "That request was invalid. Check the input and try again.";
    case "internal_error":
      return "The server failed to complete that request. Please try again.";
    default:
      return fallback?.trim() || "Something went wrong. Please try again.";
  }
}

function formatSoldChannelLabel(channel: NonNullable<ChatFlowState["soldChannel"]>): string {
  switch (channel) {
    case "store":
      return "Store";
    case "flea":
      return "Flea";
    case "other":
      return "Other";
  }
}

function buildConfirmSummary(
  state: Pick<ChatFlowState, "candidateTitle" | "soldPrice" | "soldChannel" | "endListing">,
): string {
  const lines = ["Please confirm this update."];
  if (state.candidateTitle) {
    lines.push(`Item: ${state.candidateTitle}`);
  }
  if (typeof state.soldPrice === "number") {
    lines.push(`Sold price: ${state.soldPrice}`);
  }
  if (state.soldChannel) {
    lines.push(`Sold channel: ${formatSoldChannelLabel(state.soldChannel)}`);
  }
  if (typeof state.endListing === "boolean") {
    lines.push(`End listing on eBay: ${state.endListing ? "Yes" : "No"}`);
  }
  return lines.join("\n");
}

function maybeParseSoldPrice(text: string): number | null {
  if (!PRICE_RE.test(text.trim())) {
    return null;
  }
  const value = Number(text.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function resetTelegramExternalChatStateForTests(): void {
  chatStates.clear();
  tokenIndex.clear();
}

export async function handleTelegramExternalChatMessage(
  params: MessageHandlerParams,
): Promise<boolean> {
  try {
    if (!isTelegramExternalChatEnabled()) {
      return false;
    }
    const text = params.message.text?.trim() ?? "";
    if (text === "/start") {
      await params.sendMessage(
        "Send a product photo to find a matching inventory item.\nSend your link code to connect this Telegram account.",
        { replyToMessageId: params.message.message_id },
      );
      return true;
    }
    if (text === "/cancel") {
      clearChatState(params.chatId);
      await params.sendMessage("Cancelled.", { replyToMessageId: params.message.message_id });
      return true;
    }

    const active = chatStates.get(params.chatId) ?? null;
    if (active?.stage === "awaiting-price" && text) {
      const soldPrice = maybeParseSoldPrice(text);
      if (soldPrice == null) {
        await params.sendMessage("Enter sold price.", {
          replyToMessageId: params.message.message_id,
        });
        return true;
      }
      setChatState({ ...active, soldPrice, stage: "awaiting-channel" });
      await params.sendMessage("Where was this sold?", {
        buttons: buildChannelButtons(active.token),
        replyToMessageId: params.message.message_id,
      });
      return true;
    }

    if (text && LINK_CODE_RE.test(text)) {
      try {
        const response = await postJson<LinkResponse>("/external-chat-link/complete", {
          provider: "telegram",
          chatId: params.chatId,
          code: text,
        });
        if (!response.ok) {
          await params.sendMessage(resolveErrorMessage(response.errorCode, response.message), {
            replyToMessageId: params.message.message_id,
          });
          return true;
        }
        await params.sendMessage("Your Telegram account is now linked.", {
          replyToMessageId: params.message.message_id,
        });
        return true;
      } catch (error) {
        await params.sendMessage(resolveRequestFailureMessage(error), {
          replyToMessageId: params.message.message_id,
        });
        return true;
      }
    }

    const photo = params.media[0];
    if (!photo) {
      return false;
    }

    await params.sendMessage("Photo received. Starting search...", {
      replyToMessageId: params.message.message_id,
    });

    const bytes = await fs.readFile(photo.path);
    console.warn(
      `[telegram][external-chat] photo bytes chatId=${params.chatId} messageId=${params.message.message_id} fileBytes=${bytes.byteLength} mimeType=${photo.contentType ?? "image/jpeg"}`,
    );
    try {
      const response = await postJson<SearchResponse>("/external-chat-reconcile/search", {
        provider: "telegram",
        chatId: params.chatId,
        image: {
          base64: bytes.toString("base64"),
          mimeType: photo.contentType ?? "image/jpeg",
          filename: "telegram-upload.jpg",
        },
      });
      if (!response.ok) {
        const responsePreview = JSON.stringify(response).slice(0, 1000);
        console.warn(
          `[telegram][external-chat] search failed chatId=${params.chatId} errorCode=${response.errorCode} message=${response.message ?? ""} raw=${responsePreview}`,
        );
        await params.sendMessage(resolveErrorMessage(response.errorCode, response.message), {
          replyToMessageId: params.message.message_id,
        });
        return true;
      }
      if (response.candidates.length === 0) {
        clearChatState(params.chatId);
        await params.sendMessage(
          "No confident match found. Use Mark as sold in the app to continue.",
          { replyToMessageId: params.message.message_id },
        );
        return true;
      }
      const token = createToken();
      setChatState({
        token,
        chatId: params.chatId,
        sessionId: response.sessionId,
        stage: "idle",
        requiresEndListingChoice: false,
      });
      let sentPhoto = false;
      for (const candidate of response.candidates) {
        if (!candidate.imageUrl) {
          await params.sendMessage(formatCandidateCaption(candidate), {
            replyToMessageId: !sentPhoto ? params.message.message_id : undefined,
          });
          continue;
        }
        try {
          if (!params.sendPhoto) {
            throw new Error("sendPhoto unavailable");
          }
          await params.sendPhoto(candidate.imageUrl, formatCandidateCaption(candidate), {
            replyToMessageId: !sentPhoto ? params.message.message_id : undefined,
          });
          sentPhoto = true;
        } catch (error) {
          console.warn(
            `[telegram][external-chat] candidate photo send failed chatId=${params.chatId} candidateIndex=${candidate.candidateIndex} error=${error instanceof Error ? error.message : String(error)}`,
          );
          await params.sendMessage(formatCandidateCaption(candidate), {
            replyToMessageId: !sentPhoto ? params.message.message_id : undefined,
          });
        }
      }
      if (!sentPhoto) {
        await params.sendMessage(formatCandidates(response.candidates), {
          replyToMessageId: params.message.message_id,
        });
      }
      await params.sendMessage("Choose a match:", {
        buttons: buildSelectButtons(token, response.candidates),
      });
      return true;
    } catch (error) {
      console.error(
        `[telegram][external-chat] search request error chatId=${params.chatId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      await params.sendMessage(resolveRequestFailureMessage(error), {
        replyToMessageId: params.message.message_id,
      });
      return true;
    }
  } catch {
    await params.sendMessage("Failed to process that message. Please try again.", {
      replyToMessageId: params.message.message_id,
    });
    return true;
  }
}

export async function handleTelegramExternalChatCallback(
  params: CallbackHandlerParams,
): Promise<boolean> {
  if (!isTelegramExternalChatEnabled()) {
    return false;
  }
  const parsed = parseCallbackData(params.data);
  if (!parsed) {
    return false;
  }
  const state = getChatStateByToken(parsed.token);
  if (!state || state.chatId !== params.chatId) {
    await params.sendMessage("This session expired. Send the photo again to restart.");
    await params.clearButtons().catch(() => {});
    return true;
  }
  switch (parsed.action) {
    case "x":
      clearChatState(params.chatId);
      await params.editMessage("Cancelled.");
      return true;
    case "sel": {
      const candidateIndex = Number(parsed.value);
      const response = await postJson<SelectResponse>("/external-chat-reconcile/select", {
        provider: "telegram",
        chatId: params.chatId,
        sessionId: state.sessionId,
        candidateIndex,
      });
      if (!response.ok) {
        await params.sendMessage(resolveErrorMessage(response.errorCode, response.message));
        return true;
      }
      setChatState({
        ...state,
        sessionId: response.sessionId,
        candidateTitle: response.candidateTitle,
        requiresEndListingChoice: response.requiresEndListingChoice,
        stage: "awaiting-price",
      });
      await params.clearButtons().catch(() => {});
      await params.sendMessage("Enter sold price.");
      return true;
    }
    case "ch": {
      if (state.stage !== "awaiting-channel") {
        await params.sendMessage("Please pick a candidate first.");
        return true;
      }
      const soldChannel = parsed.value;
      if (soldChannel !== "store" && soldChannel !== "flea" && soldChannel !== "other") {
        await params.sendMessage("Something went wrong. Please try again.");
        return true;
      }
      const nextState: ChatFlowState = {
        ...state,
        soldChannel,
        stage: state.requiresEndListingChoice ? "awaiting-endlist" : "awaiting-confirm",
        endListing: state.requiresEndListingChoice ? undefined : false,
      };
      setChatState(nextState);
      if (state.requiresEndListingChoice) {
        await params.editMessage("End listing on eBay?", {
          buttons: buildEndListingButtons(state.token),
        });
      } else {
        await params.editMessage(
          buildConfirmSummary({
            candidateTitle: nextState.candidateTitle,
            soldPrice: nextState.soldPrice,
            soldChannel: nextState.soldChannel,
            endListing: nextState.endListing,
          }),
          {
            buttons: buildConfirmButtons(state.token),
          },
        );
      }
      return true;
    }
    case "end": {
      if (state.stage !== "awaiting-endlist") {
        await params.sendMessage("Please pick a candidate first.");
        return true;
      }
      const endListing = parsed.value === "yes";
      const nextState = { ...state, endListing, stage: "awaiting-confirm" as const };
      setChatState(nextState);
      await params.editMessage(
        buildConfirmSummary({
          candidateTitle: nextState.candidateTitle,
          soldPrice: nextState.soldPrice,
          soldChannel: nextState.soldChannel,
          endListing: nextState.endListing,
        }),
        {
          buttons: buildConfirmButtons(state.token),
        },
      );
      return true;
    }
    case "ok": {
      if (
        state.stage !== "awaiting-confirm" ||
        typeof state.soldPrice !== "number" ||
        !state.soldChannel ||
        typeof state.endListing !== "boolean"
      ) {
        await params.sendMessage("Please pick a candidate first.");
        return true;
      }
      const response = await postJson<ConfirmResponse>("/external-chat-reconcile/confirm", {
        provider: "telegram",
        chatId: params.chatId,
        sessionId: state.sessionId,
        soldPrice: state.soldPrice,
        soldChannel: state.soldChannel,
        endListing: state.endListing,
      });
      clearChatState(params.chatId);
      if (!response.ok) {
        await params.editMessage(resolveErrorMessage(response.errorCode, response.message));
        return true;
      }
      await params.editMessage(
        response.messageCode === "marked_as_sold_end_listing_failed"
          ? "Marked as sold, but ending the eBay listing failed."
          : "Marked as sold.",
      );
      return true;
    }
    default:
      return false;
  }
}
