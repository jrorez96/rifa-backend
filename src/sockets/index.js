function initSockets(io) {
  io.on('connection', (socket) => {
    console.log(`Cliente conectado: ${socket.id} (total: ${io.engine.clientsCount})`);

    socket.on('disconnect', () => {
      console.log(`Cliente desconectado: ${socket.id}`);
    });
  });
}

module.exports = { initSockets };
