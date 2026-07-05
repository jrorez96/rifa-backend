const express = require('express');
const router = express.Router();
const numbersController = require('../controllers/numbersController');

router.get('/', numbersController.getAllNumbers);
router.get('/settings', numbersController.getSettings);

module.exports = router;
