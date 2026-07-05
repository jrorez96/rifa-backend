/**
 * Uso: node src/scripts/createAdmin.js <usuario> <password>
 * Ejemplo: node src/scripts/createAdmin.js djmarko MiClaveSegura123
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getPool, sql } = require('../config/db');

async function main() {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    console.error('Uso: node src/scripts/createAdmin.js <usuario> <password>');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const pool = await getPool();

  await pool.request()
    .input('username', sql.NVarChar, username)
    .input('hash', sql.NVarChar, hash)
    .query(`INSERT INTO admins (username, password_hash) VALUES (@username, @hash)`);

  console.log(`Admin "${username}" creado correctamente.`);
  process.exit(0);
}

main().catch(err => {
  console.error('Error al crear el admin:', err.message);
  process.exit(1);
});
