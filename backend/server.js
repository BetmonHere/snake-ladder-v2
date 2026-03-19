require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ─── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: '*' }));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 200 }));
app.use('/api/auth/', rateLimit({ windowMs: 15*60*1000, max: 30 }));

// ─── MongoDB ───────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(e  => console.error('❌ MongoDB:', e.message));

// ─── Schemas ──────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:    { type:String, required:true, unique:true, trim:true, minlength:3, maxlength:20 },
  displayName: { type:String, required:true, trim:true, maxlength:30 },
  password:    { type:String, required:true },
  isAdmin:     { type:Boolean, default:false },
  createdAt:   { type:Date, default:Date.now },
  lastLogin:   { type:Date },
  gamesPlayed: { type:Number, default:0 },
  gamesWon:    { type:Number, default:0 }
});

const gameLogSchema = new mongoose.Schema({
  gameId:    { type:String, required:true },
  mode:      { type:String, enum:['bot','multiplayer'] },
  players:   [{ username:String, displayName:String, rank:Number, isBot:Boolean }],
  winner:    String,
  moves:     Number,
  duration:  Number,
  startedAt: { type:Date, default:Date.now },
  endedAt:   Date
});

const User    = mongoose.model('User',    userSchema);
const GameLog = mongoose.model('GameLog', gameLogSchema);

// ─── In-Memory Rooms ──────────────────────────────────────────
// Rooms are kept in memory for real-time; they expire after 2 hours.
const rooms = new Map(); // code -> roomObject

function makeRoom(code, host, hostDisplay, maxPlayers) {
  return {
    code, host, hostDisplay, maxPlayers,
    players: [{ username: host, displayName: hostDisplay, socketId: null, ready: false }],
    status: 'waiting',    // waiting | playing | finished
    game: null,           // live game state
    createdAt: Date.now()
  };
}

// Clean up stale rooms every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 2*60*60*1000;
  for (const [code, room] of rooms.entries()) {
    if (room.createdAt < cutoff) rooms.delete(code);
  }
}, 30*60*1000);

// ─── Helpers ──────────────────────────────────────────────────
const JWT_SECRET   = process.env.JWT_SECRET   || 'change_me_in_production';
const ADMIN_USER   = process.env.ADMIN_USERNAME || 'snladmin';
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'Admin@SNL2024!';

const tok = u => jwt.sign({ id:u._id, username:u.username, isAdmin:u.isAdmin }, JWT_SECRET, { expiresIn:'7d' });

function verifyTok(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

const auth  = (req,res,next) => { const u=verifyTok(req.headers.authorization?.split(' ')[1]); if(!u) return res.status(401).json({error:'Unauthorized'}); req.user=u; next(); };
const admin = (req,res,next) => { if(!req.user?.isAdmin) return res.status(403).json({error:'Forbidden'}); next(); };

function validatePw(pw) {
  const e=[];
  if(pw.length<8) e.push('At least 8 characters');
  if(!/[A-Z]/.test(pw)) e.push('At least one uppercase letter');
  if(!/[a-z]/.test(pw)) e.push('At least one lowercase letter');
  if(!/[0-9]/.test(pw)) e.push('At least one number');
  if(!/[^A-Za-z0-9]/.test(pw)) e.push('At least one special character');
  return e;
}

// ─── GAME CONSTANTS ───────────────────────────────────────────
const SNAKES  = {99:5, 94:31, 89:53, 74:37, 62:19, 64:60, 87:24, 54:34, 17:7};
const LADDERS = {4:25, 9:31, 20:42, 28:84, 40:59, 51:67, 63:81, 71:91, 80:100};

function createGameState(players) {
  return {
    id: uuidv4(),
    players: players.map((p,i) => ({
      username: p.username,
      displayName: p.displayName,
      color: ['#FFD700','#FF4D6D','#00E5CC','#A78BFA','#FB923C'][i],
      pos: 0,
      isBot: p.isBot || false,
      finished: false,
      rank: null,
      moves: 0
    })),
    curIdx: 0,
    over: false,
    finished: [],
    lastRoll: null,
    lastEvent: null,   // 'snake' | 'ladder' | null
    startedAt: Date.now()
  };
}

function processRoll(game, roll) {
  const p = game.players[game.curIdx];
  if (p.finished || game.over) return null;

  const events = [];
  let newPos = p.pos + roll;
  events.push({ type:'roll', player: p.username, displayName: p.displayName, roll, from: p.pos });

  if (newPos > 100) {
    events.push({ type:'bounce', player: p.username, displayName: p.displayName, pos: p.pos });
    return { game, events, bonusTurn: false };
  }

  p.pos = newPos;
  p.moves++;

  let specialDest = null;
  let specialType = null;

  if (SNAKES[newPos] !== undefined) {
    specialDest = SNAKES[newPos];
    specialType = 'snake';
  } else if (LADDERS[newPos] !== undefined) {
    specialDest = LADDERS[newPos];
    specialType = 'ladder';
  }

  if (specialDest !== null) {
    events.push({ type: specialType, player: p.username, displayName: p.displayName, from: newPos, to: specialDest });
    p.pos = specialDest;
  }

  game.lastRoll = roll;
  game.lastEvent = specialType;

  let won = false;
  if (p.pos === 100) {
    p.finished = true;
    game.finished.push(p.username);
    p.rank = game.finished.length;
    events.push({ type:'win', player: p.username, displayName: p.displayName, rank: p.rank });
    won = true;

    const remaining = game.players.filter(x => !x.finished && !x.isBot);
    if (remaining.length === 0 || game.players.filter(x => !x.finished).length <= 1) {
      // Last person gets last rank
      game.players.filter(x => !x.finished).forEach(x => {
        x.finished = true;
        x.rank = game.finished.length + 1;
        game.finished.push(x.username);
      });
      game.over = true;
      events.push({ type:'gameover', winner: p.username, winnerDisplay: p.displayName });
    }
  }

  const bonusTurn = roll === 6 && !won && !game.over;

  // Advance turn unless bonus
  if (!bonusTurn && !game.over) {
    let tries = 0;
    do {
      game.curIdx = (game.curIdx + 1) % game.players.length;
      tries++;
      if (tries > game.players.length) break;
    } while (game.players[game.curIdx].finished);
  }

  return { game, events, bonusTurn };
}

// ─── Seed Admin ───────────────────────────────────────────────
async function seedAdmin() {
  try {
    if (!await User.findOne({ username: ADMIN_USER })) {
      await User.create({ username:ADMIN_USER, displayName:'Administrator', password: await bcrypt.hash(ADMIN_PASS,12), isAdmin:true });
      console.log('✅ Admin seeded');
    }
  } catch(e) { console.log('Admin exists:', e.message); }
}

// ─── HTTP AUTH ROUTES ─────────────────────────────────────────
app.post('/api/auth/register', async (req,res) => {
  try {
    const { username, displayName, password } = req.body;
    if (!username||!password||!displayName) return res.status(400).json({error:'All fields required'});
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({error:'Username: 3-20 chars, letters/numbers/underscore only'});
    if (username.toLowerCase()===ADMIN_USER.toLowerCase()) return res.status(400).json({error:'Username not available'});
    const pwErr = validatePw(password);
    if (pwErr.length) return res.status(400).json({error:pwErr[0], details:pwErr});
    if (await User.findOne({ username:{$regex:new RegExp(`^${username}$`,'i')} }))
      return res.status(400).json({error:'Username already taken'});
    const user = await User.create({ username, displayName:displayName.trim()||username, password:await bcrypt.hash(password,12) });
    res.status(201).json({ token:tok(user), user:{username:user.username,displayName:user.displayName,isAdmin:false} });
  } catch(e) { console.error(e); res.status(500).json({error:'Server error'}); }
});

app.post('/api/auth/login', async (req,res) => {
  try {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({error:'Required'});
    const user = await User.findOne({ username:{$regex:new RegExp(`^${username}$`,'i')} });
    if (!user||!await bcrypt.compare(password,user.password)) return res.status(401).json({error:'Invalid credentials'});
    user.lastLogin=new Date(); await user.save();
    res.json({ token:tok(user), user:{username:user.username,displayName:user.displayName,isAdmin:user.isAdmin} });
  } catch(e) { res.status(500).json({error:'Server error'}); }
});

// ─── ADMIN HTTP ROUTES ────────────────────────────────────────
app.get('/api/admin/stats', auth, admin, async (req,res) => {
  try {
    const [totalUsers,totalGames,recentUsers,recentGames,topPlayers] = await Promise.all([
      User.countDocuments({isAdmin:false}),
      GameLog.countDocuments(),
      User.find({isAdmin:false}).sort({createdAt:-1}).limit(20).select('-password'),
      GameLog.find().sort({startedAt:-1}).limit(20),
      User.find({isAdmin:false}).sort({gamesWon:-1}).limit(10).select('-password')
    ]);
    const botGames = await GameLog.countDocuments({mode:'bot'});
    const mpGames  = await GameLog.countDocuments({mode:'multiplayer'});
    const activeRooms = [...rooms.values()].filter(r=>r.status!=='finished');
    res.json({ totalUsers,totalGames,botGames,mpGames,recentUsers,recentGames,topPlayers,activeRooms });
  } catch(e) { res.status(500).json({error:'Server error'}); }
});

app.delete('/api/admin/users/:id', auth, admin, async (req,res) => {
  try { await User.findByIdAndDelete(req.params.id); res.json({success:true}); }
  catch(e) { res.status(500).json({error:'Server error'}); }
});

app.get('/api/health', (_,res) => res.json({status:'ok',rooms:rooms.size,time:new Date()}));

// ─── SOCKET.IO ────────────────────────────────────────────────
// Map socketId -> { username, displayName, roomCode }
const socketUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  const user = verifyTok(token);
  if (!user) return next(new Error('Invalid token'));
  socket.user = user;
  next();
});

io.on('connection', socket => {
  console.log(`🔌 Connected: ${socket.user.username} (${socket.id})`);

  // ── CREATE ROOM ───────────────────────────────────────────
  socket.on('create_room', ({ maxPlayers }) => {
    if (!maxPlayers || maxPlayers < 2 || maxPlayers > 5) {
      return socket.emit('error', 'Invalid player count');
    }
    // Generate unique 6-char code
    let code;
    do { code = Math.random().toString(36).substring(2,8).toUpperCase(); }
    while (rooms.has(code));

    const room = makeRoom(code, socket.user.username, socket.user.displayName||socket.user.username, maxPlayers);
    room.players[0].socketId = socket.id;
    rooms.set(code, room);

    socketUsers.set(socket.id, { username: socket.user.username, displayName: socket.user.displayName||socket.user.username, roomCode: code });
    socket.join(code);
    socket.emit('room_created', { room: sanitizeRoom(room), isHost: true });
    console.log(`🏠 Room ${code} created by ${socket.user.username}`);
  });

  // ── JOIN ROOM ─────────────────────────────────────────────
  socket.on('join_room', ({ code }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return socket.emit('join_error', 'Room not found');
    if (room.status !== 'waiting') return socket.emit('join_error', 'Game already started');
    if (room.players.length >= room.maxPlayers) return socket.emit('join_error', 'Room is full');

    const existing = room.players.find(p => p.username === socket.user.username);
    if (!existing) {
      room.players.push({ username: socket.user.username, displayName: socket.user.displayName||socket.user.username, socketId: socket.id, ready: false });
    } else {
      existing.socketId = socket.id; // reconnect
    }

    socketUsers.set(socket.id, { username: socket.user.username, displayName: socket.user.displayName||socket.user.username, roomCode: code.toUpperCase() });
    socket.join(code.toUpperCase());

    // Emit to joiner
    socket.emit('room_joined', { room: sanitizeRoom(room), isHost: false, yourUsername: socket.user.username });
    // Broadcast updated room to everyone
    io.to(code.toUpperCase()).emit('room_updated', { room: sanitizeRoom(room) });
    console.log(`👤 ${socket.user.username} joined room ${code.toUpperCase()}`);
  });

  // ── START GAME (host only) ────────────────────────────────
  socket.on('start_game', ({ code }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return socket.emit('error', 'Room not found');
    if (room.host !== socket.user.username) return socket.emit('error', 'Only host can start');
    if (room.players.length < 2) return socket.emit('error', 'Need at least 2 players');

    room.status = 'playing';
    room.game = createGameState(room.players.map(p => ({ username: p.username, displayName: p.displayName })));

    io.to(code.toUpperCase()).emit('game_started', {
      game: room.game,
      players: room.players.map(p => ({ username: p.username, displayName: p.displayName }))
    });
    console.log(`🎮 Game started in room ${code.toUpperCase()}`);
  });

  // ── ROLL DICE ─────────────────────────────────────────────
  socket.on('roll_dice', ({ code }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room || !room.game || room.game.over) return;

    const game = room.game;
    const curPlayer = game.players[game.curIdx];

    // Strict turn check: only the current player can roll
    if (curPlayer.username !== socket.user.username) {
      return socket.emit('not_your_turn', { currentPlayer: curPlayer.displayName });
    }

    const roll = Math.floor(Math.random() * 6) + 1;
    const result = processRoll(game, roll);
    if (!result) return;

    room.game = result.game;

    // Broadcast the full roll result to all players in the room
    io.to(code.toUpperCase()).emit('roll_result', {
      roll,
      rolledBy: socket.user.username,
      rolledByDisplay: curPlayer.displayName,
      events: result.events,
      bonusTurn: result.bonusTurn,
      game: room.game
    });

    // If game over, log it
    if (result.game.over) {
      const winner = result.game.players.find(p=>p.rank===1);
      GameLog.create({
        gameId: result.game.id,
        mode: 'multiplayer',
        players: result.game.players.map(p=>({ username:p.username, displayName:p.displayName, rank:p.rank, isBot:false })),
        winner: winner?.displayName,
        moves: result.game.players.reduce((a,p)=>a+p.moves,0),
        duration: Math.floor((Date.now()-result.game.startedAt)/1000),
        endedAt: new Date()
      }).then(async () => {
        // Update stats
        for (const p of result.game.players) {
          if (p.username) {
            await User.findOneAndUpdate({ username:p.username },
              { $inc:{ gamesPlayed:1, gamesWon: p.rank===1?1:0 } });
          }
        }
      }).catch(console.error);
      room.status = 'finished';
    }
  });

  // ── BOT ROLL (server-side) ─────────────────────────────────
  socket.on('bot_roll', ({ code }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room || !room.game || room.game.over) return;

    const game = room.game;
    const curPlayer = game.players[game.curIdx];
    if (!curPlayer.isBot) return; // only bots

    const roll = Math.floor(Math.random() * 6) + 1;
    const result = processRoll(game, roll);
    if (!result) return;
    room.game = result.game;

    io.to(code.toUpperCase()).emit('roll_result', {
      roll,
      rolledBy: curPlayer.username,
      rolledByDisplay: curPlayer.displayName,
      events: result.events,
      bonusTurn: result.bonusTurn,
      game: room.game
    });
  });

  // ── DISCONNECT ────────────────────────────────────────────
  socket.on('disconnect', () => {
    const info = socketUsers.get(socket.id);
    if (info) {
      const room = rooms.get(info.roomCode);
      if (room) {
        const p = room.players.find(x => x.username === info.username);
        if (p) p.socketId = null;
        // Notify others
        io.to(info.roomCode).emit('player_disconnected', { username: info.username, displayName: info.displayName });
      }
      socketUsers.delete(socket.id);
    }
    console.log(`🔌 Disconnected: ${socket.user?.username}`);
  });

  // ── RECONNECT TO ROOM ──────────────────────────────────────
  socket.on('reconnect_room', ({ code }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return socket.emit('error', 'Room expired');

    const p = room.players.find(x => x.username === socket.user.username);
    if (!p) return socket.emit('error', 'You are not in this room');
    p.socketId = socket.id;
    socketUsers.set(socket.id, { username: socket.user.username, displayName: p.displayName, roomCode: code.toUpperCase() });
    socket.join(code.toUpperCase());

    if (room.status === 'playing' && room.game) {
      socket.emit('game_started', { game: room.game, players: room.players.map(p=>({username:p.username,displayName:p.displayName})) });
    } else {
      socket.emit('room_updated', { room: sanitizeRoom(room) });
    }
  });
});

function sanitizeRoom(room) {
  return {
    code: room.code,
    host: room.host,
    hostDisplay: room.hostDisplay,
    maxPlayers: room.maxPlayers,
    status: room.status,
    players: room.players.map(p => ({ username:p.username, displayName:p.displayName, online: !!p.socketId }))
  };
}

// ─── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 SNL Server on port ${PORT}`);
  await seedAdmin();
});
