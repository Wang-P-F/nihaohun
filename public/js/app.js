// ========== State ==========
let currentUser = null;
let currentChat = null;
let socket = null;
let onlineUsersList = [];
let friends = [];
let friendRequests = [];
let activeTab = 'chats';
let messagesCache = {};
let unreadCounts = {};
let toastTimer = null;
let typingTimer = null;

// Voice call state
let peerConnection = null;
let localStream = null;
let callTimer = null;
let callSeconds = 0;
let remoteAudio = null;
let isEndingCall = false;
let incomingCallData = null;
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// Play remote audio stream with mobile compatibility
function playRemoteAudio(stream, id) {
  // For group calls, support multiple audio elements
  if (id) {
    const existing = document.getElementById('audio-' + id);
    if (existing) { existing.srcObject = stream; existing.play().catch(() => {}); return; }
    const audio = document.createElement('audio');
    audio.id = 'audio-' + id;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('autoplay', '');
    audio.srcObject = stream;
    document.body.appendChild(audio);
    audio.play().catch(() => {});
    return;
  }
  // 1-on-1 call: single audio element
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio.remove(); }
  const existingHint = document.getElementById('audioHint');
  if (existingHint) existingHint.remove();
  remoteAudio = document.createElement('audio');
  remoteAudio.setAttribute('playsinline', '');
  remoteAudio.setAttribute('autoplay', '');
  remoteAudio.srcObject = stream;
  document.body.appendChild(remoteAudio);
  remoteAudio.play().catch(() => {
    const hint = document.createElement('div');
    hint.id = 'audioHint';
    hint.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--accent);color:white;padding:12px 24px;border-radius:20px;font-size:14px;font-weight:600;z-index:300;cursor:pointer;font-family:var(--font);box-shadow:0 4px 16px rgba(0,0,0,0.2);';
    hint.textContent = '\u70B9\u51FB\u6B64\u5904\u5F00\u542F\u58F0\u97F3';
    hint.onclick = () => { remoteAudio.play(); hint.remove(); };
    document.body.appendChild(hint);
  });
}

function cleanupGroupAudio() {
  document.querySelectorAll('[id^="audio-group-"]').forEach(el => { el.srcObject = null; el.remove(); });
}

// Group voice room state
let currentRoomId = null;
let groupPeerConnections = {};
let groupLocalStream = null;
let groupCallTimer = null;
let groupCallSeconds = 0;
let voiceRoomsList = [];

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
  return (name || '?').charAt(0).toUpperCase();
}

function setAvatar(el, name) {
  el.style.background = getAvatarColor(name);
  el.textContent = getInitials(name);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
    return `\u6628\u5929 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ========== Toast ==========
function showToast(msg) {
  clearTimeout(toastTimer);
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
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
  if (!username || !password) return showAuthError('\u8BF7\u8F93\u5165\u8D26\u53F7\u548C\u5BC6\u7801');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.error) return showAuthError(data.error);
    currentUser = data.user;
    enterApp();
  } catch (err) {
    showAuthError('\u7F51\u7EDC\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5');
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('regUsername').value.trim();
  const nickname = document.getElementById('regNickname').value.trim();
  const password = document.getElementById('regPassword').value;
  const password2 = document.getElementById('regPassword2').value;
  if (!username || !password) return showAuthError('\u8BF7\u586B\u5199\u8D26\u53F7\u548C\u5BC6\u7801');
  if (password !== password2) return showAuthError('\u4E24\u6B21\u5BC6\u7801\u4E0D\u4E00\u81F4');
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nickname: nickname || username })
    });
    const data = await res.json();
    if (data.error) return showAuthError(data.error);
    currentUser = data.user;
    showToast('\u6CE8\u518C\u6210\u529F');
    enterApp();
  } catch (err) {
    showAuthError('\u7F51\u7EDC\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5');
  }
}

function handleLogout() {
  if (peerConnection || localStream) endCall(true);
  if (currentRoomId) leaveVoiceRoom();
  if (socket) socket.disconnect();
  currentUser = null;
  currentChat = null;
  friends = [];
  friendRequests = [];
  messagesCache = {};
  unreadCounts = {};
  activeTab = 'chats';
  document.getElementById('authPage').classList.remove('hidden');
  document.getElementById('appPage').classList.remove('active');
}

// ========== Enter App ==========
function enterApp() {
  document.getElementById('authPage').classList.add('hidden');
  document.getElementById('appPage').classList.add('active');
  document.getElementById('profileName').textContent = currentUser.nickname;
  document.getElementById('profileId').textContent = `@${currentUser.username}`;
  setAvatar(document.getElementById('profileAvatar'), currentUser.nickname);

  socket = io();

  socket.on('connect', () => {
    socket.emit('login', currentUser.username);
  });

  socket.on('online-users', (users) => {
    onlineUsersList = users;
    renderContacts();
    if (currentChat) updateChatStatus();
  });

  socket.on('new-message', (msg) => {
    const key = [msg.from, msg.to].sort().join(':');
    if (!messagesCache[key]) messagesCache[key] = [];
    messagesCache[key].push(msg);
    const isInCurrentChat = currentChat && (msg.from === currentChat.username || msg.to === currentChat.username);
    if (isInCurrentChat) {
      appendMessage(msg);
    } else if (msg.to === currentUser.username) {
      unreadCounts[msg.from] = (unreadCounts[msg.from] || 0) + 1;
      updateChatBadge();
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
    showToast(`${esc(data.from.nickname)} \u8BF7\u6C42\u6DFB\u52A0\u4F60\u4E3A\u597D\u53CB`);
    loadFriendRequests();
  });

  socket.on('friend-accepted', (data) => {
    showToast(`${esc(data.by.nickname)} \u63A5\u53D7\u4E86\u4F60\u7684\u597D\u53CB\u8BF7\u6C42`);
    loadFriends();
  });

  socket.on('message-recalled', (msg) => {
    const key = [msg.from, msg.to].sort().join(':');
    if (messagesCache[key]) {
      const cached = messagesCache[key].find(m => m.id === msg.id);
      if (cached) { cached.recalled = true; cached.content = ''; }
    }
    if (currentChat && (msg.from === currentChat.username || msg.to === currentChat.username)) {
      renderMessages();
    }
    renderContacts();
  });

  socket.on('friend-typing', (data) => {
    if (currentChat && data.from === currentChat.username) {
      document.getElementById('chatStatus').textContent = '\u6B63\u5728\u8F93\u5165...';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => updateChatStatus(), 2000);
    }
  });

  // Voice call signaling
  socket.on('incoming-call', handleIncomingCall);
  socket.on('call-answered', handleCallAnswered);
  socket.on('ice-candidate', handleRemoteICE);
  socket.on('call-rejected', () => {
    showToast('\u5BF9\u65B9\u62D2\u7EDD\u4E86\u901A\u8BDD');
    endCall(true);
  });
  socket.on('call-ended', () => {
    endCall(true);
  });

  // Group voice room signaling
  socket.on('voice-rooms-update', (rooms) => {
    voiceRoomsList = rooms;
    if (activeTab === 'voice') renderContacts();
  });
  socket.on('voice-room-created', (data) => {
    currentRoomId = data.roomId;
    showToast('\u8BED\u97F3\u623F\u95F4\u5DF2\u521B\u5EFA');
    closePanel('voiceRoomPanel');
    showGroupCallOverlay(data.room);
  });
  socket.on('voice-room-joined', (data) => {
    currentRoomId = data.roomId;
    closePanel('voiceRoomPanel');
    showGroupCallOverlay(data.room);
  });
  socket.on('voice-room-peer-joined', async (data) => {
    const pc = createGroupPeerConnection(data.socketId);
    groupPeerConnections[data.socketId] = pc;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('group-offer', {
      to: data.socketId,
      fromUser: currentUser.username,
      offer,
      roomId: data.roomId
    });
    const room = voiceRoomsList.find(r => r.roomId === data.roomId);
    if (room) showGroupCallOverlay(room);
  });
  socket.on('voice-room-peer-left', (data) => {
    if (data.socketId) {
      const pc = groupPeerConnections[data.socketId];
      if (pc) { pc.close(); delete groupPeerConnections[data.socketId]; }
      const audioEl = document.getElementById('audio-group-' + data.socketId);
      if (audioEl) { audioEl.srcObject = null; audioEl.remove(); }
    }
    const room = voiceRoomsList.find(r => r.roomId === data.roomId);
    if (room) showGroupCallOverlay(room);
    if (data.username) showToast(`${esc(data.username)} \u79BB\u5F00\u4E86\u623F\u95F4`);
  });
  socket.on('voice-room-error', (data) => {
    showToast(data.error);
    if (groupLocalStream && !currentRoomId) {
      groupLocalStream.getTracks().forEach(t => t.stop());
      groupLocalStream = null;
    }
  });

  // Group WebRTC
  socket.on('group-offer', async (data) => {
    const pc = createGroupPeerConnection(data.from);
    groupPeerConnections[data.from] = pc;
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('group-answer', {
      to: data.from,
      fromUser: currentUser.username,
      answer,
      roomId: data.roomId
    });
  });

  socket.on('group-answer', async (data) => {
    const pc = groupPeerConnections[data.from];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  });

  socket.on('group-ice-candidate', async (data) => {
    const pc = groupPeerConnections[data.from];
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  });

  loadFriends();
  loadFriendRequests();
}

// ========== Profile Edit ==========
function openProfilePanel() {
  document.getElementById('profilePanel').classList.add('active');
  document.getElementById('editNickname').value = currentUser.nickname;
  document.getElementById('editUsername').value = currentUser.username;
  setAvatar(document.getElementById('editProfileAvatar'), currentUser.nickname);
}

async function saveProfile() {
  const newNickname = document.getElementById('editNickname').value.trim();
  if (!newNickname) return showToast('\u6635\u79F0\u4E0D\u80FD\u4E3A\u7A7A');
  try {
    const res = await fetch(`/api/user/${currentUser.username}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: newNickname })
    });
    const data = await res.json();
    if (data.error) return showToast(data.error);
    currentUser = data.user;
    document.getElementById('profileName').textContent = currentUser.nickname;
    setAvatar(document.getElementById('profileAvatar'), currentUser.nickname);
    closePanel('profilePanel');
    showToast('\u8D44\u6599\u5DF2\u66F4\u65B0');
    loadFriends();
  } catch (err) {
    showToast('\u4FDD\u5B58\u5931\u8D25');
  }
}

// ========== Load Data ==========
async function loadFriends() {
  try {
    const res = await fetch(`/api/friends/${currentUser.username}`);
    friends = await res.json();
    renderContacts();
  } catch (err) {}
}

async function loadFriendRequests() {
  try {
    const res = await fetch(`/api/friends/requests/${currentUser.username}`);
    friendRequests = await res.json();
    updateRequestBadge();
    if (activeTab === 'requests') renderContacts();
  } catch (err) {}
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

function updateChatBadge() {
  const badge = document.getElementById('chatBadge');
  const total = Object.values(unreadCounts).reduce((s, c) => s + c, 0);
  if (total > 0) {
    badge.style.display = 'flex';
    badge.textContent = total > 99 ? '99+' : total;
  } else {
    badge.style.display = 'none';
  }
}

// ========== Sidebar Tabs ==========
function switchSidebarTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  const tabs = document.querySelectorAll('.sidebar-tab');
  const tabMap = { chats: 0, contacts: 1, voice: 2, requests: 3 };
  tabs[tabMap[tab]].classList.add('active');
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
        const msgs = (messagesCache[key] || []).filter(m => !(m.deletedBy && m.deletedBy.includes(currentUser.username)));
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        return { ...f, lastMsg, lastTime: lastMsg ? lastMsg.createdAt : f.addedAt };
      }).sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    }

    if (items.length === 0) {
      list.innerHTML = `<div style="text-align:center; padding:40px 20px; color:var(--text-tertiary);">
        ${activeTab === 'chats' ? '\u6682\u65E0\u6D88\u606F' : '\u6682\u65E0\u597D\u53CB'}
        <br><small>\u70B9\u51FB\u53F3\u4E0A\u89D2\u6DFB\u52A0\u597D\u53CB\u5F00\u59CB\u804A\u5929</small>
      </div>`;
      return;
    }

    list.innerHTML = items.map(f => {
      const isOnline = onlineUsersList.includes(f.username);
      const isActive = currentChat && currentChat.username === f.username;
      const lastMsg = f.lastMsg;
      const unread = unreadCounts[f.username] || 0;
      let preview = '';
      if (lastMsg) {
        preview = lastMsg.recalled ? '[\u6D88\u606F\u5DF2\u64A4\u56DE]' : (lastMsg.type === 'text' ? lastMsg.content : '[\u8BED\u97F3\u901A\u8BDD]');
        if (preview.length > 20) preview = preview.substring(0, 20) + '...';
      }
      return `
        <div class="contact-item ${isActive ? 'active' : ''}" onclick="openChat('${esc(f.username)}')">
          <div class="avatar" style="background:${getAvatarColor(f.nickname)}">
            ${esc(getInitials(f.nickname))}
            ${isOnline ? '<span class="online-dot"></span>' : ''}
          </div>
          <div class="contact-info">
            <div class="contact-name">${esc(f.nickname)}</div>
            <div class="contact-preview">${esc(preview) || '@' + esc(f.username)}</div>
          </div>
          <div class="contact-meta">
            ${lastMsg ? `<span class="contact-time">${formatTime(lastMsg.createdAt)}</span>` : ''}
            ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } else if (activeTab === 'voice') {
    const rooms = voiceRoomsList;
    if (rooms.length === 0) {
      list.innerHTML = `
        <div style="text-align:center; padding:40px 20px; color:var(--text-tertiary);">
          \u6682\u65E0\u8BED\u97F3\u623F\u95F4<br>
          <small style="color:var(--accent); cursor:pointer;" onclick="openVoiceRooms()">\u521B\u5EFA\u4E00\u4E2A\u623F\u95F4</small>
        </div>`;
      return;
    }
    list.innerHTML = rooms.map(r => {
      const isInRoom = currentRoomId === r.roomId;
      return `
        <div class="voice-room-item">
          <div class="voice-room-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          </div>
          <div class="voice-room-info">
            <div class="voice-room-name">${esc(r.name)}</div>
            <div class="voice-room-meta">${esc(r.creatorUser ? r.creatorUser.nickname : '\u672A\u77E5')} \u521B\u5EFA \xB7 ${r.participantCount} \u4EBA</div>
            <div class="voice-room-avatars">
              ${r.participants.slice(0, 5).map(p => {
                const nick = p.user ? p.user.nickname : p.username;
                return `<div class="avatar" style="background:${getAvatarColor(nick)}">${esc(getInitials(nick))}</div>`;
              }).join('')}
              ${r.participantCount > 5 ? `<div class="avatar" style="background:var(--bg-tertiary); font-size:10px; color:var(--text-secondary);">+${r.participantCount - 5}</div>` : ''}
            </div>
          </div>
          ${isInRoom
            ? '<button class="btn-join-room" style="background:var(--red);" onclick="leaveVoiceRoom()">\u79BB\u5F00</button>'
            : `<button class="btn-join-room" onclick="joinVoiceRoom('${esc(r.roomId)}')">加入</button>`
          }
        </div>
      `;
    }).join('');
  } else if (activeTab === 'requests') {
    if (friendRequests.length === 0) {
      list.innerHTML = `<div style="text-align:center; padding:40px 20px; color:var(--text-tertiary);">\u6682\u65E0\u597D\u53CB\u8BF7\u6C42</div>`;
      return;
    }
    list.innerHTML = friendRequests.map(r => `
      <div class="request-item">
        <div class="avatar" style="background:${getAvatarColor(r.fromUser.nickname)}">${esc(getInitials(r.fromUser.nickname))}</div>
        <div class="search-result-info">
          <div class="search-result-name">${esc(r.fromUser.nickname)}</div>
          <div class="search-result-id">@${esc(r.fromUser.username)}</div>
        </div>
        <div class="request-actions">
          <button class="btn-accept" onclick="acceptRequest('${esc(r.from)}')">接受</button>
          <button class="btn-reject" onclick="rejectRequest('${esc(r.from)}')">拒绝</button>
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

  delete unreadCounts[username];
  updateChatBadge();

  document.getElementById('noSelection').style.display = 'none';
  document.getElementById('chatView').style.display = 'flex';

  setAvatar(document.getElementById('chatAvatar'), friend.nickname);
  document.getElementById('chatName').textContent = friend.nickname;
  updateChatStatus();

  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.add('hidden-mobile');
  }

  document.getElementById('messageInput').focus();

  const key = [currentUser.username, username].sort().join(':');
  if (!messagesCache[key] || messagesCache[key].length === 0) {
    document.getElementById('messagesContainer').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-tertiary);">\u52A0\u8F7D\u4E2D...</div>';
  } else {
    renderMessages();
  }

  try {
    const res = await fetch(`/api/messages/${currentUser.username}/${username}`);
    messagesCache[key] = await res.json();
    if (currentChat && currentChat.username === username) {
      renderMessages();
    }
  } catch (err) {}
  renderContacts();
}

function closeChatMobile() {
  document.getElementById('sidebar').classList.remove('hidden-mobile');
}

function updateChatStatus() {
  if (!currentChat) return;
  const status = document.getElementById('chatStatus');
  if (onlineUsersList.includes(currentChat.username)) {
    status.textContent = '\u5728\u7EBF';
    status.style.color = 'var(--green)';
  } else {
    status.textContent = '\u79BB\u7EBF';
    status.style.color = 'var(--text-tertiary)';
  }
}

function renderMessages() {
  const container = document.getElementById('messagesContainer');
  const key = [currentUser.username, currentChat.username].sort().join(':');
  const msgs = (messagesCache[key] || []).filter(m => !(m.deletedBy && m.deletedBy.includes(currentUser.username)));
  container.innerHTML = msgs.map(m => createMessageHTML(m)).join('');
  container.scrollTop = container.scrollHeight;
}

function createMessageHTML(m) {
  const isSent = m.from === currentUser.username;
  const canRecall = isSent && !m.recalled && (Date.now() - m.createdAt <= 120000);
  const bubbleText = m.recalled
    ? (isSent ? '\u4F60\u64A4\u56DE\u4E86\u4E00\u6761\u6D88\u606F' : '\u5BF9\u65B9\u64A4\u56DE\u4E86\u4E00\u6761\u6D88\u606F')
    : esc(m.content);
  const bubbleClass = m.recalled ? 'message-bubble recalled' : 'message-bubble';
  const showMenu = !m.recalled;
  return `
    <div class="message-group ${isSent ? 'sent' : 'received'}" data-msg-id="${m.id}" data-msg-from="${m.from}">
      <div class="${bubbleClass}"${showMenu ? ` oncontextmenu="showMsgMenu(event,'${m.id}',${canRecall})" ontouchstart="handleTouchStart(event,'${m.id}',${canRecall})" ontouchend="handleTouchEnd(event)" ontouchmove="handleTouchMove(event)"` : ''}>${bubbleText}</div>
    </div>
    <div class="message-time">${formatTime(m.createdAt)}${m.recalled ? ' \xB7 \u5DF2\u64A4\u56DE' : ''}</div>
  `;
}

function appendMessage(m) {
  const container = document.getElementById('messagesContainer');
  container.insertAdjacentHTML('beforeend', createMessageHTML(m));
  container.scrollTop = container.scrollHeight;
}

// ========== Message Menu ==========
let msgMenuTimer = null;
let msgMenuTarget = null;
let touchMoved = false;

function handleTouchStart(e, msgId, canRecall) {
  touchMoved = false;
  msgMenuTimer = setTimeout(() => {
    showMsgMenu(e, msgId, canRecall);
  }, 600);
}

function handleTouchEnd(e) {
  if (msgMenuTimer) { clearTimeout(msgMenuTimer); msgMenuTimer = null; }
}

function handleTouchMove(e) {
  touchMoved = true;
  if (msgMenuTimer) { clearTimeout(msgMenuTimer); msgMenuTimer = null; }
}

function showMsgMenu(e, msgId, canRecall) {
  e.preventDefault();
  hideMsgMenu();
  msgMenuTarget = msgId;
  const menu = document.createElement('div');
  menu.id = 'msgMenu';
  menu.className = 'msg-menu';
  menu.innerHTML = `
    ${canRecall ? '<div class="msg-menu-item" onclick="recallMessageById(msgMenuTarget)">撤回</div>' : ''}
    <div class="msg-menu-item" onclick="deleteMessageById(msgMenuTarget)">删除</div>
  `;
  const x = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
  const y = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
  menu.style.left = Math.max(8, Math.min(x - 60, window.innerWidth - 140)) + 'px';
  menu.style.top = Math.max(8, y - (canRecall ? 80 : 40)) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', hideMsgMenu, { once: true });
  }, 10);
}

function hideMsgMenu() {
  const menu = document.getElementById('msgMenu');
  if (menu) menu.remove();
  msgMenuTarget = null;
}

async function recallMessageById(msgId) {
  hideMsgMenu();
  try {
    const res = await fetch(`/api/messages/${msgId}/recall?by=${currentUser.username}`, { method: 'POST' });
    if (!res.ok) { showToast('\u64A4\u56DE\u5931\u8D25'); return; }
    const data = await res.json();
    if (data.error) { showToast(data.error); return; }
    const msg = data.message;
    const key = [msg.from, msg.to].sort().join(':');
    if (messagesCache[key]) {
      const cached = messagesCache[key].find(m => m.id === msg.id);
      if (cached) { cached.recalled = true; cached.content = ''; }
    }
    if (currentChat && (msg.from === currentChat.username || msg.to === currentChat.username)) {
      renderMessages();
    }
    showToast('\u5DF2\u64A4\u56DE');
  } catch (err) {
    showToast('\u64A4\u56DE\u5931\u8D25');
  }
}

async function deleteMessageById(msgId) {
  hideMsgMenu();
  try {
    const res = await fetch(`/api/messages/${msgId}?by=${currentUser.username}`, { method: 'DELETE' });
    if (!res.ok) { showToast('\u5220\u9664\u5931\u8D25'); return; }
    const data = await res.json();
    if (data.error) { showToast(data.error); return; }
    const msg = data.message;
    const key = [msg.from, msg.to].sort().join(':');
    if (messagesCache[key]) {
      const cached = messagesCache[key].find(m => m.id === msg.id);
      if (cached) {
        if (!cached.deletedBy) cached.deletedBy = [];
        if (!cached.deletedBy.includes(currentUser.username)) cached.deletedBy.push(currentUser.username);
      }
    }
    if (currentChat && (msg.from === currentChat.username || msg.to === currentChat.username)) {
      renderMessages();
    }
    showToast('\u5DF2\u5220\u9664');
  } catch (err) {
    showToast('\u5220\u9664\u5931\u8D25');
  }
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function handleMessageKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  if (currentChat && socket) {
    socket.emit('typing', { from: currentUser.username, to: currentChat.username });
  }
}

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
  document.getElementById('searchResults').innerHTML = '<p style="color:var(--text-tertiary); text-align:center; padding:24px 0;">\u8F93\u5165\u5173\u952E\u8BCD\u641C\u7D22\u7528\u6237</p>';
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
    document.getElementById('searchResults').innerHTML = '<p style="color:var(--text-tertiary); text-align:center; padding:24px 0;">\u8F93\u5165\u5173\u952E\u8BCD\u641C\u7D22\u7528\u6237</p>';
    return;
  }
  searchTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const users = await res.json();
      const results = document.getElementById('searchResults');
      const filtered = users.filter(u => u.username !== currentUser.username);
      if (filtered.length === 0) {
        results.innerHTML = '<p style="color:var(--text-tertiary); text-align:center; padding:24px 0;">\u672A\u627E\u5230\u7528\u6237</p>';
        return;
      }
      results.innerHTML = filtered.map(u => {
        const isFriend = friends.some(f => f.username === u.username);
        return `
          <div class="search-result-item">
            <div class="avatar sm" style="background:${getAvatarColor(u.nickname)}">${esc(getInitials(u.nickname))}</div>
            <div class="search-result-info">
              <div class="search-result-name">${esc(u.nickname)}</div>
              <div class="search-result-id">@${esc(u.username)}</div>
            </div>
            ${isFriend
              ? '<button class="btn-add added">\u5DF2\u6DFB\u52A0</button>'
              : `<button class="btn-add" onclick="addFriend('${esc(u.username)}', this)">添加</button>`
            }
          </div>
        `;
      }).join('');
    } catch (err) {
      document.getElementById('searchResults').innerHTML = '<p style="color:var(--text-tertiary); text-align:center; padding:24px 0;">\u641C\u7D22\u5931\u8D25</p>';
    }
  }, 300);
}

async function addFriend(username, btn) {
  try {
    const res = await fetch('/api/friends/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: currentUser.username, to: username })
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error);
    } else {
      btn.textContent = '\u5DF2\u53D1\u9001';
      btn.classList.add('added');
      showToast(data.autoAccepted ? '\u5DF2\u4E92\u52A0\u597D\u53CB' : '\u597D\u53CB\u8BF7\u6C42\u5DF2\u53D1\u9001');
      loadFriends();
    }
  } catch (err) {
    showToast('\u7F51\u7EDC\u9519\u8BEF');
  }
}

async function loadQRCode() {
  try {
    const res = await fetch(`/api/qrcode/${currentUser.username}`);
    const data = await res.json();
    if (data.qr) {
      document.getElementById('qrImage').src = data.qr;
      document.getElementById('qrImage').style.display = 'block';
    }
  } catch (err) {}
}

// ========== Friend Requests ==========
async function acceptRequest(from) {
  try {
    const res = await fetch('/api/friends/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: currentUser.username })
    });
    const data = await res.json();
    if (data.success) {
      showToast('\u5DF2\u6DFB\u52A0\u597D\u53CB');
      loadFriends();
      loadFriendRequests();
    }
  } catch (err) {}
}

async function rejectRequest(from) {
  try {
    const res = await fetch('/api/friends/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: currentUser.username })
    });
    const data = await res.json();
    if (data.success) {
      showToast('\u5DF2\u62D2\u7EDD');
      loadFriendRequests();
    }
  } catch (err) {}
}

// ========== 1-on-1 Voice Call (WebRTC) ==========
async function startVoiceCall() {
  if (!currentChat) return;
  if (peerConnection || localStream) { showToast('\u901A\u8BDD\u4E2D'); return; }
  if (!onlineUsersList.includes(currentChat.username)) {
    showToast('\u5BF9\u65B9\u4E0D\u5728\u7EBF');
    return;
  }

  showCallOverlay(currentChat.nickname, 'calling');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE');
    endCall(true);
    return;
  }

  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('call-ice-candidate', { to: currentChat.username, candidate: e.candidate });
    }
  };

  peerConnection.ontrack = (e) => {
    playRemoteAudio(e.streams[0]);
    document.getElementById('callStatus').textContent = '\u901A\u8BDD\u4E2D';
    startCallTimer();
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection && (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected')) {
      showToast('\u8FDE\u63A5\u5DF2\u65AD\u5F00');
      endCall(true);
    }
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
  if (peerConnection || localStream) {
    socket.emit('call-reject', { to: data.from });
    return;
  }
  incomingCallData = data;
  showCallOverlay(data.fromUser.nickname, 'incoming');
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

async function acceptIncomingCall() {
  const data = incomingCallData;
  if (!data) return;
  incomingCallData = null;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE');
    endCall(true);
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
    playRemoteAudio(e.streams[0]);
    document.getElementById('callStatus').textContent = '\u901A\u8BDD\u4E2D';
    startCallTimer();
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection && (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected')) {
      showToast('\u8FDE\u63A5\u5DF2\u65AD\u5F00');
      endCall(true);
    }
  };

  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('call-answer', { to: data.from, answer });
}

function rejectIncomingCall() {
  const data = incomingCallData;
  if (!data) return;
  incomingCallData = null;
  socket.emit('call-reject', { to: data.from });
  endCall(true);
}

function endCall(fromRemote) {
  if (isEndingCall) return;
  isEndingCall = true;

  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio.remove(); remoteAudio = null; }
  const hint = document.getElementById('audioHint');
  if (hint) hint.remove();
  if (callTimer) { clearInterval(callTimer); callTimer = null; }
  callSeconds = 0;
  incomingCallData = null;
  document.getElementById('callOverlay').classList.remove('active');

  if (!fromRemote && currentChat && socket) {
    socket.emit('call-end', { to: currentChat.username });
    showToast('\u901A\u8BDD\u5DF2\u7ED3\u675F');
  } else if (fromRemote) {
    showToast('\u5BF9\u65B9\u5DF2\u7ED3\u675F\u901A\u8BDD');
  }

  setTimeout(() => { isEndingCall = false; }, 500);
}

function showCallOverlay(name, type) {
  const overlay = document.getElementById('callOverlay');
  overlay.classList.add('active');
  document.getElementById('callName').textContent = name;
  setAvatar(document.getElementById('callAvatar'), name);
  const actions = document.getElementById('callActions');

  if (type === 'calling') {
    document.getElementById('callStatus').textContent = '\u6B63\u5728\u547C\u53EB...';
    document.getElementById('callTimer').style.display = 'none';
    actions.innerHTML = `
      <button class="call-action-btn end-call" onclick="endCall()">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    `;
  } else if (type === 'incoming') {
    document.getElementById('callStatus').textContent = '\u6765\u7535...';
    document.getElementById('callTimer').style.display = 'none';
    actions.innerHTML = `
      <button class="call-action-btn reject-call" onclick="rejectIncomingCall()">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
      <button class="call-action-btn accept-call" onclick="acceptIncomingCall()">
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

// ========== Group Voice Room ==========
function openVoiceRooms() {
  document.getElementById('voiceRoomPanel').classList.add('active');
  renderVoiceRoomList();
}

function renderVoiceRoomList() {
  const list = document.getElementById('voiceRoomList');
  if (voiceRoomsList.length === 0) {
    list.innerHTML = '<p style="color:var(--text-tertiary); text-align:center; padding:24px 0;">\u6682\u65E0\u8BED\u97F3\u623F\u95F4\uFF0C\u521B\u5EFA\u4E00\u4E2A\u5427</p>';
    return;
  }
  list.innerHTML = voiceRoomsList.map(r => {
    const isInRoom = currentRoomId === r.roomId;
    return `
      <div class="voice-room-item">
        <div class="voice-room-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        </div>
        <div class="voice-room-info">
          <div class="voice-room-name">${esc(r.name)}</div>
          <div class="voice-room-meta">${esc(r.creatorUser ? r.creatorUser.nickname : '')} \xB7 ${r.participantCount} \u4EBA</div>
        </div>
        ${isInRoom
          ? '<button class="btn-join-room" style="background:var(--red);" onclick="leaveVoiceRoom(); closePanel(\'voiceRoomPanel\');">\u79BB\u5F00</button>'
          : `<button class="btn-join-room" onclick="joinVoiceRoom('${esc(r.roomId)}')">加入</button>`
        }
      </div>
    `;
  }).join('');
}

async function createVoiceRoom() {
  const name = document.getElementById('newRoomName').value.trim() || `${currentUser.nickname}\u7684\u623F\u95F4`;
  try {
    groupLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE');
    return;
  }
  socket.emit('create-voice-room', { username: currentUser.username, name });
  document.getElementById('newRoomName').value = '';
}

async function joinVoiceRoom(roomId) {
  try {
    groupLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE');
    return;
  }
  socket.emit('join-voice-room', { roomId, username: currentUser.username });
}

function createGroupPeerConnection(targetSocketId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  if (groupLocalStream) {
    groupLocalStream.getTracks().forEach(track => pc.addTrack(track, groupLocalStream));
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('group-ice-candidate', { to: targetSocketId, candidate: e.candidate });
    }
  };
  pc.ontrack = (e) => {
    // Use separate audio elements for each group peer
    playRemoteAudio(e.streams[0], 'group-' + targetSocketId);
    document.getElementById('groupCallStatus').textContent = '\u901A\u8BDD\u4E2D';
    if (!groupCallTimer) startGroupCallTimer();
  };
  return pc;
}

function showGroupCallOverlay(room) {
  const overlay = document.getElementById('groupCallOverlay');
  overlay.style.display = 'flex';
  overlay.classList.add('active');
  document.getElementById('groupRoomName').textContent = room.name || '\u8BED\u97F3\u623F\u95F4';
  if (!groupCallTimer) {
    document.getElementById('groupCallStatus').textContent = '\u7B49\u5F85\u5176\u4ED6\u4EBA\u52A0\u5165...';
  }
  const container = document.getElementById('groupParticipants');
  let html = `
    <div class="group-participant speaking">
      <div class="avatar" style="background:${getAvatarColor(currentUser.nickname)}">${esc(getInitials(currentUser.nickname))}</div>
      <div class="group-participant-name">${esc(currentUser.nickname)}\uFF08\u6211\uFF09</div>
    </div>
  `;
  if (room.participants) {
    room.participants.forEach(p => {
      if (p.username !== currentUser.username) {
        const nick = p.user ? p.user.nickname : p.username;
        html += `
          <div class="group-participant">
            <div class="avatar" style="background:${getAvatarColor(nick)}">${esc(getInitials(nick))}</div>
            <div class="group-participant-name">${esc(nick)}</div>
          </div>
        `;
      }
    });
  }
  container.innerHTML = html;
}

function startGroupCallTimer() {
  const timerEl = document.getElementById('groupCallTimer');
  timerEl.style.display = 'block';
  groupCallSeconds = 0;
  groupCallTimer = setInterval(() => {
    groupCallSeconds++;
    const m = String(Math.floor(groupCallSeconds / 60)).padStart(2, '0');
    const s = String(groupCallSeconds % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

function leaveVoiceRoom() {
  if (!currentRoomId) return;
  for (const sid in groupPeerConnections) { groupPeerConnections[sid].close(); }
  groupPeerConnections = {};
  if (groupLocalStream) { groupLocalStream.getTracks().forEach(t => t.stop()); groupLocalStream = null; }
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio.remove(); remoteAudio = null; }
  cleanupGroupAudio();
  const hint = document.getElementById('audioHint');
  if (hint) hint.remove();
  if (groupCallTimer) { clearInterval(groupCallTimer); groupCallTimer = null; }
  groupCallSeconds = 0;
  socket.emit('leave-voice-room', { roomId: currentRoomId });
  currentRoomId = null;
  document.getElementById('groupCallOverlay').style.display = 'none';
  document.getElementById('groupCallOverlay').classList.remove('active');
  document.getElementById('groupCallTimer').style.display = 'none';
  showToast('\u5DF2\u79BB\u5F00\u8BED\u97F3\u623F\u95F4');
  renderContacts();
}

// ========== Close panels on outside click ==========
document.addEventListener('click', (e) => {
  ['searchPanel', 'qrPanel', 'profilePanel', 'voiceRoomPanel'].forEach(id => {
    if (e.target.id === id) closePanel(id);
  });
});
