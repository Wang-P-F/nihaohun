const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// ========== Auth API ==========
app.post('/api/register', (req, res) => {
  const { username, password, nickname } = req.body;
  if (!username || !password) return res.status(400).json({ error: '账号和密码不能为空' });
  if (username.length < 3) return res.status(400).json({ error: '账号至少3个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });
  const result = db.createUser(username, password, nickname);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '账号和密码不能为空' });
  const result = db.authenticateUser(username, password);
  if (result.error) return res.status(401).json(result);
  res.json(result);
});

// ========== User API ==========
app.get('/api/user/:username', (req, res) => {
  const user = db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(user);
});

app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  res.json(db.searchUsers(q));
});

app.put('/api/user/:username', (req, res) => {
  const result = db.updateUser(req.params.username, req.body);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ========== QR Code ==========
app.get('/api/qrcode/:username', async (req, res) => {
  const user = db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  try {
    const qrData = JSON.stringify({ type: 'nihaohun-add', username: user.username });
    const qrUrl = await QRCode.toDataURL(qrData, {
      width: 256,
      margin: 2,
      color: { dark: '#1d1d1f', light: '#ffffff' }
    });
    res.json({ qr: qrUrl, user });
  } catch (err) {
    res.status(500).json({ error: '生成二维码失败' });
  }
});

// ========== Friends API ==========
app.post('/api/friends/request', (req, res) => {
  const { from, to } = req.body;
  const result = db.sendFriendRequest(from, to);
  if (result.error) return res.status(400).json(result);
  // Notify via socket
  const toSocket = onlineUsers[to];
  if (toSocket) {
    io.to(toSocket).emit('friend-request', { from: db.getUser(from), autoAccepted: result.autoAccepted });
  }
  res.json(result);
});

app.post('/api/friends/accept', (req, res) => {
  const { from, to } = req.body;
  const result = db.acceptFriendRequest(from, to);
  if (result.error) return res.status(400).json(result);
  const toSocket = onlineUsers[from];
  if (toSocket) {
    io.to(toSocket).emit('friend-accepted', { by: db.getUser(to) });
  }
  res.json(result);
});

app.post('/api/friends/reject', (req, res) => {
  const { from, to } = req.body;
  const result = db.rejectFriendRequest(from, to);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.get('/api/friends/requests/:username', (req, res) => {
  res.json(db.getFriendRequests(req.params.username));
});

app.get('/api/friends/:username', (req, res) => {
  res.json(db.getFriends(req.params.username));
});

// ========== Messages API ==========
app.get('/api/messages/:user1/:user2', (req, res) => {
  res.json(db.getMessages(req.params.user1, req.params.user2));
});

// ========== Online users tracking ==========
const onlineUsers = {};

// ========== Socket.IO ==========
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('login', (username) => {
    onlineUsers[username] = socket.id;
    socket.username = username;
    io.emit('online-users', Object.keys(onlineUsers));
  });

  socket.on('send-message', (data) => {
    const msg = db.saveMessage(data.from, data.to, data.content, data.type);
    const toSocket = onlineUsers[data.to];
    if (toSocket) {
      io.to(toSocket).emit('new-message', msg);
    }
    socket.emit('message-sent', msg);
  });

  // Voice call signaling
  socket.on('call-user', (data) => {
    const toSocket = onlineUsers[data.to];
    if (toSocket) {
      io.to(toSocket).emit('incoming-call', {
        from: data.from,
        fromUser: db.getUser(data.from),
        offer: data.offer
      });
    }
  });

  socket.on('call-answer', (data) => {
    const toSocket = onlineUsers[data.to];
    if (toSocket) {
      io.to(toSocket).emit('call-answered', { answer: data.answer });
    }
  });

  socket.on('call-ice-candidate', (data) => {
    const toSocket = onlineUsers[data.to];
    if (toSocket) {
      io.to(toSocket).emit('ice-candidate', { candidate: data.candidate });
    }
  });

  socket.on('call-reject', (data) => {
    const toSocket = onlineUsers[data.to];
    if (toSocket) {
      io.to(toSocket).emit('call-rejected');
    }
  });

  socket.on('call-end', (data) => {
    const toSocket = onlineUsers[data.to];
    if (toSocket) {
      io.to(toSocket).emit('call-ended');
    }
  });

  socket.on('typing', (data) => {
    const toSocket = onlineUsers[data.to];
    if (toSocket) {
      io.to(toSocket).emit('friend-typing', { from: data.from });
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete onlineUsers[socket.username];
      io.emit('online-users', Object.keys(onlineUsers));
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`nihaohun server running at http://localhost:${PORT}`);
});
