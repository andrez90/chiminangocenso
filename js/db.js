// =====================================================================
// db.js — Capa de acceso a datos (Supabase). Fuente de verdad = Postgres.
// localStorage se usa SOLO como caché de sesión (ver STATE_CACHE_KEY),
// nunca como base de datos: si Supabase no responde, se muestra un error
// de red en vez de inventar datos locales.
// =====================================================================

(function () {
  'use strict';

  const client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  // Normalizadores para emparejar el censo maestro contra lo ya cargado en
  // Supabase (nombres/aptos escritos con variaciones de mayúsculas, tildes
  // o espacios no deberían crear duplicados).
  function normNombre(s) {
    return String(s || '').trim().toUpperCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  }
  function normApto(s) { return String(s || '').trim().toUpperCase(); }
  function normTel(s) { return String(s || '').replace(/\D/g, ''); }

  const DB = {
    client,

    // ---------------------------------------------------------------
    // Auth
    // ---------------------------------------------------------------
    telefonoACorreo(telefono) {
      const limpio = String(telefono || '').replace(/\D/g, '');
      return `t${limpio}@${window.DOMINIO_CORREO_INTERNO}`;
    },

    async iniciarSesion(telefono, pin) {
      const email = this.telefonoACorreo(telefono);
      const { data, error } = await client.auth.signInWithPassword({ email, password: pin });
      if (error) throw error;
      return data;
    },

    async cerrarSesion() {
      await client.auth.signOut();
    },

    async sesionActual() {
      const { data } = await client.auth.getSession();
      return data.session;
    },

    async miPerfil() {
      const { data: sess } = await client.auth.getSession();
      if (!sess.session) return null;
      const { data, error } = await client.from('perfiles').select('*').eq('id', sess.session.user.id).single();
      if (error) throw error;
      return data;
    },

    // Crea un líder nuevo SIN afectar la sesión del coordinador: usa un
    // cliente Supabase temporal solo para el signUp.
    async crearLider({ nombre, telefono, pin, bloques, torres }) {
      const temp = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const email = this.telefonoACorreo(telefono);
      const { data, error } = await temp.auth.signUp({ email, password: pin });
      if (error) throw error;
      if (!data.user) throw new Error('No se pudo crear el usuario. Verifica que la confirmación de correo esté deshabilitada en Supabase (Authentication → Settings).');

      const { error: errPerfil } = await client.from('perfiles').insert({
        id: data.user.id,
        nombre,
        telefono,
        rol: 'lider_bloque',
        bloques_permitidos: bloques || [],
        torres_permitidas: torres || []
      });
      if (errPerfil) throw errPerfil;
      return data.user.id;
    },

    // ---------------------------------------------------------------
    // Bloques / Torres
    // ---------------------------------------------------------------
    async listarBloques() {
      const { data, error } = await client.from('bloques').select('*').order('id');
      if (error) throw error;
      return data;
    },
    async crearBloque(bloque) {
      const { error } = await client.from('bloques').insert(bloque);
      if (error) throw error;
    },
    async actualizarBloque(id, cambios) {
      const { error } = await client.from('bloques').update(cambios).eq('id', id);
      if (error) throw error;
    },
    async listarAgrupaciones(idBloque) {
      let q = client.from('agrupaciones').select('*').order('numero');
      if (idBloque) q = q.eq('id_bloque', idBloque);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async crearAgrupacion({ id_bloque, numero, nombre }) {
      const { error } = await client.from('agrupaciones').insert({ id: `${id_bloque}-${numero}`, id_bloque, numero, nombre });
      if (error) throw error;
    },
    async actualizarAgrupacion(id, cambios) {
      const { error } = await client.from('agrupaciones').update(cambios).eq('id', id);
      if (error) throw error;
    },
    async listarTorres(idAgrupacion) {
      let q = client.from('torres').select('*').order('letra_torre');
      if (idAgrupacion) q = q.eq('id_agrupacion', idAgrupacion);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async crearTorre({ id_bloque, id_agrupacion, letra_torre }) {
      const { error } = await client.from('torres').insert({ id: `${id_agrupacion}-${letra_torre}`, id_bloque, id_agrupacion, letra_torre });
      if (error) throw error;
    },

    // ---------------------------------------------------------------
    // Perfiles (líderes)
    // ---------------------------------------------------------------
    async listarLideres() {
      const { data, error } = await client.from('perfiles').select('*').eq('rol', 'lider_bloque').order('nombre');
      if (error) throw error;
      return data;
    },
    async actualizarLider(id, cambios) {
      const { error } = await client.from('perfiles').update(cambios).eq('id', id);
      if (error) throw error;
    },

    // ---------------------------------------------------------------
    // Hogares
    // ---------------------------------------------------------------
    async listarHogares() {
      const { data, error } = await client.from('hogares').select('*, mascotas(*)').order('fecha_censo', { ascending: false });
      if (error) throw error;
      return data;
    },
    async obtenerHogar(id) {
      const { data, error } = await client.from('hogares').select('*, mascotas(*), miembros_hogar(*)').eq('id', id).single();
      if (error) throw error;
      return data;
    },
    async crearHogar(hogar) {
      const { data, error } = await client.from('hogares').insert(hogar).select().single();
      if (error) throw error;
      return data;
    },
    async actualizarHogar(id, cambios) {
      const { data, error } = await client.from('hogares').update(cambios).eq('id', id).select().single();
      if (error) throw error;
      return data;
    },
    async reemplazarMascotas(idHogar, mascotas) {
      const { error: errDel } = await client.from('mascotas').delete().eq('id_hogar', idHogar);
      if (errDel) throw errDel;
      if (mascotas && mascotas.length) {
        const filas = mascotas.map((m) => ({ ...m, id_hogar: idHogar }));
        const { error } = await client.from('mascotas').insert(filas);
        if (error) throw error;
      }
    },
    async reemplazarMiembros(idHogar, miembros) {
      const { error: errDel } = await client.from('miembros_hogar').delete().eq('id_hogar', idHogar);
      if (errDel) throw errDel;
      if (miembros && miembros.length) {
        const filas = miembros.map((m) => ({ ...m, id_hogar: idHogar }));
        const { error } = await client.from('miembros_hogar').insert(filas);
        if (error) throw error;
      }
    },

    // Compara el censo maestro real (sector+agrupación+torre+apto+jefe,
    // ver js/seed-hogares.js) contra los hogares ya cargados en Supabase, y
    // decide para cada fila del maestro si corresponde a un hogar existente
    // (actualizar su sector/agrupación/torre/es_lider), si hay que crearlo
    // de cero, si hay más de un candidato posible (revisión manual) o si
    // falta el sector en el propio maestro y por eso no se puede crear
    // solo (ej. "Wilson Soto"). No hace red ni escribe nada — solo arma la
    // vista previa. El emparejamiento prueba, en orden, apto+jefe, luego
    // solo jefe, luego solo teléfono, todo dentro del mismo bloque, porque
    // el censo ya importado trae algunos aptos corruptos por Excel que la
    // hoja maestra ya no tiene (no se puede emparejar solo por apto).
    reconciliarCensoMaestro(hogaresActuales, filasMaestro) {
      const actualizaciones = [];
      const nuevos = [];
      const ambiguos = [];
      const pendientes = [];

      filasMaestro.forEach((fila) => {
        const enBloque = fila.bloque ? hogaresActuales.filter((h) => h.id_bloque === fila.bloque) : [];
        let candidatos = [];

        if (fila.bloque) {
          if (normApto(fila.apto)) {
            candidatos = enBloque.filter((h) => normApto(h.apartamento_unidad) === normApto(fila.apto) && normNombre(h.nombre_jefe_hogar) === normNombre(fila.jefe_hogar));
          }
          if (candidatos.length === 0 && normNombre(fila.jefe_hogar)) {
            candidatos = enBloque.filter((h) => normNombre(h.nombre_jefe_hogar) === normNombre(fila.jefe_hogar));
          }
          if (candidatos.length === 0 && normTel(fila.telefono)) {
            candidatos = enBloque.filter((h) => normTel(h.telefono) === normTel(fila.telefono));
          }
        } else if (normNombre(fila.jefe_hogar)) {
          candidatos = hogaresActuales.filter((h) => normNombre(h.nombre_jefe_hogar) === normNombre(fila.jefe_hogar));
        }

        if (candidatos.length === 1) actualizaciones.push({ hogar: candidatos[0], fila });
        else if (candidatos.length > 1) ambiguos.push({ fila, candidatos });
        else if (!fila.bloque) pendientes.push(fila);
        else nuevos.push(fila);
      });

      return { actualizaciones, nuevos, ambiguos, pendientes };
    },

    // Upsert del catálogo agrupaciones/torres a partir de las combinaciones
    // sector+agrupación+torre presentes en las filas que se van a aplicar.
    async sincronizarCatalogoAgrupacionesYTorres(filas) {
      const agrupacionesMap = new Map();
      const torresMap = new Map();
      filas.forEach((f) => {
        if (!f.bloque || !f.agrupacion) return;
        const idAgrupacion = `${f.bloque}-${f.agrupacion}`;
        if (!agrupacionesMap.has(idAgrupacion)) {
          agrupacionesMap.set(idAgrupacion, { id: idAgrupacion, id_bloque: f.bloque, numero: f.agrupacion });
        }
        if (f.torre) {
          const idTorre = `${idAgrupacion}-${f.torre}`;
          if (!torresMap.has(idTorre)) {
            torresMap.set(idTorre, { id: idTorre, id_bloque: f.bloque, id_agrupacion: idAgrupacion, letra_torre: f.torre });
          }
        }
      });
      const agrupaciones = Array.from(agrupacionesMap.values());
      const torres = Array.from(torresMap.values());
      if (agrupaciones.length) {
        const { error } = await client.from('agrupaciones').upsert(agrupaciones, { onConflict: 'id' });
        if (error) throw error;
      }
      if (torres.length) {
        const { error } = await client.from('torres').upsert(torres, { onConflict: 'id' });
        if (error) throw error;
      }
    },

    // Aplica solo lo que ya se confirmó en la vista previa de
    // reconciliarCensoMaestro (actualizaciones + nuevos; ambiguos y
    // pendientes se quedan siempre para revisión manual).
    async aplicarSincronizacionCensoMaestro({ actualizaciones, nuevos }, idLider) {
      await this.sincronizarCatalogoAgrupacionesYTorres([...actualizaciones.map((a) => a.fila), ...nuevos]);

      for (const { hogar, fila } of actualizaciones) {
        await this.actualizarHogar(hogar.id, {
          id_agrupacion: fila.bloque && fila.agrupacion ? `${fila.bloque}-${fila.agrupacion}` : null,
          id_torre: fila.torre || null,
          es_lider: !!fila.es_lider
        });
      }

      const lote = nuevos.map((fila) => ({
        id_bloque: fila.bloque,
        id_agrupacion: fila.bloque && fila.agrupacion ? `${fila.bloque}-${fila.agrupacion}` : null,
        id_torre: fila.torre || null,
        apartamento_unidad: fila.apto || '',
        nombre_jefe_hogar: fila.jefe_hogar || '(Sin nombre)',
        telefono: fila.telefono || '',
        legacy_ninos_sin_sexo: fila.legacy_ninos ?? null,
        legacy_adultos_sin_sexo: fila.legacy_adultos ?? null,
        es_lider: !!fila.es_lider,
        censo_inicial_importado: true,
        lider_que_censo: idLider,
        observaciones: fila.observaciones ? `Censo maestro. ${fila.observaciones}` : 'Censo maestro.'
      }));
      const TAM_LOTE = 25;
      for (let i = 0; i < lote.length; i += TAM_LOTE) {
        const { error } = await client.from('hogares').insert(lote.slice(i, i + TAM_LOTE));
        if (error) throw error;
      }

      return { actualizados: actualizaciones.length, creados: lote.length };
    },

    // Agrupa hogares por bloque + apto + jefe de hogar (mismo criterio que
    // ya usa la importación inicial para no duplicar) y regresa solo los
    // grupos con más de un hogar. Ignora jefes de hogar vacíos para no
    // marcar como "duplicados" todos los registros sin nombre. No hace
    // red, trabaja sobre un arreglo de hogares ya cargado.
    detectarDuplicados(hogares) {
      const grupos = new Map();
      hogares.forEach((h) => {
        const jefe = (h.nombre_jefe_hogar || '').trim().toLowerCase();
        if (!jefe) return;
        const clave = `${h.id_bloque}|${(h.apartamento_unidad || '').trim().toLowerCase()}|${jefe}`;
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(h);
      });
      return Array.from(grupos.values()).filter((g) => g.length > 1);
    },

    // ---------------------------------------------------------------
    // Necesidades
    // ---------------------------------------------------------------
    async listarNecesidadesPendientes() {
      const { data, error } = await client
        .from('necesidades')
        .select('*, hogares(id_bloque, apartamento_unidad, nombre_jefe_hogar)')
        .neq('estado', 'atendida')
        .order('fecha_registro');
      if (error) throw error;
      return data;
    },
    async marcarNecesidadAtendida(id) {
      const { error } = await client.from('necesidades').update({ estado: 'atendida', fecha_atencion: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    },

    // ---------------------------------------------------------------
    // Catálogo de tipos de ayuda
    // ---------------------------------------------------------------
    async listarTiposAyuda(soloActivos = true) {
      let q = client.from('tipos_ayuda').select('*').order('orden');
      if (soloActivos) q = q.eq('activo', true);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async crearTipoAyuda(tipo) {
      const { error } = await client.from('tipos_ayuda').insert(tipo);
      if (error) throw error;
    },
    async actualizarTipoAyuda(id, cambios) {
      const { error } = await client.from('tipos_ayuda').update(cambios).eq('id', id);
      if (error) throw error;
    },

    // ---------------------------------------------------------------
    // Catálogo de afectaciones de salud
    // ---------------------------------------------------------------
    async listarAfectacionesCatalogo(soloActivos = true) {
      let q = client.from('afectaciones_catalogo').select('*').order('orden');
      if (soloActivos) q = q.eq('activo', true);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async crearAfectacion(afectacion) {
      const { error } = await client.from('afectaciones_catalogo').insert(afectacion);
      if (error) throw error;
    },
    async actualizarAfectacion(id, cambios) {
      const { error } = await client.from('afectaciones_catalogo').update(cambios).eq('id', id);
      if (error) throw error;
    },

    // ---------------------------------------------------------------
    // Inventario
    // ---------------------------------------------------------------
    async listarInventario() {
      const { data, error } = await client.from('inventario_items').select('*, tipos_ayuda(nombre)').order('nombre');
      if (error) throw error;
      return data;
    },
    async crearItemInventario(item) {
      const { error } = await client.from('inventario_items').insert(item);
      if (error) throw error;
    },
    async actualizarItemInventario(id, cambios) {
      const { error } = await client.from('inventario_items').update(cambios).eq('id', id);
      if (error) throw error;
    },
    async registrarEntradaInventario(itemId, cantidad, motivo, usuarioId) {
      const { data: item, error: errGet } = await client.from('inventario_items').select('cantidad_disponible').eq('id', itemId).single();
      if (errGet) throw errGet;
      const { error: errUpd } = await client.from('inventario_items')
        .update({ cantidad_disponible: Number(item.cantidad_disponible) + Number(cantidad) })
        .eq('id', itemId);
      if (errUpd) throw errUpd;
      const { error: errMov } = await client.from('inventario_movimientos').insert({
        item_id: itemId, tipo: 'entrada', cantidad, motivo, registrado_por: usuarioId
      });
      if (errMov) throw errMov;
    },
    async listarMovimientosInventario(limite = 30) {
      const { data, error } = await client.from('inventario_movimientos')
        .select('*, inventario_items(nombre)')
        .order('created_at', { ascending: false })
        .limit(limite);
      if (error) throw error;
      return data;
    },

    // ---------------------------------------------------------------
    // Entregas
    // ---------------------------------------------------------------
    async listarEntregas(limite = 50) {
      const { data, error } = await client.from('entregas')
        .select('*, hogares(nombre_jefe_hogar, apartamento_unidad, id_bloque), entrega_items(*, tipos_ayuda(nombre))')
        .order('fecha_hora', { ascending: false })
        .limit(limite);
      if (error) throw error;
      return data;
    },
    async crearEntrega(entrega, items) {
      const { data: entregaCreada, error } = await client.from('entregas').insert(entrega).select().single();
      if (error) throw error;
      if (items && items.length) {
        const filas = items.map((it) => ({ ...it, entrega_id: entregaCreada.id }));
        const { error: errItems } = await client.from('entrega_items').insert(filas);
        if (errItems) throw errItems;
      }
      return entregaCreada;
    },
    async subirEvidencia(archivo, entregaId) {
      const ext = (archivo.name.split('.').pop() || 'jpg').toLowerCase();
      const ruta = `${entregaId}/${Date.now()}.${ext}`;
      const { error } = await client.storage.from('evidencias').upload(ruta, archivo, { upsert: false });
      if (error) throw error;
      const { data } = client.storage.from('evidencias').getPublicUrl(ruta);
      return data.publicUrl;
    },

    // ---------------------------------------------------------------
    // Tiempo real: se suscribe a cambios en las tablas clave y llama al
    // callback para que la vista activa se vuelva a pintar.
    // ---------------------------------------------------------------
    suscribirCambios(callback) {
      const canal = client
        .channel('censo-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hogares' }, callback)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'entregas' }, callback)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'entrega_items' }, callback)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'inventario_items' }, callback)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'necesidades' }, callback)
        .subscribe();
      return () => client.removeChannel(canal);
    }
  };

  window.DB = DB;
})();
