// =====================================================================
// app.js — Aplicación (router, vistas, formularios). Sin build step:
// script clásico cargado después de db.js. Usa un namespace global App
// para evitar colisiones.
// =====================================================================

(function () {
  'use strict';

  const DB = window.DB;

  // ---------------------------------------------------------------
  // Estado en memoria (NO es la fuente de verdad: siempre se vuelve a
  // pedir a Supabase; esto solo evita parpadeos entre vistas).
  // ---------------------------------------------------------------
  const state = {
    session: null,
    perfil: null,
    bloques: [],
    torres: [],
    lideres: [],
    tiposAyuda: [],
    unsubscribeRealtime: null
  };

  const SESSION_CACHE_KEY = 'censo_chimi_cache_ui'; // solo preferencias de UI, no datos del censo

  // =====================================================================
  // Utilidades generales
  // =====================================================================

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtFecha(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function horasDesde(iso) {
    return (Date.now() - new Date(iso).getTime()) / 3600000;
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function toast(msg, type) {
    const region = qs('#toast-region');
    const el = h(`<div class="toast ${type || ''}" role="status">${esc(msg)}</div>`);
    region.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function errorAmigable(err) {
    if (!err) return 'Ocurrió un error inesperado.';
    const msg = err.message || String(err);
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || !navigator.onLine) {
      return 'No hay conexión a internet. Revisa tu señal e inténtalo de nuevo.';
    }
    if (msg.includes('Invalid login credentials')) return 'Teléfono o PIN incorrecto.';
    if (msg.includes('duplicate key')) return 'Ese registro ya existe.';
    if (msg.includes('row-level security') || msg.includes('permission denied')) return 'No tienes permiso para hacer esto.';
    return msg;
  }

  function confirmar(mensaje, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const backdrop = h(`
        <div class="modal-backdrop" role="dialog" aria-modal="true">
          <div class="modal-box">
            <h3>${esc(opts.titulo || 'Confirmar')}</h3>
            <p class="text-muted">${esc(mensaje)}</p>
            <div class="modal-actions">
              <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
              <button type="button" class="btn ${opts.peligroso ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(opts.textoOk || 'Confirmar')}</button>
            </div>
          </div>
        </div>`);
      document.body.appendChild(backdrop);
      backdrop.querySelector('[data-ok]').focus();
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop || e.target.closest('[data-cancel]')) { backdrop.remove(); resolve(false); }
        if (e.target.closest('[data-ok]')) { backdrop.remove(); resolve(true); }
      });
      backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { backdrop.remove(); resolve(false); } });
    });
  }

  function exportarCSV(nombreArchivo, filas, columnas) {
    const header = columnas.map((c) => `"${c.titulo.replace(/"/g, '""')}"`).join(',');
    const body = filas.map((fila) =>
      columnas.map((c) => `"${String(c.valor(fila) ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    const csv = '﻿' + header + '\n' + body;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombreArchivo;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function esCoordinador() { return state.perfil && state.perfil.rol === 'coordinador'; }
  function misBloques() { return state.perfil ? (state.perfil.bloques_permitidos || []) : []; }

  // =====================================================================
  // Componente contador +/-
  // =====================================================================
  function contadorHTML(nombre, etiqueta, valorInicial) {
    return `
      <div class="counter" data-counter="${nombre}">
        <div class="counter-label">${esc(etiqueta)}</div>
        <div class="counter-controls">
          <button type="button" class="counter-btn" data-dec aria-label="Restar ${esc(etiqueta)}">−</button>
          <span class="counter-value" data-value>${valorInicial}</span>
          <button type="button" class="counter-btn" data-inc aria-label="Sumar ${esc(etiqueta)}">+</button>
        </div>
      </div>`;
  }

  function activarContadores(root, onChange) {
    qsa('[data-counter]', root).forEach((box) => {
      const valSpan = qs('[data-value]', box);
      const get = () => parseInt(valSpan.textContent, 10) || 0;
      const set = (v) => { valSpan.textContent = Math.max(0, v); onChange && onChange(); };
      qs('[data-inc]', box).addEventListener('click', () => set(get() + 1));
      qs('[data-dec]', box).addEventListener('click', () => set(get() - 1));
    });
  }
  function valorContador(root, nombre) {
    const box = qs(`[data-counter="${nombre}"]`, root);
    return box ? parseInt(qs('[data-value]', box).textContent, 10) || 0 : 0;
  }

  // =====================================================================
  // Router
  // =====================================================================
  const RUTAS = {
    '#/dashboard': { render: vistaDashboard, roles: ['coordinador'], titulo: 'Panel' },
    '#/censo': { render: vistaCensoLista, roles: ['coordinador', 'lider_bloque'], titulo: 'Censo de hogares' },
    '#/censo/nuevo': { render: vistaCensoForm, roles: ['coordinador', 'lider_bloque'], titulo: 'Nuevo hogar' },
    '#/entregas': { render: vistaEntregas, roles: ['coordinador'], titulo: 'Entregas de ayuda' },
    '#/inventario': { render: vistaInventario, roles: ['coordinador'], titulo: 'Inventario' },
    '#/catalogo': { render: vistaCatalogo, roles: ['coordinador'], titulo: 'Catálogo de ayudas' },
    '#/administracion': { render: vistaAdministracion, roles: ['coordinador'], titulo: 'Administración' },
    '#/reportes': { render: vistaReportes, roles: ['coordinador'], titulo: 'Reportes' }
  };

  function rutaHogarEditar(id) { return `#/censo/${id}`; }

  async function router() {
    if (!state.perfil) return renderLogin();

    let hash = location.hash || (esCoordinador() ? '#/dashboard' : '#/censo');
    let match = RUTAS[hash];
    let idHogar = null;

    if (!match && /^#\/censo\/(.+)$/.test(hash) && hash !== '#/censo/nuevo') {
      idHogar = hash.replace('#/censo/', '');
      match = { render: (root) => vistaCensoForm(root, idHogar), roles: ['coordinador', 'lider_bloque'], titulo: 'Editar hogar' };
    }

    if (!match) { location.hash = esCoordinador() ? '#/dashboard' : '#/censo'; return; }
    if (!match.roles.includes(state.perfil.rol)) { location.hash = esCoordinador() ? '#/dashboard' : '#/censo'; return; }

    renderChrome(hash);
    const root = qs('#view-root');
    root.innerHTML = '<div class="loading-block"><span class="spinner" aria-hidden="true"></span> Cargando…</div>';
    try {
      await match.render(root);
    } catch (err) {
      root.innerHTML = `<div class="card"><p class="error-text">${esc(errorAmigable(err))}</p></div>`;
    }
  }

  window.addEventListener('hashchange', router);

  // =====================================================================
  // Estructura general (header + tabs) una vez logueado
  // =====================================================================
  function tabsParaRol() {
    if (esCoordinador()) {
      return [
        ['#/dashboard', 'Panel'],
        ['#/censo', 'Censo'],
        ['#/entregas', 'Entregas'],
        ['#/inventario', 'Inventario'],
        ['#/catalogo', 'Catálogo'],
        ['#/administracion', 'Administración'],
        ['#/reportes', 'Reportes']
      ];
    }
    return [['#/censo', 'Censo de mi bloque']];
  }

  function renderChrome(hashActivo) {
    const root = qs('#app-root');
    if (!qs('#view-root')) {
      root.innerHTML = `
        <header class="app-header">
          <div class="brand"><span class="brand-badge" aria-hidden="true">🏠</span><span class="brand-text">Censo Albergue Chimi</span></div>
          <div class="user-box">
            <span>${esc(state.perfil.nombre)}</span>
            <span class="rol-badge">${state.perfil.rol === 'coordinador' ? 'Coordinador' : 'Líder de bloque'}</span>
            <button class="btn-logout" id="btn-logout" type="button">Salir</button>
          </div>
        </header>
        <nav class="app-tabs" aria-label="Secciones"></nav>
        <main class="app-main" id="view-root" tabindex="-1"></main>
        <footer class="app-footer">Sistema de Censo y Ayudas — Albergue Chimi</footer>`;
      qs('#btn-logout').addEventListener('click', async () => {
        const ok = await confirmar('¿Cerrar tu sesión en este dispositivo?', { textoOk: 'Salir' });
        if (ok) { await DB.cerrarSesion(); location.hash = ''; window.location.reload(); }
      });
    }
    const nav = qs('.app-tabs');
    nav.innerHTML = tabsParaRol().map(([href, label]) =>
      `<a href="${href}" class="${href === hashActivo ? 'active' : ''}">${esc(label)}</a>`
    ).join('');
  }

  // =====================================================================
  // LOGIN
  // =====================================================================
  function renderLogin() {
    document.getElementById('app-root').innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <div class="brand-badge-lg" aria-hidden="true">🏠</div>
          <h1>Censo Albergue Chimi</h1>
          <p class="subtitle">Ingresa con tu teléfono y tu PIN de 6 dígitos.</p>
          <form id="form-login" novalidate>
            <div class="field">
              <label for="lg-tel">Teléfono</label>
              <input id="lg-tel" name="telefono" type="tel" inputmode="numeric" autocomplete="username" required placeholder="3001234567">
            </div>
            <div class="field">
              <label for="lg-pin">PIN (6 dígitos)</label>
              <input id="lg-pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="current-password" required placeholder="••••••">
            </div>
            <button class="btn btn-primary btn-block" type="submit" id="btn-login">Ingresar</button>
            <p class="error-text" id="login-error" role="alert" aria-live="polite"></p>
          </form>
        </div>
      </div>`;

    qs('#form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = qs('#btn-login');
      const err = qs('#login-error');
      err.textContent = '';
      const telefono = qs('#lg-tel').value.trim();
      const pin = qs('#lg-pin').value.trim();
      if (!telefono || pin.length !== 6) { err.textContent = 'Escribe tu teléfono y un PIN de 6 dígitos.'; return; }
      btn.disabled = true; btn.textContent = 'Ingresando…';
      try {
        await DB.iniciarSesion(telefono, pin);
        await bootstrapSesion();
      } catch (ex) {
        err.textContent = errorAmigable(ex);
      } finally {
        btn.disabled = false; btn.textContent = 'Ingresar';
      }
    });
  }

  // =====================================================================
  // DASHBOARD (coordinador)
  // =====================================================================
  async function vistaDashboard(root) {
    const [hogares, entregas, necesidades, inventario] = await Promise.all([
      DB.listarHogares(), DB.listarEntregas(8), DB.listarNecesidadesPendientes(), DB.listarInventario()
    ]);

    const totalPersonas = hogares.reduce((s, h) => s + (h.total_personas || (h.legacy_ninos_sin_sexo || 0) + (h.legacy_adultos_sin_sexo || 0)), 0);
    const bloquesConHogares = new Set(hogares.map((h) => h.id_bloque));
    const alertasMedicas48h = necesidades.filter((n) => n.prioridad === 'alta' && horasDesde(n.fecha_registro) > 48);
    const inventarioBajo = inventario.filter((i) => Number(i.cantidad_disponible) <= Number(i.stock_minimo));

    root.innerHTML = `
      <h1>Panel del coordinador</h1>
      <div class="metrics-grid">
        <div class="metric-card"><div class="metric-value">${hogares.length}</div><div class="metric-label">Hogares censados (de 202 esperados)</div></div>
        <div class="metric-card"><div class="metric-value">${totalPersonas}</div><div class="metric-label">Personas registradas</div></div>
        <div class="metric-card"><div class="metric-value">${bloquesConHogares.size}</div><div class="metric-label">Bloques con censo activo</div></div>
        <div class="metric-card"><div class="metric-value">${entregas.length}</div><div class="metric-label">Entregas recientes</div></div>
      </div>

      <div class="section-title">Alertas de necesidad médica (pendientes hace más de 48h)</div>
      <div class="card">
        ${alertasMedicas48h.length === 0
          ? '<p class="text-muted">No hay alertas pendientes. Buen trabajo.</p>'
          : `<div class="alert-list">${alertasMedicas48h.map((n) => `
              <div class="alert-item">
                <div>
                  <strong>${esc(n.hogares?.nombre_jefe_hogar || 'Hogar')}</strong>
                  <div class="text-sm text-muted">Bloque ${esc(n.hogares?.id_bloque)} · Apto ${esc(n.hogares?.apartamento_unidad || '—')} · ${esc(n.descripcion || 'Sin descripción')}</div>
                </div>
                <button class="btn btn-sm btn-secondary" data-atender="${n.id}">Marcar atendida</button>
              </div>`).join('')}</div>`}
      </div>

      <div class="section-title">Inventario bajo el mínimo</div>
      <div class="card">
        ${inventarioBajo.length === 0
          ? '<p class="text-muted">Todo el inventario está por encima del mínimo configurado.</p>'
          : `<div class="alert-list">${inventarioBajo.map((i) => `
              <div class="alert-item warning">
                <div><strong>${esc(i.nombre)}</strong><div class="text-sm text-muted">Disponible: ${i.cantidad_disponible} ${esc(i.unidad)} (mínimo ${i.stock_minimo})</div></div>
                <a class="btn btn-sm btn-secondary" href="#/inventario">Reabastecer</a>
              </div>`).join('')}</div>`}
      </div>

      <div class="section-title">Últimas entregas registradas</div>
      <div class="card">
        ${entregas.length === 0 ? '<p class="text-muted">Todavía no se han registrado entregas.</p>' :
          `<div class="table-scroll"><table class="data-table">
            <thead><tr><th>Fecha</th><th>Hogar</th><th>Bloque</th><th>Ayuda</th></tr></thead>
            <tbody>${entregas.map((e) => `
              <tr>
                <td>${fmtFecha(e.fecha_hora)}</td>
                <td>${esc(e.hogares?.nombre_jefe_hogar || '—')}</td>
                <td>${esc(e.id_bloque)}</td>
                <td>${(e.entrega_items || []).map((it) => esc(it.tipos_ayuda?.nombre)).join(', ') || '—'}</td>
              </tr>`).join('')}</tbody>
          </table></div>`}
      </div>`;

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-atender]');
      if (!btn) return;
      const ok = await confirmar('¿Marcar esta necesidad como atendida?', { textoOk: 'Marcar atendida' });
      if (!ok) return;
      try { await DB.marcarNecesidadAtendida(btn.dataset.atender); toast('Actualizado', 'success'); router(); }
      catch (ex) { toast(errorAmigable(ex), 'error'); }
    });
  }

  // =====================================================================
  // CENSO — lista con filtros
  // =====================================================================
  let filtroHogares = { bloque: '', torre: '', texto: '', mascotas: '', medica: '' };

  async function vistaCensoLista(root) {
    const [hogares, bloques] = await Promise.all([DB.listarHogares(), DB.listarBloques()]);
    state.bloques = bloques;
    const bloquesVisibles = esCoordinador() ? bloques : bloques.filter((b) => misBloques().includes(b.id));

    root.innerHTML = `
      <div class="flex-between">
        <h1>Censo de hogares</h1>
        <a class="btn btn-primary" href="#/censo/nuevo">+ Censar hogar</a>
      </div>
      <div class="filter-bar card" role="search" aria-label="Filtros de búsqueda">
        <div class="field mb-0">
          <label for="f-texto">Buscar</label>
          <input id="f-texto" type="search" placeholder="Nombre, apto o teléfono" value="${esc(filtroHogares.texto)}">
        </div>
        <div class="field mb-0">
          <label for="f-bloque">Bloque</label>
          <select id="f-bloque">
            <option value="">Todos</option>
            ${bloquesVisibles.map((b) => `<option value="${esc(b.id)}" ${filtroHogares.bloque === b.id ? 'selected' : ''}>${esc(b.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="field mb-0">
          <label for="f-torre">Torre</label>
          <input id="f-torre" type="text" placeholder="Ej. F" value="${esc(filtroHogares.torre)}">
        </div>
        <div class="field mb-0">
          <label for="f-mascotas">Mascotas</label>
          <select id="f-mascotas">
            <option value="">Todos</option>
            <option value="si" ${filtroHogares.mascotas === 'si' ? 'selected' : ''}>Con mascotas</option>
            <option value="no" ${filtroHogares.mascotas === 'no' ? 'selected' : ''}>Sin mascotas</option>
          </select>
        </div>
        <div class="field mb-0">
          <label for="f-medica">Necesidad especial</label>
          <select id="f-medica">
            <option value="">Todos</option>
            <option value="si" ${filtroHogares.medica === 'si' ? 'selected' : ''}>Con necesidad</option>
          </select>
        </div>
      </div>
      <div id="hogar-list-region"></div>`;

    function pintar() {
      const propios = esCoordinador() ? hogares : hogares.filter((h) => misBloques().includes(h.id_bloque));
      const texto = filtroHogares.texto.trim().toLowerCase();
      const filtrados = propios.filter((h) => {
        if (filtroHogares.bloque && h.id_bloque !== filtroHogares.bloque) return false;
        if (filtroHogares.torre && !(h.id_torre || '').toLowerCase().includes(filtroHogares.torre.toLowerCase())) return false;
        if (filtroHogares.mascotas === 'si' && !h.tiene_mascotas) return false;
        if (filtroHogares.mascotas === 'no' && h.tiene_mascotas) return false;
        if (filtroHogares.medica === 'si' && !h.tiene_afectacion_medica) return false;
        if (texto) {
          const campo = `${h.nombre_jefe_hogar || ''} ${h.apartamento_unidad || ''} ${h.telefono || ''}`.toLowerCase();
          if (!campo.includes(texto)) return false;
        }
        return true;
      });

      const region = qs('#hogar-list-region', root);
      if (filtrados.length === 0) {
        region.innerHTML = `<div class="empty-state"><div class="icon">🔍</div><h3>Sin resultados</h3><p>No hay hogares que coincidan con el filtro. Prueba a limpiarlo o censa uno nuevo.</p></div>`;
        return;
      }
      region.innerHTML = `<div class="hogar-list">${filtrados.map((h) => `
        <a class="hogar-row" href="${rutaHogarEditar(h.id)}">
          <div class="info-main">
            <span class="title">${esc(h.nombre_jefe_hogar || '(Sin nombre)')}</span>
            <span class="subtitle">Bloque ${esc(h.id_bloque)}${h.id_torre ? ' · Torre ' + esc(h.id_torre) : ''} · Apto ${esc(h.apartamento_unidad || '—')} · ${esc(h.telefono || 'Sin teléfono')}</span>
          </div>
          <div class="info-side">
            ${h.tiene_afectacion_medica ? '<span class="badge badge-danger">Médica</span>' : ''}
            ${h.tiene_mascotas ? '<span class="badge badge-neutral">🐾</span>' : ''}
            <span class="badge badge-primary">${h.total_personas ?? ((h.legacy_ninos_sin_sexo || 0) + (h.legacy_adultos_sin_sexo || 0))} pers.</span>
          </div>
        </a>`).join('')}</div>`;
    }

    qs('#f-texto', root).addEventListener('input', debounce((e) => { filtroHogares.texto = e.target.value; pintar(); }, 200));
    qs('#f-bloque', root).addEventListener('change', (e) => { filtroHogares.bloque = e.target.value; pintar(); });
    qs('#f-torre', root).addEventListener('input', debounce((e) => { filtroHogares.torre = e.target.value; pintar(); }, 200));
    qs('#f-mascotas', root).addEventListener('change', (e) => { filtroHogares.mascotas = e.target.value; pintar(); });
    qs('#f-medica', root).addEventListener('change', (e) => { filtroHogares.medica = e.target.value; pintar(); });
    pintar();
  }

  // =====================================================================
  // CENSO — formulario rápido (alta / edición)
  // =====================================================================
  async function vistaCensoForm(root, idHogarParam) {
    let idHogar = idHogarParam;
    if (typeof idHogar !== 'string') idHogar = null; // llamado desde router sin id -> nuevo
    if (root && !idHogarParam && location.hash.startsWith('#/censo/') && location.hash !== '#/censo/nuevo') {
      idHogar = location.hash.replace('#/censo/', '');
    }

    const [bloques, hogarExistente] = await Promise.all([
      DB.listarBloques(),
      idHogar ? DB.obtenerHogar(idHogar) : Promise.resolve(null)
    ]);
    const bloquesVisibles = esCoordinador() ? bloques : bloques.filter((b) => misBloques().includes(b.id));

    const h0 = hogarExistente || {
      id_bloque: bloquesVisibles.length === 1 ? bloquesVisibles[0].id : '',
      id_torre: '', apartamento_unidad: '', nombre_jefe_hogar: '', telefono: '',
      mujeres_adultas: 0, hombres_adultos: 0, ninas: 0, ninos: 0, abuelas: 0, abuelos: 0,
      tiene_afectacion_medica: false, requerimiento_prioritario: '', tiene_mascotas: false, mascotas: []
    };

    const mascotasPorTipo = { perro: 0, gato: 0, otro: 0 };
    (h0.mascotas || []).forEach((m) => { if (mascotasPorTipo[m.tipo] !== undefined) mascotasPorTipo[m.tipo] += m.cantidad; });

    root.innerHTML = `
      <h1>${idHogar ? 'Editar hogar' : 'Censar hogar nuevo'}</h1>
      <form id="form-hogar" class="card" novalidate>
        <div class="form-row cols-2">
          <div class="field">
            <label for="h-bloque">Bloque</label>
            <select id="h-bloque" required ${bloquesVisibles.length === 1 && !esCoordinador() ? '' : ''}>
              <option value="">Selecciona…</option>
              ${bloquesVisibles.map((b) => `<option value="${esc(b.id)}" ${h0.id_bloque === b.id ? 'selected' : ''}>${esc(b.nombre)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="h-torre">Torre</label>
            <input id="h-torre" type="text" placeholder="Ej. F" value="${esc(h0.id_torre || '')}">
          </div>
        </div>
        <div class="form-row cols-2">
          <div class="field">
            <label for="h-apto">Apartamento / unidad</label>
            <input id="h-apto" type="text" value="${esc(h0.apartamento_unidad || '')}">
          </div>
          <div class="field">
            <label for="h-jefe">Nombre del jefe de hogar</label>
            <input id="h-jefe" type="text" required value="${esc(h0.nombre_jefe_hogar || '')}">
          </div>
        </div>
        <div class="field">
          <label for="h-tel">Teléfono</label>
          <input id="h-tel" type="tel" inputmode="numeric" value="${esc(h0.telefono || '')}">
        </div>

        <div class="section-title">Composición del hogar</div>
        <div class="counter-grid">
          ${contadorHTML('mujeres_adultas', 'Mujeres', h0.mujeres_adultas)}
          ${contadorHTML('hombres_adultos', 'Hombres', h0.hombres_adultos)}
          ${contadorHTML('ninas', 'Niñas', h0.ninas)}
          ${contadorHTML('ninos', 'Niños', h0.ninos)}
          ${contadorHTML('abuelas', 'Abuelas', h0.abuelas)}
          ${contadorHTML('abuelos', 'Abuelos', h0.abuelos)}
        </div>
        <div class="total-personas-box">
          <span>Total de personas</span>
          <span class="num" id="total-personas">0</span>
        </div>

        <div class="section-title">Mascotas</div>
        <div class="counter-grid">
          ${contadorHTML('mascota_perro', 'Perros', mascotasPorTipo.perro)}
          ${contadorHTML('mascota_gato', 'Gatos', mascotasPorTipo.gato)}
          ${contadorHTML('mascota_otro', 'Otras', mascotasPorTipo.otro)}
        </div>

        <div class="section-title">Necesidad especial</div>
        <div class="switch-row">
          <label for="h-medica" style="margin:0;">¿Afectación médica o necesidad especial?</label>
          <span class="switch">
            <input id="h-medica" type="checkbox" ${h0.tiene_afectacion_medica ? 'checked' : ''}>
            <span class="track"></span><span class="thumb"></span>
          </span>
        </div>
        <div class="field" id="campo-descripcion-medica" style="${h0.tiene_afectacion_medica ? '' : 'display:none;'} margin-top:12px;">
          <label for="h-descripcion">Descripción corta</label>
          <input id="h-descripcion" type="text" maxlength="140" value="${esc(h0.requerimiento_prioritario || '')}">
        </div>

        <div class="field" style="margin-top:24px;">
          <label for="h-obs">Observaciones (opcional)</label>
          <textarea id="h-obs">${esc(h0.observaciones || '')}</textarea>
        </div>

        <p class="error-text" id="form-hogar-error" role="alert" aria-live="polite"></p>
        <div class="flex-gap mt-4">
          <button class="btn btn-primary" type="submit" id="btn-guardar-hogar">${idHogar ? 'Guardar cambios' : 'Guardar hogar'}</button>
          <a class="btn btn-ghost" href="#/censo">Cancelar</a>
        </div>
      </form>`;

    const form = qs('#form-hogar', root);
    function recalcularTotal() {
      const total = ['mujeres_adultas', 'hombres_adultos', 'ninas', 'ninos', 'abuelas', 'abuelos']
        .reduce((s, n) => s + valorContador(form, n), 0);
      qs('#total-personas', root).textContent = total;
    }
    activarContadores(form, recalcularTotal);
    recalcularTotal();

    qs('#h-medica', root).addEventListener('change', (e) => {
      qs('#campo-descripcion-medica', root).style.display = e.target.checked ? '' : 'none';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = qs('#btn-guardar-hogar', root);
      const errBox = qs('#form-hogar-error', root);
      errBox.textContent = '';
      const idBloque = qs('#h-bloque', root).value;
      const jefe = qs('#h-jefe', root).value.trim();
      if (!idBloque) { errBox.textContent = 'Selecciona el bloque.'; return; }
      if (!jefe) { errBox.textContent = 'Escribe el nombre del jefe de hogar.'; return; }
      if (!esCoordinador() && !misBloques().includes(idBloque)) { errBox.textContent = 'No tienes permiso para censar en ese bloque.'; return; }

      const payload = {
        id_bloque: idBloque,
        id_torre: qs('#h-torre', root).value.trim() || null,
        apartamento_unidad: qs('#h-apto', root).value.trim(),
        nombre_jefe_hogar: jefe,
        telefono: qs('#h-tel', root).value.trim(),
        mujeres_adultas: valorContador(form, 'mujeres_adultas'),
        hombres_adultos: valorContador(form, 'hombres_adultos'),
        ninas: valorContador(form, 'ninas'),
        ninos: valorContador(form, 'ninos'),
        abuelas: valorContador(form, 'abuelas'),
        abuelos: valorContador(form, 'abuelos'),
        tiene_afectacion_medica: qs('#h-medica', root).checked,
        requerimiento_prioritario: qs('#h-medica', root).checked ? qs('#h-descripcion', root).value.trim() : null,
        observaciones: qs('#h-obs', root).value.trim() || null
      };
      const perrosGatosOtro = {
        perro: valorContador(form, 'mascota_perro'),
        gato: valorContador(form, 'mascota_gato'),
        otro: valorContador(form, 'mascota_otro')
      };
      payload.tiene_mascotas = Object.values(perrosGatosOtro).some((v) => v > 0);

      btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        let hogarId = idHogar;
        if (idHogar) {
          await DB.actualizarHogar(idHogar, payload);
        } else {
          payload.lider_que_censo = state.perfil.id;
          const creado = await DB.crearHogar(payload);
          hogarId = creado.id;
        }
        const mascotasFilas = Object.entries(perrosGatosOtro).filter(([, c]) => c > 0).map(([tipo, cantidad]) => ({ tipo, cantidad }));
        await DB.reemplazarMascotas(hogarId, mascotasFilas);
        toast('Hogar guardado', 'success');
        location.hash = '#/censo';
      } catch (ex) {
        errBox.textContent = errorAmigable(ex);
      } finally {
        btn.disabled = false; btn.textContent = idHogar ? 'Guardar cambios' : 'Guardar hogar';
      }
    });
  }

  // =====================================================================
  // ENTREGAS (solo coordinador)
  // =====================================================================
  async function vistaEntregas(root) {
    const [hogares, tipos, entregas, inventario, lideres] = await Promise.all([
      DB.listarHogares(), DB.listarTiposAyuda(), DB.listarEntregas(30), DB.listarInventario(), DB.listarLideres()
    ]);
    state.tiposAyuda = tipos;

    root.innerHTML = `
      <h1>Registrar entrega de ayuda</h1>
      <form id="form-entrega" class="card" novalidate>
        <div class="field">
          <label for="e-buscar">Buscar hogar (apto, nombre o teléfono)</label>
          <input id="e-buscar" type="search" autocomplete="off" placeholder="Escribe para buscar…">
          <div id="e-resultados" role="listbox" aria-label="Resultados"></div>
        </div>
        <div id="e-hogar-seleccionado" class="text-sm text-muted"></div>
        <input type="hidden" id="e-hogar-id">

        <div class="section-title">Tipos de ayuda entregados</div>
        <div class="chip-group" id="e-chips">
          ${tipos.map((t) => `<button type="button" class="chip" data-tipo="${t.id}" data-nombre="${esc(t.nombre)}">${esc(t.nombre)}</button>`).join('')}
        </div>
        <div id="e-detalle-cantidades" class="mt-4"></div>

        <div class="section-title">Quién recibió</div>
        <div class="form-row cols-2">
          <div class="field">
            <label for="e-lider">Líder que recibe/reparte (opcional)</label>
            <select id="e-lider"><option value="">— No aplica —</option>${lideres.map((l) => `<option value="${l.id}">${esc(l.nombre)}</option>`).join('')}</select>
          </div>
          <div class="field">
            <label for="e-nombre-recibe">Nombre de quien firma/recibe (opcional)</label>
            <input id="e-nombre-recibe" type="text">
          </div>
        </div>
        <div class="field">
          <label for="e-foto">Foto de evidencia (opcional)</label>
          <input id="e-foto" type="file" accept="image/*" capture="environment">
        </div>
        <div class="field">
          <label for="e-obs">Observaciones (opcional)</label>
          <textarea id="e-obs"></textarea>
        </div>

        <p class="error-text" id="form-entrega-error" role="alert" aria-live="polite"></p>
        <button class="btn btn-primary" type="submit" id="btn-guardar-entrega">Registrar entrega</button>
      </form>

      <div class="section-title">Entregas recientes</div>
      <div class="card">
        ${entregas.length === 0 ? '<p class="text-muted">Aún no hay entregas registradas.</p>' :
          `<div class="table-scroll"><table class="data-table">
            <thead><tr><th>Fecha</th><th>Hogar</th><th>Bloque</th><th>Ayuda</th><th>Evidencia</th></tr></thead>
            <tbody>${entregas.map((e) => `
              <tr>
                <td>${fmtFecha(e.fecha_hora)}</td>
                <td>${esc(e.hogares?.nombre_jefe_hogar || '—')}</td>
                <td>${esc(e.id_bloque)}</td>
                <td>${(e.entrega_items || []).map((it) => `${esc(it.tipos_ayuda?.nombre)}${it.cantidad > 1 ? ' x' + it.cantidad : ''}`).join(', ') || '—'}</td>
                <td>${e.foto_evidencia_url ? `<a href="${e.foto_evidencia_url}" target="_blank" rel="noopener">Ver foto</a>` : '—'}</td>
              </tr>`).join('')}</tbody>
          </table></div>`}
      </div>`;

    let hogarSeleccionado = null;
    const tiposSeleccionados = new Set();

    const buscarInput = qs('#e-buscar', root);
    const resultadosBox = qs('#e-resultados', root);
    buscarInput.addEventListener('input', debounce(() => {
      const q = buscarInput.value.trim().toLowerCase();
      if (q.length < 2) { resultadosBox.innerHTML = ''; return; }
      const encontrados = hogares.filter((h) =>
        `${h.nombre_jefe_hogar} ${h.apartamento_unidad} ${h.telefono}`.toLowerCase().includes(q)
      ).slice(0, 8);
      resultadosBox.innerHTML = encontrados.map((h) =>
        `<div class="hogar-row" style="margin-top:6px;" data-elegir="${h.id}">
          <div class="info-main"><span class="title">${esc(h.nombre_jefe_hogar)}</span>
          <span class="subtitle">Bloque ${esc(h.id_bloque)} · Apto ${esc(h.apartamento_unidad || '—')}</span></div>
        </div>`).join('') || '<p class="text-muted text-sm">Sin resultados.</p>';
    }, 200));

    resultadosBox.addEventListener('click', (e) => {
      const row = e.target.closest('[data-elegir]');
      if (!row) return;
      hogarSeleccionado = hogares.find((h) => h.id === row.dataset.elegir);
      qs('#e-hogar-id', root).value = hogarSeleccionado.id;
      qs('#e-hogar-seleccionado', root).innerHTML = `Hogar seleccionado: <strong>${esc(hogarSeleccionado.nombre_jefe_hogar)}</strong> (Bloque ${esc(hogarSeleccionado.id_bloque)}, Apto ${esc(hogarSeleccionado.apartamento_unidad || '—')})`;
      buscarInput.value = '';
      resultadosBox.innerHTML = '';
    });

    function actualizarDetalleCantidades() {
      const tiposConDetalle = tipos.filter((t) => tiposSeleccionados.has(t.id) && ['Pañales', 'Insumos médicos', 'Mercado'].includes(t.nombre));
      const box = qs('#e-detalle-cantidades', root);
      box.innerHTML = tiposConDetalle.map((t) => `
        <div class="field">
          <label for="cant-${t.id}">${esc(t.nombre)} — ${esc(t.campo_adicional || 'cantidad')} (opcional)</label>
          <input id="cant-${t.id}" type="text" data-cantidad-tipo="${t.id}" placeholder="Ej. 2">
        </div>`).join('');
    }

    qs('#e-chips', root).addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const id = chip.dataset.tipo;
      if (tiposSeleccionados.has(id)) { tiposSeleccionados.delete(id); chip.classList.remove('selected'); }
      else { tiposSeleccionados.add(id); chip.classList.add('selected'); }
      actualizarDetalleCantidades();
    });

    qs('#form-entrega', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = qs('#form-entrega-error', root);
      errBox.textContent = '';
      if (!hogarSeleccionado) { errBox.textContent = 'Busca y selecciona el hogar que recibe la ayuda.'; return; }
      if (tiposSeleccionados.size === 0) { errBox.textContent = 'Marca al menos un tipo de ayuda entregado.'; return; }

      const btn = qs('#btn-guardar-entrega', root);
      btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        const entrega = await DB.crearEntrega({
          id_hogar: hogarSeleccionado.id,
          id_bloque: hogarSeleccionado.id_bloque,
          id_torre: hogarSeleccionado.id_torre,
          entregado_por: state.perfil.id,
          recibido_por_lider: qs('#e-lider', root).value || null,
          nombre_quien_recibio: qs('#e-nombre-recibe', root).value.trim() || null,
          observaciones: qs('#e-obs', root).value.trim() || null
        }, Array.from(tiposSeleccionados).map((tid) => {
          const inputCant = qs(`[data-cantidad-tipo="${tid}"]`, root);
          const itemInv = inventario.find((i) => i.tipo_ayuda_id === tid);
          return { tipo_ayuda_id: tid, item_inventario_id: itemInv ? itemInv.id : null, cantidad: itemInv && inputCant?.value ? Number(inputCant.value) || 1 : 1, detalle: inputCant ? inputCant.value : null };
        }));

        const foto = qs('#e-foto', root).files[0];
        if (foto) {
          const url = await DB.subirEvidencia(foto, entrega.id);
          await DB.client.from('entregas').update({ foto_evidencia_url: url }).eq('id', entrega.id);
        }
        toast('Entrega registrada', 'success');
        router();
      } catch (ex) {
        errBox.textContent = errorAmigable(ex);
      } finally {
        btn.disabled = false; btn.textContent = 'Registrar entrega';
      }
    });
  }

  // =====================================================================
  // INVENTARIO (solo coordinador)
  // =====================================================================
  async function vistaInventario(root) {
    const [items, tipos] = await Promise.all([DB.listarInventario(), DB.listarTiposAyuda()]);

    root.innerHTML = `
      <div class="flex-between">
        <h1>Inventario</h1>
        <button class="btn btn-primary" id="btn-nuevo-item" type="button">+ Nuevo ítem</button>
      </div>
      <div class="hogar-list">
        ${items.map((i) => {
          const alcanza = i.dimensionado_por_persona
            ? Math.floor(Number(i.cantidad_disponible) / Number(i.personas_por_unidad || 1))
            : Math.floor(Number(i.cantidad_disponible));
          const bajo = Number(i.cantidad_disponible) <= Number(i.stock_minimo);
          return `
          <div class="card" style="margin-bottom:12px;">
            <div class="flex-between">
              <div>
                <strong>${esc(i.nombre)}</strong>
                <div class="text-sm text-muted">${esc(i.tipos_ayuda?.nombre || 'Sin tipo asociado')}</div>
              </div>
              ${bajo ? '<span class="badge badge-warning">Stock bajo</span>' : '<span class="badge badge-success">OK</span>'}
            </div>
            <p class="mt-4" style="margin-bottom:4px;">Disponible: <strong>${i.cantidad_disponible} ${esc(i.unidad)}</strong></p>
            <p class="text-sm text-muted">Alcanza para aproximadamente <strong>${alcanza} familia${alcanza === 1 ? '' : 's'}</strong> más${i.dimensionado_por_persona ? ` (calculado por ${i.personas_por_unidad} persona(s) por unidad)` : ''}.</p>
            <div class="flex-gap mt-4">
              <button class="btn btn-sm btn-secondary" data-entrada="${i.id}" type="button">Registrar entrada de stock</button>
              <button class="btn btn-sm btn-ghost" data-editar="${i.id}" type="button">Editar mínimos</button>
            </div>
          </div>`;
        }).join('') || '<div class="empty-state"><div class="icon">📦</div><h3>Sin ítems</h3><p>Crea el primer ítem de inventario.</p></div>'}
      </div>`;

    root.addEventListener('click', async (e) => {
      const btnEntrada = e.target.closest('[data-entrada]');
      const btnEditar = e.target.closest('[data-editar]');
      const btnNuevo = e.target.closest('#btn-nuevo-item');

      if (btnEntrada) {
        const cantidad = prompt('¿Cuántas unidades llegaron?');
        if (!cantidad || isNaN(Number(cantidad)) || Number(cantidad) <= 0) return;
        try {
          await DB.registrarEntradaInventario(btnEntrada.dataset.entrada, Number(cantidad), 'Ingreso de mercancía', state.perfil.id);
          toast('Stock actualizado', 'success');
          router();
        } catch (ex) { toast(errorAmigable(ex), 'error'); }
      }
      if (btnEditar) {
        const item = items.find((i) => i.id === btnEditar.dataset.editar);
        const nuevoMin = prompt('Nuevo stock mínimo:', item.stock_minimo);
        if (nuevoMin === null) return;
        try { await DB.actualizarItemInventario(item.id, { stock_minimo: Number(nuevoMin) || 0 }); toast('Actualizado', 'success'); router(); }
        catch (ex) { toast(errorAmigable(ex), 'error'); }
      }
      if (btnNuevo) {
        const nombre = prompt('Nombre del nuevo ítem (ej. "Kit escolar"):');
        if (!nombre) return;
        try {
          await DB.crearItemInventario({ nombre, unidad: 'unidad', cantidad_disponible: 0, stock_minimo: 5 });
          toast('Ítem creado', 'success'); router();
        } catch (ex) { toast(errorAmigable(ex), 'error'); }
      }
    });
  }

  // =====================================================================
  // CATÁLOGO DE AYUDAS (solo coordinador)
  // =====================================================================
  async function vistaCatalogo(root) {
    const tipos = await DB.listarTiposAyuda(false);
    root.innerHTML = `
      <div class="flex-between">
        <h1>Catálogo de tipos de ayuda</h1>
        <button class="btn btn-primary" id="btn-nuevo-tipo" type="button">+ Nuevo tipo</button>
      </div>
      <div class="table-scroll card">
        <table class="data-table">
          <thead><tr><th>Nombre</th><th>Campo adicional</th><th>Estado</th><th></th></tr></thead>
          <tbody>${tipos.map((t) => `
            <tr>
              <td>${esc(t.nombre)}</td>
              <td>${esc(t.campo_adicional || '—')}</td>
              <td>${t.activo ? '<span class="badge badge-success">Activo</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td>
              <td><button class="btn btn-sm btn-ghost" data-toggle="${t.id}" data-activo="${t.activo}" type="button">${t.activo ? 'Desactivar' : 'Activar'}</button></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;

    root.addEventListener('click', async (e) => {
      const btnNuevo = e.target.closest('#btn-nuevo-tipo');
      const btnToggle = e.target.closest('[data-toggle]');
      if (btnNuevo) {
        const nombre = prompt('Nombre del nuevo tipo de ayuda (ej. "Ropa"):');
        if (!nombre) return;
        const campo = prompt('Campo adicional a pedir (opcional, ej. "talla y cantidad"):') || null;
        try { await DB.crearTipoAyuda({ nombre, campo_adicional: campo, orden: tipos.length + 1 }); toast('Creado', 'success'); router(); }
        catch (ex) { toast(errorAmigable(ex), 'error'); }
      }
      if (btnToggle) {
        try { await DB.actualizarTipoAyuda(btnToggle.dataset.toggle, { activo: btnToggle.dataset.activo !== 'true' }); router(); }
        catch (ex) { toast(errorAmigable(ex), 'error'); }
      }
    });
  }

  // =====================================================================
  // ADMINISTRACIÓN — bloques / torres / líderes (solo coordinador)
  // =====================================================================
  async function vistaAdministracion(root) {
    const [bloques, torres, lideres, hogares] = await Promise.all([
      DB.listarBloques(), DB.listarTorres(), DB.listarLideres(), DB.listarHogares()
    ]);

    root.innerHTML = `
      <h1>Administración</h1>

      <div class="card">
        <div class="card-header"><h2>Importar censo inicial</h2></div>
        <p class="text-muted text-sm">Carga los 202 hogares del censo original en un solo paso. Se omiten automáticamente los que ya estén importados (no duplica).</p>
        <div class="progress-bar-track mt-4" id="import-progreso-track" style="display:none;"><div class="progress-bar-fill" id="import-progreso-fill" style="width:0%"></div></div>
        <p class="text-sm" id="import-progreso-texto"></p>
        <button class="btn btn-primary mt-4" id="btn-importar" type="button" ${hogares.some((h) => h.censo_inicial_importado) ? 'disabled' : ''}>
          ${hogares.some((h) => h.censo_inicial_importado) ? 'Censo inicial ya importado' : 'Importar censo inicial (202 hogares)'}
        </button>
      </div>

      <div class="card">
        <div class="card-header"><h2>Bloques</h2><button class="btn btn-sm btn-secondary" id="btn-nuevo-bloque" type="button">+ Bloque</button></div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>ID</th><th>Nombre</th><th>Hogares censados</th></tr></thead>
          <tbody>${bloques.map((b) => `<tr><td>${esc(b.id)}</td><td>${esc(b.nombre)}</td><td>${hogares.filter((h) => h.id_bloque === b.id).length}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Torres</h2><button class="btn btn-sm btn-secondary" id="btn-nueva-torre" type="button">+ Torre</button></div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>ID</th><th>Bloque</th><th>Letra</th></tr></thead>
          <tbody>${torres.map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.id_bloque)}</td><td>${esc(t.letra_torre)}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted">Sin torres registradas todavía.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Líderes de bloque</h2><button class="btn btn-sm btn-secondary" id="btn-nuevo-lider" type="button">+ Líder</button></div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Nombre</th><th>Teléfono</th><th>Bloques</th><th>Estado</th></tr></thead>
          <tbody>${lideres.map((l) => `<tr><td>${esc(l.nombre)}</td><td>${esc(l.telefono)}</td><td>${(l.bloques_permitidos || []).join(', ') || '—'}</td><td>${l.activo ? '<span class="badge badge-success">Activo</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">Sin líderes registrados todavía.</td></tr>'}</tbody>
        </table></div>
      </div>`;

    qs('#btn-importar', root)?.addEventListener('click', async () => {
      const ok = await confirmar('Se importarán hasta 202 hogares del censo original. Esto puede tardar un minuto. ¿Continuar?', { textoOk: 'Importar' });
      if (!ok) return;
      const btn = qs('#btn-importar', root);
      const track = qs('#import-progreso-track', root);
      const fill = qs('#import-progreso-fill', root);
      const texto = qs('#import-progreso-texto', root);
      btn.disabled = true; track.style.display = 'block';
      try {
        const { importados, omitidos } = await DB.importarHogaresIniciales(window.SEED_HOGARES, state.perfil.id, (imp, om, total) => {
          const pct = Math.round(((imp + om) / total) * 100);
          fill.style.width = pct + '%';
          texto.textContent = `Procesando ${imp + om} de ${total}… (${imp} importados, ${om} ya existían)`;
        });
        toast(`Importación completa: ${importados} hogares importados, ${omitidos} ya existían.`, 'success');
        router();
      } catch (ex) {
        toast(errorAmigable(ex), 'error');
        btn.disabled = false;
      }
    });

    qs('#btn-nuevo-bloque', root).addEventListener('click', async () => {
      const id = prompt('ID del bloque (ej. "8"):'); if (!id) return;
      const nombre = prompt('Nombre a mostrar (ej. "Bloque 8"):', `Bloque ${id}`); if (!nombre) return;
      try { await DB.crearBloque({ id, nombre }); toast('Bloque creado', 'success'); router(); }
      catch (ex) { toast(errorAmigable(ex), 'error'); }
    });

    qs('#btn-nueva-torre', root).addEventListener('click', async () => {
      const idBloque = prompt('¿En qué bloque va la torre? (ID del bloque):'); if (!idBloque) return;
      const letra = prompt('Letra de la torre (ej. "F"):'); if (!letra) return;
      try { await DB.crearTorre({ id: `${idBloque}-${letra}`, id_bloque: idBloque, letra_torre: letra }); toast('Torre creada', 'success'); router(); }
      catch (ex) { toast(errorAmigable(ex), 'error'); }
    });

    qs('#btn-nuevo-lider', root).addEventListener('click', () => abrirModalNuevoLider(bloques));
  }

  function abrirModalNuevoLider(bloques) {
    const backdrop = h(`
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Nuevo líder">
        <div class="modal-box">
          <h3>Nuevo líder de bloque</h3>
          <div class="field"><label for="nl-nombre">Nombre completo</label><input id="nl-nombre" type="text"></div>
          <div class="field"><label for="nl-tel">Teléfono (será su usuario)</label><input id="nl-tel" type="tel" inputmode="numeric"></div>
          <div class="field"><label for="nl-pin">PIN de 6 dígitos</label><input id="nl-pin" type="password" inputmode="numeric" maxlength="6"></div>
          <div class="field">
            <label>Bloques asignados</label>
            <div class="chip-group">${bloques.map((b) => `<button type="button" class="chip" data-bloque-chip="${esc(b.id)}">${esc(b.nombre)}</button>`).join('')}</div>
          </div>
          <p class="error-text" id="nl-error" role="alert" aria-live="polite"></p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
            <button type="button" class="btn btn-primary" id="nl-guardar">Crear líder</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(backdrop);
    const bloquesElegidos = new Set();
    qsa('[data-bloque-chip]', backdrop).forEach((chip) => chip.addEventListener('click', () => {
      const id = chip.dataset.bloqueChip;
      if (bloquesElegidos.has(id)) { bloquesElegidos.delete(id); chip.classList.remove('selected'); }
      else { bloquesElegidos.add(id); chip.classList.add('selected'); }
    }));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-cancel]')) backdrop.remove(); });
    qs('#nl-guardar', backdrop).addEventListener('click', async () => {
      const nombre = qs('#nl-nombre', backdrop).value.trim();
      const telefono = qs('#nl-tel', backdrop).value.trim();
      const pin = qs('#nl-pin', backdrop).value.trim();
      const err = qs('#nl-error', backdrop);
      if (!nombre || !telefono || pin.length !== 6 || bloquesElegidos.size === 0) {
        err.textContent = 'Completa nombre, teléfono, un PIN de 6 dígitos y al menos un bloque.'; return;
      }
      try {
        await DB.crearLider({ nombre, telefono, pin, bloques: Array.from(bloquesElegidos) });
        toast('Líder creado. Ya puede iniciar sesión con su teléfono y PIN.', 'success');
        backdrop.remove();
        router();
      } catch (ex) { err.textContent = errorAmigable(ex); }
    });
  }

  // =====================================================================
  // REPORTES (solo coordinador)
  // =====================================================================
  async function vistaReportes(root) {
    root.innerHTML = `
      <h1>Reportes</h1>
      <div class="card">
        <h2>Exportar a CSV</h2>
        <p class="text-muted text-sm">Descarga los datos actuales para abrirlos en Excel o Google Sheets.</p>
        <div class="flex-gap">
          <button class="btn btn-secondary" id="exp-hogares" type="button">Censo de hogares</button>
          <button class="btn btn-secondary" id="exp-entregas" type="button">Entregas</button>
          <button class="btn btn-secondary" id="exp-inventario" type="button">Inventario</button>
        </div>
      </div>`;

    qs('#exp-hogares', root).addEventListener('click', async () => {
      const hogares = await DB.listarHogares();
      exportarCSV('censo_hogares.csv', hogares, [
        { titulo: 'Bloque', valor: (h) => h.id_bloque },
        { titulo: 'Torre', valor: (h) => h.id_torre },
        { titulo: 'Apto', valor: (h) => h.apartamento_unidad },
        { titulo: 'Jefe de hogar', valor: (h) => h.nombre_jefe_hogar },
        { titulo: 'Teléfono', valor: (h) => h.telefono },
        { titulo: 'Total personas', valor: (h) => h.total_personas },
        { titulo: 'Afectación médica', valor: (h) => h.tiene_afectacion_medica ? 'Sí' : 'No' },
        { titulo: 'Descripción', valor: (h) => h.requerimiento_prioritario },
        { titulo: 'Mascotas', valor: (h) => h.tiene_mascotas ? 'Sí' : 'No' },
        { titulo: 'Fecha censo', valor: (h) => h.fecha_censo }
      ]);
    });

    qs('#exp-entregas', root).addEventListener('click', async () => {
      const entregas = await DB.listarEntregas(1000);
      exportarCSV('entregas.csv', entregas, [
        { titulo: 'Fecha', valor: (e) => e.fecha_hora },
        { titulo: 'Hogar', valor: (e) => e.hogares?.nombre_jefe_hogar },
        { titulo: 'Bloque', valor: (e) => e.id_bloque },
        { titulo: 'Ayudas', valor: (e) => (e.entrega_items || []).map((it) => it.tipos_ayuda?.nombre).join(' / ') },
        { titulo: 'Quién recibió', valor: (e) => e.nombre_quien_recibio }
      ]);
    });

    qs('#exp-inventario', root).addEventListener('click', async () => {
      const items = await DB.listarInventario();
      exportarCSV('inventario.csv', items, [
        { titulo: 'Ítem', valor: (i) => i.nombre },
        { titulo: 'Disponible', valor: (i) => i.cantidad_disponible },
        { titulo: 'Unidad', valor: (i) => i.unidad },
        { titulo: 'Stock mínimo', valor: (i) => i.stock_minimo }
      ]);
    });
  }

  // =====================================================================
  // Arranque
  // =====================================================================
  async function bootstrapSesion() {
    const sesion = await DB.sesionActual();
    state.session = sesion;
    if (!sesion) { renderLogin(); return; }
    try {
      state.perfil = await DB.miPerfil();
    } catch (ex) {
      toast(errorAmigable(ex), 'error');
      await DB.cerrarSesion();
      renderLogin();
      return;
    }
    if (!state.perfil) {
      qs('#app-root').innerHTML = `<div class="login-wrap"><div class="login-card"><p class="error-text">Tu usuario no tiene un perfil asignado todavía. Pide al coordinador que lo cree.</p><button class="btn btn-secondary btn-block mt-4" id="btn-volver">Volver</button></div></div>`;
      qs('#btn-volver').addEventListener('click', async () => { await DB.cerrarSesion(); window.location.reload(); });
      return;
    }
    if (state.unsubscribeRealtime) state.unsubscribeRealtime();
    state.unsubscribeRealtime = DB.suscribirCambios(() => router());
    router();
  }

  function actualizarBannerConexion() {
    const banner = qs('#offline-banner');
    banner.classList.toggle('visible', !navigator.onLine);
  }
  window.addEventListener('online', actualizarBannerConexion);
  window.addEventListener('offline', actualizarBannerConexion);

  document.addEventListener('DOMContentLoaded', async () => {
    actualizarBannerConexion();
    await bootstrapSesion();
  });
})();
