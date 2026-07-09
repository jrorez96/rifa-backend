require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const { initSockets } = require('./sockets');
const { startExpireHoldsJob } = require('./jobs/expireHolds');

const numbersRoutes = require('./routes/numbersRoutes');
const ordersRoutes = require('./routes/ordersRoutes');
const adminRoutes = require('./routes/adminRoutes');

// Quita cualquier "/" final para que "https://sitio.com/" y "https://sitio.com"
// se traten como el mismo origen (el navegador nunca manda la barra final).
const FRONTEND_URL = (process.env.FRONTEND_URL || '*').replace(/\/+$/, '');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: FRONTEND_URL }
});

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Inyectamos "io" en cada request para poder emitir eventos desde los controladores
app.use((req, res, next) => {
  req.io = io;
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/numbers', numbersRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/admin', adminRoutes);

// Manejador de errores genérico (ej. errores de multer)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

initSockets(io);
startExpireHoldsJob(io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Backend de la rifa corriendo en http://localhost:${PORT}`);
});
