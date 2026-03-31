import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTelegramExternalChatCallback,
  handleTelegramExternalChatMessage,
  resetTelegramExternalChatStateForTests,
} from "./telegram-external-chat.js";

function findLatestButtons(
  calls: Array<[string, { buttons?: unknown } | undefined]>,
): { callback_data?: string }[][] | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const buttons = calls[i]?.[1]?.buttons as { callback_data?: string }[][] | undefined;
    if (buttons) {
      return buttons;
    }
  }
  return undefined;
}

describe("telegram external chat", () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.SUPABASE_FUNCTION_BASE_URL;
  const originalSecret = process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.SUPABASE_FUNCTION_BASE_URL;
    } else {
      process.env.SUPABASE_FUNCTION_BASE_URL = originalBaseUrl;
    }
    if (originalSecret === undefined) {
      delete process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET;
    } else {
      process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = originalSecret;
    }
    resetTelegramExternalChatStateForTests();
  });

  it("handles /start with onboarding instructions", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        date: 1,
        text: "/start",
      },
      media: [],
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("Send a product photo"),
      expect.objectContaining({ replyToMessageId: 1 }),
    );
  });

  it("completes link flow from a text code", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, bindingId: "binding-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        date: 1,
        text: "ABCDEFGH",
      },
      media: [],
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "Your Telegram account is now linked.",
      expect.objectContaining({ replyToMessageId: 1 }),
    );
  });

  it("shows a specific message for an invalid link code", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, errorCode: "invalid_code" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        date: 1,
        text: "ABCDEFGH",
      },
      media: [],
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "That link code is invalid. Generate a new code in the app and try again.",
      expect.objectContaining({ replyToMessageId: 1 }),
    );
  });

  it("shows a specific message for an expired link code", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, errorCode: "expired_code" }), {
          status: 410,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        date: 1,
        text: "ABCDEFGH",
      },
      media: [],
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "That link code expired. Generate a new code in the app and try again.",
      expect.objectContaining({ replyToMessageId: 1 }),
    );
  });

  it("shows a specific message when InventoryManager cannot be reached during link", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        date: 1,
        text: "ABCDEFGH",
      },
      media: [],
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "Could not reach InventoryManager. Check SUPABASE_FUNCTION_BASE_URL and network access.",
      expect.objectContaining({ replyToMessageId: 1 }),
    );
  });

  it("searches by photo and drives select to awaiting-price", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extchat-"));
    const imagePath = path.join(tmpDir, "photo.jpg");
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/external-chat-reconcile/search")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            candidates: [
              {
                candidateIndex: 0,
                title: "Vintage Jacket",
                imageUrl: "https://example.com/item.jpg",
                priceLabel: "$50",
                channelLabel: "STORE",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-reconcile/select")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            candidateTitle: "Vintage Jacket",
            requiresEndListingChoice: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    globalThis.fetch = fetchMock;
    const sendMessage = vi.fn(async () => undefined);
    const sendPhoto = vi.fn(async () => undefined);
    const editMessage = vi.fn(async () => undefined);
    const clearButtons = vi.fn(async () => undefined);

    const handledPhoto = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        date: 1,
      },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
      sendPhoto,
    });
    expect(handledPhoto).toBe(true);
    expect(sendPhoto).toHaveBeenCalledWith(
      "https://example.com/item.jpg",
      expect.stringContaining("1. Vintage Jacket"),
      expect.objectContaining({ replyToMessageId: 1 }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "Choose a match:",
      expect.objectContaining({ buttons: expect.any(Array) }),
    );
    const firstButtons = findLatestButtons(sendMessage.mock.calls);
    const callbackData = firstButtons?.[0]?.[0]?.callback_data;
    expect(callbackData).toContain("v1|sel|");

    const handledCallback = await handleTelegramExternalChatCallback({
      chatId: "123",
      data: callbackData,
      sendMessage,
      editMessage,
      clearButtons,
    });
    expect(handledCallback).toBe(true);
    expect(sendMessage).toHaveBeenLastCalledWith("Enter sold price.");
  });

  it("shows a specific message when InventoryManager cannot be reached during photo search", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extchat-"));
    const imagePath = path.join(tmpDir, "photo.jpg");
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        date: 1,
      },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "Could not reach InventoryManager. Check SUPABASE_FUNCTION_BASE_URL and network access.",
      expect.objectContaining({ replyToMessageId: 1 }),
    );
  });

  it("falls back to text candidate details when candidate image sending is unavailable", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extchat-"));
    const imagePath = path.join(tmpDir, "photo.jpg");
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/external-chat-reconcile/search")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            candidates: [
              {
                candidateIndex: 0,
                title: "Vintage Jacket",
                imageUrl: "https://example.com/item.jpg",
                priceLabel: "$50",
                channelLabel: "STORE",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        date: 1,
      },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "1. Vintage Jacket\n$50 | STORE",
      expect.objectContaining({ replyToMessageId: 1 }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "Choose a match:",
      expect.objectContaining({ buttons: expect.any(Array) }),
    );
  });

  it("shows a confirm summary after price and channel selection", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extchat-"));
    const imagePath = path.join(tmpDir, "photo.jpg");
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/external-chat-reconcile/search")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            candidates: [{ candidateIndex: 0, title: "Vintage Jacket" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-reconcile/select")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            candidateTitle: "Vintage Jacket",
            requiresEndListingChoice: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);
    const editMessage = vi.fn(async () => undefined);
    const clearButtons = vi.fn(async () => undefined);

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 1, chat: { id: 123, type: "private" }, date: 1 },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
    });
    const selectData = findLatestButtons(sendMessage.mock.calls)?.[0]?.[0]?.callback_data;
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: selectData,
      sendMessage,
      editMessage,
      clearButtons,
    });
    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 2, chat: { id: 123, type: "private" }, date: 2, text: "220" },
      media: [],
      sendMessage,
    });
    const channelData = findLatestButtons(sendMessage.mock.calls)?.[0]?.[0]?.callback_data;
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: channelData,
      sendMessage,
      editMessage,
      clearButtons,
    });

    expect(editMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("Please confirm this update."),
      expect.objectContaining({ buttons: expect.any(Array) }),
    );
    expect(editMessage.mock.calls.at(-1)?.[0]).toContain("Item: Vintage Jacket");
    expect(editMessage.mock.calls.at(-1)?.[0]).toContain("Sold price: 220");
    expect(editMessage.mock.calls.at(-1)?.[0]).toContain("Sold channel: Store");
  });

  it("returns session expired for stale callback tokens", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const sendMessage = vi.fn(async () => undefined);
    const editMessage = vi.fn(async () => undefined);
    const clearButtons = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatCallback({
      chatId: "123",
      data: "v1|sel|missingtoken|0",
      sendMessage,
      editMessage,
      clearButtons,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "This session expired. Send the photo again to restart.",
    );
    expect(clearButtons).toHaveBeenCalled();
  });

  it("completes confirm with end listing choice when required", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extchat-"));
    const imagePath = path.join(tmpDir, "photo.jpg");
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/external-chat-reconcile/search")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            candidates: [{ candidateIndex: 0, title: "Vintage Jacket" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-reconcile/select")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            candidateTitle: "Vintage Jacket",
            requiresEndListingChoice: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-reconcile/confirm")) {
        return new Response(
          JSON.stringify({
            ok: true,
            resultCode: "sold_marked_end_listing_failed",
            messageCode: "marked_as_sold_end_listing_failed",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);
    const editMessage = vi.fn(async () => undefined);
    const clearButtons = vi.fn(async () => undefined);

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 1, chat: { id: 123, type: "private" }, date: 1 },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
    });
    const selectData = findLatestButtons(sendMessage.mock.calls)?.[0]?.[0]?.callback_data;
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: selectData,
      sendMessage,
      editMessage,
      clearButtons,
    });
    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 2, chat: { id: 123, type: "private" }, date: 2, text: "220" },
      media: [],
      sendMessage,
    });
    const channelData = findLatestButtons(sendMessage.mock.calls)?.[0]?.[0]?.callback_data;
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: channelData,
      sendMessage,
      editMessage,
      clearButtons,
    });
    const endListingData = editMessage.mock.calls.at(-1)?.[1]?.buttons?.[0]?.[0]?.callback_data;
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: endListingData,
      sendMessage,
      editMessage,
      clearButtons,
    });
    const confirmData = editMessage.mock.calls.at(-1)?.[1]?.buttons?.[0]?.[0]?.callback_data;
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: confirmData,
      sendMessage,
      editMessage,
      clearButtons,
    });

    expect(editMessage.mock.calls.at(-1)?.[0]).toBe(
      "Marked as sold, but ending the eBay listing failed.",
    );
  });
});
