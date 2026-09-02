import assert from "node:assert/strict";
import test from "node:test";
import { BotStore } from "../src/store.js";
import { buildChatHistoryExport } from "../src/telegram.js";

test("chat history keeps the latest message version and exports only the requested day", async () => {
  const store = new BotStore(),
    now = Math.floor(Date.now() / 1000),
    chatId = "-100123";
  try {
    store.recordChatMessage({
      chat_id: chatId,
      message_id: 1,
      created_at: now - 90_000,
      direction: "in",
      message_type: "text",
      sender_name: "Old",
      text: "older than one day",
    });
    store.recordChatMessage({
      chat_id: chatId,
      message_id: 2,
      created_at: now - 60,
      direction: "in",
      message_type: "text",
      sender_name: "Alice",
      sender_username: "alice",
      sender_id: "42",
      text: "first version",
    });
    store.recordChatMessage({
      chat_id: chatId,
      message_id: 2,
      created_at: now - 50,
      direction: "in",
      message_type: "text",
      sender_name: "Alice",
      sender_username: "alice",
      sender_id: "42",
      text: "edited token call",
    });
    store.recordChatMessage({
      chat_id: chatId,
      message_id: 3,
      created_at: now - 40,
      direction: "out",
      message_type: "text",
      sender_name: "bot",
      text: "scan result",
    });
    const rows = await store.chatHistory(chatId, now - 86_400);
    assert.deepEqual(
      rows.map((row) => row.text),
      ["edited token call", "scan result"],
    );
    const parsed = buildChatHistoryExport(chatId, rows, now - 86_400, now)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(parsed[0].record_type, "export_metadata");
    assert.equal(parsed[0].message_count, 2);
    assert.equal(parsed[1].username, "alice");
    assert.equal(parsed[2].direction, "out");
  } finally {
    await store.close();
  }
});
