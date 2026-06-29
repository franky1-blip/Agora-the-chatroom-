/**
 * app.js
 * ---------------------------------------------------------------------------
 * Client-side logic for the chat application.
 *
 * Responsibilities:
 *  - Establish the Socket.io connection and wire up all event listeners.
 *  - Manage local UI state (current channel, username, online users).
 *  - Render messages, reactions, typing indicators, and the user/channel
 *    lists into the DOM.
 *  - Handle the username + create-channel modals, including session
 *    persistence via sessionStorage (so a refresh keeps your name).
 * ---------------------------------------------------------------------------
 */

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  const state = {
    username: null,
    color: null,
    currentChannel: 'general',
    channels: [],
    users: [],
    typingTimeout: null,
    isTyping: false,
  };

  const SESSION_KEY = 'chatapp_username';

  // -----------------------------------------------------------------------
  // DOM references
  // -----------------------------------------------------------------------

  const el = {
    usernameModal: document.getElementById('username-modal'),
    usernameInput: document.getElementById('username-input'),
    usernameError: document.getElementById('username-error'),
    usernameSubmit: document.getElementById('username-submit'),

    channelModal: document.getElementById('channel-modal'),
    channelInput: document.getElementById('channel-input'),
    channelError: document.getElementById('channel-error'),
    channelSubmit: document.getElementById('channel-submit'),
    channelCancel: document.getElementById('channel-cancel'),
    addChannelBtn: document.getElementById('add-channel-btn'),

    app: document.getElementById('app'),
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebar-toggle'),

    channelList: document.getElementById('channel-list'),
    userList: document.getElementById('user-list'),
    usersCount: document.getElementById('users-count'),
    usersCountSidebar: document.getElementById('users-count-sidebar'),

    currentChannelLabel: document.getElementById('current-channel-label'),
    myUsernameBtn: document.getElementById('my-username-btn'),
    connectionStatus: document.getElementById('connection-status'),

    messages: document.getElementById('messages'),
    typingIndicator: document.getElementById('typing-indicator'),

    messageForm: document.getElementById('message-form'),
    messageInput: document.getElementById('message-input'),

    toastContainer: document.getElementById('toast-container'),
  };

  // -----------------------------------------------------------------------
  // Socket connection
  // -----------------------------------------------------------------------

  const socket = io();

  socket.on('connect', () => {
    el.connectionStatus.classList.remove('offline');
    const savedUsername = sessionStorage.getItem(SESSION_KEY);
    if (savedUsername) {
      socket.emit('set_username', { username: savedUsername });
    }
  });

  socket.on('disconnect', () => {
    el.connectionStatus.classList.add('offline');
    showToast('Connection lost. Trying to reconnect...');
  });

  socket.on('connect_error', () => {
    el.connectionStatus.classList.add('offline');
  });

  // ---- Username flow -------------------------------------------------

  socket.on('username_set', ({ username, color }) => {
    state.username = username;
    state.color = color;
    sessionStorage.setItem(SESSION_KEY, username);

    el.usernameModal.hidden = true;
    el.app.hidden = false;
    el.myUsernameBtn.textContent = username;

    // Join default channel once we have an identity.
    socket.emit('join_channel', { channelId: state.currentChannel });
  });

  socket.on('username_error', ({ message }) => {
    el.usernameError.textContent = message;
    el.usernameError.hidden = false;
  });

  // ---- Channels ---------------------------------------------------------

  socket.on('channel_list', ({ channels }) => {
    state.channels = channels;
    renderChannelList();
  });

  socket.on('channel_created', ({ channel }) => {
    closeChannelModal();
    switchChannel(channel.id);
  });

  socket.on('channel_history', ({ channelId, messages }) => {
    if (channelId !== state.currentChannel) return;
    el.messages.innerHTML = '';
    messages.forEach(renderMessage);
    scrollToBottom();
  });

  // ---- Messaging ----------------------------------------------------------

  socket.on('new_message', (message) => {
    if (message.channel !== state.currentChannel) return;
    renderMessage(message);
    scrollToBottom();
  });

  socket.on('reaction_update', ({ messageId, reactions }) => {
    updateReactionDisplay(messageId, reactions);
  });

  // ---- Presence -----------------------------------------------------------

  socket.on('user_list', ({ users, count }) => {
    state.users = users;
    el.usersCount.textContent = count;
    el.usersCountSidebar.textContent = count;
    renderUserList();
  });

  socket.on('typing_update', ({ channel, usernames }) => {
    if (channel !== state.currentChannel) return;
    renderTypingIndicator(usernames);
  });

  // ---- Errors ---------------------------------------------------------

  socket.on('error_message', ({ message }) => {
    showToast(message);
  });

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  function renderChannelList() {
    el.channelList.innerHTML = '';
    state.channels.forEach((channel) => {
      const li = document.createElement('li');
      li.className = channel.id === state.currentChannel ? 'active' : '';
      li.innerHTML = `<span><span class="channel-hash">#</span>${escapeHtml(channel.name)}</span>`;
      li.addEventListener('click', () => switchChannel(channel.id));
      el.channelList.appendChild(li);
    });
  }

  function renderUserList() {
    el.userList.innerHTML = '';
    state.users.forEach((user) => {
      const li = document.createElement('li');
      if (user.username === state.username) li.classList.add('is-me');
      li.innerHTML = `<span class="user-dot"></span><span>${escapeHtml(user.username)}${
        user.username === state.username ? ' (you)' : ''
      }</span>`;
      el.userList.appendChild(li);
    });
  }

  function renderMessage(message) {
    const row = document.createElement('div');

    if (message.system) {
      row.className = 'message-row system';
      row.innerHTML = `<div class="system-text">${escapeHtml(message.text)}</div>`;
      el.messages.appendChild(row);
      return;
    }

    row.className = 'message-row';
    row.dataset.messageId = message.id;

    const initial = (message.username || '?').charAt(0).toUpperCase();
    const avatarColor = message.color || '#5b8cff';
    const time = formatTimestamp(message.timestamp);

    row.innerHTML = `
      <div class="message-avatar" style="background:${avatarColor}">${escapeHtml(initial)}</div>
      <div class="message-content">
        <div class="message-header">
          <span class="message-username" style="color:${avatarColor}">${escapeHtml(message.username)}</span>
          <span class="message-timestamp">${time}</span>
        </div>
        <div class="message-text">${renderMarkdown(message.text)}</div>
        <div class="message-reactions" data-reactions-for="${message.id}"></div>
        <button class="reaction-add-btn" data-react-btn="${message.id}">+ react</button>
      </div>
    `;

    el.messages.appendChild(row);
    updateReactionDisplay(message.id, message.reactions || {});

    const reactBtn = row.querySelector('[data-react-btn]');
    reactBtn.addEventListener('click', (e) => openReactionPicker(e, message.id));
  }

  function updateReactionDisplay(messageId, reactions) {
    const container = el.messages.querySelector(`[data-reactions-for="${messageId}"]`);
    if (!container) return;
    container.innerHTML = '';
    Object.entries(reactions).forEach(([emoji, usernames]) => {
      if (!usernames || usernames.length === 0) return;
      const pill = document.createElement('span');
      pill.className = 'reaction-pill' + (usernames.includes(state.username) ? ' reacted' : '');
      pill.textContent = `${emoji} ${usernames.length}`;
      pill.title = usernames.join(', ');
      pill.addEventListener('click', () => {
        socket.emit('add_reaction', { channel: state.currentChannel, messageId, emoji });
      });
      container.appendChild(pill);
    });
  }

  function openReactionPicker(event, messageId) {
    closeAnyOpenPicker();
    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.dataset.picker = 'true';
    ['👍', '❤️', '😂', '🎉', '😮', '😢'].forEach((emoji) => {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        socket.emit('add_reaction', { channel: state.currentChannel, messageId, emoji });
        picker.remove();
      });
      picker.appendChild(btn);
    });

    document.body.appendChild(picker);
    const rect = event.target.getBoundingClientRect();
    picker.style.top = `${rect.bottom + window.scrollY + 4}px`;
    picker.style.left = `${rect.left + window.scrollX}px`;

    setTimeout(() => {
      document.addEventListener('click', closeAnyOpenPicker, { once: true });
    }, 0);
  }

  function closeAnyOpenPicker() {
    document.querySelectorAll('[data-picker]').forEach((p) => p.remove());
  }

  function renderTypingIndicator(usernames) {
    const others = usernames.filter((u) => u !== state.username);
    if (others.length === 0) {
      el.typingIndicator.hidden = true;
      el.typingIndicator.textContent = '';
      return;
    }
    el.typingIndicator.hidden = false;
    if (others.length === 1) {
      el.typingIndicator.textContent = `${others[0]} is typing...`;
    } else if (others.length === 2) {
      el.typingIndicator.textContent = `${others[0]} and ${others[1]} are typing...`;
    } else {
      el.typingIndicator.textContent = `Several people are typing...`;
    }
  }

  // -----------------------------------------------------------------------
  // Lightweight markdown: **bold**, *italic*, `code`, ```code block```
  // Applied AFTER escaping HTML so user input can't inject tags.
  // -----------------------------------------------------------------------

  function renderMarkdown(rawText) {
    let text = escapeHtml(rawText);

    // Code blocks first (so contents aren't touched by bold/italic rules)
    text = text.replace(/```([\s\S]+?)```/g, (_, code) => `<pre>${code}</pre>`);
    text = text.replace(/`([^`]+?)`/g, (_, code) => `<code>${code}</code>`);
    text = text.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');

    return text;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  function formatTimestamp(ts) {
    const d = new Date(ts);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    el.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // -----------------------------------------------------------------------
  // Channel switching
  // -----------------------------------------------------------------------

  function switchChannel(channelId) {
    if (channelId === state.currentChannel) return;
    state.currentChannel = channelId;
    socket.emit('join_channel', { channelId });

    const channel = state.channels.find((c) => c.id === channelId);
    el.currentChannelLabel.textContent = `#${channel ? channel.name : channelId}`;
    el.messageInput.placeholder = `Message #${channel ? channel.name : channelId}  (Enter to send, Ctrl+Enter for new line)`;

    renderChannelList();
    closeSidebarOnMobile();
  }

  // -----------------------------------------------------------------------
  // Username modal interactions
  // -----------------------------------------------------------------------

  el.usernameSubmit.addEventListener('click', submitUsername);
  el.usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitUsername();
  });

  function submitUsername() {
    const value = el.usernameInput.value.trim();
    el.usernameError.hidden = true;
    if (!value) {
      el.usernameError.textContent = 'Please enter a username.';
      el.usernameError.hidden = false;
      return;
    }
    socket.emit('set_username', { username: value });
  }

  el.myUsernameBtn.addEventListener('click', () => {
    el.usernameInput.value = state.username || '';
    el.usernameModal.hidden = false;
  });

  // -----------------------------------------------------------------------
  // Channel creation modal interactions
  // -----------------------------------------------------------------------

  el.addChannelBtn.addEventListener('click', () => {
    el.channelInput.value = '';
    el.channelError.hidden = true;
    el.channelModal.hidden = false;
    el.channelInput.focus();
  });

  el.channelCancel.addEventListener('click', closeChannelModal);

  el.channelSubmit.addEventListener('click', submitNewChannel);
  el.channelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNewChannel();
  });

  function submitNewChannel() {
    const value = el.channelInput.value.trim();
    if (!value) {
      el.channelError.textContent = 'Please enter a channel name.';
      el.channelError.hidden = false;
      return;
    }
    socket.emit('create_channel', { name: value });
  }

  function closeChannelModal() {
    el.channelModal.hidden = true;
  }

  // -----------------------------------------------------------------------
  // Message composing + typing indicator
  // -----------------------------------------------------------------------

  el.messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendCurrentMessage();
  });

  el.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      sendCurrentMessage();
    }
    // Ctrl+Enter (or Shift+Enter) inserts a newline by default textarea behavior.
  });

  el.messageInput.addEventListener('input', () => {
    autoGrowTextarea();
    notifyTyping(true);
  });

  el.messageInput.addEventListener('blur', () => notifyTyping(false));

  function sendCurrentMessage() {
    const text = el.messageInput.value.trim();
    if (!text) return;
    socket.emit('send_message', { text, channel: state.currentChannel });
    el.messageInput.value = '';
    autoGrowTextarea();
    notifyTyping(false);
  }

  function notifyTyping(isTyping) {
    if (isTyping === state.isTyping) {
      // Still refresh the server-side timeout while actively typing.
      if (isTyping) socket.emit('typing', { channel: state.currentChannel, isTyping: true });
      return;
    }
    state.isTyping = isTyping;
    socket.emit('typing', { channel: state.currentChannel, isTyping });
  }

  function autoGrowTextarea() {
    el.messageInput.style.height = 'auto';
    el.messageInput.style.height = `${Math.min(el.messageInput.scrollHeight, 140)}px`;
  }

  // -----------------------------------------------------------------------
  // Mobile sidebar toggle
  // -----------------------------------------------------------------------

  let backdropEl = null;

  el.sidebarToggle.addEventListener('click', () => {
    const isOpen = el.sidebar.classList.contains('open');
    if (isOpen) {
      closeSidebarOnMobile();
    } else {
      el.sidebar.classList.add('open');
      backdropEl = document.createElement('div');
      backdropEl.className = 'sidebar-backdrop';
      backdropEl.addEventListener('click', closeSidebarOnMobile);
      document.body.appendChild(backdropEl);
    }
  });

  function closeSidebarOnMobile() {
    el.sidebar.classList.remove('open');
    if (backdropEl) {
      backdropEl.remove();
      backdropEl = null;
    }
  }

  // Auto-focus username field on load.
  window.addEventListener('DOMContentLoaded', () => {
    el.usernameInput.focus();
  });
})();
