# Chat App

A real-time, text-based group chat application. Anonymous (no login), multi-channel, with typing indicators, reactions, and lightweight markdown.

## Features

- **No authentication** — pick a username, start chatting. Username persists in your browser session (survives refresh, cleared on tab close).
- **Channels** — default `#general` and `#random`, plus the ability to create new ones from the sidebar.
- **Real-time messaging** via Socket.io — messages, joins/leaves, and renames broadcast instantly.
- **Typing indicators** — see who's currently typing in your channel.
- **Online users list** with live count, deduplicated usernames.
- **Message history** — last 100 messages per channel, kept in memory.
- **Reactions** — 👍 ❤️ 😂 🎉 😮 😢 on any message, toggle on/off.
- **Lightweight markdown** — `**bold**`, `*italic*`, `` `inline code` ``, and triple-backtick code blocks.
- **Direct messages** — a `send_dm` socket event is implemented server-side for 1:1 messaging (see "Extending" below for hooking up UI).
- **Security basics** — HTML stripped from all input (XSS prevention), message/username length caps, a simple profanity filter, and per-socket rate limiting.
- **Mobile responsive** — sidebar collapses into a slide-out overlay on small screens.

## Project structure

```
/chat-app
  /public
    index.html      # App shell + modals
    style.css       # Dark theme styling
    app.js          # Client-side Socket.io logic + DOM rendering
  /server
    server.js       # Express + Socket.io backend, in-memory store
  package.json
```

## Running locally

**Requirements:** Node.js 18+

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

Then open **http://localhost:3000** in your browser. Open it in a second tab (or a different browser) to see real-time messaging, presence, and typing indicators in action between two "users."

To run on a different port:

```bash
PORT=5000 npm start
```

### Automated test

An integration test simulates two connected clients and exercises username setting, channel joins, messaging, XSS sanitization, typing indicators, reactions, channel creation, rate limiting, and disconnect handling. With the server running in one terminal:

```bash
npm test
```


## How the storage is structured (and how to swap in a real database)

All state lives in the `store` object in `server/server.js`:

```js
store.channels  // Map<channelId, { id, name, createdAt }>
store.messages  // Map<channelId, Array<Message>>
store.users     // Map<socketId, { id, username, color, currentChannel }>
store.typing    // Map<channelId, Map<socketId, timeoutHandle>>
```

To move to a persistent store (e.g. PostgreSQL, MongoDB, Redis):

1. Replace `store.channels` / `store.messages` reads/writes with async calls to your DB (e.g. `await db.messages.find({ channel: channelId })`).
2. Most event handlers (`send_message`, `join_channel`, etc.) would just need their synchronous `store.X.get/set` calls turned into `await`-ed DB calls — the event/emit structure stays the same.
3. `store.users` (who's online right now) and `store.typing` should probably stay in-memory or move to Redis if you scale to multiple server instances, since they represent live connection state, not durable data.
4. If you run multiple server instances, use the [Socket.io Redis adapter](https://socket.io/docs/v4/redis-adapter/) so broadcasts reach users connected to other instances.

## Security considerations implemented

- **XSS prevention**: all user-supplied text (usernames, messages, channel names) has HTML tags stripped server-side before storage/broadcast, and is HTML-escaped again client-side before rendering. Markdown formatting is applied *after* escaping, so it can't be used to inject raw HTML.
- **Input length limits**: usernames capped at 24 chars, messages at 2000 chars, channel names at 32 chars.
- **Rate limiting**: a sliding window limits each socket to 12 messages per 5 seconds; further messages are rejected with an error toast.
- **Duplicate username prevention**: two active connections can't hold the same username simultaneously.
- **Profanity filter**: a basic word-list filter masks matches with asterisks (`server/server.js`, `PROFANITY_LIST` — easily extended).
- **Payload size cap**: Socket.io is configured with `maxHttpBufferSize: 1e6` (1MB) to guard against oversized payloads.

These are reasonable defaults for a small/internal deployment. For a public production deployment you'd want to additionally add: a more robust profanity/moderation service, server-side request logging, HTTPS termination (e.g. via a reverse proxy), and possibly CAPTCHA or stricter rate limiting on connection/username-setting to deter spam bots.

## Known limitations / things to extend

- **In-memory only**: restarting the server clears all messages, channels (beyond the two seeded ones), and online users. This is by design for the "no database needed" requirement, but see the storage section above for how to persist it.
- **No channel deletion/renaming UI** — channels can only be created, not removed, from the current UI (easy to add: a `delete_channel` socket event mirroring `create_channel`).
- **Direct messages have no UI yet** — the `send_dm` / `dm_message` events exist and work over the socket, but there's no sidebar/inbox UI wired up in `app.js`. To add it: render each online user in `user-list` as clickable, open a small DM panel, and emit/listen on `send_dm` / `dm_message` (each DM payload includes `from`, `to`, `text`, `timestamp`).
- **File sharing** is not implemented (only a conceptual placeholder was requested) — would need an upload endpoint (e.g. `multer` + Express route) and a message type for attachments.
- **Profanity filter** is intentionally minimal — swap `PROFANITY_LIST` in `server.js` for a proper library (e.g. `bad-words`) for real moderation needs.

## Testing it manually

1. Run `npm start`.
2. Open two browser windows side by side at `http://localhost:3000`.
3. Set different usernames in each.
4. Send a message from one — confirm it appears instantly in the other.
5. Start typing (without sending) in one window — confirm "is typing…" appears in the other.
6. Create a new channel from the `+` button — confirm it appears in both windows' sidebars.
7. Switch channels — confirm message history loads correctly per channel.
8. Hover a message and click "+ react" — confirm the reaction appears for both users and can be toggled off.
9. Close one tab — confirm a "disconnected" system message appears and the online count drops in the other window.
