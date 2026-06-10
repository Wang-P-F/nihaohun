// ========== State ==========
let currentUser = null;
let currentChat = null;
let socket = null;
let onlineUsersList = [];
let friends = [];
let friendRequests = [];
let activeTab = 'chats';
let messagesCache = {};

// Voice call state
let peerConnection = null;
let localStream = null;
let callTimer = null;
let callSeconds = 0;
const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Avatar colors
const AVATAR_COLORS = [
  '#0071e3', '#34c759', '#ff9500', '#ff3b30', '#af52de',
  '#5ac8fa', '#ff2d55', '#5856d6', '#00c7be', '#ff6482'
];

function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name) {
  return name.charAt(0).toUpperCase();
}

function setAvatar(el, name) {
  el.style.background = getAvatarColor(name);
  el.textContent = getInitials(name);
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ========== Toast ==========
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ========== Auth ==========
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.auth-tab:${tab === 'login' ? 'first-child' : 'last-child'}`).classList.add('active');
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('authError').classList.remove('show');
}

function showAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.classList.add('show');
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!username || !password) return showAuthError('请输入账号和密码');

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (data.error) return showAuthError(data.error);

  currentUser = data.user;
  enterApp();
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('regUsername').value.trim();
  const nickname = document.getElementById('regNickname').value.trim();
  const password = document.getElementById('regPassword').value;
  const password2 = document.getElementById('regPassword2').value;

  if (!username || !password) return showAuthError('请填写账号和密码');
  if (password !== password2) return showAuthError('两次密码不一致');

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, nickname: nickname || username })
  });
  const data = await res.json();
  if (data.error) return showAuthError(data.error);

  currentUser = data.user;
  showToast('注册成功');
  enterApp();
}

function handleLogout() {
  if (socket) socket.disconnect();
  currentUser = null;
  currentChat = null;
  friends = [];
  friendRequests = [];
  messagesCache = {};
  document.getElementById('authPage').classList.remove('hidden');
  document.getElementById('appPage').classList.remove('active');
}

// ========== Enter App ==========
function enterApp() {
  document.getElementById('authPage').classList.add('hidden');
  document.getElementById('appPage').classList.add('active');

  // Setup profile
  document.getElementById('profileName').textContent = currentUser.nickname;
  document.getElementById('profileId').textContent = `@${currentUser.username}`;
  setAvatar(document.getElementById('profileAvatar'), currentUser.nickname);

  // Connect socket
  socket = io();
  socket.emit('login', currentUser.username);

  socket.on('online-users', (users) => {
    onlineUsersList = users;
    renderContacts();
    if (currentChat) updateChatStatus();
  });

  socket.on('new-message', (msg) => {
    const key = [msg.from, msg.to].sort().join(':');
    if (!messagesCache[key]) messagesCache[key] = [];
    messagesCache[key].push(msg);
    if (currentChat && (msg.from === currentChat.username || msg.to === currentChat.username)) {
      appendMessage(msg);
    }
    renderContacts();
  });

  socket.on('message-sent', (msg) => {
    const key = [msg.from, msg.to].sort().join(':');
    if (!messagesCache[key]) messagesCache[key] = [];
    messagesCache[key].push(msg);
    if (currentChat && msg.to === currentChat.username) {
      appendMessage(msg);
    }
    renderContacts();
  });

  socket.on('friend-request', (data) => {
    showToast(`${data.from.nickname} 请求添加你为好友`);
    loadFriendRequests();
  });

  socket.on('friend-accepted', (data) => {
    showToast(`${data.by.nickname} 接受了你的好友请求`);
    loadFriends();
  });

  socket.on('friend-typing', (data) => {
    if (currentChat && data.from === currentChat.username) {
      document.getElementById('chatStatus').textContent = '正在输入...';
      setTimeout(() => updateChatStatus(), 2000);
    }
  });

  // Voice call signaling
  socket.on('incoming-call', handleIncomingCall);
  socket.on('call-answered', handleCallAnswered);
  socket.on('ice-candidate', handleRemoteICE);
  socket.on('call-rejected', () => {
    showToast('对方拒绝了通话');
    endCall();
  });
  socket.on('call-ended', () => {
    showToast('通话已结束');
    endCall();
  });

  loadFriends();
  loadFriendRequests();
}

// ========== Load Data ==========
async function loadFriends() {
  const res = await fetch(`/api/friends/${currentUser.username}`);
  friends = await res.json();
  renderContacts();
}

async function loadFriendRequests() {
  const res = await fetch(`/api/friends/requests/${currentUser.username}`);
  friendRequests = await res.json();
  updateRequestBadge();
  if (activeTab === 'requests') renderContacts();
}

function updateRequestBadge() {
  const badge = document.getElementById('requestBadge');
  if (friendRequests.length > 0) {
    badge.style.display = 'flex';
    badge.textContent = friendRequests.length;
  } else {
    badge.style.display = 'none';
  }
}

// ========== Sidebar Tabs ==========
function switchSidebarTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  const tabs = document.querySelectorAll('.sidebar-tab');
  const idx = tab === 'chats' ? 0 : tab === 'contacts' ? 1 : 2;
  tabs[idx].classList.add('active');
  renderContacts();
}

// ========== Render Contacts ==========
function renderContacts() {
  const list = document.getElementById('contactList');
  const search = document.getElementById('sidebarSearch').value.trim().toLowerCase();

  if (activeTab === 'chats' || activeTab === 'contacts') {
    let items = friends.filter(f =>
      f.nickname.toLowerCase().includes(search) || f.username.toLowerCase().includes(search)
    );

    if (activeTab === 'chats') {
      items = items.map(f => {
        const key = [currentUser.username, f.username].sort().join(':');
        const msgs = messagesCache[key] || [];
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        return { ...f, lastMsg, lastTime: lastMsg ? lastMsg.createdAt : f.addedAt };
      }).sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    }

    if (items.length === 0) {
      list.innerHTML = `<div style="text-align:center; padding:40px 20px; color:var(--text-tertiary);">
        ${activeTab === 'chats' ? '暂无消息' : '暂无好友'}
        <br><small>点击右上角添加好友开始聊天</small>
      </div>`;
      return;
    }

    list.innerHTML = items.map(f => {
      const isOnline = onlineUsersList.includes(f.username);
      const isActive = currentChat && currentChat.username === f.username;
      const lastMsg = f.lastMsg;
      let preview = '';
      if (lastMsg) {
        preview = lastMsg.type === 'text' ? lastMsg.content : '[语音通话]';
        if (preview.length > 20) preview = preview.substring(0, 20) + '...';
      }
      return `
        <div class="contact-item ${isActive ? 'active' : ''}" onclick="openChat('${f.username}')">
          <div class="avatar" style="background:${getAvatarColor(f.nickname)}">
            ${getInitials(f.nickname)}
            ${isOnline ? '<span class="online-dot"></span>' : ''}
          </div>
          <div class="contact-info">
            <div class="contact-name">${f.nickname}</div>
            <div class="contact-preview">${preview || '@' + f.username}</div>
          </div>
          ${lastMsg ? `<span class="contact-time">${formatTime(lastMsg.createdAt)}</span>` : ''}
        </div>
      `;
    }).join('');
  } else if (activeTab === 'requests') {
    if (friendRequests.length === 0) {
      list.innerHTML = `<div style="text-align:center; padding:40px 20px; color:var(--text-tertiary);">暂无好友请求</div>`;
      return;
    }
    list.innerHTML = friendRequests.map(r => `
      <div class="request-item">
        <div class="avatar" style="background:${getAvatarColor(r.fromUser.nickname)}">${getInitials(r.fromUser.nickname)}</div>
        <div class="search-result-info">
          <div class="search-result-name">${r.fromUser.nickname}</div>
          <div class="search-result-id">@${r.fromUser.username}</div>
        </div>
        <div class="request-actions">
          <button class="btn-accept" onclick="acceptRequest('${r.from}')">接受</button>
          <button class="btn-reject" onclick="rejectRequest('${r.from}')">拒绝</button>
        </div>
      </div>
    `).join('');
  }
}

function filterContacts() {
  renderContacts();
}

// ========== Chat ==========
async function openChat(username) {
  const friend = friends.find(f => f.username === username);
  if (!friend) return;
  currentChat = friend;

  document.getElementById('noSelection').style.display = 'none';
  document.getElementById('chatView').style.display = 'flex';

  setAvatar(document.getElementById('chatAvatar'), friend.nickname);
  document.getElementById('chatName').textContent = friend.nickname;
  updateChatStatus();

  // Load messages
  const res = await fetch(`/api/messages/${currentUser.username}/${username}`);
  const key = [currentUser.username, username].sort().join(':');
  messagesCache[key] = await res.json();

  renderMessages();
  renderContacts();

  document.getElementById('messageInput').focus();
}

function updateChatStatus() {
  if (!currentChat) return;
  const status = document.getElementById('chatStatus');
  if (onlineUsersList.includes(currentChat.username)) {
    status.textContent = '在线';
    status.style.color = 'var(--green)';
  } else {
    status.textContent = '离线';
    status.style.color = 'var(--text-tertiary)';
  }
}

function renderMessages() {
  const container = document.getElementById('messagesContainer');
  const key = [currentUser.username, currentChat.username].sort().join(':');
  const msgs = messagesCache[key] || [];

  container.innerHTML = msgs.map(m => createMessageHTML(m)).join('');
  container.scrollTop = container.scrollHeight;
}

function createMessageHTML(m) {
  const isSent = m.from === currentUser.username;
  return `
    <div class="message-group ${isSent ? 'sent' : 'received'}">
      <div class="message-bubble">${escapeHtml(m.content)}</div>
    </div>
    <div class="message-time">${formatTime(m.createdAt)}</div>
  `;
}

function appendMessage(m) {
  const container = document.getElementById('messagesContainer');
  container.insertAdjacentHTML('beforeend', createMessageHTML(m));
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function handleMessageKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  // Typing indicator
  if (currentChat && socket) {
    socket.emit('typing', { from: currentUser.username, to: currentChat.username });
  }
}

// Enable/disable send button
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('messageInput');
  const btn = document.getElementById('sendBtn');
  if (input && btn) {
    input.addEventListener('input', () => {
      btn.disabled = !input.value.trim();
    });
  }
});

function sendMessage() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if (!content || !currentChat) return;

  socket.emit('send-message', {
    from: currentUser.username,
    to: currentChat.username,
    content,
    type: 'text'
  });

  input.value = '';
  document.getElementById('sendBtn').disabled = true;
}

// ========== Search / Add Friend ==========
function openSearchPanel() {
  document.getElementById('searchPanel').classList.add('active');
  document.getElementById('searchInput').value = '';
  document.getElementById('searchResults').innerHTML = '<p style="color:var(--text-tertiary); text-align:center; padding:24px 0;">输入关键词搜索用户</p>';
  setTimeout(() => document.getElementById('searchInput').focus(), 100);
}

function openQRPanel() {
  document.getElementById('qrPanel').classList.add('active');
  setAvatar(document.getElementById('qrAvatar'), currentUser.nickname);
  document.getElementById('qrName').textContent = currentUser.nickname;
  document.getElementById('qrId').textContent = `@${currentUser.username}`;
  loadQRCode();
}

function closePanel(id) {
  document.getElementById(id).classList.remove('active');
}

let searchTimeout;
async function searchUsers() {
  clearTimeout(searchTimeout);
  const q = document.getElementById('searchInput').value.trim();
  if (!q) {
    document.getElementById('searchResults').innerHTML = '<p style="color:var(--text-tertiary); text-align:center; padding:24px 0;">输入关键词搜索用户</p>';
    return;
  }
  searchTimeout = setTimeout(async () => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const users = await res.json();
    const results = document.getElementById('searchResults');

    const filtered = users.filter(u => u.username !== currentUser.username);
    if (filtered.length === 0) {
      results.innerHTML = '<p style="color:var(--text-tertiary); text-align:center; padding:24px 0;">未找到用户</p>';
      return;
    }

    results.innerHTML = filtered.map(u => {
      const isFriend = friends.some(f => f.username === u.username);
      return `
        <div class="search-result-item">
          <div class="avatar sm" style="background:${getAvatarColor(u.nickname)}">${getInitials(u.nickname)}</div>
          <div class="search-result-info">
            <div class="search-result-name">${u.nickname}</div>
            <div class="search-result-id">@${u.username}</div>
          </div>
          ${isFriend
            ? '<button class="btn-add added">已添加</button>'
            : `<button class="btn-add" onclick="addFriend('${u.username}', this)">添加</button>`
          }
        </div>
      `;
    }).join('');
  }, 300);
}

async function addFriend(username, btn) {
  const res = await fetch('/api/friends/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: currentUser.username, to: username })
  });
  const data = await res.json();
  if (data.error) {
    showToast(data.error);
  } else {
    btn.textContent = '已发送';
    btn.classList.add('added');
    showToast(data.autoAccepted ? '已互加好友' : '好友请求已发送');
    loadFriends();
  }
}

async function loadQRCode() {
  const res = await fetch(`/api/qrcode/${currentUser.username}`);
  const data = await res.json();
  if (data.qr) {
    document.getElementById('qrImage').src = data.qr;
    document.getElementById('qrImage').style.display = 'block';
  }
}

// ========== Friend Requests ==========
async function acceptRequest(from) {
  const res = await fetch('/api/friends/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: currentUser.username })
  });
  const data = await res.json();
  if (data.success) {
    showToast('已添加好友');
    loadFriends();
    loadFriendRequests();
  }
}

async function rejectRequest(from) {
  const res = await fetch('/api/friends/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: currentUser.username })
  });
  const data = await res.json();
  if (data.success) {
    showToast('已拒绝');
    loadFriendRequests();
  }
}

// ========== Voice Call (WebRTC) ==========
async function startVoiceCall() {
  if (!currentChat) return;
  if (!onlineUsersList.includes(currentChat.username)) {
    showToast('对方不在线');
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('无法访问麦克风');
    return;
  }

  showCallOverlay(currentChat.nickname, 'calling');

  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('call-ice-candidate', { to: currentChat.username, candidate: e.candidate });
    }
  };

  peerConnection.ontrack = (e) => {
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.play();
    document.getElementById('callStatus').textContent = '通话中';
    startCallTimer();
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('call-user', {
    from: currentUser.username,
    to: currentChat.username,
    offer
  });
}

function handleIncomingCall(data) {
  showCallOverlay(data.fromUser.nickname, 'incoming', data);
}

async function handleCallAnswered(data) {
  if (peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
  }
}

async function handleRemoteICE(data) {
  if (peerConnection) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
}

async function acceptIncomingCall(data) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('无法访问麦克风');
    endCall();
    return;
  }

  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('call-ice-candidate', { to: data.from, candidate: e.candidate });
    }
  };

  peerConnection.ontrack = (e) => {
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.play();
    document.getElementById('callStatus').textContent = '通话中';
    startCallTimer();
  };

  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('call-answer', { to: data.from, answer });
}

function rejectIncomingCall(from) {
  socket.emit('call-reject', { to: from });
  endCall();
}

function endCall() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (callTimer) {
    clearInterval(callTimer);
    callTimer = null;
  }
  callSeconds = 0;
  document.getElementById('callOverlay').classList.remove('active');

  if (currentChat && socket) {
    socket.emit('call-end', { to: currentChat.username });
  }
}

function showCallOverlay(name, type, data) {
  const overlay = document.getElementById('callOverlay');
  overlay.classList.add('active');

  document.getElementById('callName').textContent = name;
  setAvatar(document.getElementById('callAvatar'), name);

  const actions = document.getElementById('callActions');

  if (type === 'calling') {
    document.getElementById('callStatus').textContent = '正在呼叫...';
    document.getElementById('callTimer').style.display = 'none';
    actions.innerHTML = `
      <button class="call-action-btn end-call" onclick="endCall()">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    `;
  } else if (type === 'incoming') {
    document.getElementById('callStatus').textContent = '来电...';
    document.getElementById('callTimer').style.display = 'none';
    actions.innerHTML = `
      <button class="call-action-btn reject-call" onclick="rejectIncomingCall('${data.from}')">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
      <button class="call-action-btn accept-call" onclick="acceptIncomingCall(${JSON.stringify(data).replace(/"/g, '&quot;')})">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    `;
  }
}

function startCallTimer() {
  const timerEl = document.getElementById('callTimer');
  timerEl.style.display = 'block';
  callSeconds = 0;
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

// ========== Close panels on outside click ==========
document.addEventListener('click', (e) => {
  ['searchPanel', 'qrPanel'].forEach(id => {
    if (e.target.id === id) closePanel(id);
  });
});
