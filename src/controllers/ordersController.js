const { getPool, sql } = require('../config/db');

/**
 * POST /api/orders
 * Body: { name, phone, email, numbers: ['0001','0002',...] }
 *
 * Este es el endpoint que más cuidado necesita porque puede haber
 * MUCHOS clientes intentando tomar números al mismo tiempo.
 *
 * Estrategia:
 * 1. Todo corre dentro de UNA transacción.
 * 2. Se leen los números pedidos con UPDLOCK + ROWLOCK: esto bloquea
 *    esas filas específicas hasta que la transacción termine, así
 *    ninguna otra transacción puede leerlas/tomarlas al mismo tiempo.
 * 3. Si alguno de los números ya no está 'available', se aborta todo
 *    y se le informa al cliente exactamente cuáles números perdió,
 *    para que pueda ajustar su selección sin perder los demás.
 */
exports.createOrder = async (req, res) => {
  const { name, phone, email, numbers } = req.body;

  if (!name || !phone || !email) {
    return res.status(400).json({ error: 'Nombre, teléfono y correo son obligatorios' });
  }
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Debe seleccionar al menos un número' });
  }
  const invalid = numbers.filter(n => !/^\d{4}$/.test(n));
  if (invalid.length > 0) {
    return res.status(400).json({ error: 'Números inválidos', numbers: invalid });
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // 1. Leer configuración (precio, minutos de hold) dentro de la misma transacción
    const settingsResult = await new sql.Request(transaction).query(`
      SELECT price_per_number, hold_minutes FROM raffle_settings WHERE id = 1
    `);
    const { price_per_number: pricePerNumber, hold_minutes: holdMinutes } =
      settingsResult.recordset[0];

    // 2. Verificar y bloquear los números pedidos
    const checkRequest = new sql.Request(transaction);
    numbers.forEach((n, i) => checkRequest.input(`n${i}`, sql.Char(4), n));
    const placeholders = numbers.map((_, i) => `@n${i}`).join(',');

    const check = await checkRequest.query(`
      SELECT number_value, status
      FROM numbers WITH (UPDLOCK, ROWLOCK)
      WHERE number_value IN (${placeholders})
    `);

    const notAvailable = check.recordset.filter(r => r.status !== 'available');
    if (notAvailable.length > 0) {
      await transaction.rollback();
      return res.status(409).json({
        error: 'Algunos números ya no están disponibles, por favor ajuste su selección',
        numbers: notAvailable.map(r => r.number_value)
      });
    }

    // 3. Crear (o reutilizar) el cliente
    const clientResult = await new sql.Request(transaction)
      .input('name', sql.NVarChar, name)
      .input('phone', sql.NVarChar, phone)
      .input('email', sql.NVarChar, email)
      .query(`
        INSERT INTO clients (name, phone, email)
        OUTPUT INSERTED.id
        VALUES (@name, @phone, @email)
      `);
    const clientId = clientResult.recordset[0].id;

    // 4. Crear la orden
    const total = numbers.length * pricePerNumber;
    const orderResult = await new sql.Request(transaction)
      .input('clientId', sql.Int, clientId)
      .input('total', sql.Decimal(10, 2), total)
      .query(`
        INSERT INTO orders (client_id, total_amount, status)
        OUTPUT INSERTED.id
        VALUES (@clientId, @total, 'pending')
      `);
    const orderId = orderResult.recordset[0].id;

    // 5. Marcar los números como reservados con hold temporal
    const holdRequest = new sql.Request(transaction);
    numbers.forEach((n, i) => holdRequest.input(`n${i}`, sql.Char(4), n));
    holdRequest.input('orderId', sql.Int, orderId);
    holdRequest.input('holdMinutes', sql.Int, holdMinutes);
    await holdRequest.query(`
      UPDATE numbers
      SET status = 'reserved',
          order_id = @orderId,
          reserved_at = SYSUTCDATETIME(),
          hold_expires_at = DATEADD(MINUTE, @holdMinutes, SYSUTCDATETIME())
      WHERE number_value IN (${placeholders})
    `);

    // 6. Registrar la relación orden <-> números
    for (const n of numbers) {
      await new sql.Request(transaction)
        .input('orderId', sql.Int, orderId)
        .input('n', sql.Char(4), n)
        .query(`INSERT INTO order_numbers (order_id, number_value) VALUES (@orderId, @n)`);
    }

    await transaction.commit();

    // 7. Avisar en tiempo real a todos los clientes conectados
    req.io.emit(
      'numbers:update',
      numbers.map(n => ({ number_value: n, status: 'reserved' }))
    );

    res.status(201).json({
      orderId,
      total,
      holdMinutes,
      holdExpiresInSeconds: holdMinutes * 60
    });
  } catch (err) {
    await transaction.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al crear la orden' });
  }
};

/**
 * POST /api/orders/:id/proof
 * Sube el comprobante SINPE. Se guarda como binario directo en la base
 * de datos (no en disco) para que sobreviva a los redeploys de Render.
 */
exports.uploadProof = async (req, res) => {
  try {
    console.log('[uploadProof] orderId:', req.params.id);
    console.log('[uploadProof] req.file presente:', !!req.file);
    if (req.file) {
      console.log('[uploadProof] mimetype:', req.file.mimetype, '- tamaño buffer:', req.file.buffer?.length);
    }

    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('data', sql.VarBinary(sql.MAX), req.file.buffer)
      .input('mime', sql.NVarChar, req.file.mimetype)
      .query(`
        UPDATE orders
        SET payment_proof_data = @data, payment_proof_mimetype = @mime
        WHERE id = @id
      `);

    console.log('[uploadProof] filas afectadas por el UPDATE:', result.rowsAffected);

    res.json({ ok: true });
  } catch (err) {
    console.error('[uploadProof] ERROR:', err);
    res.status(500).json({ error: 'Error al subir el comprobante' });
  }
};

/**
 * GET /api/orders/:id/proof-image
 * Sirve el comprobante guardado en la BD (lo usa el panel de admin
 * para mostrar la imagen/PDF al revisar la orden).
 */
exports.getProofImage = async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`SELECT payment_proof_data, payment_proof_mimetype FROM orders WHERE id = @id`);

    const row = result.recordset[0];
    if (!row || !row.payment_proof_data) {
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    res.set('Content-Type', row.payment_proof_mimetype || 'application/octet-stream');
    res.send(row.payment_proof_data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el comprobante' });
  }
};

/**
 * GET /api/orders/:id
 * Para que el frontend pueda consultar el estado de su orden
 * (ej. mientras corre el countdown del hold).
 */
exports.getOrder = async (req, res) => {
  try {
    const pool = await getPool();
    const order = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT o.id, o.status, o.total_amount, o.created_at,
               CASE WHEN o.payment_proof_data IS NOT NULL THEN 1 ELSE 0 END AS has_proof,
               c.name, c.phone, c.email
        FROM orders o
        JOIN clients c ON c.id = o.client_id
        WHERE o.id = @id
      `);

    if (order.recordset.length === 0) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const numbers = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`SELECT number_value FROM order_numbers WHERE order_id = @id`);

    res.json({
      ...order.recordset[0],
      numbers: numbers.recordset.map(r => r.number_value)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar la orden' });
  }
};
