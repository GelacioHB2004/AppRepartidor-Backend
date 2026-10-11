const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const emailService = require('./emailService');

const generarCodigo4Digitos = () => Math.floor(1000 + Math.random() * 9000).toString();

// ==================== REGISTRO ====================
const registrarRepartidor = async (datos) => {
    const { nombre, apellidoP, apellidoM, correo, telefono, password } = datos;

    // Validar que el correo no exista ya
    const [existe] = await db.query('SELECT id_usuarios FROM usuarios1 WHERE Correo = ?', [correo]);
    if (existe.length > 0) {
        throw { status: 409, message: 'Ya existe una cuenta con ese correo electrónico.' };
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const codigo = generarCodigo4Digitos();
    const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    await db.query(`
        INSERT INTO usuarios1 
        (Nombre, ApellidoP, ApellidoM, Correo, Telefono, Password, TipoUsuario, Estado, FechaRegistro, VerificacionCodigo, MFAExpiry, PreguntaSecreta, RespuestaSecreta)
        VALUES (?, ?, ?, ?, ?, ?, 'Repartidor', 'Pendiente', NOW(), ?, ?, '', '')
    `, [nombre, apellidoP, apellidoM || '', correo, telefono, hashedPassword, codigo, expiry]);

    await emailService.enviarCodigoVerificacion(correo, nombre, codigo);
};

// ==================== VERIFICAR CUENTA ====================
const verificarCuentaRepartidor = async (correo, codigo) => {
    const [usuarios] = await db.query(
        'SELECT id_usuarios, VerificacionCodigo, MFAExpiry, Estado FROM usuarios1 WHERE Correo = ?',
        [correo]
    );

    if (usuarios.length === 0) throw { status: 404, message: 'Correo no encontrado.' };

    const user = usuarios[0];

    if (user.Estado === 'Activo') throw { status: 400, message: 'La cuenta ya está verificada.' };

    if (!user.VerificacionCodigo || user.VerificacionCodigo !== codigo) {
        throw { status: 400, message: 'Código incorrecto.' };
    }

    if (new Date() > new Date(user.MFAExpiry)) {
        throw { status: 400, message: 'El código ha expirado. Solicita uno nuevo.' };
    }

    await db.query(
        "UPDATE usuarios1 SET Estado = 'Activo', VerificacionCodigo = NULL, MFAExpiry = NULL WHERE id_usuarios = ?",
        [user.id_usuarios]
    );
};

// ==================== REENVIAR CÓDIGO DE VERIFICACIÓN ====================
const reenviarCodigoVerificacion = async (correo) => {
    const [usuarios] = await db.query('SELECT id_usuarios, Nombre, Estado FROM usuarios1 WHERE Correo = ?', [correo]);
    if (usuarios.length === 0) throw { status: 404, message: 'Correo no encontrado.' };
    const user = usuarios[0];
    if (user.Estado === 'Activo') throw { status: 400, message: 'La cuenta ya está verificada.' };

    const codigo = generarCodigo4Digitos();
    const expiry = new Date(Date.now() + 15 * 60 * 1000);

    await db.query(
        'UPDATE usuarios1 SET VerificacionCodigo = ?, MFAExpiry = ? WHERE id_usuarios = ?',
        [codigo, expiry, user.id_usuarios]
    );
    await emailService.enviarCodigoVerificacion(correo, user.Nombre, codigo);
};

// ==================== SOLICITAR RECUPERACIÓN ====================
const solicitarRecuperacion = async (correo) => {
    const [usuarios] = await db.query('SELECT id_usuarios, Nombre FROM usuarios1 WHERE Correo = ? AND TipoUsuario = ?', [correo, 'Repartidor']);
    if (usuarios.length === 0) throw { status: 404, message: 'No existe una cuenta de repartidor con ese correo.' };

    const user = usuarios[0];
    const codigo = generarCodigo4Digitos();
    const expiry = new Date(Date.now() + 15 * 60 * 1000);

    await db.query(
        'UPDATE usuarios1 SET RecuperacionCodigo = ?, RecuperacionExpiry = ? WHERE id_usuarios = ?',
        [codigo, expiry, user.id_usuarios]
    );
    await emailService.enviarCodigoRecuperacion(correo, user.Nombre, codigo);
};

// ==================== VERIFICAR CÓDIGO DE RECUPERACIÓN ====================
const verificarCodigoRecuperacion = async (correo, codigo) => {
    const [usuarios] = await db.query(
        'SELECT id_usuarios, RecuperacionCodigo, RecuperacionExpiry FROM usuarios1 WHERE Correo = ? AND TipoUsuario = ?',
        [correo, 'Repartidor']
    );
    if (usuarios.length === 0) throw { status: 404, message: 'Correo no encontrado.' };

    const user = usuarios[0];
    if (!user.RecuperacionCodigo || user.RecuperacionCodigo !== codigo) {
        throw { status: 400, message: 'Código incorrecto.' };
    }
    if (new Date() > new Date(user.RecuperacionExpiry)) {
        throw { status: 400, message: 'El código ha expirado. Solicita uno nuevo.' };
    }

    // Marcar como verificado (limpiar código) para que el siguiente paso sepa que puede cambiar
    await db.query(
        'UPDATE usuarios1 SET RecuperacionCodigo = NULL WHERE id_usuarios = ?',
        [user.id_usuarios]
    );
};

// ==================== RESETEAR CONTRASEÑA ====================
const resetearPassword = async (correo, nuevaPassword) => {
    const [usuarios] = await db.query(
        'SELECT id_usuarios, Password FROM usuarios1 WHERE Correo = ? AND TipoUsuario = ?',
        [correo, 'Repartidor']
    );
    if (usuarios.length === 0) throw { status: 404, message: 'Correo no encontrado.' };

    // Verificar que la nueva contraseña no sea igual a la actual
    const esMismaPassword = await bcrypt.compare(nuevaPassword, usuarios[0].Password);
    if (esMismaPassword) {
        throw { status: 400, message: 'La nueva contraseña no puede ser igual a la actual.' };
    }

    const hashedPassword = await bcrypt.hash(nuevaPassword, 12);
    await db.query(
        'UPDATE usuarios1 SET Password = ?, RecuperacionExpiry = NULL, IntentosFallidos = 0, BloqueadoHasta = NULL WHERE id_usuarios = ?',
        [hashedPassword, usuarios[0].id_usuarios]
    );
};

const loginUser = async (correo, password) => {
    const [usuarios] = await db.query('SELECT * FROM usuarios1 WHERE Correo = ?', [correo]);

    // Anti-timing attack
    if (usuarios.length === 0) {
        await new Promise(r => setTimeout(r, 1200));
        throw { status: 400, message: 'Correo o contraseña incorrectos.' };
    }

    const user = usuarios[0];

    // Ensure only Repartidor can log into the mobile app
    if (user.TipoUsuario !== 'Repartidor') {
        throw { status: 403, message: 'Acceso denegado. Solo para repartidores.' };
    }

    // Bloqueo temporal por intentos fallidos
    if (user.BloqueadoHasta && new Date() < new Date(user.BloqueadoHasta)) {
        const minutos = Math.ceil((new Date(user.BloqueadoHasta) - new Date()) / 60000);
        throw { status: 429, message: `Cuenta bloqueada por seguridad. Intenta de nuevo en ${minutos} minuto${minutos > 1 ? 's' : ''}.` };
    }

    const isMatch = await bcrypt.compare(password, user.Password);

    if (!isMatch) {
        const ahora = new Date();
        const intentos = (user.IntentosFallidos || 0) + 1;

        if (intentos >= 3) {
            const bloqueoHasta = new Date(ahora.getTime() + 15 * 60 * 1000); // +15 min
            await db.query(
                `UPDATE usuarios1 
                 SET IntentosFallidos = ?, UltimoIntentoFallido = ?, BloqueadoHasta = ?
                 WHERE id_usuarios = ?`,
                [intentos, ahora, bloqueoHasta, user.id_usuarios]
            );
            throw { status: 429, message: 'Demasiados intentos fallidos. Cuenta bloqueada por 15 minutos.' };
        }

        // Solo incrementar intentos
        await db.query(
            `UPDATE usuarios1 
             SET IntentosFallidos = IntentosFallidos + 1, UltimoIntentoFallido = ?
             WHERE id_usuarios = ?`,
            [ahora, user.id_usuarios]
        );

        throw { status: 400, message: 'Correo o contraseña incorrectos.' };
    }

    // Login correcto -> Resetear intentos
    await db.query(
        `UPDATE usuarios1 
         SET IntentosFallidos = 0, BloqueadoHasta = NULL, UltimoIntentoFallido = NULL, UltimaActividad = NOW()
         WHERE id_usuarios = ?`,
        [user.id_usuarios]
    );

    if (user.Estado !== 'Activo') {
        throw { status: 400, message: 'La cuenta no está verificada o está inactiva.' };
    }

    const token = jwt.sign(
        { id: user.id_usuarios, correo: user.Correo, tipo: user.TipoUsuario },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
    );

    // Guardar el token
    await db.query(
        'UPDATE usuarios1 SET token_version = ? WHERE id_usuarios = ?',
        [token, user.id_usuarios]
    );

    return { token, user: { ...user, Password: undefined } };
};

const logoutUser = async (userId) => {
    await db.query(
        'UPDATE usuarios1 SET token_version = NULL WHERE id_usuarios = ?',
        [userId]
    );
};

module.exports = {
    loginUser,
    logoutUser,
    registrarRepartidor,
    verificarCuentaRepartidor,
    reenviarCodigoVerificacion,
    solicitarRecuperacion,
    verificarCodigoRecuperacion,
    resetearPassword
};
