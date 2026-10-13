// server.js: the whole backend of the chat app.
//
// What this file does, in order:
//   1. Loads the API key from .env (it never leaves this server)
//   2. Serves the web page from the public/ folder
//   3. GET  /api/models  -> the list of models the page may use, with prices
//   4. POST /api/chat    -> checks the request, calls Claude, sends back the
//                           reply PLUS the raw request/response JSON for the inspector

import "dotenv/config"; // reads .env so ANTHROPIC_API_KEY is in process.env
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";

// ---------- Settings ----------

const PORT = Number(process.env.PORT) || 3000;

// The server stops making calls once it has spent this much since it started.
// A safety net, so a bug or a loop can't run up your bill.
const MAX_SPEND_USD = Number(process.env.MAX_SPEND_USD) || 1.0;

// The only models the page is allowed to ask for. If the page sent any model
// name it liked, anyone who could reach this server could spend your credit on
// the most expensive model. Prices are US dollars per million tokens.
const MODELS = [
  { id: "claude-haiku-5-5", label: "Haiku 5.5", inputPrice: 0.1, outputPrice: 0.5 },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", inputPrice: 2, outputPrice: 10 },
];

// Limits on what the page may send.
const MAX_MESSAGES = 40; // messages in the history
const MAX_TOTAL_CHARS = 60000; // characters across the whole history
const MAX_SYSTEM_CHARS = 2000; // characters in the system prompt
const MAX_TOKENS_LIMIT = 4096; // the biggest max_tokens the page may ask for

// ---------- Setup ----------

// One client for the whole server. It finds ANTHROPIC_API_KEY in process.env by itself.
const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("Warning: ANTHROPIC_API_KEY is not set. Create a .env file (see .env.example).");
}

let spentUsd = 0; // running cost since the server started

const app = express();
app.use(express.json({ limit: "200kb" })); // lets us read JSON request bodies
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url)))); // the web page

// ---------- Routes ----------

// The page asks for this once, to fill the model dropdown.
app.get("/api/models", (req, res) => {
  res.json({ models: MODELS, maxTokensLimit: MAX_TOKENS_LIMIT, maxSpendUsd: MAX_SPEND_USD });
});

// The page sends the whole conversation here on every message.
app.post("/api/chat", async (req, res) => {
  // Step 1: check what the page sent.
  const checked = checkInput(req.body);
  if (checked.error) {
    return res.status(400).json({ ok: false, error: { status: 400, type: "bad_request", message: checked.error } });
  }
  const { request, model } = checked; // request = exactly what we will send to Claude

  // Step 2: stop if we have already spent our limit.
  if (spentUsd >= MAX_SPEND_USD) {
    return res.status(429).json({
      ok: false,
      error: {
        status: 429,
        type: "spend_guard",
        message: `Spend guard: $${spentUsd.toFixed(4)} spent since the server started (limit $${MAX_SPEND_USD}). Restart the server to reset.`,
      },
      debug: { request },
    });
  }

  // Step 3: call Claude. withResponse() gives us the parsed answer AND the raw
  // HTTP response, so we can read the headers.
  const started = Date.now();
  try {
    const { data, response } = await client.messages.create(request).withResponse();
    const ms = Date.now() - started;

    const cost = costOf(model, data.usage);
    spentUsd += cost;

    // The reply is a list of blocks. Keep only the text ones and join them.
    const reply = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    res.json({
      ok: true,
      reply,
      debug: {
        request, // what we sent
        response: data, // the full response body, untouched
        headers: pickHeaders(response.headers),
        ms,
        cost,
        sessionCost: spentUsd,
      },
    });
  } catch (error) {
    // Claude (or the network) said no. Send the real error back so the page can show it.
    const ms = Date.now() - started;
    const status = error.status || 500;
    res.status(status).json({
      ok: false,
      error: {
        status,
        type: error.error?.error?.type || error.name || "error",
        message: error.message,
        request_id: error.requestID || null,
      },
      debug: {
        request,
        response: error.error || null, // the error body Claude sent, if any
        headers: pickHeaders(error.headers),
        ms,
        cost: 0,
        sessionCost: spentUsd,
      },
    });
  }
});

// Catches anything unexpected, such as a request body that is not valid JSON.
app.use((error, req, res, next) => {
  res.status(400).json({ ok: false, error: { status: 400, type: "bad_request", message: error.message } });
});

// Listen on 127.0.0.1 only, so the app can be reached from this computer and nothing else.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Chat app running at http://localhost:${PORT}`);
});

// ---------- Helpers ----------

// Checks the body from the page and builds the request we will send to Claude.
// Returns { error } if something is wrong, or { request, model } if it is fine.
function checkInput(body) {
  if (!body || typeof body !== "object") return { error: "Send a JSON body." };

  const model = MODELS.find((m) => m.id === body.model);
  if (!model) return { error: "That model is not allowed." };

  const maxTokens = Number(body.max_tokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_LIMIT) {
    return { error: `max_tokens must be a whole number from 1 to ${MAX_TOKENS_LIMIT}.` };
  }

  const system = typeof body.system === "string" ? body.system.trim() : "";
  if (system.length > MAX_SYSTEM_CHARS) return { error: `The system prompt is over ${MAX_SYSTEM_CHARS} characters.` };

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { error: "Send at least one message." };
  if (messages.length > MAX_MESSAGES) return { error: `Too many messages (limit ${MAX_MESSAGES}). Clear the chat.` };

  let totalChars = 0;
  for (const m of messages) {
    const roleOk = m && (m.role === "user" || m.role === "assistant");
    const textOk = m && typeof m.content === "string" && m.content.trim().length > 0;
    if (!roleOk || !textOk) return { error: "Each message needs a role (user or assistant) and some text." };
    totalChars += m.content.length;
  }
  if (totalChars > MAX_TOTAL_CHARS) return { error: "The conversation is too long. Clear the chat." };
  if (messages[messages.length - 1].role !== "user") return { error: "The last message must be from the user." };

  // Build the request. Only these fields are copied, nothing else from the page.
  const request = { model: model.id, max_tokens: maxTokens };
  if (system) request.system = system; // leave the field out when there is no system prompt
  request.messages = messages.map((m) => ({ role: m.role, content: m.content }));

  return { request, model };
}

// Dollars for one call: tokens times price per million.
function costOf(model, usage) {
  const input = (usage.input_tokens * model.inputPrice) / 1_000_000;
  const output = (usage.output_tokens * model.outputPrice) / 1_000_000;
  return input + output;
}

// Only pass these response headers to the page: the request id and anything
// starting with "anthropic-". Nothing else, so nothing sensitive can leak.
function pickHeaders(headers) {
  const picked = {};
  if (!headers) return picked;
  for (const [name, value] of headers.entries()) {
    if (name === "request-id" || name.startsWith("anthropic-")) picked[name] = value;
  }
  return picked;
}
