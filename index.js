

require('dotenv').config();

const express = require('express');
const path = require('path');
const db = require('./database');
const multer = require('multer');
const fs = require('fs');

// Mercado Pago
const {
    MercadoPagoConfig,
    Preference,
    Payment,
    WebhookSignatureValidator
} = require('mercadopago');

// Configurar Mercado Pago
const token = process.env.MERCADOPAGO_ACCESS_TOKEN;

if (!token) {
    console.error('No se encontró el token de Mercado Pago en .env');
}

const client = new MercadoPagoConfig({
    accessToken: token || ''
});

const preference = new Preference(client);
const payment = new Payment(client);

// Configuración del servidor
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Archivos del frontend
app.use(express.static(path.join(__dirname, 'public')));

// Crear carpeta uploads
const carpetaSubidas = path.join(__dirname, 'uploads');

if (!fs.existsSync(carpetaSubidas)) {
    fs.mkdirSync(carpetaSubidas, { recursive: true });
}

// Configurar almacenamiento de archivos
const almacenamiento = multer.diskStorage({

    destination: function (req, archivo, callback) {
        callback(null, carpetaSubidas);
    },

    filename: function (req, archivo, callback) {

        const nombreSeguro = Date.now() + '-' +
            archivo.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');

        callback(null, nombreSeguro);
    }
});

const subirArchivo = multer({
    storage: almacenamiento
});

// URL pública opcional.
// Se configurará cuando tengamos una dirección HTTPS.
const APP_URL = process.env.APP_URL || '';

let urlPublica = null;

try {
    const url = new URL(APP_URL);

    if (url.protocol === 'https:' &&
        url.hostname !== 'localhost' &&
        url.hostname !== '127.0.0.1') {

        urlPublica = url.origin;
    }
} catch (error) {
    console.log('APP_URL todavía no está configurada.');
}

// Comprobar servidor
app.get('/api/estado', (req, res) => {

    res.json({
        mensaje: 'El servidor de Imprenta 24h funciona correctamente.'
    });

});

// =====================================================
// REGISTRAR PEDIDOS
// =====================================================

app.post('/api/pedidos', subirArchivo.single('archivo'), async (req, res) => {

    const {
        nombre_cliente,
        email,
        telefono,
        paginas,
        impresion,
        tipo_papel,
        orientacion,
        copias
    } = req.body;

    if (!req.file) {
        return res.status(400).json({
            mensaje: 'No se recibió ningún archivo.'
        });
    }

    const eliminarArchivo = () => {
        fs.unlink(req.file.path, () => {});
    };

    // Validar datos obligatorios
    if (!nombre_cliente?.trim() ||
        !email?.trim() ||
        !paginas ||
        !impresion ||
        !tipo_papel ||
        !orientacion) {

        eliminarArchivo();

        return res.status(400).json({
            mensaje: 'Faltan datos obligatorios.'
        });
    }

    // Validar opciones
    if (!['color', 'blanco y negro'].includes(impresion) ||
        !['comun', 'fotografico'].includes(tipo_papel) ||
        !['vertical', 'horizontal'].includes(orientacion)) {

        eliminarArchivo();

        return res.status(400).json({
            mensaje: 'Las opciones seleccionadas no son válidas.'
        });
    }

    // Validar copias
    const cantidadCopias = Number(copias);

    if (!Number.isInteger(cantidadCopias) ||
        cantidadCopias < 1 ||
        cantidadCopias > 100) {

        eliminarArchivo();

        return res.status(400).json({
            mensaje: 'La cantidad de copias no es válida.'
        });
    }

    try {

        const extension = path.extname(
            req.file.originalname
        ).toLowerCase();

        let cantidadPaginas;

        // Procesar PDF
        if (extension === '.pdf') {

            const { PDFDocument } = require('pdf-lib');

            const contenido = fs.readFileSync(req.file.path);

            const documento = await PDFDocument.load(contenido);

            const totalPaginasPDF = documento.getPageCount();

            if (paginas === 'todas') {

                cantidadPaginas = totalPaginasPDF;

            } else {

                const seleccionadas = new Set();

                const partes = paginas.split(',');

                for (const parte of partes) {

                    const texto = parte.trim();

                    if (/^\d+$/.test(texto)) {

                        const numero = Number(texto);

                        if (numero < 1 || numero > totalPaginasPDF) {
                            throw new Error(
                                'Las páginas seleccionadas no son válidas.'
                            );
                        }

                        seleccionadas.add(numero);

                    } else if (/^\d+\s*-\s*\d+$/.test(texto)) {

                        const [inicio, fin] = texto
                            .split('-')
                            .map(Number);

                        if (inicio < 1 ||
                            fin < inicio ||
                            fin > totalPaginasPDF) {

                            throw new Error(
                                'El rango de páginas no es válido.'
                            );
                        }

                        for (let i = inicio; i <= fin; i++) {
                            seleccionadas.add(i);
                        }

                    } else {

                        throw new Error(
                            'El formato de páginas no es válido.'
                        );
                    }
                }

                cantidadPaginas = seleccionadas.size;
            }

        // Procesar imágenes
        } else if (['.jpg', '.jpeg', '.png'].includes(extension)) {

            if (paginas !== 'todas' &&
                paginas.trim() !== '1') {

                throw new Error(
                    'Una imagen cuenta como una sola página.'
                );
            }

            cantidadPaginas = 1;

        } else {

            throw new Error(
                'Formato de archivo no permitido.'
            );
        }

        if (cantidadPaginas < 1) {
            throw new Error('El pedido no contiene páginas válidas.');
        }

        // Calcular precios en el servidor
        const precioPorPagina = tipo_papel === 'fotografico'
            ? (impresion === 'color' ? 500 : 350)
            : (impresion === 'color' ? 150 : 80);

        const precioPorCopia = cantidadPaginas * precioPorPagina;

        const precioTotal = precioPorCopia * cantidadCopias;

        // Guardar pedido en SQLite
        const sql = `
            INSERT INTO pedidos (
                nombre_cliente,
                email,
                telefono,
                archivo_nombre,
                paginas,
                impresion,
                tipo_papel,
                orientacion,
                copias,
                precio_por_copia,
                precio_total
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(sql, [

            nombre_cliente.trim(),
            email.trim(),
            telefono || '',
            req.file.filename,
            paginas,
            impresion,
            tipo_papel,
            orientacion,
            cantidadCopias,
            precioPorCopia,
            precioTotal

        ], function (error) {

            if (error) {

                console.error(
                    'Error al guardar el pedido:',
                    error.message
                );

                eliminarArchivo();

                return res.status(500).json({
                    mensaje: 'No se pudo guardar el pedido.'
                });
            }

            res.status(201).json({

                mensaje: 'Pedido guardado correctamente.',

                id: this.lastID,

                precio_total: precioTotal

            });

        });

    } catch (error) {

        eliminarArchivo();

        return res.status(400).json({
            mensaje: error.message ||
                'No se pudo procesar el archivo.'
        });
    }

});

// =====================================================
// CREAR PREFERENCIA DE PAGO
// =====================================================

app.post('/api/crear-preferencia', async (req, res) => {

    try {

        const { pedidoId } = req.body;

        if (!pedidoId ||
            !Number.isInteger(Number(pedidoId)) ||
            Number(pedidoId) <= 0) {

            return res.status(400).json({
                mensaje: 'El número de pedido no es válido.'
            });
        }

        // Buscar pedido en SQLite
        db.get(
            'SELECT * FROM pedidos WHERE id = ?',
            [Number(pedidoId)],
            async (error, pedido) => {

                if (error) {

                    return res.status(500).json({
                        mensaje: 'Error al buscar el pedido.'
                    });
                }

                if (!pedido) {

                    return res.status(404).json({
                        mensaje: 'No se encontró el pedido.'
                    });
                }

                if (pedido.estado_pago === 'aprobado') {

                    return res.status(400).json({
                        mensaje: 'Este pedido ya está pagado.'
                    });
                }

                const precio = Number(pedido.precio_total);

                if (!Number.isFinite(precio) || precio <= 0) {

                    return res.status(400).json({
                        mensaje: 'El precio del pedido no es válido.'
                    });
                }

                try {

                    const datosPreferencia = {

                        items: [
                            {
                                id: String(pedido.id),

                                title: 'Pedido de impresión Imprenta24h',

                                quantity: 1,

                                unit_price: precio,

                                currency_id: 'ARS'
                            }
                        ],

                        payer: {
                            email: pedido.email
                        },

                        external_reference: String(pedido.id),

                        metadata: {
                            pedido_id: pedido.id
                        }

                    };

                    // Agregar URLs cuando tengamos HTTPS público
                    if (urlPublica) {

                        datosPreferencia.back_urls = {

                            success: `${urlPublica}/pago-exitoso`,

                            failure: `${urlPublica}/pago-fallido`,

                            pending: `${urlPublica}/pago-pendiente`

                        };

                        datosPreferencia.auto_return = 'approved';

                        datosPreferencia.notification_url =
                            `${urlPublica}/api/mercadopago/webhook`;
                    }

                    // Crear preferencia
                    const resultado = await preference.create({
                        body: datosPreferencia
                    });

                    res.json({

                        mensaje: 'Preferencia creada correctamente.',

                        id: resultado.id,

                        init_point: resultado.init_point

                    });

                } catch (error) {

                    console.error(
                        'Error de Mercado Pago:',
                        error.message
                    );

                    res.status(500).json({
                        mensaje: 'No se pudo generar el pago.'
                    });
                }

            }
        );

    } catch (error) {

        console.error(error);

        res.status(500).json({
            mensaje: 'Error al procesar el pago.'
        });
    }

});

// =====================================================
// WEBHOOK: RECIBIR Y VERIFICAR PAGOS
// =====================================================

app.post('/api/mercadopago/webhook', async (req, res) => {

    try {

        const secreto = process.env.MERCADOPAGO_WEBHOOK_SECRET;

        if (!secreto) {

            console.error(
                'Falta configurar MERCADOPAGO_WEBHOOK_SECRET.'
            );

            return res.sendStatus(503);
        }

        const dataId = req.query['data.id'];

        if (!dataId) {
            return res.sendStatus(400);
        }

        // Verificar que la notificación sea auténtica
        try {

            WebhookSignatureValidator.validate({

                xSignature: req.headers['x-signature'],

                xRequestId: req.headers['x-request-id'],

                dataId: String(dataId),

                secret: secreto

            });

        } catch (error) {

            console.error('Firma de webhook inválida.');

            return res.sendStatus(401);
        }

        // Consultar el pago directamente en Mercado Pago
        const informacionPago = await payment.get({
            id: String(dataId)
        });

        const pedidoId = Number(
            informacionPago.external_reference
        );

        if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
            return res.sendStatus(400);
        }

        // Buscar el pedido correspondiente
        db.get(
            'SELECT * FROM pedidos WHERE id = ?',
            [pedidoId],
            (error, pedido) => {

                if (error) {
                    return res.sendStatus(500);
                }

                if (!pedido) {
                    return res.sendStatus(404);
                }

                // Verificar importe y moneda
                const importeCorrecto =
                    Math.abs(
                        Number(informacionPago.transaction_amount) -
                        Number(pedido.precio_total)
                    ) < 0.01;

                if (
                    informacionPago.currency_id !== 'ARS' ||
                    !importeCorrecto
                ) {

                    console.error(
                        'El importe o la moneda no coinciden.'
                    );

                    return res.sendStatus(400);
                }

                // Traducir estado de Mercado Pago
                let nuevoEstado;

                switch (informacionPago.status) {

                    case 'approved':
                        nuevoEstado = 'aprobado';
                        break;

                    case 'rejected':
                    case 'cancelled':
                        nuevoEstado = 'rechazado';
                        break;

                    case 'refunded':
                    case 'charged_back':
                        nuevoEstado = 'reembolsado';
                        break;

                    default:
                        nuevoEstado = 'pendiente';
                }

                // Evitar que una notificación antigua
                // cambie un pago aprobado a pendiente.
                const sql = `
                    UPDATE pedidos
                    SET estado_pago = ?
                    WHERE id = ?
                    AND (
                        estado_pago != 'aprobado'
                        OR ? IN ('aprobado', 'reembolsado')
                    )
                `;

                db.run(
                    sql,
                    [nuevoEstado, pedidoId, nuevoEstado],
                    (error) => {

                        if (error) {

                            console.error(
                                'Error al actualizar el pago:',
                                error.message
                            );

                            return res.sendStatus(500);
                        }

                        console.log(
                            `Pedido ${pedidoId}: pago ${nuevoEstado}.`
                        );

                        res.sendStatus(200);
                    }
                );

            }
        );

    } catch (error) {

        console.error(
            'Error al procesar webhook:',
            error.message
        );

        res.sendStatus(500);
    }

});

// =====================================================
// CONSULTAR PEDIDOS
// =====================================================

app.get('/api/pedidos', (req, res) => {

    const sql = `
        SELECT
            id,
            nombre_cliente,
            email,
            telefono,
            archivo_nombre,
            paginas,
            impresion,
            tipo_papel,
            orientacion,
            copias,
            precio_total,
            estado_pago,
            estado_pedido,
            fecha_creacion
        FROM pedidos
        ORDER BY id DESC
    `;

    db.all(sql, [], (error, pedidos) => {

        if (error) {

            console.error(
                'Error al consultar pedidos:',
                error.message
            );

            return res.status(500).json({
                mensaje: 'No se pudieron obtener los pedidos.'
            });
        }

        res.json(pedidos);
    });

});

// =====================================================
// ACTUALIZAR ESTADO DEL PEDIDO
// =====================================================

app.patch('/api/pedidos/:id/estado', (req, res) => {

    const id = Number(req.params.id);

    const { estado_pedido } = req.body;

    const estadosPermitidos = [
        'pendiente',
        'en impresión',
        'completado'
    ];

    if (!Number.isInteger(id) || id <= 0) {

        return res.status(400).json({
            mensaje: 'El número de pedido no es válido.'
        });
    }

    if (!estadosPermitidos.includes(estado_pedido)) {

        return res.status(400).json({
            mensaje: 'El estado seleccionado no es válido.'
        });
    }

    const sql = `
        UPDATE pedidos
        SET estado_pedido = ?
        WHERE id = ?
    `;

    db.run(sql, [estado_pedido, id], function (error) {

        if (error) {

            console.error(
                'Error al actualizar el pedido:',
                error.message
            );

            return res.status(500).json({
                mensaje: 'No se pudo actualizar el pedido.'
            });
        }

        if (this.changes === 0) {

            return res.status(404).json({
                mensaje: 'No se encontró ese pedido.'
            });
        }

        res.json({
            mensaje: 'Estado actualizado correctamente.'
        });

    });

});

// =====================================================
// PÁGINAS DE RETORNO DE MERCADO PAGO
// =====================================================

app.get('/pago-exitoso', (req, res) => {

    res.send(`
        <h1>Pago recibido</h1>
        <p>Estamos verificando tu pago.</p>
        <p>La confirmación se realizará desde nuestro servidor.</p>
        <a href="/">Volver al inicio</a>
    `);

});

app.get('/pago-fallido', (req, res) => {

    res.send(`
        <h1>El pago no fue aprobado</h1>
        <p>Podés volver a intentar realizar el pago.</p>
        <a href="/">Volver al inicio</a>
    `);

});

app.get('/pago-pendiente', (req, res) => {

    res.send(`
        <h1>Pago pendiente</h1>
        <p>Estamos esperando la confirmación del pago.</p>
        <a href="/">Volver al inicio</a>
    `);

});

// =====================================================
// MANEJO DE ERRORES DE SUBIDA DE ARCHIVOS
// =====================================================

app.use((error, req, res, next) => {

    console.error('Error del servidor:', error.message);

    res.status(500).json({
        mensaje: 'Ocurrió un error al procesar la solicitud.'
    });

});

// =====================================================
// INICIAR SERVIDOR
// =====================================================

app.listen(PORT, () => {

    console.log(
        `Servidor de Imprenta24h funcionando en http://localhost:${PORT}`
    );

    console.log(
        token
            ? 'Token de Mercado Pago cargado correctamente.'
            : 'Falta el token de Mercado Pago.'
    );

});
