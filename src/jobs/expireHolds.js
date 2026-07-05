const cron = require('node-cron');
const { getPool, sql } = require('../config/db');

/**
 * Corre cada minuto. Busca números en estado 'reserved' cuyo
 * hold_expires_at ya pasó y cuya orden sigue 'pending' (el cliente
 * nunca completó el pago / el admin nunca confirmó a tiempo).
 * Los libera y marca la orden como 'expired'.
 */
function startExpireHoldsJob(io) {
  cron.schedule('* * * * *', async () => {
    try {
      const pool = await getPool();

      const expired = await pool.request().query(`
        SELECT DISTINCT n.number_value, n.order_id
        FROM numbers n
        WHERE n.status = 'reserved'
          AND n.hold_expires_at IS NOT NULL
          AND n.hold_expires_at < SYSUTCDATETIME()
          AND n.reserved_by_admin = 0
      `);

      if (expired.recordset.length === 0) return;

      const numberValues = expired.recordset.map(r => r.number_value);
      const orderIds = [...new Set(expired.recordset.map(r => r.order_id).filter(Boolean))];

      const transaction = new sql.Transaction(pool);
      await transaction.begin();

      const numRequest = new sql.Request(transaction);
      numberValues.forEach((n, i) => numRequest.input(`n${i}`, sql.Char(4), n));
      const numPlaceholders = numberValues.map((_, i) => `@n${i}`).join(',');
      await numRequest.query(`
        UPDATE numbers
        SET status = 'available', order_id = NULL,
            reserved_at = NULL, hold_expires_at = NULL
        WHERE number_value IN (${numPlaceholders})
      `);

      if (orderIds.length > 0) {
        const orderRequest = new sql.Request(transaction);
        orderIds.forEach((id, i) => orderRequest.input(`o${i}`, sql.Int, id));
        const orderPlaceholders = orderIds.map((_, i) => `@o${i}`).join(',');
        await orderRequest.query(`
          UPDATE orders SET status = 'expired'
          WHERE status = 'pending' AND id IN (${orderPlaceholders})
        `);
      }

      await transaction.commit();

      io.emit(
        'numbers:update',
        numberValues.map(n => ({ number_value: n, status: 'available' }))
      );

      console.log(`Liberados ${numberValues.length} números por hold vencido`);
    } catch (err) {
      console.error('Error en el job de expiración de holds:', err.message);
    }
  });
}

module.exports = { startExpireHoldsJob };
