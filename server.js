require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const XLSX = require("xlsx");
const XLSXStyle = require("xlsx-js-style");
const ExcelJS = require("exceljs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));
app.use(express.static("public"));

const PASS_COL = "\"contrase\u00f1a\"";

const APP_PORT = Number(process.env.PORT || 3000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function generarBufferInventarioConAlerta(rows, nombreHoja, campoCantidad) {
    const worksheet = XLSXStyle.utils.json_to_sheet(rows);
    const workbook = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(workbook, worksheet, nombreHoja);

    if (rows.length > 0) {
        const columnas = Object.keys(rows[0]);

        rows.forEach((row, index) => {
            const cantidad = Number(row[campoCantidad] ?? 0);
            const stockMinimo = Number(row.stock_minimo ?? 0);

            if (!Number.isFinite(cantidad) || !Number.isFinite(stockMinimo)) return;
            if (cantidad > stockMinimo) return;

            // +2 porque la fila 1 en Excel es encabezado.
            const filaExcel = index + 2;

            columnas.forEach((_, colIndex) => {
                const celda = XLSXStyle.utils.encode_cell({ r: filaExcel - 1, c: colIndex });
                if (!worksheet[celda]) return;

                worksheet[celda].s = {
                    fill: { patternType: "solid", fgColor: { rgb: "F8D7DA" } },
                    font: { color: { rgb: "B91C1C" }, bold: true }
                };
            });
        });
    }

    return XLSXStyle.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function obtenerImagenExcelDesdeDataUrl(valor) {
    if (typeof valor !== "string") return null;
    const limpio = valor.trim();
    if (!limpio.startsWith("data:image/") || !limpio.includes(";base64,")) return null;

    const match = limpio.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return null;

    const mime = String(match[1] || "").toLowerCase();
    const base64 = match[2] || "";
    if (!base64) return null;

    let extension = null;
    if (mime === "image/png") extension = "png";
    else if (mime === "image/jpeg" || mime === "image/jpg") extension = "jpeg";
    else if (mime === "image/gif") extension = "gif";
    if (!extension) return null;

    try {
        const buffer = Buffer.from(base64, "base64");
        if (!buffer.length) return null;
        return { buffer, extension };
    } catch (_) {
        return null;
    }
}

async function generarBufferInventarioConImagenes(rows, nombreHoja, campoCantidad, campoImagen = "imagen") {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(nombreHoja);
    const columnas = rows.length > 0 ? Object.keys(rows[0]) : [];

    worksheet.columns = columnas.map((columna) => {
        if (columna === campoImagen) return { header: "imagen", key: columna, width: 14 };
        return { header: columna, key: columna, width: 18 };
    });

    rows.forEach((row) => worksheet.addRow(row));

    const indiceColumnaImagen = columnas.indexOf(campoImagen) + 1;

    rows.forEach((row, index) => {
        const filaExcel = index + 2;
        const cantidad = Number(row[campoCantidad] ?? 0);
        const stockMinimo = Number(row.stock_minimo ?? 0);

        if (Number.isFinite(cantidad) && Number.isFinite(stockMinimo) && cantidad <= stockMinimo) {
            columnas.forEach((_, colIndex) => {
                const cell = worksheet.getCell(filaExcel, colIndex + 1);
                cell.fill = {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: "FFF8D7DA" }
                };
                cell.font = {
                    color: { argb: "FFB91C1C" },
                    bold: true
                };
            });
        }

        if (indiceColumnaImagen <= 0) return;

        const dataUrl = row[campoImagen];
        const imagen = obtenerImagenExcelDesdeDataUrl(dataUrl);
        const celdaImagen = worksheet.getCell(filaExcel, indiceColumnaImagen);
        celdaImagen.alignment = { vertical: "middle", horizontal: "center" };

        if (!imagen) {
            celdaImagen.value = dataUrl ? "No compatible" : "-";
            return;
        }

        const imageId = workbook.addImage({
            buffer: imagen.buffer,
            extension: imagen.extension
        });

        worksheet.getRow(filaExcel).height = 38;
        celdaImagen.value = "";
        worksheet.addImage(imageId, {
            tl: { col: indiceColumnaImagen - 1 + 0.1, row: filaExcel - 1 + 0.1 },
            ext: { width: 36, height: 36 }
        });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}

async function asegurarIntegridadAsignaciones() {
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_asignacion_equipo_activa
        ON asignaciones_equipos (equipo_id)
        WHERE estado IN ('pendiente','aprobado','entregado','pendiente_devolucion')
    `);
}

async function asegurarEstructuraRequisiciones() {
    await pool.query(`
        ALTER TABLE requisiciones
        ADD COLUMN IF NOT EXISTS tipo_origen VARCHAR(20) DEFAULT 'ensamble'
    `);

    await pool.query(`
        UPDATE requisiciones
        SET tipo_origen = 'ensamble'
        WHERE tipo_origen IS NULL OR TRIM(tipo_origen) = ''
    `);

    await pool.query(`
        ALTER TABLE requisiciones
        ADD COLUMN IF NOT EXISTS turno VARCHAR(20)
    `);

    await pool.query(`
        UPDATE requisiciones
        SET turno = CASE
            WHEN ((fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') THEN 'Turno 01'
            WHEN ((fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00'
               OR (fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') THEN 'Turno 02'
            ELSE 'Fuera de turno'
        END
        WHERE turno IS NULL OR TRIM(turno) = ''
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS detalle_requisicion_modulo (
            id SERIAL PRIMARY KEY,
            requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id) ON DELETE CASCADE,
            herramienta_modulo_id INTEGER NOT NULL REFERENCES herramienta_modulo(id),
            cantidad_solicitada INTEGER NOT NULL DEFAULT 0,
            cantidad_entregada INTEGER NOT NULL DEFAULT 0,
            estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
            tipo_movimiento VARCHAR(20) NOT NULL DEFAULT 'nuevo'
        )
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion
        DROP CONSTRAINT IF EXISTS check_tipo_movimiento
    `);
    await pool.query(`
        ALTER TABLE detalle_requisicion
        DROP CONSTRAINT IF EXISTS detalle_requisicion_tipo_movimiento_check
    `);
    await pool.query(`
        ALTER TABLE detalle_requisicion_modulo
        DROP CONSTRAINT IF EXISTS check_tipo_movimiento
    `);
    await pool.query(`
        ALTER TABLE detalle_requisicion_modulo
        DROP CONSTRAINT IF EXISTS detalle_requisicion_modulo_tipo_movimiento_check
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'chk_detalle_requisicion_tipo_movimiento'
            ) THEN
                ALTER TABLE detalle_requisicion
                ADD CONSTRAINT chk_detalle_requisicion_tipo_movimiento
                CHECK (LOWER(tipo_movimiento) IN ('nuevo', 'cambio', 'retorno'));
            END IF;
        END $$;
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'chk_detalle_requisicion_modulo_tipo_movimiento'
            ) THEN
                ALTER TABLE detalle_requisicion_modulo
                ADD CONSTRAINT chk_detalle_requisicion_modulo_tipo_movimiento
                CHECK (LOWER(tipo_movimiento) IN ('nuevo', 'cambio', 'retorno'));
            END IF;
        END $$;
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion
        ADD COLUMN IF NOT EXISTS aprobado_supervisor BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion_modulo
        ADD COLUMN IF NOT EXISTS aprobado_supervisor BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Backfill para no bloquear historicos ya entregados y cambios/retornos.
    await pool.query(`
        UPDATE detalle_requisicion
        SET aprobado_supervisor = TRUE
        WHERE LOWER(COALESCE(tipo_movimiento, '')) <> 'nuevo'
           OR COALESCE(cantidad_entregada, 0) > 0
    `);

    await pool.query(`
        UPDATE detalle_requisicion_modulo
        SET aprobado_supervisor = TRUE
        WHERE LOWER(COALESCE(tipo_movimiento, '')) <> 'nuevo'
           OR COALESCE(cantidad_entregada, 0) > 0
    `);

    // La regla nueva elimina el estado pendiente_admin de requisiciones previas.
    await pool.query(`
        UPDATE requisiciones
        SET estado_general = 'aprobada'
        WHERE COALESCE(estado_general, '') = 'pendiente_admin'
    `);
}
async function asegurarEstadoUsuarios() {
    await pool.query(`
        ALTER TABLE usuarios
        ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT TRUE
    `);

    await pool.query(`
        UPDATE usuarios
        SET activo = TRUE
        WHERE activo IS NULL
    `);
}

async function asegurarNumeroIdAlfanumerico() {
    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'usuarios'
                  AND column_name = 'numero_id'
                  AND data_type NOT IN ('character varying', 'text')
            ) THEN
                ALTER TABLE usuarios
                ALTER COLUMN numero_id TYPE VARCHAR(100)
                USING numero_id::text;
            END IF;
        END $$;
    `);
}

async function asegurarEstructuraRetornosMaterial() {
    await pool.query(`
        ALTER TABLE detalle_requisicion
        ADD COLUMN IF NOT EXISTS cantidad_retorno_aceptada INTEGER NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion
        ADD COLUMN IF NOT EXISTS cantidad_retorno_devuelta_linea INTEGER NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion
        ADD COLUMN IF NOT EXISTS retorno_recibido_por_id INTEGER REFERENCES usuarios(id)
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion
        ADD COLUMN IF NOT EXISTS retorno_recibido_en TIMESTAMP
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion_modulo
        ADD COLUMN IF NOT EXISTS cantidad_retorno_aceptada INTEGER NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion_modulo
        ADD COLUMN IF NOT EXISTS cantidad_retorno_devuelta_linea INTEGER NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion_modulo
        ADD COLUMN IF NOT EXISTS retorno_recibido_por_id INTEGER REFERENCES usuarios(id)
    `);

    await pool.query(`
        ALTER TABLE detalle_requisicion_modulo
        ADD COLUMN IF NOT EXISTS retorno_recibido_en TIMESTAMP
    `);

    // Backfill para conservar historico existente de retornos ya procesados.
    await pool.query(`
        UPDATE detalle_requisicion
        SET cantidad_retorno_aceptada = COALESCE(cantidad_entregada, 0)
        WHERE LOWER(COALESCE(tipo_movimiento, '')) = 'retorno'
          AND COALESCE(cantidad_entregada, 0) > 0
          AND COALESCE(cantidad_retorno_aceptada, 0) = 0
          AND COALESCE(cantidad_retorno_devuelta_linea, 0) = 0
    `);

    await pool.query(`
        UPDATE detalle_requisicion_modulo
        SET cantidad_retorno_aceptada = COALESCE(cantidad_entregada, 0)
        WHERE LOWER(COALESCE(tipo_movimiento, '')) = 'retorno'
          AND COALESCE(cantidad_entregada, 0) > 0
          AND COALESCE(cantidad_retorno_aceptada, 0) = 0
          AND COALESCE(cantidad_retorno_devuelta_linea, 0) = 0
    `);
}


async function asegurarHorariosLogin() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS horarios_login (
            id SERIAL PRIMARY KEY,
            rol VARCHAR(20) NOT NULL,
            dia_semana SMALLINT NOT NULL,
            hora_inicio TIME NOT NULL,
            hora_fin TIME NOT NULL,
            activo BOOLEAN NOT NULL DEFAULT TRUE,
            creado_en TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT chk_horarios_login_rol
                CHECK (rol IN ('admin', 'supervisor', 'tecnico', 'empleado')),
            CONSTRAINT chk_horarios_login_dia
                CHECK (dia_semana BETWEEN 0 AND 6),
            CONSTRAINT chk_horarios_login_horas
                CHECK (hora_inicio < hora_fin)
        )
    `);
}

async function asegurarEstructuraHerramientaModulo() {
    await pool.query(`
        ALTER TABLE herramienta_modulo
        ADD COLUMN IF NOT EXISTS stock_minimo INTEGER DEFAULT 0
    `);

    await pool.query(`
        UPDATE herramienta_modulo
        SET stock_minimo = 0
        WHERE stock_minimo IS NULL
    `);

    await pool.query(`
        ALTER TABLE materiales
        ADD COLUMN IF NOT EXISTS maximo_por_requisicion INTEGER DEFAULT 1
    `);

    await pool.query(`
        ALTER TABLE materiales
        ADD COLUMN IF NOT EXISTS imagen_url TEXT
    `);

    await pool.query(`
        UPDATE materiales
        SET maximo_por_requisicion = 1
        WHERE maximo_por_requisicion IS NULL OR maximo_por_requisicion < 1
    `);

    await pool.query(`
        ALTER TABLE materiales
        ALTER COLUMN maximo_por_requisicion SET DEFAULT 1
    `);

    await pool.query(`
        ALTER TABLE materiales
        ALTER COLUMN maximo_por_requisicion SET NOT NULL
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'chk_materiales_maximo_por_requisicion'
            ) THEN
                ALTER TABLE materiales
                ADD CONSTRAINT chk_materiales_maximo_por_requisicion
                CHECK (maximo_por_requisicion >= 1);
            END IF;
        END $$;
    `);

    await pool.query(`
        ALTER TABLE herramienta_modulo
        ADD COLUMN IF NOT EXISTS maximo_por_requisicion INTEGER DEFAULT 1
    `);

    await pool.query(`
        ALTER TABLE herramienta_modulo
        ADD COLUMN IF NOT EXISTS imagen_url TEXT
    `);

    await pool.query(`
        UPDATE herramienta_modulo
        SET maximo_por_requisicion = 1
        WHERE maximo_por_requisicion IS NULL OR maximo_por_requisicion < 1
    `);

    await pool.query(`
        ALTER TABLE herramienta_modulo
        ALTER COLUMN maximo_por_requisicion SET DEFAULT 1
    `);

    await pool.query(`
        ALTER TABLE herramienta_modulo
        ALTER COLUMN maximo_por_requisicion SET NOT NULL
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'chk_herramienta_modulo_maximo_por_requisicion'
            ) THEN
                ALTER TABLE herramienta_modulo
                ADD CONSTRAINT chk_herramienta_modulo_maximo_por_requisicion
                CHECK (maximo_por_requisicion >= 1);
            END IF;
        END $$;
    `);
}

const ROLES_HORARIO = new Set(["admin", "supervisor", "tecnico", "empleado"]);

function normalizarHora(hora) {
    if (typeof hora !== "string") return null;
    const valor = hora.trim();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(valor)) return `${valor}:00`;
    if (/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(valor)) return valor;
    return null;
}

function calcularTurnoPorHora(horaTxt) {
    const limpio = String(horaTxt || "").trim();
    const match = limpio.match(/^(\d{2}):(\d{2})/);
    if (!match) return "Fuera de turno";

    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const minutos = h * 60 + m;

    const inicioTurno1 = 6 * 60 + 24;   // 06:24
    const finTurno1 = 16 * 60 + 29;     // 16:29
    const inicioTurno2 = 16 * 60 + 30;  // 16:30
    const finTurno2 = 1 * 60;           // 01:00

    if (minutos >= inicioTurno1 && minutos <= finTurno1) return "Turno 01";
    if (minutos >= inicioTurno2 || minutos <= finTurno2) return "Turno 02";
    return "Fuera de turno";
}

function obtenerTurnoActualTijuana() {
    const ahoraTj = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Tijuana" }));
    const hh = String(ahoraTj.getHours()).padStart(2, "0");
    const mm = String(ahoraTj.getMinutes()).padStart(2, "0");
    return calcularTurnoPorHora(`${hh}:${mm}`);
}

function normalizarImagenDataUrl(valor) {
    if (valor == null) return { value: null };
    if (typeof valor !== "string") return { error: "Formato de imagen invalido" };

    const limpio = valor.trim();
    if (!limpio) return { value: null };

    if (!limpio.startsWith("data:image/") || !limpio.includes(";base64,")) {
        return { error: "La imagen debe estar en formato valido" };
    }

    const maxBytes = 5 * 1024 * 1024;
    if (Buffer.byteLength(limpio, "utf8") > maxBytes) {
        return { error: "La imagen excede el limite permitido (5MB)" };
    }

    return { value: limpio };
}

function normalizarTurno(turno) {
    if (!turno) return null;
    const t = String(turno).trim().toLowerCase();
    if (t === "turno 01" || t === "turno1" || t === "01") return "Turno 01";
    if (t === "turno 02" || t === "turno2" || t === "02") return "Turno 02";
    if (t === "fuera de turno") return "Fuera de turno";
    return null;
}
app.get("/", (req, res) => {
    res.redirect("/login.html");
});

///////////////////////////////////////////
/////////////// LOGIN  ////////////////////
///////////////////////////////////////////
////////Login - PestaÃ±a///////////
app.post("/login", async (req, res) => {
    const numero_id = String(req.body.numero_id || "").trim();
    const contrasena = req.body["contrase\u00f1a"] || req.body.contrasena || req.body.password;

    if (!numero_id || !contrasena) {
        return res.json({ success: false, message: "Credenciales incorrectas" });
    }

    try {
        const result = await pool.query(
            `SELECT * FROM usuarios WHERE numero_id = $1 AND ${PASS_COL} = $2`,
            [numero_id, contrasena]
        );

        if (result.rows.length > 0) {
            const usuario = result.rows[0];
            if (usuario.activo === false) {
                return res.status(403).json({ success: false, message: "Usuario deshabilitado" });
            }

            const horarios = await pool.query(
                `SELECT id FROM horarios_login WHERE rol = $1 AND activo = TRUE`,
                [usuario.rol]
            );

            if (horarios.rowCount > 0) {
                const ahora = await pool.query(`
                    SELECT
                        EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Tijuana'))::INT AS dia_actual,
                        (NOW() AT TIME ZONE 'America/Tijuana')::TIME AS hora_actual
                `);

                const { dia_actual, hora_actual } = ahora.rows[0];

                const permitido = await pool.query(
                    `SELECT 1
                     FROM horarios_login
                     WHERE rol = $1
                       AND activo = TRUE
                       AND dia_semana = $2
                       AND $3::TIME BETWEEN hora_inicio AND hora_fin
                     LIMIT 1`,
                    [usuario.rol, dia_actual, hora_actual]
                );

                if (permitido.rowCount === 0) {
                    return res.status(403).json({
                        success: false,
                        message: "Acceso fuera del horario permitido"
                    });
                }
            }

            res.json({ success: true, usuario });
        } else {
            res.json({ success: false, message: "Credenciales incorrectas" });
        }

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error en el servidor" });
    }
});

///////////////////////////////////////////
/////////// Administrador /////////////////
///////////////////////////////////////////
////////Agregar Lineas - PestaÃ±a///////////
// Agregar lÃ­nea solo admin puede agregarla 
app.post("/lineas", async (req, res) => {
    const { nombre } = req.body;

    try {
        await pool.query(
            "INSERT INTO lineas_produccion (nombre) VALUES ($1)",
            [nombre]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al crear lÃ­nea" });
    }
});

app.get("/lineas", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM lineas_produccion ORDER BY id ASC"
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener lÃ­neas" });
    }
});

app.put("/lineas/:id", async (req, res) => {
    const { id } = req.params;
    const { nombre } = req.body;

    if (!nombre || !nombre.trim()) {
        return res.status(400).json({ error: "Nombre requerido" });
    }

    try {
        const result = await pool.query(
            "UPDATE lineas_produccion SET nombre = $1 WHERE id = $2",
            [nombre.trim(), id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "LÃ­nea no encontrada" });
        }

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al editar lÃ­nea" });
    }
});
// Eliminar lÃ­nea solo admin puede eliminarla 
app.delete("/lineas/:id", async (req, res) => {
    const { id } = req.params;

    try {

        await pool.query(
            "DELETE FROM lineas_produccion WHERE id = $1",
            [id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al eliminar lÃ­nea" });
    }
});

app.get("/horarios-login", async (req, res) => {
    try {
        const rol = String(req.query.rol || "empleado").toLowerCase();
        if (!ROLES_HORARIO.has(rol)) {
            return res.status(400).json({ error: "Rol invalido" });
        }

        const result = await pool.query(
            `SELECT
                id,
                rol,
                dia_semana,
                TO_CHAR(hora_inicio, 'HH24:MI') AS hora_inicio,
                TO_CHAR(hora_fin, 'HH24:MI') AS hora_fin,
                activo
             FROM horarios_login
             WHERE rol = $1
             ORDER BY dia_semana ASC, hora_inicio ASC`,
            [rol]
        );

        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener horarios" });
    }
});

app.post("/horarios-login", async (req, res) => {
    try {
        const rol = String(req.body.rol || "empleado").toLowerCase();
        const dia_semana = Number(req.body.dia_semana);
        const hora_inicio = normalizarHora(req.body.hora_inicio);
        const hora_fin = normalizarHora(req.body.hora_fin);
        const activo = req.body.activo !== false;

        if (!ROLES_HORARIO.has(rol)) {
            return res.status(400).json({ error: "Rol invalido" });
        }
        if (!Number.isInteger(dia_semana) || dia_semana < 0 || dia_semana > 6) {
            return res.status(400).json({ error: "Dia de semana invalido" });
        }
        if (!hora_inicio || !hora_fin) {
            return res.status(400).json({ error: "Formato de hora invalido" });
        }
        if (hora_inicio >= hora_fin) {
            return res.status(400).json({ error: "La hora inicio debe ser menor a la hora fin" });
        }

        const total = await pool.query(
            `SELECT COUNT(*)::INT AS total
             FROM horarios_login
             WHERE rol = $1 AND activo = TRUE`,
            [rol]
        );

        if (total.rows[0].total >= 24) {
            return res.status(400).json({ error: "Solo se permiten 24 horarios activos por rol" });
        }

        const traslape = await pool.query(
            `SELECT 1
             FROM horarios_login
             WHERE rol = $1
               AND activo = TRUE
               AND dia_semana = $2
               AND NOT ($4::TIME <= hora_inicio OR $3::TIME >= hora_fin)
             LIMIT 1`,
            [rol, dia_semana, hora_inicio, hora_fin]
        );

        if (traslape.rowCount > 0) {
            return res.status(400).json({ error: "Ese horario se traslapa con otro existente" });
        }

        const insert = await pool.query(
            `INSERT INTO horarios_login (rol, dia_semana, hora_inicio, hora_fin, activo)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [rol, dia_semana, hora_inicio, hora_fin, activo]
        );

        res.json({ success: true, id: insert.rows[0].id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al guardar horario" });
    }
});

app.put("/horarios-login/:id", async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await pool.query(
            `SELECT id, rol, activo FROM horarios_login WHERE id = $1`,
            [id]
        );

        if (existente.rowCount === 0) {
            return res.status(404).json({ error: "Horario no encontrado" });
        }

        const rol = String(req.body.rol || existente.rows[0].rol || "empleado").toLowerCase();
        const dia_semana = Number(req.body.dia_semana);
        const hora_inicio = normalizarHora(req.body.hora_inicio);
        const hora_fin = normalizarHora(req.body.hora_fin);
        const activo = req.body.activo !== false;

        if (!ROLES_HORARIO.has(rol)) {
            return res.status(400).json({ error: "Rol invalido" });
        }
        if (!Number.isInteger(dia_semana) || dia_semana < 0 || dia_semana > 6) {
            return res.status(400).json({ error: "Dia de semana invalido" });
        }
        if (!hora_inicio || !hora_fin) {
            return res.status(400).json({ error: "Formato de hora invalido" });
        }
        if (hora_inicio >= hora_fin) {
            return res.status(400).json({ error: "La hora inicio debe ser menor a la hora fin" });
        }

        if (activo) {
            const total = await pool.query(
                `SELECT COUNT(*)::INT AS total
                 FROM horarios_login
                 WHERE rol = $1 AND activo = TRUE AND id <> $2`,
                [rol, id]
            );

            if (total.rows[0].total >= 24) {
                return res.status(400).json({ error: "Solo se permiten 24 horarios activos por rol" });
            }
        }

        const traslape = await pool.query(
            `SELECT 1
             FROM horarios_login
             WHERE rol = $1
               AND activo = TRUE
               AND dia_semana = $2
               AND id <> $5
               AND NOT ($4::TIME <= hora_inicio OR $3::TIME >= hora_fin)
             LIMIT 1`,
            [rol, dia_semana, hora_inicio, hora_fin, id]
        );

        if (traslape.rowCount > 0) {
            return res.status(400).json({ error: "Ese horario se traslapa con otro existente" });
        }

        await pool.query(
            `UPDATE horarios_login
             SET rol = $1,
                 dia_semana = $2,
                 hora_inicio = $3,
                 hora_fin = $4,
                 activo = $5
             WHERE id = $6`,
            [rol, dia_semana, hora_inicio, hora_fin, activo, id]
        );

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al editar horario" });
    }
});

app.delete("/horarios-login/:id", async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query("DELETE FROM horarios_login WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al eliminar horario" });
    }
});
///////Agregar Materiales - PestaÃ±a ///////// 
app.post("/materiales", async (req, res) => {

    const { nombre, tipo, cantidad_stock, stock_minimo, precio_unitario, maximo_por_requisicion, imagen_url } = req.body;

    if (!nombre || !tipo || cantidad_stock == null || stock_minimo == null || precio_unitario == null) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    const maximoPorReqNum = parseInt(maximo_por_requisicion ?? 1, 10);

    if (cantidad_stock < 0 || stock_minimo < 0 || Number(precio_unitario) < 0) {
        return res.status(400).json({ error: "Stock/precio no pueden ser negativos" });
    }
    if (Number.isNaN(maximoPorReqNum) || maximoPorReqNum < 1) {
        return res.status(400).json({ error: "Maximo por requisicion invalido" });
    }
    const imagenNormalizada = normalizarImagenDataUrl(imagen_url);
    if (imagenNormalizada.error) {
        return res.status(400).json({ error: imagenNormalizada.error });
    }
    const imagenDataUrl = imagenNormalizada.value;

    try {

        // Verificar si ya existe por nombre y tipo
        const existe = await pool.query(
            `SELECT * FROM materiales 
             WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1))
             AND tipo = $2`,
            [nombre, tipo]
        );

        if (existe.rows.length > 0) {

            await pool.query(
                `UPDATE materiales
                 SET cantidad_stock = cantidad_stock + $1,
                     precio_unitario = $4,
                     stock_minimo = $5,
                     maximo_por_requisicion = $6,
                     imagen_url = COALESCE($7, imagen_url)
                 WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($2))
                 AND tipo = $3`,
                [cantidad_stock, nombre, tipo, Number(precio_unitario), parseInt(stock_minimo, 10), maximoPorReqNum, imagenDataUrl]
            );

            return res.json({ success: true, message: "Stock actualizado" });

        } else {

            await pool.query(
                `INSERT INTO materiales
                (nombre, tipo, cantidad_stock, stock_minimo, precio_unitario, maximo_por_requisicion, imagen_url)
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [nombre.trim(), tipo, cantidad_stock, stock_minimo, Number(precio_unitario), maximoPorReqNum, imagenDataUrl]
            );

            return res.json({ success: true, message: "Material creado" });
        }

    } catch (error) {
        console.error("ERROR AL CREAR MATERIAL:", error);
        res.status(500).json({ error: "Error al crear material" });
    }
});
app.put("/materiales/:id", async (req, res) => {
    const { id } = req.params;
    const { nombre, tipo, stock_minimo, precio_unitario, cantidad_stock, maximo_por_requisicion, imagen_url } = req.body;

    if (!nombre || !tipo || stock_minimo == null || precio_unitario == null) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    if (!["consumible", "herramienta"].includes(tipo)) {
        return res.status(400).json({ error: "Tipo invalido" });
    }

    if (parseInt(stock_minimo) < 0) {
        return res.status(400).json({ error: "Stock minimo invalido" });
    }
    if (Number(precio_unitario) < 0 || Number.isNaN(Number(precio_unitario))) {
        return res.status(400).json({ error: "Precio unitario invalido" });
    }
    const maximoPorReqNum = parseInt(maximo_por_requisicion ?? 1, 10);
    if (Number.isNaN(maximoPorReqNum) || maximoPorReqNum < 1) {
        return res.status(400).json({ error: "Maximo por requisicion invalido" });
    }
    const imagenNormalizada = normalizarImagenDataUrl(imagen_url);
    if (imagenNormalizada.error) {
        return res.status(400).json({ error: imagenNormalizada.error });
    }
    const imagenDataUrl = imagenNormalizada.value;
    let cantidadStockNum = null;
    if (cantidad_stock != null) {
        cantidadStockNum = parseInt(cantidad_stock, 10);
        if (Number.isNaN(cantidadStockNum) || cantidadStockNum < 0) {
            return res.status(400).json({ error: "Stock actual invalido" });
        }
    }

    try {
        const result = await pool.query(
            `UPDATE materiales
             SET nombre = $1,
                 tipo = $2,
                 stock_minimo = $3,
                 precio_unitario = $4,
                 cantidad_stock = COALESCE($5, cantidad_stock),
                 maximo_por_requisicion = $6,
                 imagen_url = COALESCE($7, imagen_url)
             WHERE id = $8
             RETURNING id, nombre, tipo, cantidad_stock, stock_minimo, precio_unitario, maximo_por_requisicion, imagen_url`,
            [nombre.trim(), tipo, parseInt(stock_minimo, 10), Number(precio_unitario), cantidadStockNum, maximoPorReqNum, imagenDataUrl, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Material no encontrado" });
        }

        res.json({ success: true, material: result.rows[0] });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al editar material" });
    }
});

app.put("/materiales/:id/imagen", async (req, res) => {
    const { id } = req.params;
    const { imagen_url } = req.body;

    const imagenNormalizada = normalizarImagenDataUrl(imagen_url);
    if (imagenNormalizada.error) {
        return res.status(400).json({ error: imagenNormalizada.error });
    }

    try {
        const result = await pool.query(
            `UPDATE materiales
             SET imagen_url = $1
             WHERE id = $2
             RETURNING id, nombre, imagen_url`,
            [imagenNormalizada.value, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Material no encontrado" });
        }

        res.json({ success: true, material: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al actualizar imagen del material" });
    }
});
// Modificar stock manualmente (Solo enteros)
app.put("/materiales/:id/stock", async (req, res) => {
    const { id } = req.params;
    let { nuevo_stock } = req.body;

    try {

        if (nuevo_stock === undefined || nuevo_stock === null) {
            return res.status(400).json({ error: "Debe enviar un valor" });
        }

        // Obtener stock actual
        const material = await pool.query(
            "SELECT cantidad_stock FROM materiales WHERE id = $1",
            [id]
        );

        if (material.rows.length === 0) {
            return res.status(404).json({ error: "Material no encontrado" });
        }

        const stockActual = parseInt(material.rows[0].cantidad_stock);

        nuevo_stock = nuevo_stock.toString().trim();

        // Validar que sea entero vÃ¡lido (permite + o -)
        if (!/^[-+]?\d+$/.test(nuevo_stock)) {
            return res.status(400).json({ error: "Solo se permiten nÃºmeros enteros" });
        }

        const valor = parseInt(nuevo_stock);

        let stockFinal;

        // Si empieza con + o -, hacer ajuste
        if (nuevo_stock.startsWith("+") || nuevo_stock.startsWith("-")) {
            stockFinal = stockActual + valor;
        } else {
            // Valor directo
            stockFinal = valor;
        }

        if (stockFinal < 0) {
            return res.status(400).json({ error: "El stock no puede quedar negativo" });
        }

        await pool.query(
            "UPDATE materiales SET cantidad_stock = $1 WHERE id = $2",
            [stockFinal, id]
        );

        res.json({ success: true, nuevo_stock: stockFinal });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al actualizar stock" });
    }
});
// Barra busqueda de materiales 
app.get("/materiales", async (req, res) => {
    try {

        const { buscar, tipo } = req.query;

        let query = `
            SELECT id, nombre, tipo, cantidad_stock, stock_minimo, precio_unitario, maximo_por_requisicion, imagen_url
            FROM materiales
        `;

        let values = [];
        let where = [];

        if (tipo) {
            const tipoNorm = String(tipo).trim().toLowerCase();
            if (!["consumible", "herramienta"].includes(tipoNorm)) {
                return res.status(400).json({ error: "Tipo invalido" });
            }
            where.push(`LOWER(tipo) = $${values.length + 1}`);
            values.push(tipoNorm);
        }

        if (buscar) {
            where.push(`LOWER(nombre) LIKE LOWER($${values.length + 1})`);
            values.push(`%${buscar}%`);
        }

        if (where.length > 0) {
            query += ` WHERE ${where.join(" AND ")}`;
        }

        query += " ORDER BY id ASC";

        const result = await pool.query(query, values);

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener materiales" });
    }
});
// Eliminar material
app.delete("/materiales/:id", async (req, res) => {
    const { id } = req.params;

    try {

        // Verificar si estÃ¡ en alguna requisiciÃ³n
        const uso = await pool.query(
            "SELECT * FROM detalle_requisicion WHERE material_id = $1",
            [id]
        );

        if (uso.rows.length > 0) {
            return res.status(400).json({
                error: "No se puede eliminar. El material estÃ¡ en requisiciones."
            });
        }

        await pool.query(
            "DELETE FROM materiales WHERE id = $1",
            [id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al eliminar material" });
    }
});

async function obtenerColumnaDescripcionHerramientaModulo() {
    const result = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'herramienta_modulo' AND column_name IN ('descripcion', 'descripton') ORDER BY CASE WHEN column_name = 'descripcion' THEN 0 ELSE 1 END LIMIT 1"
    );

    return result.rows[0]?.column_name || "descripton";
}

// ======= Herramienta de Modulo =======
app.get("/herramienta-modulo", async (req, res) => {
    try {
        const { buscar } = req.query;
        const colDesc = await obtenerColumnaDescripcionHerramientaModulo();

        let query = `SELECT id, nombre, ${colDesc} AS descripcion, cantidad, stock_minimo, precio_por_unidad, maximo_por_requisicion, imagen_url FROM herramienta_modulo`;
        const values = [];

        if (buscar) {
            query += " WHERE LOWER(nombre) LIKE LOWER($1)";
            values.push(`%${buscar}%`);
        }

        query += " ORDER BY id ASC";

        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener herramienta de modulo" });
    }
});

app.post("/herramienta-modulo", async (req, res) => {
    const { nombre, descripcion, cantidad, stock_minimo, precio_por_unidad, maximo_por_requisicion, imagen_url } = req.body;

    if (!nombre || cantidad == null || precio_por_unidad == null || stock_minimo == null) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    const cantidadNum = parseInt(cantidad, 10);
    const stockMinimoNum = parseInt(stock_minimo, 10);
    const precioNum = parseFloat(precio_por_unidad);
    const maximoPorReqNum = parseInt(maximo_por_requisicion ?? 1, 10);

    if (Number.isNaN(cantidadNum) || cantidadNum < 0) {
        return res.status(400).json({ error: "Cantidad invalida" });
    }
    if (Number.isNaN(stockMinimoNum) || stockMinimoNum < 0) {
        return res.status(400).json({ error: "Stock minimo invalido" });
    }

    if (Number.isNaN(precioNum) || precioNum < 0) {
        return res.status(400).json({ error: "Precio invalido" });
    }
    if (Number.isNaN(maximoPorReqNum) || maximoPorReqNum < 1) {
        return res.status(400).json({ error: "Maximo por requisicion invalido" });
    }
    const imagenNormalizada = normalizarImagenDataUrl(imagen_url);
    if (imagenNormalizada.error) {
        return res.status(400).json({ error: imagenNormalizada.error });
    }
    const imagenDataUrl = imagenNormalizada.value;

    try {
        const colDesc = await obtenerColumnaDescripcionHerramientaModulo();

        await pool.query(
            `INSERT INTO herramienta_modulo (nombre, ${colDesc}, cantidad, stock_minimo, precio_por_unidad, maximo_por_requisicion, imagen_url) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [nombre.trim(), (descripcion || "").trim() || null, cantidadNum, stockMinimoNum, precioNum, maximoPorReqNum, imagenDataUrl]
        );

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al crear herramienta de modulo" });
    }
});

app.put("/herramienta-modulo/:id", async (req, res) => {
    const { id } = req.params;
    const { nombre, descripcion, cantidad, stock_minimo, precio_por_unidad, maximo_por_requisicion, imagen_url } = req.body;

    if (!nombre || cantidad == null || precio_por_unidad == null || stock_minimo == null) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    const cantidadNum = parseInt(cantidad, 10);
    const stockMinimoNum = parseInt(stock_minimo, 10);
    const precioNum = parseFloat(precio_por_unidad);
    const maximoPorReqNum = parseInt(maximo_por_requisicion ?? 1, 10);

    if (Number.isNaN(cantidadNum) || cantidadNum < 0) {
        return res.status(400).json({ error: "Cantidad invalida" });
    }
    if (Number.isNaN(stockMinimoNum) || stockMinimoNum < 0) {
        return res.status(400).json({ error: "Stock minimo invalido" });
    }

    if (Number.isNaN(precioNum) || precioNum < 0) {
        return res.status(400).json({ error: "Precio invalido" });
    }
    if (Number.isNaN(maximoPorReqNum) || maximoPorReqNum < 1) {
        return res.status(400).json({ error: "Maximo por requisicion invalido" });
    }
    const imagenNormalizada = normalizarImagenDataUrl(imagen_url);
    if (imagenNormalizada.error) {
        return res.status(400).json({ error: imagenNormalizada.error });
    }
    const imagenDataUrl = imagenNormalizada.value;

    try {
        const colDesc = await obtenerColumnaDescripcionHerramientaModulo();

        const result = await pool.query(
            `UPDATE herramienta_modulo
             SET nombre = $1,
                 ${colDesc} = $2,
                 cantidad = $3,
                 stock_minimo = $4,
                 precio_por_unidad = $5,
                 maximo_por_requisicion = $6,
                 imagen_url = COALESCE($7, imagen_url)
             WHERE id = $8
             RETURNING id, nombre, ${colDesc} AS descripcion, cantidad, stock_minimo, precio_por_unidad, maximo_por_requisicion, imagen_url`,
            [nombre.trim(), (descripcion || "").trim() || null, cantidadNum, stockMinimoNum, precioNum, maximoPorReqNum, imagenDataUrl, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Herramienta no encontrada" });
        }

        res.json({ success: true, herramienta: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al editar herramienta de modulo" });
    }
});

app.put("/herramienta-modulo/:id/imagen", async (req, res) => {
    const { id } = req.params;
    const { imagen_url } = req.body;

    const imagenNormalizada = normalizarImagenDataUrl(imagen_url);
    if (imagenNormalizada.error) {
        return res.status(400).json({ error: imagenNormalizada.error });
    }

    try {
        const result = await pool.query(
            `UPDATE herramienta_modulo
             SET imagen_url = $1
             WHERE id = $2
             RETURNING id, nombre, imagen_url`,
            [imagenNormalizada.value, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Herramienta no encontrada" });
        }

        res.json({ success: true, herramienta: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al actualizar imagen de herramienta" });
    }
});

app.put("/herramienta-modulo/:id/cantidad", async (req, res) => {
    const { id } = req.params;
    let { cambio } = req.body;

    if (cambio === undefined || cambio === null) {
        return res.status(400).json({ error: "Debe enviar un valor" });
    }

    try {
        const actual = await pool.query(
            "SELECT cantidad FROM herramienta_modulo WHERE id = $1",
            [id]
        );

        if (actual.rows.length === 0) {
            return res.status(404).json({ error: "Herramienta no encontrada" });
        }

        const cantidadActual = parseInt(actual.rows[0].cantidad, 10);
        cambio = cambio.toString().trim();

        if (!/^[-+]?\d+$/.test(cambio)) {
            return res.status(400).json({ error: "Solo se permiten numeros enteros" });
        }

        const delta = parseInt(cambio, 10);
        let cantidadFinal;

        if (cambio.startsWith("+") || cambio.startsWith("-")) {
            cantidadFinal = cantidadActual + delta;
        } else {
            cantidadFinal = delta;
        }

        if (cantidadFinal < 0) {
            return res.status(400).json({ error: "La cantidad no puede quedar negativa" });
        }

        await pool.query(
            "UPDATE herramienta_modulo SET cantidad = $1 WHERE id = $2",
            [cantidadFinal, id]
        );

        res.json({ success: true, cantidad: cantidadFinal });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al actualizar cantidad" });
    }
});

app.delete("/herramienta-modulo/:id", async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            "DELETE FROM herramienta_modulo WHERE id = $1",
            [id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Herramienta no encontrada" });
        }

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al eliminar herramienta de modulo" });
    }
});
////////Agregar equipos - PestaÃ±a///////////
// Crear equipo individual
app.post("/equipos-individuales", async (req, res) => {
    const { nombre, descripcion, numero_serie, numero_activo, ubicacion } = req.body;

    if (!nombre || !numero_serie) {
        return res.status(400).json({ error: "Nombre y nÃºmero de serie obligatorios" });
    }

    try {

        const existe = await pool.query(
            "SELECT * FROM equipos_individuales WHERE numero_serie = $1",
            [numero_serie]
        );

        if (existe.rows.length > 0) {
            return res.status(400).json({ error: "NÃºmero de serie ya existe" });
        }

        await pool.query(
            `INSERT INTO equipos_individuales
            (nombre, descripcion, numero_serie, numero_activo, ubicacion)
            VALUES ($1, $2, $3, $4, $5)`,
            [nombre, descripcion || null, numero_serie, numero_activo || null, ubicacion || null]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al guardar equipo" });
    }
});
app.put("/equipos-individuales/:id", async (req, res) => {
    const { id } = req.params;
    const { nombre, descripcion, numero_serie, numero_activo, ubicacion } = req.body;

    if (!nombre || !numero_serie) {
        return res.status(400).json({ error: "Nombre y numero de serie obligatorios" });
    }

    try {
        const existeSerie = await pool.query(
            "SELECT id FROM equipos_individuales WHERE numero_serie = $1 AND id <> $2",
            [numero_serie, id]
        );

        if (existeSerie.rows.length > 0) {
            return res.status(400).json({ error: "Numero de serie ya existe" });
        }

        const result = await pool.query(
            `UPDATE equipos_individuales
             SET nombre = $1,
                 descripcion = $2,
                 numero_serie = $3,
                 numero_activo = $4,
                 ubicacion = $5
             WHERE id = $6`,
            [nombre, descripcion || null, numero_serie, numero_activo || null, ubicacion || null, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Equipo no encontrado" });
        }

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al editar equipo" });
    }
});

// Cambiar condicion de equipo (funcional/danado)
app.put("/equipos-individuales/:id/condicion", async (req, res) => {
    const { id } = req.params;
    const { condicion } = req.body;

    if (!["funcional", "danado"].includes(condicion)) {
        return res.status(400).json({ error: "Condicion invalida" });
    }

    try {
        const equipo = await pool.query(
            "SELECT estado FROM equipos_individuales WHERE id = $1",
            [id]
        );

        if (equipo.rows.length === 0) {
            return res.status(404).json({ error: "Equipo no encontrado" });
        }

        const estadoActual = equipo.rows[0].estado;

        if (estadoActual === "en_uso") {
            return res.status(400).json({ error: "No se puede cambiar condicion: equipo en uso" });
        }

        const nuevoEstado = condicion === "danado" ? "danado" : "disponible";

        await pool.query(
            "UPDATE equipos_individuales SET estado = $1 WHERE id = $2",
            [nuevoEstado, id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al cambiar condicion" });
    }
});


// Admin recibe equipo manualmente (sin esperar solicitud de devolucion)
app.put("/equipos-individuales/:id/devolver-manual", async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query("BEGIN");

        const equipo = await pool.query(
            `SELECT id, estado
             FROM equipos_individuales
             WHERE id = $1
             FOR UPDATE`,
            [id]
        );

        if (equipo.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Equipo no encontrado" });
        }

        if (equipo.rows[0].estado !== "en_uso") {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "El equipo no esta en uso" });
        }

        const asignacion = await pool.query(
            `SELECT id
             FROM asignaciones_equipos
             WHERE equipo_id = $1
               AND estado IN ('entregado','pendiente_devolucion')
             ORDER BY id DESC
             LIMIT 1
             FOR UPDATE`,
            [id]
        );

        if (asignacion.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "No hay asignacion activa para este equipo" });
        }

        const asignacionId = asignacion.rows[0].id;

        await pool.query(
            `UPDATE asignaciones_equipos
             SET estado = 'devuelto',
                 fecha_devolucion = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [asignacionId]
        );

        await pool.query(
            `UPDATE equipos_individuales
             SET estado = 'disponible'
             WHERE id = $1`,
            [id]
        );

        await pool.query("COMMIT");
        res.json({ success: true, asignacion_id: asignacionId });

    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al devolver manualmente el equipo" });
    }
});
// Eliminar equipo individual
app.delete("/equipos-individuales/:id", async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query(
            "DELETE FROM equipos_individuales WHERE id = $1",
            [id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al eliminar equipo" });
    }
});
// Obtener todos los equipos individuales (ADMIN)
app.get("/equipos-individuales", async (req, res) => {
    try {

        const result = await pool.query(`
            SELECT 
                id,
                nombre,
                descripcion,
                numero_serie,
                numero_activo,
                ubicacion,
                estado
            FROM equipos_individuales
            ORDER BY id DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error("Error al obtener equipos:", error);
        res.status(500).json({ error: "Error al obtener equipos" });
    }
});

////////Solicitud de equipos por tecnico - PestaÃ±a///////////
//Ver solicitudes pendientes por tecnico
app.get("/asignaciones/pendientes", async (req, res) => {
    try {

        const result = await pool.query(`
            SELECT 
                a.id,
                u.nombre AS tecnico,
                e.nombre AS equipo,
                l.nombre AS linea,
                a.fecha_solicitud
            FROM asignaciones_equipos a
            LEFT JOIN usuarios u ON a.usuario_id = u.id
            LEFT JOIN equipos_individuales e ON a.equipo_id = e.id
            LEFT JOIN lineas_produccion l ON a.linea_id = l.id
            WHERE a.estado = 'pendiente'
            ORDER BY a.fecha_solicitud DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener solicitudes pendientes" });
    }
});
// Admin rechaza solicitud equipo
app.put("/asignaciones/:id/rechazar", async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query(`
            UPDATE asignaciones_equipos
            SET estado = 'rechazado'
            WHERE id = $1
        `, [id]);

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al rechazar" });
    }
});
// Admin aprueba solicitud de equipo
app.put("/asignaciones/:id/aprobar", async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query("BEGIN");

        const asignacion = await pool.query(
            `SELECT id, equipo_id, estado
             FROM asignaciones_equipos
             WHERE id = $1
             FOR UPDATE`,
            [id]
        );

        if (asignacion.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Asignacion no encontrada" });
        }

        const a = asignacion.rows[0];

        const equipoLock = await pool.query(
            `SELECT id, estado
             FROM equipos_individuales
             WHERE id = $1
             FOR UPDATE`,
            [a.equipo_id]
        );

        if (equipoLock.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Equipo no encontrado" });
        }

        if (a.estado !== "pendiente") {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Solo se puede aprobar una solicitud pendiente" });
        }

        const conflicto = await pool.query(
            `SELECT id
             FROM asignaciones_equipos
             WHERE equipo_id = $1
               AND estado IN ('aprobado','entregado','pendiente_devolucion')
               AND id <> $2
             LIMIT 1`,
            [a.equipo_id, id]
        );

        if (conflicto.rows.length > 0) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Ese equipo ya tiene una asignacion activa" });
        }

        await pool.query(
            `UPDATE asignaciones_equipos
             SET estado = 'aprobado',
                 fecha_aprobacion = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id]
        );

        await pool.query("COMMIT");
        res.json({ success: true });

    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al aprobar solicitud" });
    }
});
// Admin ve devoluciones pendientes
app.get("/asignaciones/devoluciones-pendientes", async (req, res) => {
    try {

        const result = await pool.query(`
            SELECT 
                a.id,
                u.nombre AS tecnico,
                e.nombre AS equipo,
                l.nombre AS linea,
                a.fecha_solicitud
            FROM asignaciones_equipos a
            LEFT JOIN usuarios u ON a.usuario_id = u.id
            LEFT JOIN equipos_individuales e ON a.equipo_id = e.id
            LEFT JOIN lineas_produccion l ON a.linea_id = l.id
            WHERE a.estado = 'pendiente_devolucion'
            ORDER BY a.fecha_solicitud DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener devoluciones pendientes" });
    }
});
// Admin aprueba devoluciÃ³n
app.put("/asignaciones/:id/aprobar-devolucion", async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query("BEGIN");

        const asignacion = await pool.query(
            `SELECT equipo_id
             FROM asignaciones_equipos
             WHERE id = $1`,
            [id]
        );

        if (asignacion.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "AsignaciÃ³n no encontrada" });
        }

        const equipo_id = asignacion.rows[0].equipo_id;

        if (!equipo_id) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "La asignaciÃ³n no tiene equipo asociado" });
        }

        // Marcar como devuelto
        await pool.query(
            `UPDATE asignaciones_equipos
             SET estado = 'devuelto',
                 fecha_devolucion = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id]
        );

        // Regresar equipo a disponible
        await pool.query(
            `UPDATE equipos_individuales
             SET estado = 'disponible'
             WHERE id = $1`,
            [equipo_id]
        );

        await pool.query("COMMIT");

        res.json({ success: true });

    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al aprobar devoluciÃ³n" });
    }
});


// Admin rechaza devoluciÃ³n (cancela solicitud de devoluciÃ³n)
app.put("/asignaciones/:id/rechazar-devolucion", async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `UPDATE asignaciones_equipos
             SET estado = 'entregado'
             WHERE id = $1
               AND estado = 'pendiente_devolucion'
             RETURNING id`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: "La asignacion no esta pendiente de devolucion" });
        }

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al rechazar devolucion" });
    }
});

app.get("/requisiciones-pendientes-admin", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                r.id AS requisicion_id,
                r.fecha,
                COALESCE(r.tipo_origen, 'ensamble') AS tipo_origen,
                COALESCE(r.turno, CASE
                    WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') THEN 'Turno 01'
                    WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00'
                       OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') THEN 'Turno 02'
                    ELSE 'Fuera de turno'
                END) AS turno,
                COALESCE(l.nombre, '-') AS linea_nombre,
                COALESCE(u.nombre, '-') AS solicitante,
                COALESCE(u.numero_id::text, '-') AS numero_id,
                d.detalle_id,
                d.detalle_tipo,
                d.material,
                d.estado,
                d.tipo_movimiento,
                d.cantidad_solicitada
            FROM requisiciones r
            JOIN usuarios u ON r.usuario_id = u.id
            LEFT JOIN lineas_produccion l ON r.linea_id = l.id
            JOIN (
                SELECT
                    d.requisicion_id,
                    d.id AS detalle_id,
                    'ensamble' AS detalle_tipo,
                    m.nombre AS material,
                    d.estado,
                    d.tipo_movimiento,
                    d.cantidad_solicitada
                FROM detalle_requisicion d
                JOIN materiales m ON d.material_id = m.id
                WHERE LOWER(COALESCE(d.tipo_movimiento, '')) = 'nuevo'
                  AND COALESCE(d.aprobado_supervisor, FALSE) = FALSE
                  AND COALESCE(d.estado, '') <> 'rechazada'
                UNION ALL
                SELECT
                    dm.requisicion_id,
                    dm.id AS detalle_id,
                    'modulo' AS detalle_tipo,
                    hm.nombre AS material,
                    dm.estado,
                    dm.tipo_movimiento,
                    dm.cantidad_solicitada
                FROM detalle_requisicion_modulo dm
                JOIN herramienta_modulo hm ON dm.herramienta_modulo_id = hm.id
                WHERE LOWER(COALESCE(dm.tipo_movimiento, '')) = 'nuevo'
                  AND COALESCE(dm.aprobado_supervisor, FALSE) = FALSE
                  AND COALESCE(dm.estado, '') <> 'rechazada'
            ) d ON d.requisicion_id = r.id
            WHERE COALESCE(r.estado_general, '') NOT IN ('completa', 'rechazada', 'cancelada')
            ORDER BY r.id DESC, d.material ASC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener requisiciones pendientes de aprobacion" });
    }
});

app.put("/requisiciones-detalle/:detalle_id/aprobar-admin", async (req, res) => {
    const { detalle_id } = req.params;
    const usuarioAdminId = parseInt(req.body?.usuario_admin_id, 10);
    const detalleTipo = String(req.body?.detalle_tipo || "ensamble").trim().toLowerCase();

    if (!Number.isInteger(usuarioAdminId) || usuarioAdminId <= 0) {
        return res.status(400).json({ error: "Usuario administrador invalido" });
    }
    if (!["ensamble", "modulo"].includes(detalleTipo)) {
        return res.status(400).json({ error: "Tipo de detalle invalido" });
    }

    try {
        const adminResult = await pool.query(
            "SELECT rol, COALESCE(activo, TRUE) AS activo FROM usuarios WHERE id = $1",
            [usuarioAdminId]
        );
        if (adminResult.rows.length === 0 || adminResult.rows[0].rol !== "admin") {
            return res.status(403).json({ error: "Solo administrador puede aprobar" });
        }
        if (adminResult.rows[0].activo === false) {
            return res.status(403).json({ error: "Administrador deshabilitado" });
        }

        const tabla = detalleTipo === "modulo" ? "detalle_requisicion_modulo" : "detalle_requisicion";
        const detalleResult = await pool.query(
            `SELECT id, requisicion_id, COALESCE(tipo_movimiento, '') AS tipo_movimiento, COALESCE(estado, '') AS estado
             FROM ${tabla}
             WHERE id = $1`,
            [detalle_id]
        );

        if (detalleResult.rows.length === 0) {
            return res.status(404).json({ error: "Detalle no encontrado" });
        }
        const detalle = detalleResult.rows[0];
        if (String(detalle.tipo_movimiento).toLowerCase() !== "nuevo") {
            return res.status(400).json({ error: "Solo se puede aprobar material tipo nuevo" });
        }
        if (String(detalle.estado).toLowerCase() === "rechazada") {
            return res.status(400).json({ error: "No se puede aprobar un material ya rechazado" });
        }

        await pool.query(
            `UPDATE ${tabla}
             SET aprobado_supervisor = TRUE
             WHERE id = $1`,
            [detalle_id]
        );

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al aprobar material nuevo" });
    }
});

app.put("/requisiciones-detalle/:detalle_id/rechazar-admin", async (req, res) => {
    const { detalle_id } = req.params;
    const usuarioAdminId = parseInt(req.body?.usuario_admin_id, 10);
    const detalleTipo = String(req.body?.detalle_tipo || "ensamble").trim().toLowerCase();

    if (!Number.isInteger(usuarioAdminId) || usuarioAdminId <= 0) {
        return res.status(400).json({ error: "Usuario administrador invalido" });
    }
    if (!["ensamble", "modulo"].includes(detalleTipo)) {
        return res.status(400).json({ error: "Tipo de detalle invalido" });
    }

    try {
        const adminResult = await pool.query(
            "SELECT rol, COALESCE(activo, TRUE) AS activo FROM usuarios WHERE id = $1",
            [usuarioAdminId]
        );
        if (adminResult.rows.length === 0 || adminResult.rows[0].rol !== "admin") {
            return res.status(403).json({ error: "Solo administrador puede rechazar" });
        }
        if (adminResult.rows[0].activo === false) {
            return res.status(403).json({ error: "Administrador deshabilitado" });
        }

        await pool.query("BEGIN");

        const tabla = detalleTipo === "modulo" ? "detalle_requisicion_modulo" : "detalle_requisicion";
        const detalleResult = await pool.query(
            `SELECT id, requisicion_id, COALESCE(tipo_movimiento, '') AS tipo_movimiento, COALESCE(estado, '') AS estado
             FROM ${tabla}
             WHERE id = $1
             FOR UPDATE`,
            [detalle_id]
        );

        if (detalleResult.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Detalle no encontrado" });
        }
        const detalle = detalleResult.rows[0];
        const estadoDetalle = String(detalle.estado || "").toLowerCase();
        if (String(detalle.tipo_movimiento).toLowerCase() !== "nuevo") {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Solo se puede rechazar material tipo nuevo" });
        }
        if (["completa", "parcial"].includes(estadoDetalle)) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "No se puede rechazar un material ya entregado" });
        }

        await pool.query(
            `UPDATE ${tabla}
             SET estado = 'rechazada',
                 aprobado_supervisor = FALSE
             WHERE id = $1`,
            [detalle_id]
        );

        const reqId = parseInt(detalle.requisicion_id, 10);
        const estadoReqResult = await pool.query(
            "SELECT COALESCE(tipo_origen, 'ensamble') AS tipo_origen FROM requisiciones WHERE id = $1",
            [reqId]
        );
        const origenReq = String(estadoReqResult.rows[0]?.tipo_origen || "ensamble").toLowerCase();
        const tablaReq = origenReq === "modulo" ? "detalle_requisicion_modulo" : "detalle_requisicion";

        const agg = await pool.query(
            `SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE COALESCE(estado, '') = 'rechazada') AS rechazadas,
                COUNT(*) FILTER (WHERE COALESCE(estado, '') = 'completa') AS completas,
                COUNT(*) FILTER (WHERE COALESCE(estado, '') NOT IN ('completa', 'rechazada')) AS pendientes
             FROM ${tablaReq}
             WHERE requisicion_id = $1`,
            [reqId]
        );

        const total = parseInt(agg.rows[0]?.total, 10) || 0;
        const rechazadas = parseInt(agg.rows[0]?.rechazadas, 10) || 0;
        const completas = parseInt(agg.rows[0]?.completas, 10) || 0;
        const pendientes = parseInt(agg.rows[0]?.pendientes, 10) || 0;

        let nuevoEstadoGeneral = "aprobada";
        if (pendientes === 0) {
            if (rechazadas === total && total > 0) {
                nuevoEstadoGeneral = "rechazada";
            } else {
                nuevoEstadoGeneral = "completa";
            }
        } else if (completas > 0 || rechazadas > 0) {
            nuevoEstadoGeneral = "parcial";
        }

        await pool.query(
            "UPDATE requisiciones SET estado_general = $1 WHERE id = $2",
            [nuevoEstadoGeneral, reqId]
        );

        await pool.query("COMMIT");
        res.json({ success: true });
    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al rechazar material nuevo" });
    }
});

app.put("/requisiciones/:id/aprobar-admin", async (req, res) => {
    const { id } = req.params;
    const usuarioAdminId = parseInt(req.body?.usuario_admin_id, 10);

    if (!Number.isInteger(usuarioAdminId) || usuarioAdminId <= 0) {
        return res.status(400).json({ error: "Usuario administrador invalido" });
    }

    try {
        const adminResult = await pool.query(
            "SELECT rol, COALESCE(activo, TRUE) AS activo FROM usuarios WHERE id = $1",
            [usuarioAdminId]
        );

        if (adminResult.rows.length === 0 || adminResult.rows[0].rol !== "admin") {
            return res.status(403).json({ error: "Solo el administrador puede aprobar requisiciones nuevas" });
        }
        if (adminResult.rows[0].activo === false) {
            return res.status(403).json({ error: "Administrador deshabilitado" });
        }

        await pool.query("BEGIN");

        const reqResult = await pool.query(
            `SELECT id, COALESCE(estado_general, '') AS estado_general
             FROM requisiciones
             WHERE id = $1
             FOR UPDATE`,
            [id]
        );
        if (reqResult.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Requisicion no encontrada" });
        }

        const estadoActual = String(reqResult.rows[0].estado_general || "").toLowerCase();
        if (["completa", "rechazada", "cancelada"].includes(estadoActual)) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "La requisicion ya esta cerrada" });
        }

        const updEns = await pool.query(
            `UPDATE detalle_requisicion
             SET aprobado_supervisor = TRUE
             WHERE requisicion_id = $1
               AND LOWER(COALESCE(tipo_movimiento, '')) = 'nuevo'
               AND COALESCE(aprobado_supervisor, FALSE) = FALSE
               AND COALESCE(estado, '') <> 'rechazada'`,
            [id]
        );
        const updMod = await pool.query(
            `UPDATE detalle_requisicion_modulo
             SET aprobado_supervisor = TRUE
             WHERE requisicion_id = $1
               AND LOWER(COALESCE(tipo_movimiento, '')) = 'nuevo'
               AND COALESCE(aprobado_supervisor, FALSE) = FALSE
               AND COALESCE(estado, '') <> 'rechazada'`,
            [id]
        );

        const totalAprobados = Number(updEns.rowCount || 0) + Number(updMod.rowCount || 0);
        if (totalAprobados <= 0) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "No hay materiales tipo nuevo pendientes de aprobar en esta requisicion" });
        }

        if (estadoActual === "pendiente_admin") {
            await pool.query(
                "UPDATE requisiciones SET estado_general = 'aprobada' WHERE id = $1",
                [id]
            );
        }

        await pool.query("COMMIT");
        res.json({ success: true, aprobados: totalAprobados });
    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al aprobar requisicion" });
    }
});

app.put("/requisiciones/:id/rechazar-admin", async (req, res) => {
    const { id } = req.params;
    const usuarioAdminId = parseInt(req.body?.usuario_admin_id, 10);

    if (!Number.isInteger(usuarioAdminId) || usuarioAdminId <= 0) {
        return res.status(400).json({ error: "Usuario administrador invalido" });
    }

    try {
        const adminResult = await pool.query(
            "SELECT rol, COALESCE(activo, TRUE) AS activo FROM usuarios WHERE id = $1",
            [usuarioAdminId]
        );

        if (adminResult.rows.length === 0 || adminResult.rows[0].rol !== "admin") {
            return res.status(403).json({ error: "Solo el administrador puede rechazar requisiciones nuevas" });
        }
        if (adminResult.rows[0].activo === false) {
            return res.status(403).json({ error: "Administrador deshabilitado" });
        }

        const reqResult = await pool.query(
            `SELECT id, COALESCE(estado_general, '') AS estado_general
             FROM requisiciones
             WHERE id = $1`,
            [id]
        );
        if (reqResult.rows.length === 0) {
            return res.status(404).json({ error: "Requisicion no encontrada" });
        }

        const estadoActual = String(reqResult.rows[0].estado_general || "").toLowerCase();
        if (["completa", "rechazada", "cancelada"].includes(estadoActual)) {
            return res.status(400).json({ error: "La requisicion ya esta cerrada" });
        }

        await pool.query(
            `UPDATE requisiciones
             SET estado_general = 'rechazada'
             WHERE id = $1`,
            [id]
        );

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al rechazar requisicion" });
    }
});
////////Agregar Usuarios - PestaÃ±a///////////
//Agregar o crear Usuario
app.post("/usuarios", async (req, res) => {
    const nombre = String(req.body.nombre || "").trim();
    const numero_id = String(req.body.numero_id || "").trim();
    const rol = String(req.body.rol || "").trim().toLowerCase();
    const contrasena = String(req.body["contrase\u00f1a"] || req.body.contrasena || req.body.password || "");

    if (!nombre || !numero_id || !contrasena || !rol) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    if (!["tecnico", "empleado", "supervisor"].includes(rol)) {
        return res.status(400).json({ error: "Rol invÃ¡lido" });
    }

    if (!/^[A-Za-z0-9_-]+$/.test(numero_id)) {
        return res.status(400).json({ error: "Numero ID invalido. Usa solo letras y numeros." });
    }

    try {
        const existe = await pool.query(
            "SELECT id FROM usuarios WHERE numero_id = $1",
            [numero_id]
        );

        if (existe.rows.length > 0) {
            return res.status(400).json({ error: "NÃºmero ID ya registrado" });
        }

        await pool.query(
            `INSERT INTO usuarios (nombre, numero_id, ${PASS_COL}, rol, activo)
             VALUES ($1, $2, $3, $4, TRUE)`,
            [nombre, numero_id, contrasena, rol]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al crear usuario" });
    }
});
//Obtener Usuarios y Tecnicos
app.get("/usuarios", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, nombre, numero_id, rol, ${PASS_COL} AS contrasena, COALESCE(activo, TRUE) AS activo
            FROM usuarios
            WHERE rol IN ('tecnico','empleado','supervisor')
            ORDER BY id DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener usuarios" });
    }
});
app.put("/usuarios/:id", async (req, res) => {
    const { id } = req.params;
    const nombre = String(req.body.nombre || "").trim();
    const numero_id = String(req.body.numero_id || "").trim();
    const rol = String(req.body.rol || "").trim().toLowerCase();
    const contrasenaNueva = String(req.body["contrase\u00f1a"] || req.body.contrasena || req.body.password || "");

    if (!nombre || !numero_id || !rol) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    if (!["tecnico", "empleado", "supervisor"].includes(rol)) {
        return res.status(400).json({ error: "Rol invalido" });
    }

    if (!/^[A-Za-z0-9_-]+$/.test(numero_id)) {
        return res.status(400).json({ error: "Numero ID invalido. Usa solo letras y numeros." });
    }

    try {
        const existe = await pool.query(
            "SELECT id FROM usuarios WHERE numero_id = $1 AND id <> $2",
            [numero_id, id]
        );

        if (existe.rows.length > 0) {
            return res.status(400).json({ error: "Numero ID ya registrado" });
        }

        if (contrasenaNueva && contrasenaNueva.toString().trim()) {
            await pool.query(
                `UPDATE usuarios SET nombre = $1, numero_id = $2, rol = $3, ${PASS_COL} = $4 WHERE id = $5`,
                [nombre, numero_id, rol, contrasenaNueva.toString().trim(), id]
            );
        } else {
            await pool.query(
                "UPDATE usuarios SET nombre = $1, numero_id = $2, rol = $3 WHERE id = $4",
                [nombre, numero_id, rol, id]
            );
        }

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al editar usuario" });
    }
});
app.put("/usuarios/:id/estado", async (req, res) => {
    const { id } = req.params;
    const { activo } = req.body;

    if (typeof activo !== "boolean") {
        return res.status(400).json({ error: "Estado invalido" });
    }

    try {
        const result = await pool.query(
            "UPDATE usuarios SET activo = $1 WHERE id = $2 AND rol IN ('tecnico','empleado','supervisor')",
            [activo, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al actualizar estado del usuario" });
    }
});

//Eliminar usuario: Empleado o Tecnico
app.delete("/usuarios/:id", async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query(
            "DELETE FROM usuarios WHERE id = $1",
            [id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al eliminar usuario" });
    }
});

////////Exportar - PestaÃ±a///////////
// Exportar Inventario cantidad total de todo lo que esta en inventario
app.get("/exportar-inventario", async (req, res) => {
    try {

        const result = await pool.query(`
            SELECT 
                m.id,
                m.imagen_url AS imagen,
                m.nombre,
                m.tipo,
                m.cantidad_stock,
                m.stock_minimo,
                CASE
                    WHEN m.cantidad_stock <= COALESCE(m.stock_minimo, 0) THEN 'Low stock'
                    ELSE 'Normal stock'
                END AS stock_status,
                COALESCE(m.precio_unitario, 0) AS precio_unitario,
                ROUND((m.cantidad_stock * COALESCE(m.precio_unitario, 0))::numeric, 2) AS total_inventario
            FROM materiales m
            ORDER BY m.id ASC
        `);

        const buffer = await generarBufferInventarioConImagenes(
            result.rows,
            "Inventario",
            "cantidad_stock",
            "imagen"
        );

        res.setHeader("Content-Disposition", "attachment; filename=inventario.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        res.send(buffer);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al exportar inventario" });
    }
});

app.get("/exportar-inventario-herramienta-modulo", async (req, res) => {
    try {
        const colDesc = await obtenerColumnaDescripcionHerramientaModulo();

        const result = await pool.query(`
            SELECT
                hm.id,
                hm.imagen_url AS imagen,
                hm.nombre,
                hm.${colDesc} AS descripcion,
                hm.cantidad,
                COALESCE(hm.stock_minimo, 0) AS stock_minimo,
                CASE
                    WHEN hm.cantidad <= COALESCE(hm.stock_minimo, 0) THEN 'Low stock'
                    ELSE 'Normal stock'
                END AS stock_status,
                COALESCE(hm.precio_por_unidad, 0) AS precio_unitario,
                ROUND((hm.cantidad * COALESCE(hm.precio_por_unidad, 0))::numeric, 2) AS total_inventario
            FROM herramienta_modulo hm
            ORDER BY hm.id ASC
        `);

        const buffer = await generarBufferInventarioConImagenes(
            result.rows,
            "InvModulo",
            "cantidad",
            "imagen"
        );

        res.setHeader("Content-Disposition", "attachment; filename=inventario_herramienta_modulo.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        res.send(buffer);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al exportar inventario de herramienta de modulo" });
    }
});
//Exportar historial de requisiciones
app.get("/exportar-requisiciones", async (req, res) => {

    const { fecha_inicio, fecha_fin, usuario_id } = req.query;

    if (!fecha_inicio || !fecha_fin || !usuario_id) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    try {

        const usuario = await pool.query(
            "SELECT rol FROM usuarios WHERE id = $1",
            [usuario_id]
        );

        const rolUsuario = String(usuario.rows[0]?.rol || "").trim().toLowerCase();
        const rolesPermitidosExportacion = new Set(["admin", "supervisor", "empleado", "tecnico"]);

        if (usuario.rows.length === 0 || !rolesPermitidosExportacion.has(rolUsuario)) {
            return res.status(403).json({ error: "Acceso no autorizado" });
        }

        const result = await pool.query(`
            SELECT 
                r.id AS requisicion,
                r.fecha,
                r.estado_general,
                l.nombre AS linea,
                COALESCE(r.turno, CASE
                    WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') THEN 'Turno 01'
                    WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00'
                       OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') THEN 'Turno 02'
                    ELSE 'Fuera de turno'
                END) AS turno,
                u.nombre AS solicitante,
                u.numero_id,
                m.nombre AS material,
                d.tipo_movimiento,
                d.cantidad_solicitada,
                d.cantidad_entregada
            FROM requisiciones r
            JOIN usuarios u ON r.usuario_id = u.id
            JOIN detalle_requisicion d ON r.id = d.requisicion_id
            JOIN materiales m ON d.material_id = m.id
            LEFT JOIN lineas_produccion l ON r.linea_id = l.id
            WHERE r.fecha::date BETWEEN $1::date AND $2::date
              AND COALESCE(r.tipo_origen, 'ensamble') = 'ensamble'
            ORDER BY r.fecha DESC
        `, [fecha_inicio, fecha_fin]);

        const worksheet = XLSX.utils.json_to_sheet(result.rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Requisiciones");

        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        res.setHeader("Content-Disposition", "attachment; filename=requisiciones.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        res.send(buffer);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al exportar requisiciones" });
    }
});

// Exportar historial de requisiciones de herramienta modulo
app.get("/exportar-requisiciones-modulo", async (req, res) => {

    const { fecha_inicio, fecha_fin, usuario_id } = req.query;

    if (!fecha_inicio || !fecha_fin || !usuario_id) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    try {

        const usuario = await pool.query(
            "SELECT rol FROM usuarios WHERE id = $1",
            [usuario_id]
        );

        const rolUsuario = String(usuario.rows[0]?.rol || "").trim().toLowerCase();
        const rolesPermitidosExportacion = new Set(["admin", "supervisor", "empleado", "tecnico"]);

        if (usuario.rows.length === 0 || !rolesPermitidosExportacion.has(rolUsuario)) {
            return res.status(403).json({ error: "Acceso no autorizado" });
        }

        const result = await pool.query(`
            SELECT 
                r.id AS requisicion,
                r.fecha,
                r.estado_general,
                l.nombre AS linea,
                COALESCE(r.turno, CASE
                    WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') THEN 'Turno 01'
                    WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00'
                       OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') THEN 'Turno 02'
                    ELSE 'Fuera de turno'
                END) AS turno,
                u.nombre AS solicitante,
                u.numero_id,
                hm.nombre AS material,
                d.tipo_movimiento,
                d.cantidad_solicitada,
                d.cantidad_entregada
            FROM requisiciones r
            JOIN usuarios u ON r.usuario_id = u.id
            JOIN detalle_requisicion_modulo d ON r.id = d.requisicion_id
            JOIN herramienta_modulo hm ON d.herramienta_modulo_id = hm.id
            LEFT JOIN lineas_produccion l ON r.linea_id = l.id
            WHERE r.fecha::date BETWEEN $1::date AND $2::date
              AND COALESCE(r.tipo_origen, 'ensamble') = 'modulo'
            ORDER BY r.fecha DESC
        `, [fecha_inicio, fecha_fin]);

        const worksheet = XLSX.utils.json_to_sheet(result.rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "ReqModulo");

        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        res.setHeader("Content-Disposition", "attachment; filename=requisiciones_modulo.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        res.send(buffer);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al exportar requisiciones de modulo" });
    }
});

// Exportar historial de devoluciones (retornos)
app.get("/exportar-devoluciones", async (req, res) => {

    const { fecha_inicio, fecha_fin, usuario_id } = req.query;

    if (!fecha_inicio || !fecha_fin || !usuario_id) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    try {
        const usuario = await pool.query(
            "SELECT rol FROM usuarios WHERE id = $1",
            [usuario_id]
        );

        const rolUsuario = String(usuario.rows[0]?.rol || "").trim().toLowerCase();
        const rolesPermitidosExportacion = new Set(["admin", "supervisor", "empleado", "tecnico"]);

        if (usuario.rows.length === 0 || !rolesPermitidosExportacion.has(rolUsuario)) {
            return res.status(403).json({ error: "Acceso no autorizado" });
        }

        const result = await pool.query(`
            SELECT
                t.requisicion,
                t.fecha,
                t.estado_general,
                t.linea,
                t.turno,
                t.solicitante,
                t.numero_id,
                t.seccion,
                t.material,
                t.tipo_movimiento,
                t.cantidad_solicitada,
                t.cantidad_entregada,
                t.cantidad_retorno_aceptada,
                t.cantidad_retorno_devuelta_linea,
                t.pendiente_aceptar,
                t.pendiente_devolver_linea,
                t.recibido_por,
                t.retorno_recibido_en
            FROM (
                SELECT
                    r.id AS requisicion,
                    r.fecha,
                    r.estado_general,
                    l.nombre AS linea,
                    COALESCE(r.turno, CASE
                        WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') THEN 'Turno 01'
                        WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00'
                           OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') THEN 'Turno 02'
                        ELSE 'Fuera de turno'
                    END) AS turno,
                    u.nombre AS solicitante,
                    u.numero_id,
                    'ensamble' AS seccion,
                    m.nombre AS material,
                    d.tipo_movimiento,
                    d.cantidad_solicitada,
                    d.cantidad_entregada,
                    COALESCE(d.cantidad_retorno_aceptada, 0) AS cantidad_retorno_aceptada,
                    COALESCE(d.cantidad_retorno_devuelta_linea, 0) AS cantidad_retorno_devuelta_linea,
                    GREATEST(COALESCE(d.cantidad_solicitada, 0) - COALESCE(d.cantidad_entregada, 0), 0) AS pendiente_aceptar,
                    GREATEST(COALESCE(d.cantidad_retorno_aceptada, 0) - COALESCE(d.cantidad_retorno_devuelta_linea, 0), 0) AS pendiente_devolver_linea,
                    ur.nombre AS recibido_por,
                    d.retorno_recibido_en
                FROM requisiciones r
                JOIN usuarios u ON r.usuario_id = u.id
                JOIN detalle_requisicion d ON r.id = d.requisicion_id
                JOIN materiales m ON d.material_id = m.id
                LEFT JOIN usuarios ur ON d.retorno_recibido_por_id = ur.id
                LEFT JOIN lineas_produccion l ON r.linea_id = l.id
                WHERE r.fecha::date BETWEEN $1::date AND $2::date
                  AND LOWER(COALESCE(d.tipo_movimiento, '')) = 'retorno'

                UNION ALL

                SELECT
                    r.id AS requisicion,
                    r.fecha,
                    r.estado_general,
                    l.nombre AS linea,
                    COALESCE(r.turno, CASE
                        WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') THEN 'Turno 01'
                        WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00'
                           OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') THEN 'Turno 02'
                        ELSE 'Fuera de turno'
                    END) AS turno,
                    u.nombre AS solicitante,
                    u.numero_id,
                    'modulo' AS seccion,
                    hm.nombre AS material,
                    dm.tipo_movimiento,
                    dm.cantidad_solicitada,
                    dm.cantidad_entregada,
                    COALESCE(dm.cantidad_retorno_aceptada, 0) AS cantidad_retorno_aceptada,
                    COALESCE(dm.cantidad_retorno_devuelta_linea, 0) AS cantidad_retorno_devuelta_linea,
                    GREATEST(COALESCE(dm.cantidad_solicitada, 0) - COALESCE(dm.cantidad_entregada, 0), 0) AS pendiente_aceptar,
                    GREATEST(COALESCE(dm.cantidad_retorno_aceptada, 0) - COALESCE(dm.cantidad_retorno_devuelta_linea, 0), 0) AS pendiente_devolver_linea,
                    ur.nombre AS recibido_por,
                    dm.retorno_recibido_en
                FROM requisiciones r
                JOIN usuarios u ON r.usuario_id = u.id
                JOIN detalle_requisicion_modulo dm ON r.id = dm.requisicion_id
                JOIN herramienta_modulo hm ON dm.herramienta_modulo_id = hm.id
                LEFT JOIN usuarios ur ON dm.retorno_recibido_por_id = ur.id
                LEFT JOIN lineas_produccion l ON r.linea_id = l.id
                WHERE r.fecha::date BETWEEN $1::date AND $2::date
                  AND LOWER(COALESCE(dm.tipo_movimiento, '')) = 'retorno'
            ) t
            ORDER BY t.fecha DESC, t.requisicion DESC, t.seccion ASC, t.material ASC
        `, [fecha_inicio, fecha_fin]);

        const worksheet = XLSX.utils.json_to_sheet(result.rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Devoluciones");

        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        res.setHeader("Content-Disposition", "attachment; filename=devoluciones.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.send(buffer);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al exportar devoluciones" });
    }
});

///////////////////////////////////////////
////////////// Empleado ///////////////////
///////////////////////////////////////////
app.post("/requisiciones", async (req, res) => {

    const { usuario_id, materiales, linea_id, tipo_origen, turno: turnoBody } = req.body;
    const origen = (tipo_origen || "ensamble").toLowerCase();
    const turno = normalizarTurno(turnoBody) || obtenerTurnoActualTijuana();
    const materialesNormalizados = [];
    const acumuladoPorMaterial = new Map();
    const acumuladoRetornoPorMaterial = new Map();
    let enTransaccion = false;

    if (!linea_id) {
        return res.status(400).json({ error: "Debe seleccionar una linea" });
    }

    if (!["ensamble", "modulo"].includes(origen)) {
        return res.status(400).json({ error: "Tipo de requisicion invalido" });
    }

    if (!Array.isArray(materiales) || materiales.length === 0) {
        return res.status(400).json({ error: "Debe agregar al menos un material" });
    }

    const esTipoRetorno = (tipoMovimiento) =>
        String(tipoMovimiento || "").trim().toLowerCase() === "retorno";

    for (const mat of materiales) {
        const materialIdNum = parseInt(mat?.material_id, 10);
        const cantidadNum = parseInt(mat?.cantidad, 10);
        const tipoMovimiento = String(mat?.tipo_movimiento || "nuevo").trim().toLowerCase();

        if (!Number.isInteger(materialIdNum) || materialIdNum <= 0) {
            return res.status(400).json({ error: "Material invalido en la requisicion" });
        }
        if (!Number.isInteger(cantidadNum) || cantidadNum <= 0) {
            return res.status(400).json({ error: "Cantidad invalida en la requisicion" });
        }
        if (!["nuevo", "cambio", "retorno"].includes(tipoMovimiento)) {
            return res.status(400).json({ error: "Tipo de movimiento invalido" });
        }

        materialesNormalizados.push({
            material_id: materialIdNum,
            cantidad: cantidadNum,
            tipo_movimiento: tipoMovimiento
        });

        if (!esTipoRetorno(tipoMovimiento)) {
            acumuladoPorMaterial.set(
                materialIdNum,
                (acumuladoPorMaterial.get(materialIdNum) || 0) + cantidadNum
            );
        } else {
            acumuladoRetornoPorMaterial.set(
                materialIdNum,
                (acumuladoRetornoPorMaterial.get(materialIdNum) || 0) + cantidadNum
            );
        }
    }

    try {

        const usuario = await pool.query(
            "SELECT rol, COALESCE(activo, TRUE) AS activo FROM usuarios WHERE id = $1",
            [usuario_id]
        );

        if (usuario.rows.length === 0 || usuario.rows[0].rol !== "empleado") {
            return res.status(403).json({ error: "Solo empleados pueden crear requisiciones" });
        }

        if (usuario.rows[0].activo === false) {
            return res.status(403).json({ error: "Usuario deshabilitado" });
        }

        const idsMaterial = [...acumuladoPorMaterial.keys()];
        if (idsMaterial.length > 0) {
            const limites = await pool.query(
                origen === "modulo"
                    ? `SELECT id, nombre, COALESCE(maximo_por_requisicion, 1) AS maximo_por_requisicion
                       FROM herramienta_modulo
                       WHERE id = ANY($1::INT[])`
                    : `SELECT id, nombre, COALESCE(maximo_por_requisicion, 1) AS maximo_por_requisicion
                       FROM materiales
                       WHERE id = ANY($1::INT[])`,
                [idsMaterial]
            );

            const limitePorMaterial = new Map(
                limites.rows.map((r) => [Number(r.id), r])
            );

            for (const materialId of idsMaterial) {
                const infoMaterial = limitePorMaterial.get(materialId);

                if (!infoMaterial) {
                    return res.status(400).json({ error: `Material no encontrado (ID ${materialId})` });
                }

                const maximoPermitido = Math.max(parseInt(infoMaterial.maximo_por_requisicion, 10) || 1, 1);
                const totalSolicitado = acumuladoPorMaterial.get(materialId) || 0;

                if (totalSolicitado > maximoPermitido) {
                    return res.status(400).json({
                        error: `El material "${infoMaterial.nombre}" permite maximo ${maximoPermitido} por requisicion. Solicitado: ${totalSolicitado}`
                    });
                }
            }
        }

        const idsRetorno = [...acumuladoRetornoPorMaterial.keys()];
        if (idsRetorno.length > 0) {
            const disponiblesRetorno = await obtenerMaterialesDisponiblesRetorno(parseInt(linea_id, 10), origen);
            const disponiblesMap = new Map(
                disponiblesRetorno.map((r) => [Number(r.material_id), r])
            );

            for (const materialId of idsRetorno) {
                const infoDisponible = disponiblesMap.get(Number(materialId));
                const solicitadoRetorno = acumuladoRetornoPorMaterial.get(materialId) || 0;
                const disponibleLinea = Math.max(
                    0,
                    parseInt(infoDisponible?.cantidad_en_linea, 10) || 0
                );
                const nombreMaterial = infoDisponible?.material || `ID ${materialId}`;

                if (!infoDisponible) {
                    return res.status(400).json({
                        error: `El material "${nombreMaterial}" no tiene existencia cargada en la linea para devolver.`
                    });
                }

                if (solicitadoRetorno > disponibleLinea) {
                    return res.status(400).json({
                        error: `No puedes devolver ${solicitadoRetorno} de "${nombreMaterial}". Disponible en linea: ${disponibleLinea}.`
                    });
                }
            }
        }

        await pool.query("BEGIN");
        enTransaccion = true;

        const nuevaReq = await pool.query(
            `INSERT INTO requisiciones (usuario_id, estado_general, linea_id, tipo_origen, turno)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [usuario_id, "aprobada", parseInt(linea_id, 10), origen, turno]
        );

        const requisicion_id = nuevaReq.rows[0].id;

        if (origen === "modulo") {
            for (const mat of materialesNormalizados) {
                await pool.query(
                    `INSERT INTO detalle_requisicion_modulo
                    (requisicion_id, herramienta_modulo_id, cantidad_solicitada, cantidad_entregada, estado, tipo_movimiento)
                    VALUES ($1, $2, $3, 0, 'pendiente', $4)`,
                    [requisicion_id, mat.material_id, mat.cantidad, mat.tipo_movimiento]
                );
            }
        } else {
            for (const mat of materialesNormalizados) {
                await pool.query(
                    `INSERT INTO detalle_requisicion
                    (requisicion_id, material_id, cantidad_solicitada, cantidad_entregada, estado, tipo_movimiento)
                    VALUES ($1, $2, $3, 0, 'pendiente', $4)`,
                    [requisicion_id, mat.material_id, mat.cantidad, mat.tipo_movimiento]
                );
            }
        }

        await pool.query("COMMIT");
        enTransaccion = false;
        res.json({ success: true });

    } catch (error) {
        if (enTransaccion) {
            await pool.query("ROLLBACK");
        }
        console.error(error);
        res.status(500).json({ error: "Error al crear requisicion" });
    }
});
// Requisiciones enviadas por empleado
app.get("/requisiciones/usuario/:usuario_id", async (req, res) => {
    const { usuario_id } = req.params;

    try {
        const result = await pool.query(
            `SELECT
                r.id,
                r.fecha,
                COALESCE(l.nombre, '-') AS linea,
                COALESCE(r.tipo_origen, 'ensamble') AS tipo_origen,
                COALESCE(r.turno, CASE
                    WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') THEN 'Turno 01'
                    WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00'
                       OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') THEN 'Turno 02'
                    ELSE 'Fuera de turno'
                END) AS turno,
                COALESCE(r.estado_general, 'pendiente') AS estado_general,
                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM detalle_requisicion d
                        WHERE d.requisicion_id = r.id
                          AND LOWER(COALESCE(d.tipo_movimiento, '')) = 'retorno'
                    ) OR EXISTS (
                        SELECT 1
                        FROM detalle_requisicion_modulo dm
                        WHERE dm.requisicion_id = r.id
                          AND LOWER(COALESCE(dm.tipo_movimiento, '')) = 'retorno'
                    ) THEN 'devolucion'
                    ELSE 'requisicion'
                END AS tipo_historial
             FROM requisiciones r
             LEFT JOIN lineas_produccion l ON r.linea_id = l.id
             WHERE r.usuario_id = $1
             ORDER BY r.id DESC`,
            [usuario_id]
        );

        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener requisiciones del usuario" });
    }
});

///////////////////////////////////////////
///////////// Supervisor //////////////////
///////////////////////////////////////////

async function obtenerMaterialesPorLinea(linea, seccion) {
    const params = [];
    let filtros = " WHERE 1=1 ";

    if (linea && linea !== "todas") {
        params.push(`%${linea}%`);
        filtros += ` AND COALESCE(t.linea, '') ILIKE $${params.length}`;
    }

    if (seccion === "ensamble" || seccion === "modulo") {
        params.push(seccion);
        filtros += ` AND LOWER(t.seccion) = $${params.length}`;
    }

    const query = `
        SELECT *
        FROM (
            SELECT
                COALESCE(l.nombre, 'Sin linea') AS linea,
                'ensamble' AS seccion,
                m.nombre AS material,
                SUM(CASE 
                    WHEN LOWER(COALESCE(d.tipo_movimiento, '')) = 'nuevo' THEN d.cantidad_entregada
                    WHEN LOWER(COALESCE(d.tipo_movimiento, '')) = 'retorno' THEN -GREATEST(COALESCE(d.cantidad_retorno_aceptada, d.cantidad_entregada, 0) - COALESCE(d.cantidad_retorno_devuelta_linea, 0), 0)
                    ELSE 0 END) AS acumulado_nuevo,
                SUM(CASE WHEN LOWER(COALESCE(d.tipo_movimiento, '')) = 'cambio' THEN d.cantidad_entregada ELSE 0 END) AS cambios_registrados
            FROM requisiciones r
            JOIN detalle_requisicion d ON r.id = d.requisicion_id
            JOIN materiales m ON d.material_id = m.id
            LEFT JOIN lineas_produccion l ON r.linea_id = l.id
            WHERE d.cantidad_entregada > 0
            GROUP BY COALESCE(l.nombre, 'Sin linea'), m.nombre

            UNION ALL

            SELECT
                COALESCE(l.nombre, 'Sin linea') AS linea,
                'modulo' AS seccion,
                hm.nombre AS material,
                SUM(CASE 
                    WHEN LOWER(COALESCE(dm.tipo_movimiento, '')) = 'nuevo' THEN dm.cantidad_entregada
                    WHEN LOWER(COALESCE(dm.tipo_movimiento, '')) = 'retorno' THEN -GREATEST(COALESCE(dm.cantidad_retorno_aceptada, dm.cantidad_entregada, 0) - COALESCE(dm.cantidad_retorno_devuelta_linea, 0), 0)
                    ELSE 0 END) AS acumulado_nuevo,
                SUM(CASE WHEN LOWER(COALESCE(dm.tipo_movimiento, '')) = 'cambio' THEN dm.cantidad_entregada ELSE 0 END) AS cambios_registrados
            FROM requisiciones r
            JOIN detalle_requisicion_modulo dm ON r.id = dm.requisicion_id
            JOIN herramienta_modulo hm ON dm.herramienta_modulo_id = hm.id
            LEFT JOIN lineas_produccion l ON r.linea_id = l.id
            WHERE dm.cantidad_entregada > 0
            GROUP BY COALESCE(l.nombre, 'Sin linea'), hm.nombre
        ) t
        ${filtros}
        ORDER BY t.linea ASC, t.seccion ASC, t.material ASC
    `;

    const result = await pool.query(query, params);
    return result.rows;
}

async function obtenerMaterialesDisponiblesRetorno(lineaId, seccion = "ensamble") {
    const seccionNorm = String(seccion || "ensamble").trim().toLowerCase();
    const lineaIdNum = parseInt(lineaId, 10);

    if (!Number.isInteger(lineaIdNum) || lineaIdNum <= 0) {
        return [];
    }

    if (seccionNorm === "modulo") {
        const queryModulo = `
            SELECT
                dm.herramienta_modulo_id AS material_id,
                hm.nombre AS material,
                SUM(CASE
                    WHEN LOWER(COALESCE(dm.tipo_movimiento, '')) IN ('nuevo', 'cambio') THEN dm.cantidad_entregada
                    WHEN LOWER(COALESCE(dm.tipo_movimiento, '')) = 'retorno' THEN -GREATEST(COALESCE(dm.cantidad_retorno_aceptada, dm.cantidad_entregada, 0) - COALESCE(dm.cantidad_retorno_devuelta_linea, 0), 0)
                    ELSE 0
                END) AS cantidad_en_linea
            FROM requisiciones r
            JOIN detalle_requisicion_modulo dm ON r.id = dm.requisicion_id
            JOIN herramienta_modulo hm ON dm.herramienta_modulo_id = hm.id
            WHERE r.linea_id = $1
              AND dm.cantidad_entregada > 0
            GROUP BY dm.herramienta_modulo_id, hm.nombre
            HAVING SUM(CASE
                WHEN LOWER(COALESCE(dm.tipo_movimiento, '')) IN ('nuevo', 'cambio') THEN dm.cantidad_entregada
                WHEN LOWER(COALESCE(dm.tipo_movimiento, '')) = 'retorno' THEN -GREATEST(COALESCE(dm.cantidad_retorno_aceptada, dm.cantidad_entregada, 0) - COALESCE(dm.cantidad_retorno_devuelta_linea, 0), 0)
                ELSE 0
            END) > 0
            ORDER BY hm.nombre ASC
        `;

        const resultModulo = await pool.query(queryModulo, [lineaIdNum]);
        return resultModulo.rows;
    }

    const queryEnsamble = `
        SELECT
            d.material_id,
            m.nombre AS material,
            SUM(CASE
                WHEN LOWER(COALESCE(d.tipo_movimiento, '')) IN ('nuevo', 'cambio') THEN d.cantidad_entregada
                WHEN LOWER(COALESCE(d.tipo_movimiento, '')) = 'retorno' THEN -GREATEST(COALESCE(d.cantidad_retorno_aceptada, d.cantidad_entregada, 0) - COALESCE(d.cantidad_retorno_devuelta_linea, 0), 0)
                ELSE 0
            END) AS cantidad_en_linea
        FROM requisiciones r
        JOIN detalle_requisicion d ON r.id = d.requisicion_id
        JOIN materiales m ON d.material_id = m.id
        WHERE r.linea_id = $1
          AND d.cantidad_entregada > 0
          AND LOWER(COALESCE(m.tipo, '')) IN ('consumible', 'herramienta')
        GROUP BY d.material_id, m.nombre
        HAVING SUM(CASE
            WHEN LOWER(COALESCE(d.tipo_movimiento, '')) IN ('nuevo', 'cambio') THEN d.cantidad_entregada
            WHEN LOWER(COALESCE(d.tipo_movimiento, '')) = 'retorno' THEN -GREATEST(COALESCE(d.cantidad_retorno_aceptada, d.cantidad_entregada, 0) - COALESCE(d.cantidad_retorno_devuelta_linea, 0), 0)
            ELSE 0
        END) > 0
        ORDER BY m.nombre ASC
    `;

    const resultEnsamble = await pool.query(queryEnsamble, [lineaIdNum]);
    return resultEnsamble.rows;
}
app.get("/materiales-por-linea", async (req, res) => {
    const linea = (req.query.linea || "").trim();
    const seccion = (req.query.seccion || "todas").trim().toLowerCase();

    try {
        const rows = await obtenerMaterialesPorLinea(linea, seccion);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener material por linea" });
    }
});

app.get("/materiales-retorno-por-linea", async (req, res) => {
    const lineaId = parseInt(req.query.linea_id, 10);
    const seccion = (req.query.seccion || "ensamble").trim().toLowerCase();

    if (!Number.isInteger(lineaId) || lineaId <= 0) {
        return res.status(400).json({ error: "Linea invalida" });
    }

    if (!["ensamble", "modulo"].includes(seccion)) {
        return res.status(400).json({ error: "Seccion invalida" });
    }

    try {
        const rows = await obtenerMaterialesDisponiblesRetorno(lineaId, seccion);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener materiales para devolucion" });
    }
});

app.get("/exportar-materiales-por-linea", async (req, res) => {
    const linea = (req.query.linea || "").trim();
    const seccion = (req.query.seccion || "todas").trim().toLowerCase();

    try {
        const rows = await obtenerMaterialesPorLinea(linea, seccion);

        const datos = rows.map((r) => ({
            Linea: r.linea,
            Seccion: r.seccion,
            Material: r.material,
            "Acumulado (Nuevo)": Number(r.acumulado_nuevo || 0),
            "Cantidad en Cambio": Number(r.cambios_registrados || 0)
        }));

        const worksheet = XLSX.utils.json_to_sheet(datos);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "MaterialPorLinea");

        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        res.setHeader(
            "Content-Disposition",
            `attachment; filename=material_por_linea_${Date.now()}.xlsx`
        );
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.send(buffer);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al exportar material por linea" });
    }
});
////////Ver consumibles - PestaÃ±a///////////
// Muestra las requisiciones
app.get("/requisiciones-detalle", async (req, res) => {

    const { tipo, cerradas, origen, movimiento, incluir_todas, incluir_rechazadas } = req.query;
    const origenReq = (origen || "ensamble").toLowerCase();
    const movimientoReq = (movimiento || "").toLowerCase();
    const incluirTodas = incluir_todas === "true";
    const incluirRechazadas = incluir_rechazadas === "true";

    try {

        let filtroEstado;

        if (incluirTodas) {
            filtroEstado = incluirRechazadas
                ? "COALESCE(r.estado_general, '') <> 'cancelada'"
                : "COALESCE(r.estado_general, '') NOT IN ('rechazada','cancelada')";
        } else if (cerradas === "true") {
            filtroEstado = incluirRechazadas
                ? "COALESCE(r.estado_general, '') IN ('completa','rechazada')"
                : "r.estado_general = 'completa'";
        } else {
            filtroEstado = "COALESCE(r.estado_general, '') NOT IN ('completa','rechazada','cancelada','pendiente_admin')";
        }

        let filtroMovimiento = "";
        if (movimientoReq === "retorno") {
            filtroMovimiento = "AND LOWER(COALESCE(d.tipo_movimiento, '')) = 'retorno'";
        } else if (movimientoReq === "sin_retorno") {
            filtroMovimiento = "AND LOWER(COALESCE(d.tipo_movimiento, '')) <> 'retorno'";
        }

        if (origenReq === "modulo") {
            const queryModulo = "SELECT r.id AS requisicion_id, r.estado_general, r.fecha, " +
                "COALESCE(r.turno, CASE WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') " +
                "THEN 'Turno 01' WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00' OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') " +
                "THEN 'Turno 02' ELSE 'Fuera de turno' END) AS turno, l.nombre AS linea_nombre, " +
                "u.nombre, u.numero_id, u.rol AS rol_solicitante, d.id AS detalle_id, hm.nombre AS material, 'modulo' AS tipo, " +
                "d.cantidad_solicitada, d.cantidad_entregada, d.estado, d.tipo_movimiento, d.aprobado_supervisor, " +
                "COALESCE(d.cantidad_retorno_aceptada, 0) AS cantidad_retorno_aceptada, " +
                "COALESCE(d.cantidad_retorno_devuelta_linea, 0) AS cantidad_retorno_devuelta_linea, " +
                "d.retorno_recibido_por_id, d.retorno_recibido_en, ur.nombre AS recibido_por, ur.rol AS rol_recibido_por " +
                "FROM requisiciones r " +
                "JOIN usuarios u ON r.usuario_id = u.id " +
                "JOIN detalle_requisicion_modulo d ON r.id = d.requisicion_id " +
                "JOIN herramienta_modulo hm ON d.herramienta_modulo_id = hm.id " +
                "LEFT JOIN usuarios ur ON d.retorno_recibido_por_id = ur.id " +
                "LEFT JOIN lineas_produccion l ON r.linea_id = l.id " +
                "WHERE " + filtroEstado + " AND COALESCE(r.tipo_origen, 'ensamble') = 'modulo' " +
                filtroMovimiento + " ORDER BY r.id DESC";

            const result = await pool.query(queryModulo);
            return res.json(result.rows);
        }

        let filtroTipo = "";

        if (tipo === "consumible") {
            filtroTipo = "AND LOWER(COALESCE(m.tipo, '')) = 'consumible'";
        } else if (tipo === "herramienta") {
            filtroTipo = "AND LOWER(COALESCE(m.tipo, '')) = 'herramienta'";
        } else if (tipo === "equipo") {
            filtroTipo = "AND LOWER(COALESCE(m.tipo, '')) = 'equipo'";
        }

        const query = "SELECT r.id AS requisicion_id, r.estado_general, r.fecha, " +
            "COALESCE(r.turno, CASE WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') " +
            "THEN 'Turno 01' WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00' OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') " +
            "THEN 'Turno 02' ELSE 'Fuera de turno' END) AS turno, l.nombre AS linea_nombre, " +
            "u.nombre, u.numero_id, u.rol AS rol_solicitante, d.id AS detalle_id, m.nombre AS material, m.tipo, " +
            "d.cantidad_solicitada, d.cantidad_entregada, d.estado, d.tipo_movimiento, d.aprobado_supervisor, " +
            "COALESCE(d.cantidad_retorno_aceptada, 0) AS cantidad_retorno_aceptada, " +
            "COALESCE(d.cantidad_retorno_devuelta_linea, 0) AS cantidad_retorno_devuelta_linea, " +
            "d.retorno_recibido_por_id, d.retorno_recibido_en, ur.nombre AS recibido_por, ur.rol AS rol_recibido_por " +
            "FROM requisiciones r " +
            "JOIN usuarios u ON r.usuario_id = u.id " +
            "JOIN detalle_requisicion d ON r.id = d.requisicion_id " +
            "JOIN materiales m ON d.material_id = m.id " +
            "LEFT JOIN usuarios ur ON d.retorno_recibido_por_id = ur.id " +
            "LEFT JOIN lineas_produccion l ON r.linea_id = l.id " +
            "WHERE " + filtroEstado + " AND COALESCE(r.tipo_origen, 'ensamble') = 'ensamble' " +
            filtroTipo + " " + filtroMovimiento + " ORDER BY r.id DESC";

        const result = await pool.query(query);
        res.json(result.rows);

    } catch (error) {
        console.error("Error en /requisiciones-detalle:", error);
        res.status(500).json({ error: "Error al obtener requisiciones" });
    }
});

//Funcion entregar material
app.post("/entregar-material", async (req, res) => {

    const { detalle_id, cantidad_entregada, detalle_tipo, accion_retorno, usuario_recibe_id } = req.body;
    const tipoDetalle = (detalle_tipo || "ensamble").toLowerCase();
    const accionRetorno = String(accion_retorno || "").trim().toLowerCase();
    const usuarioRecibeId = parseInt(usuario_recibe_id, 10);

    try {

        const cantidad = parseInt(cantidad_entregada, 10);

        if (!cantidad || cantidad <= 0) {
            return res.status(400).json({ error: "Cantidad invalida" });
        }

        await pool.query("BEGIN");

        let detalleResult;
        if (tipoDetalle === "modulo") {
            detalleResult = await pool.query(
                "SELECT d.*, hm.cantidad AS cantidad_stock FROM detalle_requisicion_modulo d " +
                "JOIN herramienta_modulo hm ON d.herramienta_modulo_id = hm.id WHERE d.id = $1",
                [detalle_id]
            );
        } else {
            detalleResult = await pool.query(
                "SELECT d.*, m.cantidad_stock FROM detalle_requisicion d " +
                "JOIN materiales m ON d.material_id = m.id WHERE d.id = $1",
                [detalle_id]
            );
        }

        if (detalleResult.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Detalle no encontrado" });
        }

        const det = detalleResult.rows[0];
        const reqEstadoResult = await pool.query(
            "SELECT COALESCE(estado_general, '') AS estado_general FROM requisiciones WHERE id = $1",
            [det.requisicion_id]
        );
        if (reqEstadoResult.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Requisicion no encontrada" });
        }
        const estadoReq = String(reqEstadoResult.rows[0].estado_general || "").toLowerCase();
        if (["rechazada", "cancelada"].includes(estadoReq)) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "La devolucion fue rechazada y ya no puede procesarse" });
        }
        if (estadoReq === "pendiente_admin") {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Esta requisicion requiere aprobacion del administrador antes de entregar material" });
        }

        const tipoMovimiento = (det.tipo_movimiento || "nuevo").toLowerCase();
        const estadoDetalleActual = String(det.estado || "").toLowerCase();
        if (estadoDetalleActual === "rechazada") {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Este material fue rechazado y ya no puede entregarse" });
        }
        if (tipoMovimiento === "nuevo" && det.aprobado_supervisor !== true) {
            await pool.query("ROLLBACK");
            return res.status(400).json({
                error: "Este material tipo nuevo debe ser aprobado por supervisor antes de entregarse"
            });
        }
        const nuevoEntregado = parseInt(det.cantidad_entregada, 10) + cantidad;

        if (nuevoEntregado > det.cantidad_solicitada) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Excede lo solicitado" });
        }

        if (tipoMovimiento !== "retorno" && cantidad > parseInt(det.cantidad_stock, 10)) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Stock insuficiente" });
        }

        if (tipoMovimiento === "retorno") {
            if (accionRetorno !== "aceptar") {
                await pool.query("ROLLBACK");
                return res.status(400).json({ error: "Accion de retorno invalida" });
            }

            if (!Number.isInteger(usuarioRecibeId) || usuarioRecibeId <= 0) {
                await pool.query("ROLLBACK");
                return res.status(400).json({ error: "Usuario que recibe invalido" });
            }

            const usuarioRecibe = await pool.query(
                "SELECT id FROM usuarios WHERE id = $1",
                [usuarioRecibeId]
            );
            if (usuarioRecibe.rows.length === 0) {
                await pool.query("ROLLBACK");
                return res.status(404).json({ error: "Usuario que recibe no encontrado" });
            }
        }

        let nuevoEstadoDetalle = "pendiente";
        if (nuevoEntregado < det.cantidad_solicitada) {
            nuevoEstadoDetalle = "parcial";
        } else if (nuevoEntregado === det.cantidad_solicitada) {
            nuevoEstadoDetalle = "completa";
        }

        if (tipoDetalle === "modulo") {
            if (tipoMovimiento === "retorno") {
                await pool.query(
                    `UPDATE detalle_requisicion_modulo
                     SET cantidad_entregada = $1,
                         estado = $2,
                         cantidad_retorno_aceptada = COALESCE(cantidad_retorno_aceptada, 0) + $4,
                         retorno_recibido_por_id = $5,
                         retorno_recibido_en = CURRENT_TIMESTAMP
                     WHERE id = $3`,
                    [nuevoEntregado, nuevoEstadoDetalle, detalle_id, cantidad, usuarioRecibeId]
                );

                await pool.query(
                    "UPDATE herramienta_modulo SET cantidad = cantidad + $1 WHERE id = $2",
                    [cantidad, det.herramienta_modulo_id]
                );
            } else {
                await pool.query(
                    "UPDATE detalle_requisicion_modulo SET cantidad_entregada = $1, estado = $2 WHERE id = $3",
                    [nuevoEntregado, nuevoEstadoDetalle, detalle_id]
                );

                await pool.query(
                    "UPDATE herramienta_modulo SET cantidad = cantidad - $1 WHERE id = $2",
                    [cantidad, det.herramienta_modulo_id]
                );
            }
        } else {
            if (tipoMovimiento === "retorno") {
                await pool.query(
                    `UPDATE detalle_requisicion
                     SET cantidad_entregada = $1,
                         estado = $2,
                         cantidad_retorno_aceptada = COALESCE(cantidad_retorno_aceptada, 0) + $4,
                         retorno_recibido_por_id = $5,
                         retorno_recibido_en = CURRENT_TIMESTAMP
                     WHERE id = $3`,
                    [nuevoEntregado, nuevoEstadoDetalle, detalle_id, cantidad, usuarioRecibeId]
                );

                await pool.query(
                    "UPDATE materiales SET cantidad_stock = cantidad_stock + $1 WHERE id = $2",
                    [cantidad, det.material_id]
                );
            } else {
                await pool.query(
                    "UPDATE detalle_requisicion SET cantidad_entregada = $1, estado = $2 WHERE id = $3",
                    [nuevoEntregado, nuevoEstadoDetalle, detalle_id]
                );

                await pool.query(
                    "UPDATE materiales SET cantidad_stock = cantidad_stock - $1 WHERE id = $2",
                    [cantidad, det.material_id]
                );
            }
        }

        const requisicion_id = det.requisicion_id;

        let check;
        if (tipoDetalle === "modulo") {
            check = await pool.query(
                "SELECT COUNT(*) FILTER (WHERE COALESCE(estado, '') NOT IN ('completa','rechazada')) AS pendientes FROM detalle_requisicion_modulo WHERE requisicion_id = $1",
                [requisicion_id]
            );
        } else {
            check = await pool.query(
                "SELECT COUNT(*) FILTER (WHERE COALESCE(estado, '') NOT IN ('completa','rechazada')) AS pendientes FROM detalle_requisicion WHERE requisicion_id = $1",
                [requisicion_id]
            );
        }

        let nuevoEstadoGeneral = "parcial";
        if (parseInt(check.rows[0].pendientes, 10) === 0) {
            nuevoEstadoGeneral = "completa";
        }

        await pool.query(
            "UPDATE requisiciones SET estado_general = $1 WHERE id = $2",
            [nuevoEstadoGeneral, requisicion_id]
        );

        await pool.query("COMMIT");
        res.json({ success: true });

    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al entregar material" });
    }
});

app.post("/retornos-material/devolver-linea", async (req, res) => {
    const { detalle_id, cantidad_devolver, detalle_tipo, usuario_recibe_id } = req.body;
    const tipoDetalle = (detalle_tipo || "ensamble").toLowerCase();
    const usuarioRecibeId = parseInt(usuario_recibe_id, 10);
    const cantidad = parseInt(cantidad_devolver, 10);

    try {
        if (!cantidad || cantidad <= 0) {
            return res.status(400).json({ error: "Cantidad invalida" });
        }

        if (!Number.isInteger(usuarioRecibeId) || usuarioRecibeId <= 0) {
            return res.status(400).json({ error: "Usuario que recibe invalido" });
        }

        await pool.query("BEGIN");

        let detalleResult;
        if (tipoDetalle === "modulo") {
            detalleResult = await pool.query(
                "SELECT d.*, hm.cantidad AS cantidad_stock FROM detalle_requisicion_modulo d " +
                "JOIN herramienta_modulo hm ON d.herramienta_modulo_id = hm.id " +
                "WHERE d.id = $1 FOR UPDATE OF d, hm",
                [detalle_id]
            );
        } else {
            detalleResult = await pool.query(
                "SELECT d.*, m.cantidad_stock FROM detalle_requisicion d " +
                "JOIN materiales m ON d.material_id = m.id " +
                "WHERE d.id = $1 FOR UPDATE OF d, m",
                [detalle_id]
            );
        }

        if (detalleResult.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Detalle no encontrado" });
        }

        const usuarioRecibe = await pool.query(
            "SELECT id FROM usuarios WHERE id = $1",
            [usuarioRecibeId]
        );
        if (usuarioRecibe.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Usuario que recibe no encontrado" });
        }

        const det = detalleResult.rows[0];
        const reqEstadoResult = await pool.query(
            "SELECT COALESCE(estado_general, '') AS estado_general FROM requisiciones WHERE id = $1",
            [det.requisicion_id]
        );
        if (reqEstadoResult.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Requisicion no encontrada" });
        }
        const estadoReq = String(reqEstadoResult.rows[0].estado_general || "").toLowerCase();
        if (["rechazada", "cancelada"].includes(estadoReq)) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "La devolucion fue rechazada y ya no puede procesarse" });
        }

        const tipoMovimiento = (det.tipo_movimiento || "nuevo").toLowerCase();
        const stockActual = parseInt(det.cantidad_stock, 10) || 0;
        const aceptado = parseInt(det.cantidad_retorno_aceptada, 10) || 0;
        const devueltoLinea = parseInt(det.cantidad_retorno_devuelta_linea, 10) || 0;
        const pendienteDevolverLinea = Math.max(0, aceptado - devueltoLinea);

        if (tipoMovimiento !== "retorno") {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Solo aplica para requisiciones de retorno" });
        }

        if (cantidad > pendienteDevolverLinea) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Excede lo aceptado pendiente de devolver a linea" });
        }

        if (cantidad > stockActual) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Stock insuficiente para devolver a linea" });
        }

        if (tipoDetalle === "modulo") {
            await pool.query(
                `UPDATE detalle_requisicion_modulo
                 SET cantidad_retorno_devuelta_linea = COALESCE(cantidad_retorno_devuelta_linea, 0) + $2
                 WHERE id = $1`,
                [detalle_id, cantidad]
            );

            await pool.query(
                "UPDATE herramienta_modulo SET cantidad = cantidad - $1 WHERE id = $2",
                [cantidad, det.herramienta_modulo_id]
            );
        } else {
            await pool.query(
                `UPDATE detalle_requisicion
                 SET cantidad_retorno_devuelta_linea = COALESCE(cantidad_retorno_devuelta_linea, 0) + $2
                 WHERE id = $1`,
                [detalle_id, cantidad]
            );

            await pool.query(
                "UPDATE materiales SET cantidad_stock = cantidad_stock - $1 WHERE id = $2",
                [cantidad, det.material_id]
            );
        }

        await pool.query("COMMIT");
        res.json({ success: true });
    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al devolver material a linea" });
    }
});

app.put("/retornos-material/requisiciones/:id/rechazar", async (req, res) => {
    const { id } = req.params;
    const tipoDetalle = String(req.body?.detalle_tipo || "ensamble").trim().toLowerCase();

    if (!["ensamble", "modulo"].includes(tipoDetalle)) {
        return res.status(400).json({ error: "Tipo de detalle invalido" });
    }

    try {
        await pool.query("BEGIN");

        const reqResult = await pool.query(
            `SELECT id, COALESCE(tipo_origen, 'ensamble') AS tipo_origen, COALESCE(estado_general, '') AS estado_general
             FROM requisiciones
             WHERE id = $1
             FOR UPDATE`,
            [id]
        );

        if (reqResult.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Requisicion no encontrada" });
        }

        const reqInfo = reqResult.rows[0];
        if (String(reqInfo.tipo_origen).toLowerCase() !== tipoDetalle) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "La devolucion no corresponde a esa seccion" });
        }

        if (["rechazada", "cancelada"].includes(String(reqInfo.estado_general).toLowerCase())) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "La devolucion ya esta cerrada" });
        }

        let retornoExiste;
        if (tipoDetalle === "modulo") {
            retornoExiste = await pool.query(
                `SELECT 1
                 FROM detalle_requisicion_modulo
                 WHERE requisicion_id = $1
                   AND LOWER(COALESCE(tipo_movimiento, '')) = 'retorno'
                 LIMIT 1`,
                [id]
            );
        } else {
            retornoExiste = await pool.query(
                `SELECT 1
                 FROM detalle_requisicion
                 WHERE requisicion_id = $1
                   AND LOWER(COALESCE(tipo_movimiento, '')) = 'retorno'
                 LIMIT 1`,
                [id]
            );
        }

        if (retornoExiste.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "La requisicion no es de devolucion" });
        }

        await pool.query(
            "UPDATE requisiciones SET estado_general = 'rechazada' WHERE id = $1",
            [id]
        );

        await pool.query("COMMIT");
        res.json({ success: true });
    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al rechazar devolucion" });
    }
});
// Supervisor rechaza (cancela) requisicion de consumibles/modulo
app.put("/requisiciones/:id/rechazar", async (req, res) => {
    const { id } = req.params;

    try {
        const reqInfo = await pool.query(
            "SELECT id, COALESCE(tipo_origen, 'ensamble') AS tipo_origen, COALESCE(estado_general, '') AS estado_general FROM requisiciones WHERE id = $1",
            [id]
        );
        if (reqInfo.rows.length === 0) {
            return res.status(404).json({ error: "Requisicion no encontrada" });
        }

        const estadoActual = String(reqInfo.rows[0].estado_general || "").toLowerCase();
        if (["completa", "rechazada", "cancelada"].includes(estadoActual)) {
            return res.status(400).json({ error: "La requisicion ya esta cerrada o cancelada" });
        }

        const esModulo = String(reqInfo.rows[0].tipo_origen || "").toLowerCase() === "modulo";
        const pendientesNuevo = esModulo
            ? await pool.query(
                `SELECT COUNT(*)::INT AS total
                 FROM detalle_requisicion_modulo
                 WHERE requisicion_id = $1
                   AND LOWER(COALESCE(tipo_movimiento, '')) = 'nuevo'
                   AND COALESCE(estado, '') <> 'rechazada'
                   AND COALESCE(aprobado_supervisor, FALSE) = FALSE`,
                [id]
            )
            : await pool.query(
                `SELECT COUNT(*)::INT AS total
                 FROM detalle_requisicion
                 WHERE requisicion_id = $1
                   AND LOWER(COALESCE(tipo_movimiento, '')) = 'nuevo'
                   AND COALESCE(estado, '') <> 'rechazada'
                   AND COALESCE(aprobado_supervisor, FALSE) = FALSE`,
                [id]
            );

        if (parseInt(pendientesNuevo.rows[0]?.total, 10) > 0) {
            return res.status(400).json({
                error: "No puedes rechazar la requisicion mientras existan materiales tipo nuevo sin aprobar o rechazar"
            });
        }

        const result = await pool.query(
            `UPDATE requisiciones
             SET estado_general = 'rechazada'
             WHERE id = $1
              AND COALESCE(estado_general, '') NOT IN ('completa','rechazada','cancelada')
             RETURNING id`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: "La requisicion ya esta cerrada o cancelada" });
        }

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al rechazar requisicion" });
    }
});
////////Ver equipos - PestaÃ±a///////////
// Ver solicitudes aprobadas
app.get("/asignaciones/aprobadas", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                a.id,
                u.nombre AS tecnico,
                e.nombre AS equipo,
                l.nombre AS linea,
                a.fecha_aprobacion
            FROM asignaciones_equipos a
            LEFT JOIN usuarios u ON a.usuario_id = u.id
            LEFT JOIN equipos_individuales e ON a.equipo_id = e.id
            LEFT JOIN lineas_produccion l ON a.linea_id = l.id
            WHERE a.estado = 'aprobado'
            ORDER BY a.fecha_aprobacion DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error("ERROR APROBADAS:", error);
        res.status(500).json({ error: "Error al obtener aprobadas" });
    }
});
// Ver equipos actualmente asignados a tecnicos
app.get("/asignaciones/tecnicos-asignados", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                a.id,
                u.nombre AS tecnico,
                e.nombre AS equipo,
                e.numero_serie,
                l.nombre AS linea,
                a.estado,
                a.fecha_entrega,
                a.fecha_solicitud
            FROM asignaciones_equipos a
            LEFT JOIN usuarios u ON a.usuario_id = u.id
            LEFT JOIN equipos_individuales e ON a.equipo_id = e.id
            LEFT JOIN lineas_produccion l ON a.linea_id = l.id
            WHERE a.estado IN ('entregado', 'pendiente_devolucion')
            ORDER BY COALESCE(a.fecha_entrega, a.fecha_solicitud) DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error("ERROR TECNICOS ASIGNADOS:", error);
        res.status(500).json({ error: "Error al obtener equipos asignados" });
    }
});

// Ver estatus completo del flujo de requisiciones de equipo
app.get("/asignaciones/estatus", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                a.id,
                u.nombre AS tecnico,
                e.nombre AS equipo,
                l.nombre AS linea,
                a.estado,
                a.fecha_solicitud,
                a.fecha_aprobacion,
                a.fecha_entrega,
                a.fecha_devolucion
            FROM asignaciones_equipos a
            LEFT JOIN usuarios u ON a.usuario_id = u.id
            LEFT JOIN equipos_individuales e ON a.equipo_id = e.id
            LEFT JOIN lineas_produccion l ON a.linea_id = l.id
            ORDER BY a.id DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error("ERROR ESTATUS ASIGNACIONES:", error);
        res.status(500).json({ error: "Error al obtener estatus de asignaciones" });
    }
});
// Aprobadar entrega de equipos
app.put("/asignaciones/:id/entregar", async (req, res) => {
    const { id } = req.params;

    try {
        await pool.query("BEGIN");

        const asignacion = await pool.query(
            `SELECT id, equipo_id, estado
             FROM asignaciones_equipos
             WHERE id = $1
             FOR UPDATE`,
            [id]
        );

        if (asignacion.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "No se encontro asignacion" });
        }

        const a = asignacion.rows[0];

        if (a.estado !== "aprobado") {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "Solo se puede entregar una asignacion aprobada" });
        }

        const equipo = await pool.query(
            `SELECT id, estado
             FROM equipos_individuales
             WHERE id = $1
             FOR UPDATE`,
            [a.equipo_id]
        );

        if (equipo.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Equipo no encontrado" });
        }

        if (equipo.rows[0].estado !== "disponible") {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "El equipo ya no esta disponible" });
        }

        const conflictoEntregado = await pool.query(
            `SELECT id
             FROM asignaciones_equipos
             WHERE equipo_id = $1
               AND id <> $2
               AND estado IN ('entregado','pendiente_devolucion')
             LIMIT 1`,
            [a.equipo_id, id]
        );

        if (conflictoEntregado.rows.length > 0) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "El equipo ya esta asignado a otro tecnico" });
        }

        await pool.query(
            `UPDATE asignaciones_equipos
             SET estado = 'entregado',
                 fecha_entrega = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id]
        );

        await pool.query(
            `UPDATE equipos_individuales
             SET estado = 'en_uso'
             WHERE id = $1`,
            [a.equipo_id]
        );

        await pool.query(
            `UPDATE asignaciones_equipos
             SET estado = 'rechazado'
             WHERE equipo_id = $1
               AND id <> $2
               AND estado IN ('pendiente','aprobado')`,
            [a.equipo_id, id]
        );

        await pool.query("COMMIT");
        res.json({ success: true });

    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al entregar equipo" });
    }
});
////////Ver cerradas - PestaÃ±a///////////
// Obtener requisiciones cerradas
app.get("/requisiciones-cerradas", async (req, res) => {
    const origenReq = (req.query.origen || "ensamble").toLowerCase();
    const fechaInicio = (req.query.fecha_inicio || "").trim();
    const fechaFin = (req.query.fecha_fin || "").trim();

    try {
        const params = [];
        let filtrosFecha = "";

        if (fechaInicio) {
            params.push(fechaInicio);
            filtrosFecha += ` AND r.fecha::date >= $${params.length}`;
        }

        if (fechaFin) {
            params.push(fechaFin);
            filtrosFecha += ` AND r.fecha::date <= $${params.length}`;
        }

        if (origenReq === "modulo") {
            const queryModulo = `
               SELECT
                   r.id AS requisicion_id,
                   r.estado_general,
                   r.fecha,
                   COALESCE(r.turno, CASE
                       WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') THEN 'Turno 01'
                       WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00'
                          OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') THEN 'Turno 02'
                       ELSE 'Fuera de turno'
                   END) AS turno,
                   l.nombre AS linea_nombre,
                   u.nombre,
                   u.numero_id,
                   d.id AS detalle_id,
                   hm.nombre AS material,
                   d.cantidad_solicitada,
                   d.cantidad_entregada
               FROM requisiciones r
               JOIN usuarios u ON r.usuario_id = u.id
               JOIN detalle_requisicion_modulo d ON r.id = d.requisicion_id
               JOIN herramienta_modulo hm ON d.herramienta_modulo_id = hm.id
               LEFT JOIN lineas_produccion l ON r.linea_id = l.id
               WHERE r.estado_general = 'completa'
                 AND COALESCE(r.tipo_origen, 'ensamble') = 'modulo'
                 ${filtrosFecha}
               ORDER BY r.id DESC
            `;

            const resultModulo = await pool.query(queryModulo, params);
            return res.json(resultModulo.rows);
        }

        const query = `
           SELECT
               r.id AS requisicion_id,
               r.estado_general,
               r.fecha,
               COALESCE(r.turno, CASE
                   WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time BETWEEN TIME '06:24:00' AND TIME '16:29:59') THEN 'Turno 01'
                   WHEN ((r.fecha AT TIME ZONE 'America/Tijuana')::time >= TIME '16:30:00'
                      OR (r.fecha AT TIME ZONE 'America/Tijuana')::time <= TIME '01:00:00') THEN 'Turno 02'
                   ELSE 'Fuera de turno'
               END) AS turno,
               l.nombre AS linea_nombre,
               u.nombre,
               u.numero_id,
               d.id AS detalle_id,
               m.nombre AS material,
               d.cantidad_solicitada,
               d.cantidad_entregada
           FROM requisiciones r
           JOIN usuarios u ON r.usuario_id = u.id
           JOIN detalle_requisicion d ON r.id = d.requisicion_id
           JOIN materiales m ON d.material_id = m.id
           LEFT JOIN lineas_produccion l ON r.linea_id = l.id
           WHERE r.estado_general = 'completa'
             AND COALESCE(r.tipo_origen, 'ensamble') = 'ensamble'
             ${filtrosFecha}
           ORDER BY r.id DESC
        `;

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al obtener requisiciones cerradas" });
    }
});

///////////////////////////////////////////
////// Equipos para tecnivos flujo ////////
///////////////////////////////////////////
// Verificar si tecnico tiene equipo activo
app.get("/asignaciones/activo/:usuario_id", async (req,res)=>{
    const { usuario_id } = req.params;

    try{
        const result = await pool.query(`
            SELECT 
                a.id,
                e.nombre AS equipo,
                e.numero_serie,
                l.nombre AS linea,
                a.estado
            FROM asignaciones_equipos a
            LEFT JOIN equipos_individuales e ON a.equipo_id = e.id
            LEFT JOIN lineas_produccion l ON a.linea_id = l.id
            WHERE usuario_id = $1
            AND a.estado IN ('pendiente','aprobado','entregado','pendiente_devolucion')
            ORDER BY a.id DESC
        `,[usuario_id]);

        res.json(result.rows);

    }catch(error){
        console.error(error);
        res.status(500).json({error:"Error al verificar equipo activo"});
    }
});
// Ver equipos asignados a un tecnico
app.get("/asignaciones/usuario/:id", async (req, res) => {
    const { id } = req.params;

    try {

        const result = await pool.query(`
            SELECT 
                a.id,
                e.nombre AS equipo,
                e.numero_serie,
                l.nombre AS linea,
                a.estado
            FROM asignaciones_equipos a
            JOIN equipos_individuales e ON a.equipo_id = e.id
            JOIN lineas_produccion l ON a.linea_id = l.id
            WHERE a.usuario_id = $1
            AND a.estado = 'aprobado',
            ORDER BY a.fecha_entrega DESC
        `, [id]);

        res.json(result.rows);

    } catch (error) {
        console.error("ERROR EN ASIGNACIONES USUARIO:", error);
        res.status(500).json({ error: "Error al obtener asignaciones" });
    }
});
// Ver equipos disponibles en la barra
app.get("/equipos-disponibles", async (req,res)=>{
    try{
        const result = await pool.query(`
            SELECT id,
                   nombre,
                   descripcion,
                   numero_serie,
                   numero_activo,
                   ubicacion
            FROM equipos_individuales
            WHERE estado = 'disponible'
            ORDER BY id DESC
        `);

        res.json(result.rows);

    }catch(error){
        console.error(error);
        res.status(500).json({error:"Error al obtener equipos disponibles"});
    }
});
// Tecnico solicita equipo
app.post("/asignaciones/solicitar", async (req, res) => {
    const { usuario_id, equipo_id, linea_id } = req.body;

    try {
        await pool.query("BEGIN");

        const estadoUsuario = await pool.query(
            "SELECT COALESCE(activo, TRUE) AS activo FROM usuarios WHERE id = $1",
            [usuario_id]
        );

        if (estadoUsuario.rows.length === 0 || estadoUsuario.rows[0].activo === false) {
            await pool.query("ROLLBACK");
            return res.status(403).json({ error: "Usuario deshabilitado" });
        }

        const existeUsuario = await pool.query(
            `SELECT id
             FROM asignaciones_equipos
             WHERE usuario_id = $1
               AND estado IN ('pendiente','aprobado','entregado','pendiente_devolucion')
             LIMIT 1`,
            [usuario_id]
        );

        if (existeUsuario.rows.length > 0) {
            await pool.query("ROLLBACK");
            return res.status(400).json({
                error: "Ya tienes una solicitud o equipo activo."
            });
        }

        const equipo = await pool.query(
            `SELECT id, estado
             FROM equipos_individuales
             WHERE id = $1
             FOR UPDATE`,
            [equipo_id]
        );

        if (equipo.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Equipo no encontrado" });
        }

        if (equipo.rows[0].estado !== "disponible") {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "El equipo no esta disponible" });
        }

        const existeEquipo = await pool.query(
            `SELECT id
             FROM asignaciones_equipos
             WHERE equipo_id = $1
               AND estado IN ('pendiente','aprobado','entregado','pendiente_devolucion')
             LIMIT 1`,
            [equipo_id]
        );

        if (existeEquipo.rows.length > 0) {
            await pool.query("ROLLBACK");
            return res.status(400).json({ error: "El equipo ya fue solicitado por otro tecnico" });
        }

        await pool.query(
            `INSERT INTO asignaciones_equipos
             (usuario_id, equipo_id, linea_id, estado, fecha_solicitud)
             VALUES ($1,$2,$3,'pendiente',CURRENT_TIMESTAMP)`,
            [usuario_id, equipo_id, linea_id]
        );

        await pool.query("COMMIT");
        res.json({ success:true });

    } catch (error) {
        await pool.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ error: "Error al solicitar equipo" });
    }
});

//Tecnico devuelve el equipo
app.put("/asignaciones/:id/solicitar-devolucion", async (req, res) => {
    const { id } = req.params;

    try {

        const asignacion = await pool.query(`
            SELECT estado
            FROM asignaciones_equipos
            WHERE id = $1
        `,[id]);

        if (asignacion.rows.length === 0) {
            return res.status(404).json({ error: "AsignaciÃ³n no encontrada" });
        }

        if (asignacion.rows[0].estado !== 'entregado') {
            return res.status(400).json({
                error: "Ya existe una devoluciÃ³n pendiente o no estÃ¡ entregado"
            });
        }

        await pool.query(`
            UPDATE asignaciones_equipos
            SET estado = 'pendiente_devolucion'
            WHERE id = $1
        `,[id]);

        res.json({ success:true });

    } catch(error){
        console.error(error);
        res.status(500).json({error:"Error al solicitar devoluciÃ³n"});
    }
});

///////////////////////////////////////////
Promise.all([
    asegurarIntegridadAsignaciones(),
    asegurarEstructuraRequisiciones(),
    asegurarEstructuraRetornosMaterial(),
    asegurarEstadoUsuarios(),
    asegurarNumeroIdAlfanumerico(),
    asegurarHorariosLogin(),
    asegurarEstructuraHerramientaModulo()
])
    .then(() => {
        app.listen(APP_PORT, () => {
            console.log(`Servidor corriendo en puerto ${APP_PORT}`);
        });
    })
    .catch((error) => {
        console.error("No se pudo iniciar por error de integridad:", error);
        process.exit(1);
    });
























































