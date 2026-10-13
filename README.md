# Sunflower Studio (claude-chat-app)

A small chat app for learning the Claude API. You chat on the left. On the right, an inspector shows the real request your server sent to Claude and the raw response that came back, with tokens, latency and cost.

## Run it

1. Copy `.env.example` to `.env` and put your own API key in it. Use a key from a workspace with a spend limit.
2. `npm install`
3. `npm start`
4. Open http://localhost:3000

## Set up the Claude API from zero

Never used the Messages API before? This takes about 15 minutes. Steps marked **Console** happen in the browser at platform.claude.com.

1. **Money (Console).** Creating an API key needs no credit, but using it does. Without credit every call fails with a 400, "Your credit balance is too low". Add a small amount of prepaid credit and keep **auto-reload off**, so the credit is your hard cap.
2. **A workspace with a limit (Console, optional but recommended).** Settings, Workspaces, Create workspace. Open its Spend limits and set a monthly limit and a notification.
3. **A key (Console).** Create it inside that workspace and set an expiration if offered. Copy it as soon as it's shown. It goes only in `.env`. Never paste a key into chat, a ticket or git.
4. **Node and npm.** This project was built with Node v24 and npm 11.
5. **A new project to try the API on its own:**
   ```bash
   mkdir my-claude-test && cd my-claude-test
   git init
   npm pkg set type=module                 # lets you use import/export and top-level await
   npm install @anthropic-ai/sdk dotenv
   printf 'node_modules/\n.env\n' > .gitignore
   touch .env && chmod 600 .env            # then add ANTHROPIC_API_KEY=your-key to .env
   ```
6. **The first call.** Save as `01-first-call.js` and run `node 01-first-call.js` from the same folder as `.env`:
   ```js
   import "dotenv/config";                 // loads .env, so the key is in process.env
   import Anthropic from "@anthropic-ai/sdk";

   const client = new Anthropic();         // finds ANTHROPIC_API_KEY by itself

   const response = await client.messages.create({
     model: "claude-haiku-5-5",            // cheapest and fastest model
     max_tokens: 1024,                     // the most Claude may write (thinking counts too)
     messages: [{ role: "user", content: "Explain what a CDN is in two sentences." }],
   });

   console.log(JSON.stringify(response, null, 2));
   ```
   A good result has `stop_reason: "end_turn"`, one `text` block in `content`, and a `usage` object with the token counts. A call like this costs a small fraction of a cent.

If it fails:

| What you see | Meaning and fix |
|---|---|
| 400, "Your credit balance is too low" | No credit. Add credit in the Console. |
| 401 | Bad or missing key. Check `.env`, the variable name, and that you run the command from the folder that holds `.env`. |
| `Cannot use import statement outside a module` | `"type": "module"` is missing in `package.json`. Run `npm pkg set type=module`. |
| 429 with a `retry-after` header | Rate limit. Wait the stated time. |

To see the same call without the SDK, run it with curl (export the key in your terminal first, never paste it into chat):

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-5-5","max_tokens":100,"messages":[{"role":"user","content":"Hi"}]}'
```

Model IDs change. List the current ones with `client.models.list()` (the Models API) before relying on a name.

## How it works

```
Browser (public/app.js)  ──POST /api/chat──►  Node server (server.js)  ──Messages API──►  Claude
        ◄── reply + request JSON + response JSON + headers ──┘
```

- The browser keeps the whole conversation and sends it with every message. The Claude API remembers nothing between calls.
- The server holds the API key, checks the request, adds nothing the page didn't ask for, and calls Claude. The key never reaches the browser.
- The model dropdown only offers models listed in `server.js` (Haiku 5.5 and Sonnet 5.5).
- The server stops calling Claude once it has spent `MAX_SPEND_USD` (default $1) since it started.

## What to try

- Send two messages in a row and compare the request JSON: the second contains the first turn.
- Switch the model and compare the cost tile.
- Set `max_tokens` to 20 and ask for a long answer. `stop_reason` is `max_tokens`. Thinking counts toward the limit, so the model may spend all 20 tokens thinking and return no text. The app shows a note when that happens.
- Edit the system prompt and watch the `system` field appear in the request.
- Click **Copy as cURL** and run the same call in a terminal.

## Files

| File | What it does |
|---|---|
| `server.js` | Backend: model allow-list, input checks, spend guard, calls Claude, returns the reply plus the raw JSON and headers |
| `public/index.html` | Page structure |
| `public/app.js` | Browser logic: chat history, send, inspector, copy buttons |
| `public/style.css` | The Sunflower Studio look (colours are CSS variables at the top) |
| `public/images/sunflower-bg.svg` | Painted background |
