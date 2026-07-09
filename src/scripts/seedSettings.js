/**
 * Inserta la fila de configuración inicial en raffle_settings (id = 1)
 * si todavía no existe. Ajusta los valores por defecto abajo antes de correrlo,
 * o simplemente edítalos después directo en la tabla / desde el panel admin.
 *
 * Uso: node src/scripts/seedSettings.js
 */
require('dotenv').config();
const { getPool, sql } = require('../config/db');

async function main() {
  const pool = await getPool();

  const exists = await pool.request().query(`SELECT id FROM raffle_settings WHERE id = 1`);
  if (exists.recordset.length > 0) {
    console.log('raffle_settings ya tiene una fila con id=1, no se hizo nada.');
    process.exit(0);
  }

  await pool.request()
    .input('price', sql.Decimal(10, 2), Number(process.env.PRICE_PER_NUMBER) || 1000)
    .input('drawDate', sql.DateTime2, new Date('2026-10-25T00:00:00'))
    .input('holdMinutes', sql.Int, Number(process.env.HOLD_MINUTES) || 1440)
    .input('proofUploadMinutes', sql.Int, Number(process.env.PROOF_UPLOAD_MINUTES) || 15)
    .input('whatsapp', sql.NVarChar, process.env.ADMIN_WHATSAPP || '50662132462')
    .query(`
      INSERT INTO raffle_settings (id, price_per_number, draw_date, hold_minutes, proof_upload_minutes, admin_whatsapp)
      VALUES (1, @price, @drawDate, @holdMinutes, @proofUploadMinutes, @whatsapp)
    `);

  console.log('Configuración inicial de la rifa creada.');
  process.exit(0);
}

main().catch(err => {
  console.error('Error al insertar la configuración:', err.message);
  process.exit(1);
});
