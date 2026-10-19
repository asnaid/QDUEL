require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { v4: uuid } = require('uuid');

async function fixAdmin() {
  try {
    // 1. Pastikan kolom is_teacher ada
    await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS is_teacher BOOLEAN DEFAULT FALSE');

    // 2. Hapus akun admin lama (jika ada yang rusak)
    await pool.query("DELETE FROM students WHERE username = 'admin'");

    // 3. Buat akun admin baru dengan password yang di-hash
    const hash = bcrypt.hashSync('admin123', 10);
    const id = uuid();
    
    await pool.query(
      "INSERT INTO students (id, username, password_hash, full_name, is_teacher, created_at, matches_played, rating) VALUES ($1, 'admin', $2, 'Guru Pengampu', TRUE, $3, 0, 1000)",
      [id, hash, Date.now()]
    );

    console.log('✅ BERHASIL! Akun admin telah dibuat ulang.');
    console.log('Username: admin');
    console.log('Password: admin123');
    process.exit(0);
  } catch (err) {
    console.error('❌ GAGAL:', err);
    process.exit(1);
  }
}

fixAdmin();