const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      users: {},
      friendRequests: [],
      friends: [],
      messages: []
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// User operations
function createUser(username, password, nickname, avatar) {
  const db = loadDB();
  if (db.users[username]) {
    return { error: '该账号已被注册' };
  }
  const hashedPassword = bcrypt.hashSync(password, 10);
  db.users[username] = {
    username,
    password: hashedPassword,
    nickname: nickname || username,
    avatar: avatar || '',
    createdAt: Date.now()
  };
  saveDB(db);
  return { success: true, user: { username, nickname: nickname || username, avatar } };
}

function authenticateUser(username, password) {
  const db = loadDB();
  const user = db.users[username];
  if (!user) return { error: '账号不存在' };
  if (!bcrypt.compareSync(password, user.password)) return { error: '密码错误' };
  return { success: true, user: { username: user.username, nickname: user.nickname, avatar: user.avatar } };
}

function getUser(username) {
  const db = loadDB();
  const user = db.users[username];
  if (!user) return null;
  return { username: user.username, nickname: user.nickname, avatar: user.avatar };
}

function searchUsers(keyword) {
  const db = loadDB();
  const results = [];
  for (const uname in db.users) {
    const u = db.users[uname];
    if (u.username.includes(keyword) || u.nickname.includes(keyword)) {
      results.push({ username: u.username, nickname: u.nickname, avatar: u.avatar });
    }
  }
  return results;
}

function updateUser(username, updates) {
  const db = loadDB();
  const user = db.users[username];
  if (!user) return { error: '用户不存在' };
  if (updates.nickname) user.nickname = updates.nickname;
  if (updates.avatar) user.avatar = updates.avatar;
  saveDB(db);
  return { success: true, user: { username: user.username, nickname: user.nickname, avatar: user.avatar } };
}

// Friend operations
function sendFriendRequest(from, to) {
  const db = loadDB();
  if (!db.users[to]) return { error: '目标用户不存在' };
  if (from === to) return { error: '不能添加自己为好友' };
  const existing = db.friends.find(f =>
    (f.user1 === from && f.user2 === to) || (f.user1 === to && f.user2 === from)
  );
  if (existing) return { error: '已经是好友了' };
  const pending = db.friendRequests.find(r =>
    r.from === from && r.to === to && r.status === 'pending'
  );
  if (pending) return { error: '已经发送过好友请求' };
  // Check if the other person already sent a request
  const reversePending = db.friendRequests.find(r =>
    r.from === to && r.to === from && r.status === 'pending'
  );
  if (reversePending) {
    // Auto accept
    reversePending.status = 'accepted';
    db.friends.push({ user1: from, user2: to, createdAt: Date.now() });
    saveDB(db);
    return { success: true, autoAccepted: true };
  }
  db.friendRequests.push({ from, to, status: 'pending', createdAt: Date.now() });
  saveDB(db);
  return { success: true };
}

function acceptFriendRequest(from, to) {
  const db = loadDB();
  const req = db.friendRequests.find(r => r.from === from && r.to === to && r.status === 'pending');
  if (!req) return { error: '好友请求不存在' };
  req.status = 'accepted';
  db.friends.push({ user1: from, user2: to, createdAt: Date.now() });
  saveDB(db);
  return { success: true };
}

function rejectFriendRequest(from, to) {
  const db = loadDB();
  const req = db.friendRequests.find(r => r.from === from && r.to === to && r.status === 'pending');
  if (!req) return { error: '好友请求不存在' };
  req.status = 'rejected';
  saveDB(db);
  return { success: true };
}

function getFriendRequests(username) {
  const db = loadDB();
  return db.friendRequests
    .filter(r => r.to === username && r.status === 'pending')
    .map(r => ({ from: r.from, fromUser: getUser(r.from), createdAt: r.createdAt }));
}

function getFriends(username) {
  const db = loadDB();
  return db.friends
    .filter(f => f.user1 === username || f.user2 === username)
    .map(f => {
      const friendUsername = f.user1 === username ? f.user2 : f.user1;
      return { ...getUser(friendUsername), addedAt: f.createdAt };
    });
}

function areFriends(user1, user2) {
  const db = loadDB();
  return db.friends.some(f =>
    (f.user1 === user1 && f.user2 === user2) || (f.user1 === user2 && f.user2 === user1)
  );
}

// Message operations
function saveMessage(from, to, content, type = 'text') {
  const db = loadDB();
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
    from, to, content, type,
    createdAt: Date.now()
  };
  db.messages.push(msg);
  saveDB(db);
  return msg;
}

function getMessages(user1, user2, limit = 50) {
  const db = loadDB();
  return db.messages
    .filter(m =>
      (m.from === user1 && m.to === user2) || (m.from === user2 && m.to === user1)
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-limit);
}

module.exports = {
  createUser, authenticateUser, getUser, searchUsers, updateUser,
  sendFriendRequest, acceptFriendRequest, rejectFriendRequest,
  getFriendRequests, getFriends, areFriends,
  saveMessage, getMessages
};
