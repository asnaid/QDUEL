const bcrypt = require('bcryptjs');
const pool = require('./db');

const hash = bcrypt.hashSync('admin123', 10);

pool.query("UPDATE students SET password_hash = $1 WHERE username = 'admin'", [hash])
  .then(() => { 
    console.log('✅ Sukses! Password admin sekarang adalah: admin123'); 
    process.exit(0); 
  })
  .catch(err => { 
    console.error('❌ Gagal:', err); 
    process.exit(1); 
  });