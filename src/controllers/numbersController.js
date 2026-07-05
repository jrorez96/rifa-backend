const { getPool } = require('../config/db');

/**
 * GET /api/numbers
 * Devuelve el estado actual de los 10,000 números.
 * El frontend usa esto al cargar la página, y después
 * se mantiene actualizado por sockets.
 */
exports.getAllNumbers = async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT number_value, status
      FROM numbers
      ORDER BY number_value
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar los números' });
  }
};

/**
 * GET /api/numbers/settings
 * Precio por número, fecha de sorteo, etc.
 * Así el frontend no tiene nada hardcodeado.
 */
exports.getSettings = async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT price_per_number, draw_date, hold_minutes, admin_whatsapp
      FROM raffle_settings WHERE id = 1
    `);
    res.json(result.recordset[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar la configuración' });
  }
};
