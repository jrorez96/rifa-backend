const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const requireAdmin = require('../middleware/auth');

router.post('/login', adminController.login);

// Todo lo de abajo requiere estar logueado como admin
router.use(requireAdmin);

router.get('/orders', adminController.listOrders);
router.patch('/orders/:id/confirm', adminController.confirmOrder);
router.patch('/orders/:id/reject', adminController.rejectOrder);
router.post('/numbers/reserve', adminController.manualReserve);

module.exports = router;
