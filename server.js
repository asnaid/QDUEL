require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const pool = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'] });

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Auto-migrate
pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS session_token TEXT').catch(e => console.log(e.message));
pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS is_teacher BOOLEAN DEFAULT FALSE').catch(e => console.log(e.message));
pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT FALSE').catch(e => console.log(e.message));

// --- AUTH & PROFIL ---
app.post('/api/register', async (req, res) => {
  const { username, password, fullName, classCode } = req.body;
  if (!username || !password || !fullName) return res.status(400).json({ error: 'Data kurang' });
  if (/\s/.test(username)) return res.status(400).json({ error: 'Username tidak boleh mengandung spasi' });

  try {
    const exists = await pool.query('SELECT id FROM students WHERE username=$1', [username]);
    if (exists.rows.length) return res.status(400).json({ error: 'Username sudah dipakai' });
    
    const id = uuid();
    const token = uuid();
    const hash = bcrypt.hashSync(password, 10);
    
    await pool.query('INSERT INTO students (id, username, password_hash, full_name, class_code, created_at, session_token, is_teacher) VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)',
      [id, username, hash, fullName, classCode || '', Date.now(), token]);
      
    res.cookie('sid', id, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, redirect: '/lobby' });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM students WHERE username=$1', [username]);
    const user = r.rows[0];
    
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Salah username/password' });
    }

    if (user.is_frozen) {
      return res.status(403).json({ error: 'Akun ini dibekukan oleh Guru karena terindikasi kecurangan.' });
    }
      
    const token = uuid();
    await pool.query('UPDATE students SET session_token=$1 WHERE id=$2', [token, user.id]);
    
    for (const [id, s] of io.sockets.sockets) {
      if (s.user && s.user.id === user.id) {
        s.emit('force_logout');
        s.disconnect(true);
      }
    }
    
    res.cookie('sid', user.id, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    
    res.json({ ok: true, redirect: user.is_teacher ? '/admin' : '/lobby' });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/logout', (req, res) => { 
  res.clearCookie('sid'); res.clearCookie('token'); res.json({ ok: true }); 
});

app.get('/api/me', async (req, res) => {
  const id = req.cookies.sid;
  const token = req.cookies.token;
  if (!id || !token) return res.status(401).json({ error: 'Belum login' });
  
  try {
    const r = await pool.query('SELECT id, username, full_name, rating, matches_played, session_token, class_code, is_teacher, is_frozen FROM students WHERE id=$1', [id]);
    const user = r.rows[0];
    if (!user || user.session_token !== token) {
      res.clearCookie('sid'); res.clearCookie('token');
      return res.status(401).json({ error: 'Sesi berakhir' });
    }
    if (user.is_frozen) {
      res.clearCookie('sid'); res.clearCookie('token');
      return res.status(403).json({ error: 'Akun dibekukan' });
    }
    res.json(user);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/leaderboard', async (req, res) => {
  const id = req.cookies.sid;
  if (!id) return res.status(401).json({ error: 'Belum login' });
  try {
    const top10 = await pool.query('SELECT username, rating FROM students WHERE is_teacher = FALSE AND is_frozen = FALSE ORDER BY rating DESC LIMIT 10');
    const myData = await pool.query('SELECT rating FROM students WHERE id=$1', [id]);
    if (myData.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const myRating = myData.rows[0].rating;
    const myRankData = await pool.query('SELECT COUNT(*) as total FROM students WHERE rating > $1 AND is_teacher = FALSE AND is_frozen = FALSE', [myRating]);
    const myRank = Number(myRankData.rows[0].total) + 1;
    res.json({ top10: top10.rows, myRank: myRank, myRating: myRating });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', async (req, res) => {
  const id = req.cookies.sid;
  if (!id) return res.status(401).json({ error: 'Belum login' });
  try {
    const q = `
      SELECT m.id, m.winner, m.is_bot, m.hp_a, m.hp_b, 
        m.rating_a_before, m.rating_a_after, m.rating_b_before, m.rating_b_after, 
        m.finished_at, m.player_a_id, m.player_b_id,
        pA.username as name_a, pB.username as name_b
      FROM matches m
      LEFT JOIN students pA ON pA.id = m.player_a_id
      LEFT JOIN students pB ON pB.id = m.player_b_id
      WHERE m.player_a_id = $1 OR m.player_b_id = $1
      ORDER BY m.finished_at DESC LIMIT 5
    `;
    const result = await pool.query(q, [id]);
    const history = result.rows.map(row => {
      const isA = row.player_a_id === id;
      const iWon = row.winner === (isA ? 'a' : 'b');
      const oppName = row.is_bot ? 'Komputer' : (isA ? row.name_b : row.name_a);
      const ratingChange = isA ? (row.rating_a_after - row.rating_a_before) : (row.rating_b_after - row.rating_b_before);
      return {
        id: row.id, opponent: oppName || 'Unknown', isBot: row.is_bot,
        iWon: iWon, myHp: isA ? row.hp_a : row.hp_b, oppHp: isA ? row.hp_b : row.hp_a,
        ratingChange: ratingChange, date: row.finished_at
      };
    });
    res.json(history);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// --- RUTE ADMIN (GURU) ---
app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalStudents = await pool.query('SELECT COUNT(*) FROM students WHERE is_teacher = FALSE');
    const totalMatches = await pool.query('SELECT COUNT(*) FROM matches');
    const activeBank = await pool.query('SELECT s.active_bank_id, qb.name FROM settings s JOIN question_banks qb ON s.active_bank_id = qb.id WHERE s.id = 1');
    const recent = await pool.query(`
      SELECT m.id, m.is_bot, m.finished_at, m.winner, 
             m.player_a_id, m.player_b_id, pA.username as name_a, pB.username as name_b 
      FROM matches m
      LEFT JOIN students pA ON m.player_a_id = pA.id
      LEFT JOIN students pB ON m.player_b_id = pB.id
      ORDER BY m.finished_at DESC LIMIT 5
    `);
    res.json({
      students: Number(totalStudents.rows[0].count),
      matches: Number(totalMatches.rows[0].count),
      activeBank: activeBank.rows[0] || { active_bank_id: 1, name: 'Belum disetel' },
      recentMatches: recent.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/banks', async (req, res) => {
  try {
    const q = `SELECT qb.id, qb.name, COUNT(q.id) as total_questions 
               FROM question_banks qb LEFT JOIN questions q ON qb.id = q.bank_id 
               GROUP BY qb.id, qb.name ORDER BY qb.id ASC`;
    const result = await pool.query(q);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DETEKSI ANOMALI (Perbaikan dengan Casting & JS Math)
app.get('/api/admin/students', async (req, res) => {
  try {
    const q = `
      SELECT 
        s.id, s.full_name, s.username, s.class_code, s.rating, s.matches_played, s.is_frozen,
        COUNT(a.id) as total_answered,
        COALESCE(SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END), 0) as correct,
        COALESCE(AVG(a.time_ms), 0) as avg_time_ms
      FROM students s
      LEFT JOIN answers a ON s.id::text = a.student_id::text
      WHERE s.is_teacher = FALSE
      GROUP BY s.id, s.full_name, s.username, s.class_code, s.rating, s.matches_played, s.is_frozen
      ORDER BY s.rating DESC
    `;
    const result = await pool.query(q);
    
    const processed = result.rows.map(s => {
      const total = Number(s.total_answered) || 0;
      const correct = Number(s.correct) || 0;
      
      // Hitung rata-rata detik di JS agar tidak ada bug tipe data Postgres
      const avgMs = Number(s.avg_time_ms);
      const avgTime = avgMs > 0 ? Math.round((avgMs / 1000.0) * 10) / 10 : 0;
      const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
      
      let isAnomaly = false;
      let anomalyReason = '';

      if (total >= 10 && avgTime > 0 && avgTime < 3) {
        isAnomaly = true; anomalyReason = 'Waktu jawab super cepat (< 3 detik)';
      } else if (total >= 15 && accuracy > 90 && avgTime < 5) {
        isAnomaly = true; anomalyReason = 'Akurasi > 90% dengan waktu sangat cepat';
      }

      return { 
        ...s, 
        total_answered: total, 
        correct: correct, 
        avg_time_sec: avgTime, 
        accuracy: accuracy, 
        isAnomaly, 
        anomalyReason 
      };
    });

    res.json(processed);
  } catch (e) { 
    console.error("ERROR STUDENTS:", e); 
    res.status(500).json({ error: e.message }); 
  }
});

app.post('/api/admin/students/:id/freeze', async (req, res) => {
  const { id } = req.params;
  const { frozen } = req.body;
  try {
    await pool.query('UPDATE students SET is_frozen=$1 WHERE id=$2', [frozen, id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CRUD SISWA
app.post('/api/admin/students', async (req, res) => {
  const { username, password, full_name, class_code } = req.body;
  try {
    const exists = await pool.query('SELECT id FROM students WHERE username=$1', [username]);
    if (exists.rows.length) return res.status(400).json({ error: 'Username sudah dipakai' });
    const id = uuid();
    const hash = bcrypt.hashSync(password, 10);
    await pool.query('INSERT INTO students (id, username, password_hash, full_name, class_code, created_at, is_teacher) VALUES ($1,$2,$3,$4,$5,$6,FALSE)',
      [id, username, hash, full_name, class_code || '', Date.now()]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/students/:id', async (req, res) => {
  const { id } = req.params;
  const { username, full_name, class_code } = req.body;
  try {
    await pool.query('UPDATE students SET username=$1, full_name=$2, class_code=$3 WHERE id=$4', [username, full_name, class_code || '', id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/students/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM answers WHERE student_id=$1', [id]);
    await pool.query('DELETE FROM matches WHERE player_a_id=$1 OR player_b_id=$1', [id]);
    await pool.query('DELETE FROM students WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/students/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  try {
    const hash = bcrypt.hashSync(newPassword, 10);
    await pool.query('UPDATE students SET password_hash=$1 WHERE id=$2', [hash, id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/students/:id/detail', async (req, res) => {
  const { id } = req.params;
  try {
    const student = await pool.query('SELECT full_name, username, class_code, rating, matches_played FROM students WHERE id=$1', [id]);
    if (student.rows.length === 0) return res.status(404).json({ error: 'Siswa tidak ditemukan' });
    const matches = await pool.query(`
      SELECT m.finished_at, m.winner, m.hp_a, m.hp_b, m.is_bot, pA.username as name_a, pB.username as name_b, m.player_a_id, m.player_b_id
      FROM matches m LEFT JOIN students pA ON m.player_a_id = pA.id LEFT JOIN students pB ON m.player_b_id = pB.id
      WHERE m.player_a_id = $1 OR m.player_b_id = $1 ORDER BY m.finished_at DESC LIMIT 10
    `, [id]);
    res.json({ info: student.rows[0], matches: matches.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/questions/stats', async (req, res) => {
  try {
    const q = `SELECT q.id, q.bank_id, q.code, COUNT(a.id) as total_attempts, SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) as correct_attempts
               FROM questions q JOIN answers a ON q.id = a.question_id GROUP BY q.id, q.bank_id, q.code HAVING COUNT(a.id) > 0`;
    const result = await pool.query(q);
    const processed = result.rows.map(r => {
      const total = Number(r.total_attempts);
      const correct = Number(r.correct_attempts);
      return { ...r, total, correct, accuracy: Math.round((correct / total) * 100) };
    });
    processed.sort((a, b) => a.accuracy - b.accuracy);
    res.json(processed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/set-bank', async (req, res) => {
  const { bankId } = req.body;
  try {
    await pool.query('UPDATE settings SET active_bank_id = $1 WHERE id = 1', [bankId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ROUTES ---
app.get('/lobby', async (req, res) => {
  if (!req.cookies.sid || !req.cookies.token) return res.redirect('/');
  try {
    const r = await pool.query('SELECT session_token, is_teacher, is_frozen FROM students WHERE id=$1', [req.cookies.sid]);
    if (!r.rows.length || r.rows[0].session_token !== req.cookies.token || r.rows[0].is_frozen) return res.redirect('/');
    if (r.rows[0].is_teacher) return res.redirect('/admin');
    res.sendFile(__dirname + '/public/app.html');
  } catch (e) { res.redirect('/'); }
});

app.get('/admin', async (req, res) => {
  if (!req.cookies.sid || !req.cookies.token) return res.redirect('/');
  try {
    const r = await pool.query('SELECT session_token, is_teacher FROM students WHERE id=$1', [req.cookies.sid]);
    if (!r.rows.length || r.rows[0].session_token !== req.cookies.token || !r.rows[0].is_teacher) return res.redirect('/');
    res.sendFile(__dirname + '/public/admin.html');
  } catch (e) { res.redirect('/'); }
});

// ===== SOCKET.IO =====
const queue = [];
const activeMatches = new Map();

function parseCookies(str) {
  const out = {};
  if (!str) return out;
  str.split(';').forEach(p => {
    const [k, v] = p.trim().split('=');
    out[k] = decodeURIComponent(v || '');
  });
  return out;
}

io.use(async (socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  if (!cookies.sid || !cookies.token) return next(new Error('No auth'));
  try {
    const r = await pool.query('SELECT * FROM students WHERE id=$1', [cookies.sid]);
    const user = r.rows[0];
    if (!user || user.session_token !== cookies.token || user.is_teacher || user.is_frozen) return next(new Error('Sesi berakhir'));
    socket.user = user;
    next();
  } catch (e) { next(e); }
});

io.on('connection', (socket) => {
  for (const [id, s] of io.sockets.sockets) {
    if (s.id !== socket.id && s.user && s.user.id === socket.user.id) {
      s.emit('force_logout'); s.disconnect(true);
    }
  }

  socket.on('queue:join', async () => {
    for (const m of activeMatches.values()) {
      if (m.playerA.id === socket.user.id || m.playerB.id === socket.user.id) {
        socket.emit('error:msg', { message: 'Kamu sedang bermain!' }); return;
      }
    }
    if (queue.find(q => q.studentId === socket.user.id)) {
      socket.emit('error:msg', { message: 'Kamu sudah berada di antrean!' }); return;
    }
    queue.push({ studentId: socket.user.id, socketId: socket.id, rating: socket.user.rating, joinedAt: Date.now() });
    socket.emit('queue:waiting');
    tryMatch();
  });

  socket.on('queue:leave', () => {
    const idx = queue.findIndex(q => q.studentId === socket.user.id);
    if (idx >= 0) queue.splice(idx, 1);
  });

  socket.on('queue:accept-bot', () => {
    const idx = queue.findIndex(q => q.studentId === socket.user.id);
    if (idx < 0) return;
    queue.splice(idx, 1);
    startMatch(socket.id, socket.user, null);
  });

  socket.on('round:answer', ({ matchId, round, answerIndex }) => {
    const match = activeMatches.get(matchId);
    if (!match || match.state !== 'playing') return;
    const roundNum = Number(round);
    if (Number(match.currentRound) !== roundNum) return;
    
    const side = match.playerA.id === socket.user.id ? 'a' : match.playerB.id === socket.user.id ? 'b' : null;
    if (!side || match.answers[side][roundNum]) return;
    
    match.answers[side][roundNum] = { selected: Number(answerIndex), timeMs: Date.now() - match.roundStartedAt };
    if (match.answers.a[roundNum] && match.answers.b[roundNum] && !match.roundEnding) {
      match.roundEnding = true;
      setTimeout(() => revealRound(match), 200);
    }
  });

  socket.on('disconnect', () => {
    const idx = queue.findIndex(q => q.studentId === socket.user.id);
    if (idx >= 0) queue.splice(idx, 1);
    for (const m of activeMatches.values()) {
      if (m.state !== 'playing' && m.state !== 'revealing') continue;
      if (m.playerA.id === socket.user.id || m.playerB.id === socket.user.id) {
        finishMatch(m, m.playerA.id === socket.user.id ? 'b' : 'a', 'disconnect');
      }
    }
  });
});

function tryMatch() {
  const now = Date.now();
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i], b = queue[j];
      const wait = Math.min(now - a.joinedAt, now - b.joinedAt);
      const window = Math.min(5 + Math.floor(wait / 1000) * 10, 400);
      if (Math.abs(a.rating - b.rating) <= window) {
        queue.splice(j, 1); queue.splice(i, 1);
        const sockA = io.sockets.sockets.get(a.socketId);
        const sockB = io.sockets.sockets.get(b.socketId);
        if (sockA && sockB) {
          Promise.all([
            pool.query('SELECT * FROM students WHERE id=$1', [a.studentId]),
            pool.query('SELECT * FROM students WHERE id=$1', [b.studentId]),
          ]).then(([ra, rb]) => {
            startMatch(a.socketId, ra.rows[0], { socketId: b.socketId, user: rb.rows[0] });
          }).catch(() => queue.push(a, b));
        }
        return;
      }
    }
  }
}

setInterval(() => {
  tryMatch();
  const now = Date.now();
  for (const q of queue) {
    if (now - q.joinedAt > 45000) {
      const sock = io.sockets.sockets.get(q.socketId);
      if (sock) sock.emit('queue:offer-bot');
    }
  }
}, 2000);

async function startMatch(socketAId, userA, opponent) {
  const socketA = io.sockets.sockets.get(socketAId);
  if (!socketA) return;

  let isBot = false, userB, socketB = null;
  if (!opponent) {
    isBot = true;
    let botAccuracy = 0.70, minDelay = 5000, maxDelay = 13000;
    if (userA.rating < 1000) { botAccuracy = 0.40; minDelay = 8000; maxDelay = 15000; }
    else if (userA.rating >= 1000 && userA.rating < 1300) { botAccuracy = 0.65; minDelay = 5000; maxDelay = 10000; }
    else { botAccuracy = 0.85; minDelay = 3000; maxDelay = 6000; }
    userB = { id: `bot_${uuid()}`, username: 'Komputer', rating: userA.rating, botAccuracy, botMinDelay: minDelay, botMaxDelay: maxDelay };
  } else {
    userB = opponent.user;
    socketB = io.sockets.sockets.get(opponent.socketId);
    if (!socketB) return;
  }

  try {
    const bank = (await pool.query('SELECT active_bank_id FROM settings WHERE id=1')).rows[0];
    const qs = (await pool.query('SELECT * FROM questions WHERE bank_id=$1 ORDER BY RANDOM() LIMIT 5', [bank.active_bank_id])).rows;
    if (qs.length < 5) {
      socketA.emit('error:msg', { message: 'Bank soal belum siap atau kurang dari 5.' }); return;
    }

    const matchId = uuid();
    const match = {
      id: matchId, bankId: bank.active_bank_id,
      playerA: { id: userA.id, name: userA.username, rating: userA.rating },
      playerB: { id: userB.id, name: userB.username, rating: userB.rating },
      isBot, botAccuracy: userB.botAccuracy, botMinDelay: userB.botMinDelay, botMaxDelay: userB.botMaxDelay,
      questions: qs, hp: { a: 100, b: 100 }, currentRound: 1,
      answers: { a: {}, b: {} }, state: 'starting', roundEnding: false, roundDuration: 90000,
    };
    activeMatches.set(matchId, match);

    socketA.join(matchId);
    socketA.emit('match:start', {
      matchId, you: 'a', playerA: { name: match.playerA.name, rating: match.playerA.rating },
      playerB: { name: match.playerB.name, rating: match.playerB.rating }, isBot,
    });
    
    if (socketB) {
      socketB.join(matchId);
      socketB.emit('match:start', {
        matchId, you: 'b', playerA: { name: match.playerA.name, rating: match.playerA.rating },
        playerB: { name: match.playerB.name, rating: match.playerB.rating }, isBot: false,
      });
    }
    setTimeout(() => startRound(match), 3000);
  } catch (err) {
    socketA.emit('error:msg', { message: 'Koneksi database terputus.' });
    if (socketB) socketB.emit('error:msg', { message: 'Koneksi database terputus.' });
  }
}

function startRound(match) {
  if (match.state === 'finished') return;
  match.state = 'playing';
  match.roundEnding = false;
  match.roundStartedAt = Date.now();
  match.currentRound = Number(match.currentRound);
  const q = match.questions[match.currentRound - 1];

  io.to(match.id).emit('round:start', {
    round: match.currentRound, totalRounds: 5, code: q.code, options: q.options,
    duration: 90000, hp: { ...match.hp },
  });

  if (match.isBot) {
    const botRound = match.currentRound;
    const willBeCorrect = Math.random() < match.botAccuracy; 
    const delay = match.botMinDelay + Math.random() * (match.botMaxDelay - match.botMinDelay);
    setTimeout(() => {
      if (match.state !== 'playing' || Number(match.currentRound) !== botRound || match.roundEnding) return;
      const q2 = match.questions[botRound - 1];
      let answerIdx;
      if (willBeCorrect) answerIdx = q2.correct_index;
      else {
        const wrongs = [0, 1, 2, 3].filter(i => i !== Number(q2.correct_index));
        answerIdx = wrongs[Math.floor(Math.random() * wrongs.length)];
      }
      match.answers.b[botRound] = { selected: Number(answerIdx), timeMs: delay };
      if (match.answers.a[botRound] && !match.roundEnding) {
        match.roundEnding = true; setTimeout(() => revealRound(match), 200);
      }
    }, delay);
  }

  if (match.roundTimeout) clearTimeout(match.roundTimeout);
  match.roundTimeout = setTimeout(() => {
    if (match.state !== 'playing' || match.roundEnding) return;
    match.roundEnding = true;
    revealRound(match);
  }, 90000);
}

function revealRound(match) {
  if (match.state !== 'playing') return;
  match.state = 'revealing';
  if (match.roundTimeout) { clearTimeout(match.roundTimeout); match.roundTimeout = null; }
  const r = Number(match.currentRound);
  const q = match.questions[r - 1];
  const ansA = match.answers.a[r];
  const ansB = match.answers.b[r];
  
  const correctA = ansA && Number(ansA.selected) === Number(q.correct_index);
  const correctB = ansB && Number(ansB.selected) === Number(q.correct_index);

  let dmgA = 0, dmgB = 0, reason = '';
  if (!ansA && !ansB) { dmgA = 10; dmgB = 10; reason = 'both_timeout'; } 
  else if (correctA && correctB) {
    if (ansA.timeMs <= ansB.timeMs) { dmgB = 35; dmgA = 15; reason = 'a_faster'; }
    else { dmgA = 35; dmgB = 15; reason = 'b_faster'; }
  } 
  else if (correctA) { dmgB = 25; reason = !ansB ? 'a_correct_b_timeout' : 'a_correct'; } 
  else if (correctB) { dmgA = 25; reason = !ansA ? 'b_correct_a_timeout' : 'b_correct'; } 
  else if (!ansA) { dmgA = 15; dmgB = 15; reason = 'a_timeout_b_wrong'; } 
  else if (!ansB) { dmgB = 15; dmgA = 15; reason = 'b_timeout_a_wrong'; } 
  else { reason = 'both_wrong'; }

  match.hp.a = Math.max(0, match.hp.a - dmgA);
  match.hp.b = Math.max(0, match.hp.b - dmgB);

  io.to(match.id).emit('round:reveal', {
    round: r, correctIndex: q.correct_index, explanation: q.explanation,
    hp: { ...match.hp }, damage: { a: dmgA, b: dmgB }, reason: reason,
  });

  (async () => {
    try {
      if (ansA) await pool.query('INSERT INTO answers (match_id, student_id, round, question_id, selected, is_correct, time_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [match.id, match.playerA.id, r, q.id, ansA.selected, correctA ? 1 : 0, ansA.timeMs]);
      if (ansB && !match.isBot) await pool.query('INSERT INTO answers (match_id, student_id, round, question_id, selected, is_correct, time_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [match.id, match.playerB.id, r, q.id, ansB.selected, correctB ? 1 : 0, ansB.timeMs]);
    } catch (e) {}
  })();

  setTimeout(() => {
    if (match.state !== 'revealing') return;
    if (match.hp.a <= 0 || match.hp.b <= 0) {
      finishMatch(match, match.hp.a <= 0 ? 'b' : 'a', 'ko'); return;
    }
    if (match.currentRound >= 5) {
      let winner = match.hp.a > match.hp.b ? 'a' : match.hp.b > match.hp.a ? 'b' : (Math.random() < 0.5 ? 'a' : 'b');
      finishMatch(match, winner, 'poin'); return;
    }
    match.currentRound++; match.state = 'playing'; startRound(match);
  }, 5000); 
}

async function finishMatch(match, winner, reason) {
  if (match.state === 'finished') return;
  match.state = 'finished';
  let ratingA_after = match.playerA.rating;
  let ratingB_after = match.playerB.rating;

  try {
    const rowA = (await pool.query('SELECT matches_played FROM students WHERE id=$1', [match.playerA.id])).rows[0];
    let rowB = match.isBot ? { matches_played: rowA.matches_played } : (await pool.query('SELECT matches_played FROM students WHERE id=$1', [match.playerB.id])).rows[0];
    const getK = (matches, isBot) => isBot ? 10 : (matches < 10 ? 40 : matches < 30 ? 32 : 24);
    const kA = getK(rowA.matches_played, match.isBot);
    const kB = getK(rowB.matches_played, match.isBot);
    const EA = 1 / (1 + Math.pow(10, (match.playerB.rating - match.playerA.rating) / 400));
    const EB = 1 - EA;
    const SA = winner === 'a' ? 1 : 0;
    const SB = winner === 'b' ? 1 : 0;
    
    ratingA_after += Math.round(kA * (SA - EA));
    ratingB_after += Math.round(kB * (SB - EB));

    await pool.query('UPDATE students SET rating=$1, matches_played=matches_played+1 WHERE id=$2', [ratingA_after, match.playerA.id]);
    if (!match.isBot) await pool.query('UPDATE students SET rating=$1, matches_played=matches_played+1 WHERE id=$2', [ratingB_after, match.playerB.id]);

    await pool.query('INSERT INTO matches (id, bank_id, player_a_id, player_b_id, is_bot, hp_a, hp_b, winner, rating_a_before, rating_b_before, rating_a_after, rating_b_after, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [match.id, match.bankId, match.playerA.id, match.isBot ? null : match.playerB.id, match.isBot ? 1 : 0,
       match.hp.a, match.hp.b, winner, match.playerA.rating, match.playerB.rating, ratingA_after, ratingB_after, Date.now()]);
  } catch (e) {}

  io.to(match.id).emit('match:end', {
    winner, reason, hp: { ...match.hp },
    rating: { a: { before: match.playerA.rating, after: ratingA_after, change: ratingA_after - match.playerA.rating }, b: { before: match.playerB.rating, after: ratingB_after, change: ratingB_after - match.playerB.rating } },
  });
  activeMatches.delete(match.id);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`▶ http://localhost:${PORT}`));