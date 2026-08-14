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
    async crearLider({ nombre, telefono, pin, bloques }) {
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
        bloques_permitidos: bloques
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
    async listarTorres(idBloque) {
      let q = client.from('torres').select('*').order('letra_torre');
      if (idBloque) q = q.eq('id_bloque', idBloque);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    async crearTorre(torre) {
      const { error } = await client.from('torres').insert(torre);
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
      const { data, error } = await client.from('hogares').select('*, mascotas(*)').eq('id', id).single();
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
    async existeHogarImportado(bloque, apto, jefe) {
      const { data, error } = await client
        .from('hogares')
        .select('id')
        .eq('id_bloque', bloque)
        .eq('apartamento_unidad', apto || '')
        .eq('nombre_jefe_hogar', jefe || '')
        .limit(1);
      if (error) throw error;
      return data.length > 0;
    },
    async importarHogaresIniciales(filas, idLider, onProgreso) {
      let importados = 0;
      let omitidos = 0;
      const lote = [];
      const TAM_LOTE = 25;

      async function volcarLote(self) {
        if (!lote.length) return;
        const { error } = await client.from('hogares').insert(lote.splice(0, lote.length));
        if (error) throw error;
      }

      for (const h of filas) {
        const yaExiste = await this.existeHogarImportado(h.bloque, h.apto, h.jefe_hogar);
        if (yaExiste) { omitidos++; if (onProgreso) onProgreso(importados, omitidos, filas.length); continue; }
        lote.push({
          id_bloque: h.bloque,
          apartamento_unidad: h.apto || '',
          nombre_jefe_hogar: h.jefe_hogar || '(Sin nombre)',
          telefono: h.telefono || '',
          legacy_ninos_sin_sexo: h.legacy_ninos ?? null,
          legacy_adultos_sin_sexo: h.legacy_adultos ?? null,
          censo_inicial_importado: true,
          lider_que_censo: idLider,
          observaciones: h.observaciones ? `Censo inicial (importado). ${h.observaciones}` : 'Censo inicial (importado).'
        });
        importados++;
        if (lote.length >= TAM_LOTE) await volcarLote(this);
        if (onProgreso) onProgreso(importados, omitidos, filas.length);
      }
      await volcarLote(this);
      return { importados, omitidos };
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
