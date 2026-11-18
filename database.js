

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Conexión con la base de datos
const dbPath = path.join(__dirname, 'imprenta24.db');

const db = new sqlite3.Database(dbPath, (error) => {
    if (error) {
        console.error('Error al conectar con la base de datos:', error.message);
    } else {
        console.log('Base de datos conectada correctamente.');
    }
});

// Crear la tabla de pedidos
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS pedidos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre_cliente TEXT NOT NULL,
            email TEXT NOT NULL,
            telefono TEXT,
            archivo_nombre TEXT NOT NULL,
            paginas TEXT NOT NULL,
            impresion TEXT NOT NULL
                CHECK (impresion IN ('color', 'blanco y negro')),
            tipo_papel TEXT NOT NULL,
            orientacion TEXT NOT NULL,
            copias INTEGER NOT NULL,
            precio_por_copia REAL NOT NULL,
            precio_total REAL NOT NULL,
            estado_pago TEXT NOT NULL DEFAULT 'pendiente',
            estado_pedido TEXT NOT NULL DEFAULT 'pendiente',
            fecha_creacion TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `, (error) => {
        if (error) {
            console.error('Error al crear la tabla:', error.message);
        } else {
            console.log('Tabla de pedidos preparada correctamente.');
        }
    });
});

// Exportar la conexión para utilizarla en index.js
module.exports = db;
