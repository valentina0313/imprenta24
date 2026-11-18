
const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = 3000;

// Permitir recibir datos JSON
app.use(express.json());

// Servir los archivos del frontend
app.use(express.static(path.join(__dirname, 'public')));

// Ruta principal
app.get('/api/estado', (req, res) => {
    res.json({
        mensaje: 'El servidor de Imprenta 24h funciona correctamente.'
    });
});

// Consultar los pedidos
app.get('/api/pedidos', (req, res) => {
    db.all('SELECT * FROM pedidos ORDER BY id DESC', [], (error, pedidos) => {
        if (error) {
            return res.status(500).json({
                error: 'No se pudieron consultar los pedidos.'
            });
        }

        res.json(pedidos);
    });
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor de Imprenta 24h funcionando en http://localhost:${PORT}`);
});
