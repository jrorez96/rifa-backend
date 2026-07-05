const sql = require('mssql');

function readConfig() {
  const required = ['DB_USER', 'DB_PASS', 'DB_SERVER', 'DB_NAME'];
  const missing = required.filter(key => !process.env[key] || process.env[key].trim() === '');

  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno en tu .env: ${missing.join(', ')}. ` +
      `Verifica que el archivo .env exista en la raíz del proyecto (junto a package.json) ` +
      `y que hayas reemplazado los valores de ejemplo por los reales de tu SQL Server.`
    );
  }

  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 1433,
    options: {
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_CERT === 'true'
    },
    pool: {
      max: 20,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };
}

let pool;

/**
 * Devuelve un pool de conexiones reutilizable.
 * Node/Express es de un solo hilo, pero puede atender muchas
 * peticiones concurrentes; el pool de mssql maneja varias
 * conexiones físicas a SQL Server para soportar eso.
 */
async function getPool() {
  if (pool && pool.connected) return pool;
  pool = await sql.connect(readConfig());

  pool.on('error', (err) => {
    console.error('Error en el pool de SQL Server:', err.message);
  });

  return pool;
}

module.exports = { getPool, sql };
