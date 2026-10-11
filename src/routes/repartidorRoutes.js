const express = require('express');
const router = express.Router();
const repartidorController = require('../controllers/repartidorController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.get('/pedidos', authenticateToken, repartidorController.getPedidosAsignados);
router.put('/iniciar-entrega/:id_pedido', authenticateToken, repartidorController.iniciarEntrega);
router.get('/dashboard', authenticateToken, repartidorController.getDashboard);
router.put('/entregar/:id_pedido', authenticateToken, repartidorController.confirmarEntrega);
router.post('/incidencia', authenticateToken, repartidorController.registrarIncidencia);
router.get('/historial', authenticateToken, repartidorController.getHistorialEntregas);
router.get('/resumen-carga', authenticateToken, repartidorController.getResumenCarga);

module.exports = router;
