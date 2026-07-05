const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../config/db');

/**
 * POST /api/admin/login
 */
exports.login = async (req, res) => {
  const { username, password } = req.body;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('username', sql.NVarChar, username)
      .query(`SELECT id, username, password_hash FROM admins WHERE username = @username`);

    const admin = result.recordset[0];
    if (!admin) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    const token = jwt.sign(
      { id: admin.id, username: admin.username },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token, admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
};

/**
 * GET /api/admin/orders?status=pending
 * Lista de órdenes para revisar en el panel.
 */
exports.listOrders = async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const pool = await getPool();
    const result = await pool.request()
      .input('status', sql.VarChar, status)
      .query(`
        SELECT o.id, o.status, o.total_amount, o.payment_proof_url, o.created_at,
               c.name, c.phone, c.email,
               STRING_AGG(nx.number_value, ', ') AS numbers
        FROM orders o
        JOIN clients c ON c.id = o.client_id
        JOIN order_numbers nx ON nx.order_id = o.id
        WHERE o.status = @status
        GROUP BY o.id, o.status, o.total_amount, o.payment_proof_url, o.created_at,
                 c.name, c.phone, c.email
        ORDER BY o.created_at DESC
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar órdenes' });
  }
};

/**
 * PATCH /api/admin/orders/:id/confirm
 * El admin ya verificó el pago -> números quedan bloqueados en firme ('sold').
 */
exports.confirmOrder = async (req, res) => {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const orderId = req.params.id;

    const nums = await new sql.Request(transaction)
      .input('id', sql.Int, orderId)
      .query(`SELECT number_value FROM order_numbers WHERE order_id = @id`);

    if (nums.recordset.length === 0) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    await new sql.Request(transaction)
      .input('id', sql.Int, orderId)
      .input('adminId', sql.Int, req.admin.id)
      .query(`
        UPDATE orders
        SET status = 'confirmed', confirmed_at = SYSUTCDATETIME(), confirmed_by = @adminId
        WHERE id = @id
      `);

    const placeholders = nums.recordset.map((_, i) => `@n${i}`).join(',');
    const updateNums = new sql.Request(transaction);
    nums.recordset.forEach((r, i) => updateNums.input(`n${i}`, sql.Char(4), r.number_value));
    await updateNums.query(`
      UPDATE numbers
      SET status = 'sold', sold_at = SYSUTCDATETIME(), hold_expires_at = NULL
      WHERE number_value IN (${placeholders})
    `);

    await transaction.commit();

    req.io.emit(
      'numbers:update',
      nums.recordset.map(r => ({ number_value: r.number_value, status: 'sold' }))
    );

    res.json({ ok: true });
  } catch (err) {
    await transaction.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al confirmar la orden' });
  }
};

/**
 * PATCH /api/admin/orders/:id/reject
 * Libera los números para que vuelvan a estar disponibles.
 */
exports.rejectOrder = async (req, res) => {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const orderId = req.params.id;

    const nums = await new sql.Request(transaction)
      .input('id', sql.Int, orderId)
      .query(`SELECT number_value FROM order_numbers WHERE order_id = @id`);

    if (nums.recordset.length === 0) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    await new sql.Request(transaction)
      .input('id', sql.Int, orderId)
      .query(`UPDATE orders SET status = 'rejected' WHERE id = @id`);

    const placeholders = nums.recordset.map((_, i) => `@n${i}`).join(',');
    const updateNums = new sql.Request(transaction);
    nums.recordset.forEach((r, i) => updateNums.input(`n${i}`, sql.Char(4), r.number_value));
    await updateNums.query(`
      UPDATE numbers
      SET status = 'available', order_id = NULL, reserved_at = NULL, hold_expires_at = NULL
      WHERE number_value IN (${placeholders})
    `);

    await transaction.commit();

    req.io.emit(
      'numbers:update',
      nums.recordset.map(r => ({ number_value: r.number_value, status: 'available' }))
    );

    res.json({ ok: true });
  } catch (err) {
    await transaction.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al rechazar la orden' });
  }
};

/**
 * POST /api/admin/numbers/reserve
 * Body: { name, phone, email, numbers: [...] }
 * Para clientes que compran offline (no pueden entrar al sitio).
 * Se venden directo como 'sold', sin pasar por WhatsApp ni comprobante.
 */
exports.manualReserve = async (req, res) => {
  const { name, phone, email, numbers } = req.body;

  if (!name || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Nombre y al menos un número son obligatorios' });
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const checkRequest = new sql.Request(transaction);
    numbers.forEach((n, i) => checkRequest.input(`n${i}`, sql.Char(4), n));
    const placeholders = numbers.map((_, i) => `@n${i}`).join(',');

    const check = await checkRequest.query(`
      SELECT number_value, status FROM numbers WITH (UPDLOCK, ROWLOCK)
      WHERE number_value IN (${placeholders})
    `);
    const notAvailable = check.recordset.filter(r => r.status !== 'available');
    if (notAvailable.length > 0) {
      await transaction.rollback();
      return res.status(409).json({
        error: 'Algunos números ya no están disponibles',
        numbers: notAvailable.map(r => r.number_value)
      });
    }

    const settingsResult = await new sql.Request(transaction).query(
      `SELECT price_per_number FROM raffle_settings WHERE id = 1`
    );
    const pricePerNumber = settingsResult.recordset[0].price_per_number;

    const clientResult = await new sql.Request(transaction)
      .input('name', sql.NVarChar, name)
      .input('phone', sql.NVarChar, phone || '')
      .input('email', sql.NVarChar, email || '')
      .query(`
        INSERT INTO clients (name, phone, email)
        OUTPUT INSERTED.id VALUES (@name, @phone, @email)
      `);
    const clientId = clientResult.recordset[0].id;

    const total = numbers.length * pricePerNumber;
    const orderResult = await new sql.Request(transaction)
      .input('clientId', sql.Int, clientId)
      .input('total', sql.Decimal(10, 2), total)
      .input('adminId', sql.Int, req.admin.id)
      .query(`
        INSERT INTO orders (client_id, total_amount, status, confirmed_at, confirmed_by)
        OUTPUT INSERTED.id
        VALUES (@clientId, @total, 'confirmed', SYSUTCDATETIME(), @adminId)
      `);
    const orderId = orderResult.recordset[0].id;

    const updateNums = new sql.Request(transaction);
    numbers.forEach((n, i) => updateNums.input(`n${i}`, sql.Char(4), n));
    updateNums.input('orderId', sql.Int, orderId);
    await updateNums.query(`
      UPDATE numbers
      SET status = 'sold', order_id = @orderId, sold_at = SYSUTCDATETIME(),
          reserved_by_admin = 1
      WHERE number_value IN (${placeholders})
    `);

    for (const n of numbers) {
      await new sql.Request(transaction)
        .input('orderId', sql.Int, orderId)
        .input('n', sql.Char(4), n)
        .query(`INSERT INTO order_numbers (order_id, number_value) VALUES (@orderId, @n)`);
    }

    await transaction.commit();

    req.io.emit(
      'numbers:update',
      numbers.map(n => ({ number_value: n, status: 'sold' }))
    );

    res.status(201).json({ orderId, total });
  } catch (err) {
    await transaction.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al reservar los números' });
  }
};
