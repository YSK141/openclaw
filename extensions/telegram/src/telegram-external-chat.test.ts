import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTelegramExternalChatCallback,
  handleTelegramExternalChatMessage,
  resetTelegramExternalChatStateForTests,
} from "./telegram-external-chat.js";

const privateChat = { id: 123, type: "private", first_name: "Test" } as const;

function expectDefined<T>(value: T | undefined, message = "expected value to be defined"): T {
  expect(value, message).toBeDefined();
  return value as T;
}

function findLatestButtons(
  calls: ReadonlyArray<readonly unknown[]>,
): { callback_data?: string }[][] | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const options = calls[i]?.[1] as { buttons?: unknown } | undefined;
    const buttons = options?.buttons as { callback_data?: string }[][] | undefined;
    if (buttons) {
      return buttons;
    }
  }
  return undefined;
}

function findLatestEditButtons(
  calls: ReadonlyArray<readonly unknown[]>,
): { callback_data?: string }[][] | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const options = calls[i]?.[1] as { buttons?: unknown } | undefined;
    const buttons = options?.buttons as { callback_data?: string }[][] | undefined;
    if (buttons) {
      return buttons;
    }
  }
  return undefined;
}

function expectFirstCallbackData(calls: ReadonlyArray<readonly unknown[]>): string {
  const buttons = expectDefined(findLatestButtons(calls), "expected inline buttons");
  return expectDefined(buttons[0]?.[0]?.callback_data, "expected callback data");
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
        chat: privateChat,
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
        chat: privateChat,
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
        chat: privateChat,
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
        chat: privateChat,
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
        chat: privateChat,
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
      if (url === "https://example.com/item.jpg") {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
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
                ebayItemUrl: "https://www.ebay.com/itm/1234567890",
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
      if (url.endsWith("/external-chat-link/defaults/get")) {
        return new Response(
          JSON.stringify({
            ok: true,
            defaultSoldChannel: null,
            defaultEndListing: null,
            hasDefaultsConfigured: false,
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
        chat: privateChat,
        date: 1,
      },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
      sendPhoto,
    });
    expect(handledPhoto).toBe(true);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const firstPhotoCall = expectDefined(
      sendPhoto.mock.calls[0] as unknown as
        | [unknown, string, { replyToMessageId?: number } | undefined]
        | undefined,
      "expected first photo call",
    );
    expect(firstPhotoCall[0]).toEqual(
      expect.objectContaining({
        filename: "item.jpg",
        contentType: "image/jpeg",
        buffer: expect.any(Buffer),
      }),
    );
    expect(firstPhotoCall[1]).toContain("1. Vintage Jacket");
    expect(firstPhotoCall[1]).toContain("eBay: https://www.ebay.com/itm/1234567890");
    expect(firstPhotoCall[2]).toEqual(expect.objectContaining({ replyToMessageId: 1 }));
    expect(sendMessage).toHaveBeenCalledWith(
      "Choose a match:",
      expect.objectContaining({ buttons: expect.any(Array) }),
    );
    const callbackData = expectFirstCallbackData(sendMessage.mock.calls);
    expect(callbackData).toContain("v1|sel|");

    const handledCallback = await handleTelegramExternalChatCallback({
      chatId: "123",
      data: callbackData,
      sendMessage,
      editMessage,
      clearButtons,
    });
    expect(handledCallback).toBe(true);
    expect(sendMessage).toHaveBeenLastCalledWith("Enter sold price.", {});
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
        chat: privateChat,
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/item.jpg") {
        throw new Error("image fetch failed");
      }
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
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: privateChat,
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

  it("falls back per candidate when one candidate image fetch fails", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extchat-"));
    const imagePath = path.join(tmpDir, "photo.jpg");
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/item-1.jpg") {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      if (url === "https://example.com/item-2.jpg") {
        throw new Error("image fetch failed");
      }
      if (url.endsWith("/external-chat-reconcile/search")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            candidates: [
              {
                candidateIndex: 0,
                title: "Vintage Jacket",
                imageUrl: "https://example.com/item-1.jpg",
                priceLabel: "$50",
                channelLabel: "STORE",
              },
              {
                candidateIndex: 1,
                title: "Beige Corduroy Jacket",
                imageUrl: "https://example.com/item-2.jpg",
                priceLabel: "$80",
                channelLabel: "EBAY",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);
    const sendPhoto = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: privateChat,
        date: 1,
      },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
      sendPhoto,
    });

    expect(handled).toBe(true);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const firstPhotoCall = expectDefined(
      sendPhoto.mock.calls[0] as unknown as [unknown, string, unknown] | undefined,
      "expected first photo call",
    );
    expect(firstPhotoCall[1]).toContain("1. Vintage Jacket");
    expect(sendMessage).toHaveBeenCalledWith("2. Beige Corduroy Jacket\n$80 | EBAY", {
      replyToMessageId: undefined,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "Choose a match:",
      expect.objectContaining({ buttons: expect.any(Array) }),
    );
  });

  it("confirms immediately after sold price when defaults are configured", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extchat-"));
    const imagePath = path.join(tmpDir, "photo.jpg");
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/item.jpg") {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
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
      if (url.endsWith("/external-chat-link/defaults/get")) {
        return new Response(
          JSON.stringify({
            ok: true,
            defaultSoldChannel: "store",
            defaultEndListing: true,
            hasDefaultsConfigured: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-reconcile/confirm")) {
        return new Response(
          JSON.stringify({
            ok: true,
            resultCode: "sold_marked",
            messageCode: "marked_as_sold",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);
    const editMessage = vi.fn(async () => undefined);
    const clearButtons = vi.fn(async () => undefined);

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 1, chat: privateChat, date: 1 },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
    });
    const selectData = expectFirstCallbackData(sendMessage.mock.calls);
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: selectData,
      sendMessage,
      editMessage,
      clearButtons,
    });
    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 2, chat: privateChat, date: 2, text: "220" },
      media: [],
      sendMessage,
    });

    expect(sendMessage).toHaveBeenLastCalledWith("Marked as sold.");
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/item.jpg") {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
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
      if (url.endsWith("/external-chat-link/defaults/get")) {
        return new Response(
          JSON.stringify({
            ok: true,
            defaultSoldChannel: null,
            defaultEndListing: null,
            hasDefaultsConfigured: false,
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
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);
    const editMessage = vi.fn(async () => undefined);
    const clearButtons = vi.fn(async () => undefined);

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 1, chat: privateChat, date: 1 },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
    });
    const selectData = expectFirstCallbackData(sendMessage.mock.calls);
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: selectData,
      sendMessage,
      editMessage,
      clearButtons,
    });
    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 2, chat: privateChat, date: 2, text: "220" },
      media: [],
      sendMessage,
    });
    const channelData = expectFirstCallbackData(sendMessage.mock.calls);
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: channelData,
      sendMessage,
      editMessage,
      clearButtons,
    });
    const endListingButtons = expectDefined(
      findLatestEditButtons(editMessage.mock.calls),
      "expected end-listing buttons",
    );
    const endListingData = expectDefined(
      endListingButtons[0]?.[0]?.callback_data,
      "expected end-listing callback data",
    );
    await handleTelegramExternalChatCallback({
      chatId: "123",
      data: endListingData,
      sendMessage,
      editMessage,
      clearButtons,
    });

    const lastEditCall = expectDefined(
      editMessage.mock.calls.at(-1) as [string, unknown] | undefined,
      "expected final edit message call",
    );
    expect(lastEditCall[0]).toBe("Marked as sold, but ending the eBay listing failed.");
  });

  it("updates defaults from natural language and shows them on /defaults", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/external-chat-link/defaults/update")) {
        return new Response(
          JSON.stringify({
            ok: true,
            defaultSoldChannel: "flea",
            defaultEndListing: true,
            hasDefaultsConfigured: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-link/defaults/get")) {
        return new Response(
          JSON.stringify({
            ok: true,
            defaultSoldChannel: "flea",
            defaultEndListing: true,
            hasDefaultsConfigured: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: privateChat,
        date: 1,
        text: "売れたチャネルはfleaで、ebayからのデリストもデフォルトにしてください",
      },
      media: [],
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("Sold channel: Flea"),
      expect.objectContaining({ replyToMessageId: 1 }),
    );

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 2,
        chat: privateChat,
        date: 2,
        text: "/defaults",
      },
      media: [],
      sendMessage,
    });

    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("eBay delist: Yes"),
      expect.objectContaining({ replyToMessageId: 2 }),
    );
  });

  it("starts mark-as-sold flow from natural language and asks for a photo", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    globalThis.fetch = vi.fn() as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: privateChat,
        date: 1,
        text: "Please mark this as sold on flea and delist it from eBay",
      },
      media: [],
      sendMessage,
    });

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("Send a product photo to start mark-as-sold."),
      expect.objectContaining({ replyToMessageId: 1 }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("sold channel = Flea, eBay delist = Yes"),
      expect.objectContaining({ replyToMessageId: 1 }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not treat explanatory delist text as external-chat intent", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const sendMessage = vi.fn(async () => undefined);

    const handled = await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: privateChat,
        date: 1,
        text: "What does delist mean?",
      },
      media: [],
      sendMessage,
    });

    expect(handled).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("applies natural-language session overrides to the current sold flow only", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extchat-"));
    const imagePath = path.join(tmpDir, "photo.jpg");
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/external-chat-reconcile/search")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            autoSelectCandidateIndex: 0,
            autoSelectCandidateTitle: "Vintage Jacket",
            autoSelected: {
              candidateIndex: 0,
              candidateTitle: "Vintage Jacket",
              requiresEndListingChoice: true,
            },
            candidates: [{ candidateIndex: 0, title: "Vintage Jacket" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-link/defaults/get")) {
        return new Response(
          JSON.stringify({
            ok: true,
            defaultSoldChannel: "store",
            defaultEndListing: false,
            hasDefaultsConfigured: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-reconcile/confirm")) {
        expectDefined(init?.body as string | undefined, "expected confirm request body");
        expect(JSON.parse(String(init?.body))).toEqual(
          expect.objectContaining({
            soldPrice: 220,
            soldChannel: "flea",
            endListing: true,
          }),
        );
        return new Response(
          JSON.stringify({
            ok: true,
            resultCode: "sold_marked",
            messageCode: "marked_as_sold",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: {
        message_id: 1,
        chat: privateChat,
        date: 1,
        text: "Mark this as sold on flea and delist this from eBay",
      },
      media: [],
      sendMessage,
    });

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 2, chat: privateChat, date: 2 },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
    });

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 3, chat: privateChat, date: 3, text: "220" },
      media: [],
      sendMessage,
    });

    expect(sendMessage).toHaveBeenLastCalledWith("Marked as sold.");
  });

  it("auto-selects the top candidate and finishes after sold price", async () => {
    process.env.SUPABASE_FUNCTION_BASE_URL = "https://example.supabase.co/functions/v1";
    process.env.OPENCLAW_TO_SUPABASE_SHARED_SECRET = "secret";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extchat-"));
    const imagePath = path.join(tmpDir, "photo.jpg");
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/item.jpg") {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      if (url.endsWith("/external-chat-reconcile/search")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "00000000-0000-0000-0000-000000000123",
            autoSelectCandidateIndex: 0,
            autoSelectCandidateTitle: "Vintage Jacket",
            autoSelected: {
              candidateIndex: 0,
              candidateTitle: "Vintage Jacket",
              requiresEndListingChoice: true,
              imageUrl: "https://example.com/item.jpg",
              priceLabel: "$316",
              channelLabel: "EBAY",
              ebayStateLabel: "ACTIVE",
              ebayItemUrl: "https://www.ebay.com/itm/1234567890",
            },
            candidates: [{ candidateIndex: 0, title: "Vintage Jacket" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-link/defaults/get")) {
        return new Response(
          JSON.stringify({
            ok: true,
            defaultSoldChannel: "flea",
            defaultEndListing: true,
            hasDefaultsConfigured: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/external-chat-reconcile/confirm")) {
        return new Response(
          JSON.stringify({
            ok: true,
            resultCode: "sold_marked",
            messageCode: "marked_as_sold",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const sendMessage = vi.fn(async () => undefined);
    const sendPhoto = vi.fn(async () => undefined);

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 1, chat: privateChat, date: 1 },
      media: [{ path: imagePath, contentType: "image/jpeg" }],
      sendMessage,
      sendPhoto,
    });

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const autoSelectedPhotoCall = expectDefined(
      sendPhoto.mock.calls[0] as unknown as [unknown, string, unknown] | undefined,
      "expected auto-selected photo call",
    );
    expect(autoSelectedPhotoCall[1]).toContain("1. Vintage Jacket");
    expect(autoSelectedPhotoCall[1]).toContain("eBay: https://www.ebay.com/itm/1234567890");
    expect(sendMessage).toHaveBeenCalledWith(
      "Auto-selected match: Vintage Jacket",
      expect.objectContaining({ replyToMessageId: 1 }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith("Choose a match:", expect.anything());

    await handleTelegramExternalChatMessage({
      chatId: "123",
      message: { message_id: 2, chat: privateChat, date: 2, text: "220" },
      media: [],
      sendMessage,
    });

    expect(sendMessage).toHaveBeenLastCalledWith("Marked as sold.");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      "https://example.supabase.co/functions/v1/external-chat-reconcile/select",
    );
  });
});
