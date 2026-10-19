require('dotenv').config();
const pool = require('./db');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query(`
      DROP TABLE IF EXISTS answers;
      DROP TABLE IF EXISTS matches;
      DROP TABLE IF EXISTS students;
      DROP TABLE IF EXISTS questions;
      DROP TABLE IF EXISTS question_banks;
      DROP TABLE IF EXISTS settings;

      CREATE TABLE question_banks (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        bank_id INTEGER REFERENCES question_banks(id),
        code TEXT NOT NULL,
        options JSONB NOT NULL,
        correct_index INTEGER NOT NULL,
        explanation TEXT
      );
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        active_bank_id INTEGER REFERENCES question_banks(id)
      );
      CREATE TABLE students (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        class_code TEXT,
        rating INTEGER DEFAULT 1000,
        matches_played INTEGER DEFAULT 0,
        created_at BIGINT
      );
      CREATE TABLE matches (
        id TEXT PRIMARY KEY,
        bank_id INTEGER,
        player_a_id TEXT,
        player_b_id TEXT,
        is_bot INTEGER DEFAULT 0,
        hp_a INTEGER,
        hp_b INTEGER,
        winner TEXT,
        rating_a_before INTEGER,
        rating_b_before INTEGER,
        rating_a_after INTEGER,
        rating_b_after INTEGER,
        finished_at BIGINT
      );
      CREATE TABLE answers (
        id SERIAL PRIMARY KEY,
        match_id TEXT,
        student_id TEXT,
        round INTEGER,
        question_id TEXT,
        selected INTEGER,
        is_correct INTEGER,
        time_ms INTEGER
      );
    `);

    const banks = [
      { id: 1, name: 'Set A' },
      { id: 2, name: 'Set B' },
      { id: 3, name: 'Set C' },
      { id: 4, name: 'Set D' },
      { id: 5, name: 'Set E' },
    ];

    // 1. BUAT BANK DULU
    for (const b of banks) {
      await client.query('INSERT INTO question_banks (id, name) VALUES ($1, $2)', [b.id, b.name]);
    }

    // 2. BUAT SOAL
    for (const bank of banks) {
      for (let i = 1; i <= 10; i++) {
        const a = bank.id * 10 + i;
        const b = a + 3;
        const code = `int a = ${a};\nint b = ${b};\ncout << a + b;`;
        const correct = a + b;
        const options = [correct, correct + 1, correct - 1, correct + 5];
        for (let j = options.length - 1; j > 0; j--) {
          const k = Math.floor(Math.random() * (j + 1));
          [options[j], options[k]] = [options[k], options[j]];
        }
        const idx = options.indexOf(correct);
        await client.query(
          'INSERT INTO questions (id, bank_id, code, options, correct_index, explanation) VALUES ($1, $2, $3, $4, $5, $6)',
          [`q_b${bank.id}_${i}`, bank.id, code, JSON.stringify(options), idx, `${a} + ${b} = ${correct}`]
        );
      }
    }

    // 3. BARU SET BANK AKTIF (karena bank 1 sudah ada)
    await client.query('INSERT INTO settings (id, active_bank_id) VALUES (1, 1)');

    console.log('✅ Seeded: 5 bank × 10 soal');
  } catch (err) {
    console.error('❌ Seed error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();