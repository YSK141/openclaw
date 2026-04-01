import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
  ebayItemUrl?: string;
};

type SearchResponse =
  | {
      ok: true;
      sessionId: string;
      candidates: SearchCandidate[];
      autoSelectCandidateIndex?: number;
      autoSelectCandidateTitle?: string;
      autoSelected?: {
        candidateIndex: number;
        candidateTitle: string;
        requiresEndListingChoice: boolean;
        imageUrl?: string;
        priceLabel?: string;
        channelLabel?: string;
        ebayStateLabel?: string;
        ebayItemUrl?: string;
      };
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

type DefaultsResponse =
  | {
      ok: true;
      defaultSoldChannel: "store" | "flea" | "other" | null;
      defaultEndListing: boolean | null;
      hasDefaultsConfigured: boolean;
    }
  | { ok: false; errorCode: ExternalChatErrorCode; message?: string };

type CancelResponse =
  | { ok: true; cancelled: boolean }
  | { ok: false; errorCode: ExternalChatErrorCode; message?: string };

type ChatStage = "idle" | "awaiting-price" | "awaiting-channel" | "awaiting-endlist";

type ChatFlowState = {
  token: string;
  chatId: string;
  sessionId: string;
  stage: ChatStage;
  candidateTitle?: string;
  soldPrice?: number;
  soldChannel?: "store" | "flea" | "other";
  endListing?: boolean;
  defaultSoldChannel?: "store" | "flea" | "other" | null;
  defaultEndListing?: boolean | null;
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
    image: {
      buffer: Buffer;
      filename: string;
      contentType?: string;
    },
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

class CandidateImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateImageFetchError";
  }
}

const LINK_CODE_RE = /^[A-Z0-9]{4,32}$/i;
const PRICE_RE = /^\d+(?:\.\d{1,2})?$/;
const CALLBACK_PREFIX = "v1";
const chatStates = new Map<string, ChatFlowState>();
const tokenIndex = new Map<string, string>();
const SETTING_INTENT_PATTERNS = [
  /default/i,
  /defaults/i,
  /from now on/i,
  /always/i,
  /set\b/i,
  /設定/,
  /デフォルト/,
  /今後/,
  /これから/,
  /毎回/,
  /通常/,
];

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

function resolveRuntimeErrorMessage(error: unknown): string {
  if (error instanceof ExternalChatRequestError) {
    return resolveRequestFailureMessage(error);
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function normalizeSettingsText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[，、。]/g, " ")
    .replace(/\s+/g, " ");
}

function hasSettingsIntent(text: string): boolean {
  return SETTING_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function parseDefaultSoldChannel(text: string): "store" | "flea" | "other" | undefined {
  if (/(flea market|flea|フリマ|マーケット|popup)/i.test(text)) {
    return "flea";
  }
  if (/(store|shop|店売り|店舗|店)/i.test(text)) {
    return "store";
  }
  if (/(other|その他)/i.test(text)) {
    return "other";
  }
  return undefined;
}

function parseDefaultEndListing(text: string): boolean | undefined {
  if (
    /(keep listed|do not delist|don't remove|leave it|取り下げない|消さない|そのまま残す|出品を残す)/i.test(
      text,
    )
  ) {
    return false;
  }
  if (
    /(mark as sold|delist|remove|end listing|take down|close listing|デリストする|出品終了する|取り下げる|削除する|mark as soldにする)/i.test(
      text,
    )
  ) {
    return true;
  }
  return undefined;
}

function parseDefaultsIntent(text: string): {
  defaultSoldChannel?: "store" | "flea" | "other";
  defaultEndListing?: boolean;
} | null {
  const normalized = normalizeSettingsText(text);
  if (!hasSettingsIntent(normalized)) {
    return null;
  }
  const defaultSoldChannel = parseDefaultSoldChannel(normalized);
  const defaultEndListing = parseDefaultEndListing(normalized);
  if (defaultSoldChannel === undefined && defaultEndListing === undefined) {
    return null;
  }
  return {
    ...(defaultSoldChannel !== undefined ? { defaultSoldChannel } : {}),
    ...(defaultEndListing !== undefined ? { defaultEndListing } : {}),
  };
}

function formatDefaultsMessage(
  defaults: Pick<
    ChatFlowState | Extract<DefaultsResponse, { ok: true }>,
    "defaultSoldChannel" | "defaultEndListing"
  >,
): string {
  const lines = ["Current defaults:"];
  lines.push(
    `Sold channel: ${
      defaults.defaultSoldChannel ? formatSoldChannelLabel(defaults.defaultSoldChannel) : "Not set"
    }`,
  );
  lines.push(
    `eBay delist: ${
      typeof defaults.defaultEndListing === "boolean"
        ? defaults.defaultEndListing
          ? "Yes"
          : "No"
        : "Not set"
    }`,
  );
  return lines.join("\n");
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

function formatCandidates(candidates: SearchCandidate[]): string {
  const lines = ["I found these possible matches:"];
  for (const candidate of candidates) {
    lines.push(`${candidate.candidateIndex + 1}. ${candidate.title}`);
    const details = formatCandidateDetails(candidate);
    if (details.length > 0) {
      lines.push(details.join(" | "));
    }
    if (candidate.ebayItemUrl) {
      lines.push(`eBay: ${candidate.ebayItemUrl}`);
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
  if (candidate.ebayItemUrl) {
    lines.push(`eBay: ${candidate.ebayItemUrl}`);
  }
  return lines.join("\n");
}

function resolveCandidateImageFilename(imageUrl: string, contentType?: string): string {
  try {
    const url = new URL(imageUrl);
    const name = path.posix.basename(url.pathname);
    if (name && name !== "/") {
      return name;
    }
  } catch {
    // Fall back to a synthetic filename below.
  }
  if (contentType?.includes("png")) {
    return "candidate.png";
  }
  if (contentType?.includes("webp")) {
    return "candidate.webp";
  }
  return "candidate.jpg";
}

async function fetchCandidateImage(imageUrl: string): Promise<{
  buffer: Buffer;
  filename: string;
  contentType?: string;
}> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.trim() || undefined;
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    filename: resolveCandidateImageFilename(imageUrl, contentType),
    contentType,
  };
}

async function sendCandidatePreview(params: {
  chatId: string;
  candidate: SearchCandidate;
  replyToMessageId?: number;
  sendMessage: MessageHandlerParams["sendMessage"];
  sendPhoto?: MessageHandlerParams["sendPhoto"];
}): Promise<boolean> {
  if (!params.candidate.imageUrl) {
    await params.sendMessage(formatCandidateCaption(params.candidate), {
      replyToMessageId: params.replyToMessageId,
    });
    return false;
  }

  try {
    if (!params.sendPhoto) {
      console.warn(
        `[telegram][external-chat] candidate photo send unavailable chatId=${params.chatId} candidateIndex=${params.candidate.candidateIndex}`,
      );
      throw new Error("sendPhoto unavailable");
    }
    let image: {
      buffer: Buffer;
      filename: string;
      contentType?: string;
    };
    try {
      image = await fetchCandidateImage(params.candidate.imageUrl);
    } catch (error) {
      console.warn(
        `[telegram][external-chat] candidate photo fetch failed chatId=${params.chatId} candidateIndex=${params.candidate.candidateIndex} error=${error instanceof Error ? error.message : String(error)}`,
      );
      throw new CandidateImageFetchError(error instanceof Error ? error.message : String(error));
    }
    await params.sendPhoto(image, formatCandidateCaption(params.candidate), {
      replyToMessageId: params.replyToMessageId,
    });
    return true;
  } catch (error) {
    if (
      params.sendPhoto &&
      error instanceof Error &&
      error.message !== "sendPhoto unavailable" &&
      !(error instanceof CandidateImageFetchError)
    ) {
      console.warn(
        `[telegram][external-chat] candidate photo send failed chatId=${params.chatId} candidateIndex=${params.candidate.candidateIndex} error=${error.message}`,
      );
    }
    await params.sendMessage(formatCandidateCaption(params.candidate), {
      replyToMessageId: params.replyToMessageId,
    });
    return false;
  }
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

function maybeParseSoldPrice(text: string): number | null {
  if (!PRICE_RE.test(text.trim())) {
    return null;
  }
  const value = Number(text.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function fetchDefaults(chatId: string): Promise<Extract<DefaultsResponse, { ok: true }>> {
  const response = await postJson<DefaultsResponse>("/external-chat-link/defaults/get", {
    provider: "telegram",
    chatId,
  });
  if (!response.ok) {
    throw new Error(resolveErrorMessage(response.errorCode, response.message));
  }
  return response;
}

async function updateDefaults(
  chatId: string,
  defaults: {
    defaultSoldChannel?: "store" | "flea" | "other";
    defaultEndListing?: boolean;
  },
): Promise<Extract<DefaultsResponse, { ok: true }>> {
  const response = await postJson<DefaultsResponse>("/external-chat-link/defaults/update", {
    provider: "telegram",
    chatId,
    ...defaults,
  });
  if (!response.ok) {
    throw new Error(resolveErrorMessage(response.errorCode, response.message));
  }
  return response;
}

async function cancelRemoteSession(chatId: string, sessionId: string): Promise<void> {
  const response = await postJson<CancelResponse>("/external-chat-reconcile/cancel", {
    provider: "telegram",
    chatId,
    sessionId,
  });
  if (!response.ok) {
    throw new Error(resolveErrorMessage(response.errorCode, response.message));
  }
}

async function confirmAndFinish(
  params: Pick<CallbackHandlerParams, "chatId" | "sendMessage" | "editMessage">,
  state: ChatFlowState & {
    soldPrice: number;
    soldChannel: "store" | "flea" | "other";
    endListing: boolean;
  },
  mode: "message" | "callback",
): Promise<void> {
  const response = await postJson<ConfirmResponse>("/external-chat-reconcile/confirm", {
    provider: "telegram",
    chatId: params.chatId,
    sessionId: state.sessionId,
    soldPrice: state.soldPrice,
    soldChannel: state.soldChannel,
    endListing: state.endListing,
  });
  clearChatState(params.chatId);
  const text = !response.ok
    ? response.message?.trim() || resolveErrorMessage(response.errorCode, response.message)
    : response.messageCode === "marked_as_sold_end_listing_failed"
      ? "Marked as sold, but ending the eBay listing failed."
      : "Marked as sold.";
  if (mode === "callback") {
    await params.editMessage(text);
  } else {
    await params.sendMessage(text);
  }
}

export function resetTelegramExternalChatStateForTests(): void {
  chatStates.clear();
  tokenIndex.clear();
}

async function startSelectedCandidateFlow(params: {
  chatId: string;
  token: string;
  sessionId: string;
  candidateTitle: string;
  requiresEndListingChoice: boolean;
  sendMessage: (
    text: string,
    options?: {
      buttons?: TelegramInlineButtons;
      replyToMessageId?: number;
    },
  ) => Promise<void>;
  replyToMessageId?: number;
}): Promise<void> {
  const defaults = await fetchDefaults(params.chatId);
  setChatState({
    token: params.token,
    chatId: params.chatId,
    sessionId: params.sessionId,
    candidateTitle: params.candidateTitle,
    requiresEndListingChoice: params.requiresEndListingChoice,
    defaultSoldChannel: defaults.defaultSoldChannel,
    defaultEndListing: defaults.defaultEndListing,
    stage: "awaiting-price",
  });
  await params.sendMessage("Enter sold price.", {
    ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
  });
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
      const active = chatStates.get(params.chatId) ?? null;
      if (active) {
        await cancelRemoteSession(params.chatId, active.sessionId).catch(() => {});
      }
      clearChatState(params.chatId);
      await params.sendMessage("Cancelled.", { replyToMessageId: params.message.message_id });
      return true;
    }

    const active = chatStates.get(params.chatId) ?? null;
    if (text === "/defaults") {
      if (active) {
        await params.sendMessage("Finish or cancel the current flow before changing defaults.", {
          replyToMessageId: params.message.message_id,
        });
        return true;
      }
      try {
        const defaults = await fetchDefaults(params.chatId);
        await params.sendMessage(formatDefaultsMessage(defaults), {
          replyToMessageId: params.message.message_id,
        });
      } catch (error) {
        await params.sendMessage(resolveRuntimeErrorMessage(error), {
          replyToMessageId: params.message.message_id,
        });
      }
      return true;
    }

    const defaultsIntent = text ? parseDefaultsIntent(text) : null;
    if (defaultsIntent) {
      if (active) {
        await params.sendMessage("Finish or cancel the current flow before changing defaults.", {
          replyToMessageId: params.message.message_id,
        });
        return true;
      }
      try {
        const defaults = await updateDefaults(params.chatId, defaultsIntent);
        await params.sendMessage(formatDefaultsMessage(defaults), {
          replyToMessageId: params.message.message_id,
        });
      } catch (error) {
        await params.sendMessage(resolveRuntimeErrorMessage(error), {
          replyToMessageId: params.message.message_id,
        });
      }
      return true;
    }

    if (active?.stage === "awaiting-price" && text) {
      const soldPrice = maybeParseSoldPrice(text);
      if (soldPrice == null) {
        await params.sendMessage("Enter sold price.", {
          replyToMessageId: params.message.message_id,
        });
        return true;
      }
      const nextState: ChatFlowState = { ...active, soldPrice };
      if (active.defaultSoldChannel) {
        nextState.soldChannel = active.defaultSoldChannel;
        if (active.requiresEndListingChoice) {
          if (typeof active.defaultEndListing === "boolean") {
            nextState.endListing = active.defaultEndListing;
            setChatState(nextState);
            await confirmAndFinish(
              {
                chatId: params.chatId,
                sendMessage: params.sendMessage,
                editMessage: async (message) => params.sendMessage(message),
              },
              nextState as ChatFlowState & {
                soldPrice: number;
                soldChannel: "store" | "flea" | "other";
                endListing: boolean;
              },
              "message",
            );
          } else {
            nextState.stage = "awaiting-endlist";
            setChatState(nextState);
            await params.sendMessage("End listing on eBay?", {
              buttons: buildEndListingButtons(active.token),
              replyToMessageId: params.message.message_id,
            });
          }
        } else {
          nextState.endListing = false;
          setChatState(nextState);
          await confirmAndFinish(
            {
              chatId: params.chatId,
              sendMessage: params.sendMessage,
              editMessage: async (message) => params.sendMessage(message),
            },
            nextState as ChatFlowState & {
              soldPrice: number;
              soldChannel: "store" | "flea" | "other";
              endListing: boolean;
            },
            "message",
          );
        }
      } else {
        nextState.stage = "awaiting-channel";
        setChatState(nextState);
        await params.sendMessage("Where was this sold?", {
          buttons: buildChannelButtons(active.token),
          replyToMessageId: params.message.message_id,
        });
      }
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
      console.warn(
        `[telegram][external-chat] search candidates chatId=${params.chatId} count=${response.candidates.length} candidates=${JSON.stringify(
          response.candidates.map((candidate) => ({
            candidateIndex: candidate.candidateIndex,
            title: candidate.title,
            hasImageUrl: Boolean(candidate.imageUrl),
            imageUrl: candidate.imageUrl ?? null,
          })),
        )}`,
      );
      if (response.candidates.length === 0) {
        clearChatState(params.chatId);
        await params.sendMessage(
          "No confident match found. Use Mark as sold in the app to continue.",
          { replyToMessageId: params.message.message_id },
        );
        return true;
      }
      const token = createToken();
      if (response.autoSelected) {
        const autoSelectedCandidate: SearchCandidate = {
          candidateIndex: response.autoSelected.candidateIndex,
          title: response.autoSelected.candidateTitle,
          ...(response.autoSelected.imageUrl ? { imageUrl: response.autoSelected.imageUrl } : {}),
          ...(response.autoSelected.priceLabel
            ? { priceLabel: response.autoSelected.priceLabel }
            : {}),
          ...(response.autoSelected.channelLabel
            ? { channelLabel: response.autoSelected.channelLabel }
            : {}),
          ...(response.autoSelected.ebayStateLabel
            ? { ebayStateLabel: response.autoSelected.ebayStateLabel }
            : {}),
          ...(response.autoSelected.ebayItemUrl
            ? { ebayItemUrl: response.autoSelected.ebayItemUrl }
            : {}),
        };
        await sendCandidatePreview({
          chatId: params.chatId,
          candidate: autoSelectedCandidate,
          replyToMessageId: params.message.message_id,
          sendMessage: params.sendMessage,
          sendPhoto: params.sendPhoto,
        });
        await params.sendMessage(`Auto-selected match: ${response.autoSelected.candidateTitle}`, {
          replyToMessageId: params.message.message_id,
        });
        await startSelectedCandidateFlow({
          chatId: params.chatId,
          token,
          sessionId: response.sessionId,
          candidateTitle: response.autoSelected.candidateTitle,
          requiresEndListingChoice: response.autoSelected.requiresEndListingChoice,
          sendMessage: params.sendMessage,
          replyToMessageId: params.message.message_id,
        });
        return true;
      }
      setChatState({
        token,
        chatId: params.chatId,
        sessionId: response.sessionId,
        stage: "idle",
        requiresEndListingChoice: false,
      });
      let sentPhoto = false;
      for (const candidate of response.candidates) {
        sentPhoto =
          (await sendCandidatePreview({
            chatId: params.chatId,
            candidate,
            replyToMessageId: !sentPhoto ? params.message.message_id : undefined,
            sendMessage: params.sendMessage,
            sendPhoto: params.sendPhoto,
          })) || sentPhoto;
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
  try {
    switch (parsed.action) {
      case "x":
        await cancelRemoteSession(params.chatId, state.sessionId).catch(() => {});
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
        await params.clearButtons().catch(() => {});
        await startSelectedCandidateFlow({
          chatId: params.chatId,
          token: state.token,
          sessionId: response.sessionId,
          candidateTitle: response.candidateTitle,
          requiresEndListingChoice: response.requiresEndListingChoice,
          sendMessage: params.sendMessage as (
            text: string,
            options?: { buttons?: TelegramInlineButtons; replyToMessageId?: number },
          ) => Promise<void>,
        });
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
          stage: "idle",
          endListing: state.requiresEndListingChoice ? undefined : false,
        };
        if (state.requiresEndListingChoice) {
          nextState.stage = "awaiting-endlist";
          setChatState(nextState);
          await params.editMessage("End listing on eBay?", {
            buttons: buildEndListingButtons(state.token),
          });
        } else {
          setChatState(nextState);
          await confirmAndFinish(
            params,
            nextState as ChatFlowState & {
              soldPrice: number;
              soldChannel: "store" | "flea" | "other";
              endListing: boolean;
            },
            "callback",
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
        const nextState = { ...state, endListing, stage: "idle" as const };
        setChatState(nextState);
        await confirmAndFinish(
          params,
          nextState as ChatFlowState & {
            soldPrice: number;
            soldChannel: "store" | "flea" | "other";
            endListing: boolean;
          },
          "callback",
        );
        return true;
      }
      default:
        return false;
    }
  } catch (error) {
    await params.sendMessage(resolveRuntimeErrorMessage(error));
    return true;
  }
}
