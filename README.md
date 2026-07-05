# Backend — Rifa Hyundai Accent 2016 + iPhone 17 Pro Max

## 1. Instalación

```bash
npm install
cp .env.example .env
```

Edita `.env` con los datos reales de tu SQL Server (el que ya creaste con las tablas
y los 10,000 números poblados).

## 2. Preparar datos iniciales

```bash
# Configuración de la rifa (precio, fecha de sorteo, whatsapp del admin)
npm run seed-settings

# Crear tu primer usuario admin
npm run create-admin -- djmarko TuClaveSegura123
```

## 3. Correr en desarrollo

```bash
npm run dev
```

Deberías ver: `Backend de la rifa corriendo en http://localhost:4000`

Probar que está vivo: `GET http://localhost:4000/health`

## 4. Endpoints disponibles

### Públicos
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/numbers` | Estado de los 10,000 números |
| GET | `/api/numbers/settings` | Precio, fecha de sorteo, hold, whatsapp admin |
| POST | `/api/orders` | Crear orden (toma números con lock transaccional) |
| GET | `/api/orders/:id` | Consultar estado de una orden |
| POST | `/api/orders/:id/proof` | Subir comprobante SINPE (form-data, campo `proof`) |

### Admin (requieren header `Authorization: Bearer <token>`)
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/admin/login` | Login, devuelve el token |
| GET | `/api/admin/orders?status=pending` | Listar órdenes por estado |
| PATCH | `/api/admin/orders/:id/confirm` | Confirmar pago → números pasan a `sold` |
| PATCH | `/api/admin/orders/:id/reject` | Rechazar → números vuelven a `available` |
| POST | `/api/admin/numbers/reserve` | Reservar/vender números manualmente (clientes offline) |

## 5. Ejemplo rápido con curl

```bash
# Crear una orden
curl -X POST http://localhost:4000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"name":"Joel","phone":"88887777","email":"joel@test.com","numbers":["0001","0002"]}'

# Login admin
curl -X POST http://localhost:4000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"djmarko","password":"TuClaveSegura123"}'

# Confirmar una orden (con el token que devuelve el login)
curl -X PATCH http://localhost:4000/api/admin/orders/1/confirm \
  -H "Authorization: Bearer TU_TOKEN_AQUI"
```

## 6. Notas importantes

- El job que libera números con hold vencido corre automáticamente cada minuto
  (no necesitas hacer nada, está en `src/jobs/expireHolds.js`).
- Los comprobantes se guardan en `/uploads` en disco local. Si despliegas en
  Render/Railway con disco efímero, los archivos se pierden en cada deploy —
  considera migrar a un bucket (Cloudflare R2 / S3) antes de ir a producción.
- El socket emite el evento `numbers:update` con un array de
  `{ number_value, status }` cada vez que algo cambia (nueva reserva, hold
  vencido, confirmación, rechazo). El frontend debe escuchar ese evento y
  actualizar el grid en memoria sin volver a pedir los 10,000 números completos.
