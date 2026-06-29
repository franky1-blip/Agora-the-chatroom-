/**
 * server.js
 * ---------------------------------------------------------------------------
 * Backend for the real-time group chat application.
 *
 * Responsibilities:
 *  - Serve the static frontend (public/) via Express.
 *  - Maintain in-memory state for channels, messages, and connected users.
 *  - Handle all real-time events via Socket.io: joining channels, sending
 *    messages, typing indicators, username changes, reactions, and DMs.
 *  - Apply basic security/hygiene: input sanitization, length limits, rate
 *    limiting, and a lightweight profanity filter.
 *
 * Storage note:
 *  All state lives in the `store` object below. It's intentionally shaped
 *  like a tiny database (collections of plain objects keyed by id) so that
 *  swapping in a real database (Mongo, Postgres, Redis, etc.) later only
 *  requires replacing the functions in store.js-style — the event handlers
 *  themselves wouldn't need to change much.
 * ---------------------------------------------------------------------------
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// -----------------------------------------------------------------------
// App / server setup
// -----------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // In production behind a reverse proxy you'd restrict this to your domain.
  cors: {
    origin: '*',
  },
  maxHttpBufferSize: 1e6, // 1MB cap on any single socket payload (DoS guard)
});

const PORT = process.env.PORT || 3000;
const MAX_MESSAGES_PER_CHANNEL = 100;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_USERNAME_LENGTH = 24;
const MAX_CHANNEL_NAME_LENGTH = 32;
const TYPING_TIMEOUT_MS = 4000;

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------
// In-memory "database"
// -----------------------------------------------------------------------

/**
 * store.channels: Map<channelId, { id, name, createdAt }>
 * store.messages: Map<channelId, Array<Message>>
 * store.users:    Map<socketId, { id, username, color, currentChannel }>
 * store.typing:   Map<channelId, Map<socketId, timeoutHandle>>
 */
const store = {
  channels: new Map(),
  messages: new Map(),
  users: new Map(),
  typing: new Map(),
};

// Seed the default channel.
function createChannel(name, { seed = false } = {}) {
  const id = slugify(name);
  if (store.channels.has(id)) return store.channels.get(id);
  const channel = { id, name: seed ? name : name, createdAt: Date.now() };
  store.channels.set(id, channel);
  store.messages.set(id, []);
  store.typing.set(id, new Map());
  return channel;
}

createChannel('General', { seed: true });
createChannel('Random', { seed: true });

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Turn a display name into a safe, unique-ish channel id ("My Channel" -> "my-channel"). */
function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, MAX_CHANNEL_NAME_LENGTH) || `channel-${Date.now()}`;
}

/** Strip HTML tags and trim whitespace. Prevents stored/reflected XSS via chat content. */
function sanitizeText(input, maxLength) {
  if (typeof input !== 'string') return '';
  const noTags = input.replace(/<[^>]*>/g, '');
  return noTags.trim().slice(0, maxLength);
}

// Minimal, easily-extended profanity filter. Not exhaustive by design —
// intended as a light deterrent, not a moderation system.
const PROFANITY_LIST = ['badword1', 'badword2', 'damn', 'hell'];
function filterProfanity(text) {
  let result = text;
  for (const word of PROFANITY_LIST) {
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(re, (match) => '*'.repeat(match.length));
  }
  return result;
}

/** Deterministic color per username so the same name always renders the same color. */
function colorForUsername(username) {
  const palette = [
    '#F87171', '#FB923C', '#FBBF24', '#A3E635', '#34D399',
    '#22D3EE', '#60A5FA', '#A78BFA', '#F472B6', '#FB7185',
  ];
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

function getOnlineUsernames() {
  return Array.from(store.users.values()).map((u) => ({
    id: u.id,
    username: u.username,
    color: u.color,
  }));
}

function broadcastUserList() {
  io.emit('user_list', {
    users: getOnlineUsernames(),
    count: store.users.size,
  });
}

function broadcastChannelList() {
  io.emit('channel_list', {
    channels: Array.from(store.channels.values()),
  });
}

function pushMessage(channelId, message) {
  const list = store.messages.get(channelId);
  if (!list) return;
  list.push(message);
  if (list.length > MAX_MESSAGES_PER_CHANNEL) {
    list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
  }
}

function makeSystemMessage(channelId, text) {
  return {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    username: 'System',
    text,
    timestamp: Date.now(),
    channel: channelId,
    system: true,
    reactions: {},
  };
}

// Simple per-socket rate limiter for chat messages (sliding window).
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 12;
const messageTimestamps = new Map(); // socketId -> array of send times

function isRateLimited(socketId) {
  const now = Date.now();
  const arr = (messageTimestamps.get(socketId) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  arr.push(now);
  messageTimestamps.set(socketId, arr);
  return arr.length > RATE_LIMIT_MAX_MESSAGES;
}

// -----------------------------------------------------------------------
// Socket.io event handling
// -----------------------------------------------------------------------

io.on('connection', (socket) => {
  // Each connection starts "unnamed" until the client sends set_username.
  // We don't add them to store.users until then, so user counts/lists
  // only reflect people who've actually joined.

  socket.on('set_username', ({ username }) => {
    const clean = sanitizeText(username, MAX_USERNAME_LENGTH);
    if (!clean) {
      socket.emit('error_message', { message: 'Username cannot be empty.' });
      return;
    }

    // Prevent duplicate active usernames to avoid confusing chats.
    const taken = Array.from(store.users.values()).some(
      (u) => u.username.toLowerCase() === clean.toLowerCase() && u.id !== socket.id
    );
    if (taken) {
      socket.emit('username_error', { message: 'That username is already in use.' });
      return;
    }

    const existing = store.users.get(socket.id);
    const isRename = !!existing;
    const previousName = existing?.username;

    // Note: currentChannel is intentionally left as whatever it already was
    // (or null for a brand-new connection). It only ever becomes a real
    // value via join_channel, which is also what actually calls
    // socket.join() on the underlying Socket.io room. Pre-seeding this with
    // a default channel name here would desync "the room the socket
    // believes it's in" from "the room it has actually joined."
    const user = {
      id: socket.id,
      username: clean,
      color: colorForUsername(clean),
      currentChannel: existing?.currentChannel || null,
    };
    store.users.set(socket.id, user);

    socket.emit('username_set', { username: clean, color: user.color });

    if (isRename && previousName && previousName !== clean && user.currentChannel) {
      const sysMsg = makeSystemMessage(user.currentChannel, `${previousName} is now known as ${clean}`);
      pushMessage(user.currentChannel, sysMsg);
      io.to(user.currentChannel).emit('new_message', sysMsg);
    }

    broadcastUserList();
  });

  socket.on('join_channel', ({ channelId }) => {
    const user = store.users.get(socket.id);
    if (!user) return;

    const channel = store.channels.get(channelId);
    if (!channel) {
      socket.emit('error_message', { message: 'Channel does not exist.' });
      return;
    }

    const previousChannel = user.currentChannel;
    if (previousChannel === channelId) {
      // Already there; just resend history for a clean refresh.
      socket.emit('channel_history', {
        channelId,
        messages: store.messages.get(channelId) || [],
      });
      return;
    }

    if (previousChannel) {
      socket.leave(previousChannel);
      const leaveMsg = makeSystemMessage(previousChannel, `${user.username} left #${previousChannel}`);
      pushMessage(previousChannel, leaveMsg);
      socket.to(previousChannel).emit('new_message', leaveMsg);
      clearTyping(previousChannel, socket.id, true);
    }

    socket.join(channelId);
    user.currentChannel = channelId;

    const joinMsg = makeSystemMessage(channelId, `${user.username} joined #${channel.name}`);
    pushMessage(channelId, joinMsg);
    socket.to(channelId).emit('new_message', joinMsg);

    socket.emit('channel_history', {
      channelId,
      messages: store.messages.get(channelId) || [],
    });

    broadcastUserList();
  });

  socket.on('create_channel', ({ name }) => {
    const clean = sanitizeText(name, MAX_CHANNEL_NAME_LENGTH);
    if (!clean) {
      socket.emit('error_message', { message: 'Channel name cannot be empty.' });
      return;
    }
    const id = slugify(clean);
    if (store.channels.has(id)) {
      socket.emit('error_message', { message: 'A channel with that name already exists.' });
      return;
    }
    const channel = createChannel(clean);
    broadcastChannelList();
    socket.emit('channel_created', { channel });
  });

  socket.on('send_message', ({ text, channel: channelId }) => {
    const user = store.users.get(socket.id);
    if (!user) {
      socket.emit('error_message', { message: 'Set a username before sending messages.' });
      return;
    }
    if (!store.channels.has(channelId)) {
      socket.emit('error_message', { message: 'Cannot send to an unknown channel.' });
      return;
    }
    if (isRateLimited(socket.id)) {
      socket.emit('error_message', { message: 'You are sending messages too quickly. Slow down a bit.' });
      return;
    }

    const cleanText = filterProfanity(sanitizeText(text, MAX_MESSAGE_LENGTH));
    if (!cleanText) return;

    const message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username: user.username,
      color: user.color,
      text: cleanText,
      timestamp: Date.now(),
      channel: channelId,
      reactions: {}, // emoji -> array of usernames who reacted
    };

    pushMessage(channelId, message);
    io.to(channelId).emit('new_message', message);

    clearTyping(channelId, socket.id, true);
  });

  socket.on('typing', ({ channel: channelId, isTyping }) => {
    const user = store.users.get(socket.id);
    if (!user || !store.channels.has(channelId)) return;

    const channelTyping = store.typing.get(channelId);
    if (!channelTyping) return;

    if (isTyping) {
      // Reset any existing timeout for this user.
      clearTyping(channelId, socket.id, false);
      const handle = setTimeout(() => clearTyping(channelId, socket.id, true), TYPING_TIMEOUT_MS);
      channelTyping.set(socket.id, handle);
      emitTypingList(channelId);
    } else {
      clearTyping(channelId, socket.id, true);
    }
  });

  socket.on('add_reaction', ({ channel: channelId, messageId, emoji }) => {
    const user = store.users.get(socket.id);
    if (!user) return;
    const list = store.messages.get(channelId);
    if (!list) return;
    const message = list.find((m) => m.id === messageId);
    if (!message) return;

    const allowedEmoji = ['👍', '❤️', '😂', '🎉', '😮', '😢'];
    if (!allowedEmoji.includes(emoji)) return;

    if (!message.reactions[emoji]) message.reactions[emoji] = [];
    const idx = message.reactions[emoji].indexOf(user.username);
    if (idx === -1) {
      message.reactions[emoji].push(user.username);
    } else {
      // Toggle off if they already reacted with this emoji.
      message.reactions[emoji].splice(idx, 1);
      if (message.reactions[emoji].length === 0) delete message.reactions[emoji];
    }

    io.to(channelId).emit('reaction_update', {
      messageId,
      reactions: message.reactions,
    });
  });

  // Direct messages: simple room-per-pair approach using sorted socket ids.
  socket.on('send_dm', ({ toSocketId, text }) => {
    const sender = store.users.get(socket.id);
    const recipient = store.users.get(toSocketId);
    if (!sender || !recipient) {
      socket.emit('error_message', { message: 'That user is no longer online.' });
      return;
    }
    if (isRateLimited(socket.id)) {
      socket.emit('error_message', { message: 'You are sending messages too quickly.' });
      return;
    }
    const cleanText = filterProfanity(sanitizeText(text, MAX_MESSAGE_LENGTH));
    if (!cleanText) return;

    const dm = {
      id: `dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: { id: sender.id, username: sender.username, color: sender.color },
      to: { id: recipient.id, username: recipient.username },
      text: cleanText,
      timestamp: Date.now(),
    };

    socket.emit('dm_message', dm);
    io.to(toSocketId).emit('dm_message', dm);
  });

  socket.on('disconnect', () => {
    const user = store.users.get(socket.id);
    messageTimestamps.delete(socket.id);

    if (user) {
      const { currentChannel, username } = user;
      store.users.delete(socket.id);

      if (currentChannel) {
        clearTyping(currentChannel, socket.id, true);
        const leaveMsg = makeSystemMessage(currentChannel, `${username} disconnected`);
        pushMessage(currentChannel, leaveMsg);
        io.to(currentChannel).emit('new_message', leaveMsg);
      }

      broadcastUserList();
    }
  });

  // Send initial channel list immediately on connect.
  socket.emit('channel_list', { channels: Array.from(store.channels.values()) });
  broadcastUserList();
});

// -----------------------------------------------------------------------
// Typing indicator helpers (defined after io is set up so they can emit)
// -----------------------------------------------------------------------

function clearTyping(channelId, socketId, shouldEmitUpdate) {
  const channelTyping = store.typing.get(channelId);
  if (!channelTyping) return;
  const handle = channelTyping.get(socketId);
  if (handle) clearTimeout(handle);
  const had = channelTyping.delete(socketId);
  if (had && shouldEmitUpdate) emitTypingList(channelId);
}

function emitTypingList(channelId) {
  const channelTyping = store.typing.get(channelId);
  if (!channelTyping) return;
  const usernames = Array.from(channelTyping.keys())
    .map((sid) => store.users.get(sid)?.username)
    .filter(Boolean);
  io.to(channelId).emit('typing_update', { channel: channelId, usernames });
}

// -----------------------------------------------------------------------
// Basic error handling for the HTTP layer
// -----------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('Uncaught exception:', err);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Chat server running at http://localhost:${PORT}`);
});

