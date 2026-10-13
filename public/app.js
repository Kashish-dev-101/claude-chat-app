// app.js: the browser side of the chat app.
//
// The idea in one paragraph:
//   - We keep the conversation in an array called state.messages.
//   - When you press Send, we post the WHOLE conversation to our server (the
//     Claude API remembers nothing, so we resend the history every time).
//   - The server calls Claude and sends back the reply plus the raw request
//     and response JSON. We draw the reply in the chat and the JSON in the
//     inspector on the right.
//   - The inspector always shows the LATEST call only.

// ---------- Small helpers ----------

const $ = (id) => document.getElementById(id); // shorthand for getElementById

// Makes an element in one line: el("div", "class-name", "text")
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent is safe: it never runs HTML
  return node;
}

// ---------- State: everything the page remembers ----------

const PRESETS = [
  { label: "Concise assistant", text: "You are a concise, friendly assistant. Keep answers short." },
  { label: "One line", text: "Answer in one line." },
  { label: "ImageKit expert", text: "You are an expert on ImageKit, a media CDN and digital asset management platform. Answer briefly and say when you are not sure." },
  { label: "Explain simply", text: "Explain things to a beginner, using a short everyday analogy." },
  { label: "No system prompt", text: "" },
];

const state = {
  messages: [], // the chat: { role: "user" | "assistant" | "error", content, meta?, failed? }
  system: PRESETS[0].text, // the system prompt
  lastCall: null, // the latest API call: { status, request, response, headers, ms, cost, httpStatus }
  tab: "request", // which inspector tab is showing
  pending: false, // true while we wait for Claude
  totalCost: 0, // dollars spent in this chat
};

let config = { models: [], maxTokensLimit: 4096 }; // filled from /api/models

// The request headers we show are fixed text. The real key never reaches the browser.
const REQUEST_HEADERS = {
  "x-api-key": "sk-ant-••••••••",
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
};

// ---------- Start up ----------

init();

async function init() {
  // Ask the server which models we may use, then fill the dropdown.
  try {
    const res = await fetch("/api/models");
    config = await res.json();
  } catch {
    // If this fails we simply have an empty dropdown; sending will show the error.
  }
  for (const m of config.models) {
    const option = el("option", "", m.id);
    option.value = m.id;
    option.title = `${m.label}: $${m.inputPrice} in / $${m.outputPrice} out per million tokens`;
    $("model").appendChild(option);
  }
  $("maxTokens").max = config.maxTokensLimit;

  // System prompt: the pill, the editor, and the preset buttons.
  $("systemInput").value = state.system;
  $("systemPill").addEventListener("click", toggleSystemEditor);
  $("systemInput").addEventListener("input", () => {
    state.system = $("systemInput").value;
    renderSystemPill();
  });
  for (const preset of PRESETS) {
    const button = el("button", "chip-btn", preset.label);
    button.type = "button";
    button.addEventListener("click", () => {
      state.system = preset.text;
      $("systemInput").value = preset.text;
      renderSystemPill();
    });
    $("presets").appendChild(button);
  }

  // Composer: Send button, and Enter to send (Shift+Enter makes a new line).
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });
  $("input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  $("clearBtn").addEventListener("click", clearChat);

  // Inspector tabs, Copy and Copy as cURL.
  for (const tab of document.querySelectorAll(".tab[data-tab]")) {
    tab.addEventListener("click", () => {
      state.tab = tab.dataset.tab;
      renderInspector();
    });
  }
  $("copyBtn").addEventListener("click", () => copyText(currentPaneText(), $("copyBtn")));
  $("curlBtn").addEventListener("click", () => copyText(buildCurl(), $("curlBtn")));

  renderSystemPill();
  render();
}

// ---------- Sending a message ----------

async function send() {
  const text = $("input").value.trim();
  if (!text || state.pending) return;

  setSystemEditor(false); // tuck the system prompt editor away so the chat has the room

  // 1. Add your message to the chat and build the request from the whole history.
  state.messages.push({ role: "user", content: text });
  $("input").value = "";
  const request = buildRequest();

  // 2. Show the request in the inspector straight away, before Claude answers.
  state.lastCall = { status: "pending", request };
  state.tab = "request";
  state.pending = true;
  render();

  // 3. Send it to our server and wait.
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const data = await res.json().catch(() => null);

    if (data && data.ok) {
      handleSuccess(data);
    } else {
      handleError(data, request, res.status);
    }
  } catch (error) {
    // The server could not be reached at all.
    handleError({ error: { message: "Could not reach the server: " + error.message } }, request, 0);
  }

  state.pending = false;
  render();
  $("input").focus();
}

// The call worked: add Claude's reply and fill the inspector with the real JSON.
function handleSuccess(data) {
  const { debug } = data;
  const usage = debug.response.usage;
  const stopReason = debug.response.stop_reason;
  const thinking = usage.output_tokens_details?.thinking_tokens || 0;
  const meta = { stop_reason: stopReason, ms: debug.ms, outTokens: usage.output_tokens, thinking };

  if (data.reply) {
    state.messages.push({ role: "assistant", content: data.reply, meta });
  } else {
    // Claude answered but wrote no text. This happens when max_tokens is so low that
    // the thinking uses it all up. Show a note, and keep it out of the history so the
    // next call isn't confused by it.
    const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
    if (lastUser) lastUser.failed = true;
    const why =
      stopReason === "max_tokens" && thinking > 0
        ? `Claude used all ${usage.output_tokens} output tokens on thinking and wrote no answer. Raise max_tokens and send again.`
        : "The reply had no text.";
    state.messages.push({ role: "notice", content: why, meta });
  }

  state.lastCall = {
    status: "ok",
    httpStatus: 200,
    request: debug.request,
    response: debug.response,
    headers: debug.headers,
    ms: debug.ms,
    cost: debug.cost,
  };
  state.totalCost += debug.cost;
  state.tab = "response";
}

// The call failed: show the error in the chat and the real error JSON in the inspector.
function handleError(data, request, httpStatus) {
  const message = data?.error?.message || "Something went wrong.";

  // The user's message did not get an answer, so keep it on screen but leave it out of the history.
  const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
  if (lastUser) lastUser.failed = true;
  state.messages.push({ role: "error", content: message });

  state.lastCall = {
    status: "error",
    httpStatus: data?.error?.status || httpStatus,
    request: data?.debug?.request || request,
    response: data?.debug?.response || { error: data?.error || { message } },
    headers: data?.debug?.headers || {},
    ms: data?.debug?.ms || 0,
    cost: 0,
  };
  state.tab = "response";
}

// The history we send: only real messages, not error bubbles and not failed ones.
function historyForApi() {
  return state.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.failed)
    .map((m) => ({ role: m.role, content: m.content }));
}

// Builds the request body. It has exactly the fields the server will pass to Claude.
function buildRequest() {
  // max_tokens: keep it a whole number inside the allowed range.
  let maxTokens = Math.round(Number($("maxTokens").value)) || 1024;
  maxTokens = Math.min(Math.max(maxTokens, 1), config.maxTokensLimit);
  $("maxTokens").value = maxTokens;

  const request = { model: $("model").value, max_tokens: maxTokens };
  const system = state.system.trim();
  if (system) request.system = system; // leave the field out when empty
  request.messages = historyForApi();
  return request;
}

function clearChat() {
  state.messages = [];
  state.lastCall = null;
  state.tab = "request";
  state.totalCost = 0;
  state.pending = false;
  render();
  $("input").focus();
}

// ---------- Drawing the page ----------

function render() {
  renderChat();
  renderInspector();
  $("sendBtn").disabled = state.pending;
  $("sendBtn").textContent = state.pending ? "Sending…" : "Send";
}

// Opens or closes the system prompt editor.
function setSystemEditor(open) {
  $("systemEditor").hidden = !open;
  $("systemPill").setAttribute("aria-expanded", String(open));
}

function toggleSystemEditor() {
  setSystemEditor($("systemEditor").hidden); // hidden now means we are opening it
}

// The button stays small: it says whether a system prompt is on. The text itself shows
// in the editor when you open it, and as a tooltip when you hover the button.
function renderSystemPill() {
  const text = state.system.trim();
  $("systemPill").textContent = text ? "System prompt: on" : "System prompt: off";
  $("systemPill").title = text || "No system prompt";
}

function renderChat() {
  const box = $("messages");
  box.replaceChildren();

  if (state.messages.length === 0 && !state.pending) {
    const empty = el("div", "empty");
    empty.appendChild(el("h2", "", "Ask anything"));
    empty.appendChild(el("p", "", "Type a message below. The panel on the right shows the real request and response JSON for every call, with tokens and cost."));
    box.appendChild(empty);
    return;
  }

  for (const m of state.messages) {
    if (m.role === "user") {
      box.appendChild(el("div", m.failed ? "bubble user failed" : "bubble user", m.content));
    } else if (m.role === "error") {
      box.appendChild(el("div", "bubble error", m.content));
    } else if (m.role === "notice") {
      // Claude replied but wrote no text: an amber note plus the usual chips.
      const wrap = el("div", "assistant-wrap");
      wrap.appendChild(el("div", "bubble notice", m.content));
      wrap.appendChild(metaChips(m.meta));
      box.appendChild(wrap);
    } else {
      const wrap = el("div", "assistant-wrap");
      const bubble = el("div", "bubble assistant");
      renderMarkdown(m.content, bubble); // Claude writes Markdown, so draw it properly
      wrap.appendChild(bubble);
      wrap.appendChild(metaChips(m.meta));
      box.appendChild(wrap);
    }
  }

  if (state.pending) {
    const dots = el("div", "bubble assistant typing");
    dots.setAttribute("aria-label", "Claude is replying");
    dots.append(el("span"), el("span"), el("span"));
    box.appendChild(dots);
  }

  // Put your latest question at the top of the box, so you always see it together with
  // the start of the reply. (If the reply is long, scroll down inside the box to read the rest.)
  const lastQuestion = [...box.querySelectorAll(".bubble.user")].pop();
  box.scrollTop = lastQuestion ? lastQuestion.offsetTop - 12 : 0;
}

// The little labels under a reply: why it stopped, how long, how many tokens.
function metaChips(meta) {
  const row = el("div", "chips");
  const cutOff = meta.stop_reason === "max_tokens";
  row.appendChild(el("span", cutOff ? "chip warn" : meta.stop_reason === "end_turn" ? "chip ok" : "chip", meta.stop_reason));
  if (cutOff) row.appendChild(el("span", "chip warn", "cut off"));
  row.appendChild(el("span", "chip", (meta.ms / 1000).toFixed(1) + "s"));
  row.appendChild(el("span", "chip", meta.outTokens + " tokens"));
  // Thinking tokens are billed as output and count toward max_tokens, so show them when there are any.
  if (meta.thinking > 0) row.appendChild(el("span", "chip", meta.thinking + " thinking"));
  return row;
}

// ---------- Markdown for Claude's replies ----------

// Turns the common Markdown in a reply (paragraphs, headings, bullet and numbered
// lists, ``` code blocks, **bold**, `code`) into real elements inside `container`.
// Everything goes in as text, never as HTML, so a reply can't inject anything into the page.
function renderMarkdown(text, container) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const bullet = /^\s*[-*]\s+(.*)$/;
  const numbered = /^\s*\d+[.)]\s+(.*)$/;
  const heading = /^#{1,4}\s+(.*)$/;
  const fence = /^\s*```/;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
    } else if (fence.test(line)) {
      // A code block: everything up to the closing fence, shown as-is.
      const code = [];
      i++;
      while (i < lines.length && !fence.test(lines[i])) code.push(lines[i++]);
      i++; // skip the closing fence
      const pre = el("pre", "md-code");
      pre.textContent = code.join("\n");
      container.appendChild(pre);
    } else if (heading.test(line)) {
      const p = el("p", "md-heading");
      addInline(p, line.match(heading)[1]);
      container.appendChild(p);
      i++;
    } else if (bullet.test(line) || numbered.test(line)) {
      // A list. Blank lines between items are fine, as long as the next item is the same kind.
      const ordered = numbered.test(line);
      const itemPattern = ordered ? numbered : bullet;
      const list = el(ordered ? "ol" : "ul", "md-list");
      if (ordered) list.start = Number(line.match(/^\s*(\d+)/)[1]);
      while (i < lines.length && itemPattern.test(lines[i])) {
        const li = el("li");
        addInline(li, lines[i].match(itemPattern)[1]);
        list.appendChild(li);
        i++;
        let next = i;
        while (next < lines.length && lines[next].trim() === "") next++; // look past blank lines
        if (next < lines.length && itemPattern.test(lines[next])) i = next;
      }
      container.appendChild(list);
    } else {
      // A paragraph: lines up to the next blank line or the start of another block.
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !fence.test(lines[i]) &&
        !heading.test(lines[i]) &&
        !bullet.test(lines[i]) &&
        !numbered.test(lines[i])
      ) {
        para.push(lines[i++]);
      }
      const p = el("p");
      addInline(p, para.join("\n"));
      container.appendChild(p);
    }
  }
}

// Adds text to `node`, turning **bold** and `code` into elements.
function addInline(node, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      node.appendChild(el("strong", "", part.slice(2, -2)));
    } else if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      node.appendChild(el("code", "", part.slice(1, -1)));
    } else if (part) {
      node.appendChild(document.createTextNode(part));
    }
  }
}

function renderInspector() {
  const call = state.lastCall;

  // Tabs: mark the active one.
  for (const tab of document.querySelectorAll(".tab[data-tab]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === state.tab));
  }
  $("copyBtn").disabled = !call;
  $("curlBtn").disabled = !call;

  renderStats(call);

  const body = $("paneBody");
  body.replaceChildren();

  // Nothing sent yet.
  if (!call) {
    $("paneTitle").textContent = "Inspector";
    $("paneNote").textContent = "";
    body.appendChild(el("p", "empty-inspector", "Send a message to see the request your server sends to Claude, and the raw response that comes back."));
    return;
  }

  if (state.tab === "request") {
    $("paneTitle").textContent = "Request JSON";
    $("paneNote").textContent = "What your server sent to Claude (POST /v1/messages). The whole history goes in every time.";
    body.appendChild(jsonBlock(call.request));
  } else if (state.tab === "response") {
    $("paneTitle").textContent = call.status === "error" ? "Error JSON" : "Response JSON";
    if (call.status === "pending") {
      $("paneNote").textContent = "";
      body.appendChild(el("p", "empty-inspector", "Waiting for Claude…"));
    } else {
      $("paneNote").textContent =
        call.status === "error" ? "The call failed. This is the error the API sent back." : "The raw response body, as Claude sent it.";
      body.appendChild(jsonBlock(call.response));
    }
  } else {
    $("paneTitle").textContent = "Headers";
    $("paneNote").textContent = "Metadata beside the JSON. Request headers are what your server sends (the key is hidden).";
    body.appendChild(headersTable("Request headers", REQUEST_HEADERS));
    body.appendChild(
      headersTable(
        "Response headers",
        call.status === "pending"
          ? {}
          : { status: String(call.httpStatus), ...call.headers }
      )
    );
  }
}

// The row of number tiles above the JSON.
function renderStats(call) {
  const done = call && call.status !== "pending";
  const usage = call?.response?.usage;
  const tiles = [
    ["Input", usage ? usage.input_tokens : "–", ""],
    ["Output", usage ? usage.output_tokens : "–", ""],
    ["Time", done && call.ms ? (call.ms / 1000).toFixed(1) + "s" : "–", ""],
    ["Status", done ? call.httpStatus || "–" : "–", done ? (call.httpStatus === 200 ? "good" : "bad") : ""],
    ["Cost", done ? dollars(call.cost) : "–", ""],
    ["Total", dollars(state.totalCost), ""],
  ];
  const box = $("stats");
  box.replaceChildren();
  for (const [label, value, tone] of tiles) {
    const tile = el("div", "stat");
    tile.appendChild(el("span", "", label));
    tile.appendChild(el("b", tone, String(value)));
    box.appendChild(tile);
  }
}

// ---------- JSON display ----------

// Pretty-prints a value as coloured JSON inside a <pre>.
function jsonBlock(value) {
  const pre = el("pre", "json");
  const code = document.createElement("code");
  code.innerHTML = highlight(JSON.stringify(value, null, 2)); // safe: highlight() escapes first
  pre.appendChild(code);
  return pre;
}

// Escapes < > & first, then wraps keys, strings, numbers and true/false/null in coloured spans.
function highlight(json) {
  const safe = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pattern = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  return safe.replace(pattern, (match, str, colon, literal, number) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (literal) return `<span class="j-lit">${literal}</span>`;
    return `<span class="j-num">${number}</span>`;
  });
}

function headersTable(title, headers) {
  const wrap = el("div", "headers");
  wrap.appendChild(el("h3", "", title));
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    wrap.appendChild(el("p", "empty-inspector", "None yet."));
    return wrap;
  }
  const table = el("table");
  for (const [name, value] of entries) {
    const row = el("tr");
    row.appendChild(el("td", "h-name", name));
    row.appendChild(el("td", "h-value", value));
    table.appendChild(row);
  }
  wrap.appendChild(table);
  return wrap;
}

// ---------- Copy buttons ----------

// The text the Copy button copies for the tab that is showing.
function currentPaneText() {
  const call = state.lastCall;
  if (!call) return "";
  if (state.tab === "request") return JSON.stringify(call.request, null, 2);
  if (state.tab === "response") return call.status === "pending" ? "" : JSON.stringify(call.response, null, 2);
  const lines = Object.entries(REQUEST_HEADERS).map(([k, v]) => `${k}: ${v}`);
  const response = { status: String(call.httpStatus), ...call.headers };
  return lines.join("\n") + "\n\n" + Object.entries(response).map(([k, v]) => `${k}: ${v}`).join("\n");
}

// A curl command you can paste in a terminal to repeat this call. It uses
// $ANTHROPIC_API_KEY, so your real key is never written out.
function buildCurl() {
  const body = JSON.stringify(state.lastCall.request, null, 2).replace(/'/g, "'\\''"); // make single quotes safe for the shell
  return [
    "curl https://api.anthropic.com/v1/messages \\",
    '  -H "x-api-key: $ANTHROPIC_API_KEY" \\',
    '  -H "anthropic-version: 2023-06-01" \\',
    '  -H "content-type: application/json" \\',
    `  -d '${body}'`,
  ].join("\n");
}

async function copyText(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    // Some browsers block clipboard access. Select the text so Cmd/Ctrl+C works.
    button.textContent = "Press Cmd/Ctrl+C";
    const block = document.querySelector("#paneBody .json");
    if (block) window.getSelection().selectAllChildren(block);
  }
  setTimeout(() => (button.textContent = original), 1500);
}

function dollars(amount) {
  if (amount === 0) return "$0";
  return amount < 0.01 ? "$" + amount.toFixed(5) : "$" + amount.toFixed(4);
}
