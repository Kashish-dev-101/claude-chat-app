# Sunflower Studio (claude-chat-app)

A small chat app for learning the Claude API. You chat on the left. On the right, an inspector shows the real request your server sent to Claude and the raw response that came back, with tokens, latency and cost.

## Run it

1. Copy `.env.example` to `.env` and put your own API key in it. Use a key from a workspace with a spend limit.
2. `npm install`
3. `npm start`
4. Open http://localhost:3000

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
- Set `max_tokens` to 20 and ask for a long answer. The reply is cut off and `stop_reason` is `max_tokens`.
- Edit the system prompt and watch the `system` field appear in the request.
- Click **Copy as cURL** and run the same call in a terminal.

## Files

See `.claude/CLAUDE.md` for the file list.
