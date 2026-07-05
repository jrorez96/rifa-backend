const express = require('express');
const router = express.Router();
const ordersController = require('../controllers/ordersController');
const upload = require('../middleware/upload');

router.post('/', ordersController.createOrder);
router.get('/:id', ordersController.getOrder);
router.post('/:id/proof', upload.single('proof'), ordersController.uploadProof);

module.exports = router;
