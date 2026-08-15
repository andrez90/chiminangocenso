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
  function telHref(telefono) {
    const limpio = String(telefono || '').replace(/[^\d+]/g, '');
    return limpio ? `tel:${limpio}` : '';
  }
  function normTelSimple(telefono) { return String(telefono || '').replace(/\D/g, ''); }
  // Enlace de llamada real (<a href="tel:">) para contextos que NO están
  // dentro de otro <a> (ej. celdas de tabla).
  function telLinkHTML(telefono) {
    if (!telefono) return 'Sin teléfono';
    return `<a href="${esc(telHref(telefono))}" class="tel-link">${esc(telefono)}</a>`;
  }
  // Versión para contextos que SÍ están dentro de otro <a> (ej. la card
  // de un hogar, que es un <a> completo): un <a> anidado sería HTML
  // inválido, así que se pinta como span clicable y el click se resuelve
  // por delegación en el contenedor (ver vistaCensoLista).
  function telSpanHTML(telefono) {
    if (!telefono) return 'Sin teléfono';
    return `<span class="tel-link" data-tel="${esc(telHref(telefono))}">${esc(telefono)}</span>`;
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
  // Cada valor tiene el mismo formato que torres.id: "<id_bloque>-<numero_agrupacion>-<letra>"
  // (ej. "3-1-A"), porque una letra de torre solo existe dentro de una
  // agrupación y un sector específicos — no hay "Torre A" global.
  function misTorres() { return state.perfil ? (state.perfil.torres_permitidas || []) : []; }
  function claveTorreHogar(h) { return `${h.id_agrupacion || ''}-${h.id_torre || ''}`; }
  function puedeVerHogar(h) {
    return esCoordinador() || misBloques().includes(h.id_bloque) || misTorres().includes(claveTorreHogar(h));
  }
  // Sectores a los que un líder de torre tiene acceso (derivados de sus torres asignadas)
  function misBloquesPorTorre() {
    return Array.from(new Set(misTorres().map((t) => t.split('-')[0])));
  }
  // Agrupaciones (ids completos "<bloque>-<numero>") a las que un líder de
  // torre tiene acceso, opcionalmente limitado a un sector.
  function misAgrupacionesPorTorre(idBloque) {
    return Array.from(new Set(
      misTorres()
        .filter((t) => !idBloque || t.split('-')[0] === idBloque)
        .map((t) => t.split('-').slice(0, 2).join('-'))
    ));
  }
  // Letras de torre permitidas dentro de una agrupación específica.
  function misLetrasPorAgrupacion(idAgrupacion) {
    return misTorres()
      .filter((t) => t.startsWith(`${idAgrupacion}-`))
      .map((t) => t.slice(idAgrupacion.length + 1));
  }

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
    return [['#/censo', 'Censo de mi torre']];
  }

  function renderChrome(hashActivo) {
    const root = qs('#app-root');
    if (!qs('#view-root')) {
      root.innerHTML = `
        <header class="app-header">
          <div class="brand"><span class="brand-badge" aria-hidden="true">🏠</span><span class="brand-text">Censo Albergue Chimi</span></div>
          <div class="user-box">
            <span>${esc(state.perfil.nombre)}</span>
            <span class="rol-badge">${state.perfil.rol === 'coordinador' ? 'Coordinador' : 'Líder de torre'}</span>
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
    const duplicados = DB.detectarDuplicados(hogares);

    root.innerHTML = `
      <h1>Panel del coordinador</h1>
      <div class="metrics-grid">
        <div class="metric-card"><div class="metric-value">${hogares.length}</div><div class="metric-label">Hogares censados (de 203 esperados)</div></div>
        <div class="metric-card"><div class="metric-value">${totalPersonas}</div><div class="metric-label">Personas registradas</div></div>
        <div class="metric-card"><div class="metric-value">${bloquesConHogares.size}</div><div class="metric-label">Sectores con censo activo</div></div>
        <div class="metric-card"><div class="metric-value">${entregas.length}</div><div class="metric-label">Entregas recientes</div></div>
      </div>

      <div class="section-title">Posibles hogares repetidos</div>
      <div class="card">
        ${duplicados.length === 0
          ? '<p class="text-muted">No se detectaron hogares repetidos (mismo sector, apto y jefe de hogar).</p>'
          : `<div class="alert-list">${duplicados.map((grupo) => `
              <div class="alert-item warning">
                <div><strong>${esc(grupo[0].nombre_jefe_hogar)}</strong><div class="text-sm text-muted">Sector ${esc(grupo[0].id_bloque)} · Apto ${esc(grupo[0].apartamento_unidad || '—')} · ${grupo.length} registros iguales</div></div>
                <a class="btn btn-sm btn-secondary" href="${rutaHogarEditar(grupo[0].id)}">Revisar</a>
              </div>`).join('')}</div>`}
      </div>

      <div class="section-title">Alertas de necesidad médica (pendientes hace más de 48h)</div>
      <div class="card">
        ${alertasMedicas48h.length === 0
          ? '<p class="text-muted">No hay alertas pendientes. Buen trabajo.</p>'
          : `<div class="alert-list">${alertasMedicas48h.map((n) => `
              <div class="alert-item">
                <div>
                  <strong>${esc(n.hogares?.nombre_jefe_hogar || 'Hogar')}</strong>
                  <div class="text-sm text-muted">Sector ${esc(n.hogares?.id_bloque)} · Apto ${esc(n.hogares?.apartamento_unidad || '—')} · ${esc(n.descripcion || 'Sin descripción')}</div>
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
            <thead><tr><th>Fecha</th><th>Destino</th><th>Sector</th><th>Ayuda</th></tr></thead>
            <tbody>${entregas.map((e) => `
              <tr>
                <td>${fmtFecha(e.fecha_hora)}</td>
                <td>${e.id_hogar ? esc(e.hogares?.nombre_jefe_hogar || '—') : `Entrega grupal${e.id_torre ? ' — Torre ' + esc(e.id_torre) : ''}`}</td>
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
  let filtroHogares = { bloque: '', torre: '', texto: '', mascotas: '', medica: '', lider: '', agrupacion: '' };

  function filaHogarHTML(h, agrupacionPorId) {
    const agrupacion = h.id_agrupacion ? agrupacionPorId.get(h.id_agrupacion) : null;
    return `
      <a class="hogar-row ${h.es_lider ? 'hogar-row--lider' : ''}" href="${rutaHogarEditar(h.id)}">
        <div class="info-main">
          <span class="title">${esc(h.nombre_jefe_hogar || '(Sin nombre)')}</span>
          <span class="subtitle">Sector ${esc(h.id_bloque)}${agrupacion ? ' · Agrupación ' + esc(agrupacion.numero) : ''}${h.id_torre ? ' · Torre ' + esc(h.id_torre) : ''} · Apto ${esc(h.apartamento_unidad || '—')} · ${telSpanHTML(h.telefono)}</span>
        </div>
        <div class="info-side">
          ${h.es_lider ? '<span class="badge badge-warning">Líder</span>' : ''}
          ${h.tiene_afectacion_medica ? '<span class="badge badge-danger">Médica</span>' : ''}
          ${h.tiene_mascotas ? '<span class="badge badge-neutral">🐾</span>' : ''}
          <span class="badge badge-primary">${h.total_personas ?? ((h.legacy_ninos_sin_sexo || 0) + (h.legacy_adultos_sin_sexo || 0))} pers.</span>
        </div>
      </a>`;
  }

  async function vistaCensoLista(root) {
    const [hogares, bloques, agrupaciones] = await Promise.all([DB.listarHogares(), DB.listarBloques(), DB.listarAgrupaciones()]);
    state.bloques = bloques;
    const bloquesVisibles = esCoordinador() ? bloques : bloques.filter((b) => misBloques().includes(b.id) || misBloquesPorTorre().includes(b.id));
    const agrupacionesVisibles = esCoordinador() ? agrupaciones : agrupaciones.filter((a) => misBloques().includes(a.id_bloque) || misAgrupacionesPorTorre().includes(a.id));
    const agrupacionPorId = new Map(agrupaciones.map((a) => [a.id, a]));
    const duplicados = DB.detectarDuplicados(esCoordinador() ? hogares : hogares.filter(puedeVerHogar));

    root.innerHTML = `
      <div class="flex-between">
        <h1>Censo de hogares</h1>
        <a class="btn btn-primary" href="#/censo/nuevo">+ Censar hogar</a>
      </div>
      ${duplicados.length === 0 ? '' : `
      <details class="card" style="border-color:var(--color-warning);">
        <summary style="cursor:pointer; font-weight:700; color:var(--color-warning);">⚠️ ${duplicados.length} posible${duplicados.length === 1 ? '' : 's'} hogar${duplicados.length === 1 ? '' : 'es'} repetido${duplicados.length === 1 ? '' : 's'} (mismo sector, apto y jefe de hogar)</summary>
        <div class="hogar-list mt-4">
          ${duplicados.map((grupo) => `
            <div class="mb-0">
              <div class="text-sm text-muted" style="margin-bottom:4px;">${grupo.length} registros iguales — Sector ${esc(grupo[0].id_bloque)} · Apto ${esc(grupo[0].apartamento_unidad || '—')} · ${esc(grupo[0].nombre_jefe_hogar)}</div>
              ${grupo.map((h) => filaHogarHTML(h, agrupacionPorId)).join('')}
            </div>`).join('')}
        </div>
      </details>`}
      <div class="filter-bar card" role="search" aria-label="Filtros de búsqueda">
        <div class="field mb-0">
          <label for="f-texto">Buscar</label>
          <input id="f-texto" type="search" placeholder="Nombre, apto o teléfono" value="${esc(filtroHogares.texto)}">
        </div>
        <div class="field mb-0">
          <label for="f-bloque">Sector</label>
          <select id="f-bloque">
            <option value="">Todos</option>
            ${bloquesVisibles.map((b) => `<option value="${esc(b.id)}" ${filtroHogares.bloque === b.id ? 'selected' : ''}>${esc(b.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="field mb-0">
          <label for="f-agrupacion">Agrupación</label>
          <select id="f-agrupacion">
            <option value="">Todas</option>
            ${agrupacionesVisibles.filter((a) => !filtroHogares.bloque || a.id_bloque === filtroHogares.bloque).map((a) => `<option value="${esc(a.id)}" ${filtroHogares.agrupacion === a.id ? 'selected' : ''}>Sector ${esc(a.id_bloque)} · Agrupación ${esc(a.numero)}</option>`).join('')}
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
        <div class="field mb-0">
          <label for="f-lider">Líderes</label>
          <select id="f-lider">
            <option value="">Todos</option>
            <option value="si" ${filtroHogares.lider === 'si' ? 'selected' : ''}>Solo líderes</option>
          </select>
        </div>
      </div>
      <div id="hogar-list-region"></div>`;

    function pintar() {
      const propios = esCoordinador() ? hogares : hogares.filter(puedeVerHogar);
      const texto = filtroHogares.texto.trim().toLowerCase();
      const filtrados = propios.filter((h) => {
        if (filtroHogares.bloque && h.id_bloque !== filtroHogares.bloque) return false;
        if (filtroHogares.torre && !(h.id_torre || '').toLowerCase().includes(filtroHogares.torre.toLowerCase())) return false;
        if (filtroHogares.agrupacion && h.id_agrupacion !== filtroHogares.agrupacion) return false;
        if (filtroHogares.mascotas === 'si' && !h.tiene_mascotas) return false;
        if (filtroHogares.mascotas === 'no' && h.tiene_mascotas) return false;
        if (filtroHogares.medica === 'si' && !h.tiene_afectacion_medica) return false;
        if (filtroHogares.lider === 'si' && !h.es_lider) return false;
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

      // Agrupa por torre y ordena alfabéticamente (los sin torre al final).
      // No se arma el HTML de cada fila todavía: cada grupo se pinta la
      // primera vez que se expande, para no cargar cientos de filas de
      // una sola vez cuando el censo crezca.
      const grupos = new Map();
      filtrados.forEach((h) => {
        const clave = h.id_torre ? h.id_torre.toUpperCase() : 'Sin torre';
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(h);
      });
      const clavesOrdenadas = Array.from(grupos.keys()).sort((a, b) => {
        if (a === 'Sin torre') return 1;
        if (b === 'Sin torre') return -1;
        return a.localeCompare(b, 'es');
      });

      region.innerHTML = `<div class="hogar-groups">${clavesOrdenadas.map((clave) => `
        <details class="hogar-group" data-torre="${esc(clave)}">
          <summary>Torre ${esc(clave)} <span class="badge badge-neutral">${grupos.get(clave).length} hogar${grupos.get(clave).length === 1 ? '' : 'es'}</span></summary>
          <div class="hogar-list" data-contenido></div>
        </details>`).join('')}</div>`;

      qsa('.hogar-group', region).forEach((detalle) => {
        let pintado = false;
        detalle.addEventListener('toggle', () => {
          if (pintado || !detalle.open) return;
          pintado = true;
          const clave = detalle.dataset.torre;
          qs('[data-contenido]', detalle).innerHTML = grupos.get(clave).map((h) => filaHogarHTML(h, agrupacionPorId)).join('');
        });
      });
    }

    // Los números de teléfono se pintan dentro de la card (que ya es un
    // <a> hacia la edición del hogar); se resuelven por delegación para
    // no anidar <a> dentro de <a>, y frenan la navegación de la card.
    root.addEventListener('click', (e) => {
      const tel = e.target.closest('[data-tel]');
      if (!tel || !tel.dataset.tel) return;
      e.preventDefault();
      e.stopPropagation();
      window.location.href = tel.dataset.tel;
    });

    function repintarSelectAgrupacion() {
      const select = qs('#f-agrupacion', root);
      const disponibles = agrupacionesVisibles.filter((a) => !filtroHogares.bloque || a.id_bloque === filtroHogares.bloque);
      select.innerHTML = `<option value="">Todas</option>${disponibles.map((a) => `<option value="${esc(a.id)}">Sector ${esc(a.id_bloque)} · Agrupación ${esc(a.numero)}</option>`).join('')}`;
    }

    qs('#f-texto', root).addEventListener('input', debounce((e) => { filtroHogares.texto = e.target.value; pintar(); }, 200));
    qs('#f-bloque', root).addEventListener('change', (e) => {
      filtroHogares.bloque = e.target.value;
      filtroHogares.agrupacion = '';
      repintarSelectAgrupacion();
      pintar();
    });
    qs('#f-torre', root).addEventListener('input', debounce((e) => { filtroHogares.torre = e.target.value; pintar(); }, 200));
    qs('#f-agrupacion', root).addEventListener('change', (e) => { filtroHogares.agrupacion = e.target.value; pintar(); });
    qs('#f-mascotas', root).addEventListener('change', (e) => { filtroHogares.mascotas = e.target.value; pintar(); });
    qs('#f-medica', root).addEventListener('change', (e) => { filtroHogares.medica = e.target.value; pintar(); });
    qs('#f-lider', root).addEventListener('change', (e) => { filtroHogares.lider = e.target.value; pintar(); });
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

    const [bloques, hogarExistente, afectacionesCatalogo] = await Promise.all([
      DB.listarBloques(),
      idHogar ? DB.obtenerHogar(idHogar) : Promise.resolve(null),
      DB.listarAfectacionesCatalogo()
    ]);
    const esLiderDeTorre = !esCoordinador() && misTorres().length > 0;
    const bloquesPermitidosPorTorre = misBloquesPorTorre();
    const bloquesVisibles = esCoordinador()
      ? bloques
      : bloques.filter((b) => misBloques().includes(b.id) || bloquesPermitidosPorTorre.includes(b.id));

    const h0 = hogarExistente || {
      id_bloque: bloquesVisibles.length === 1 ? bloquesVisibles[0].id : '',
      id_agrupacion: '', id_torre: '', apartamento_unidad: '', nombre_jefe_hogar: '', telefono: '',
      mujeres_adultas: 0, hombres_adultos: 0, ninas: 0, ninos: 0, abuelas: 0, abuelos: 0,
      tiene_afectacion_medica: false, requerimiento_prioritario: '', tiene_mascotas: false, mascotas: [],
      es_lider: false, miembros_hogar: []
    };

    // Filtra el catálogo de agrupaciones/torres a lo que este usuario puede
    // ver: el coordinador ve todo lo que trae RLS, un líder de torre solo
    // sus propias agrupaciones/torres asignadas (defensa en profundidad,
    // RLS ya restringe por sector pero no hasta la agrupación/torre exacta).
    function filtrarAgrupaciones(lista, idBloque) {
      if (esCoordinador()) return lista;
      const permitidas = new Set(misAgrupacionesPorTorre(idBloque));
      return lista.filter((a) => permitidas.has(a.id));
    }
    function filtrarTorres(lista, idAgrupacion) {
      if (esCoordinador()) return lista;
      const permitidas = new Set(misTorres());
      return lista.filter((t) => permitidas.has(t.id));
    }

    const [agrupacionesIniciales, torresIniciales] = await Promise.all([
      h0.id_bloque ? DB.listarAgrupaciones(h0.id_bloque) : Promise.resolve([]),
      h0.id_agrupacion ? DB.listarTorres(h0.id_agrupacion) : Promise.resolve([])
    ]);

    const mascotasPorTipo = { perro: 0, gato: 0, otro: 0 };
    (h0.mascotas || []).forEach((m) => { if (mascotasPorTipo[m.tipo] !== undefined) mascotasPorTipo[m.tipo] += m.cantidad; });

    // Estado en memoria de los integrantes nombrados, sincronizado con los
    // contadores de composición. Se precarga desde miembros_hogar y se
    // completa con filas vacías hasta igualar cada contador.
    const CATEGORIAS = [
      ['mujeres_adultas', 'mujer', 'Mujer'],
      ['hombres_adultos', 'hombre', 'Hombre'],
      ['ninas', 'nina', 'Niña'],
      ['ninos', 'nino', 'Niño'],
      ['abuelas', 'abuela', 'Abuela'],
      ['abuelos', 'abuelo', 'Abuelo']
    ];
    const miembros = {};
    CATEGORIAS.forEach(([campo, categoria]) => {
      const existentes = (h0.miembros_hogar || []).filter((m) => m.categoria === categoria)
        .map((m) => ({ nombre: m.nombre || '', afectaciones: m.afectaciones || [] }));
      const total = h0[campo] || 0;
      while (existentes.length < total) existentes.push({ nombre: '', afectaciones: [] });
      miembros[categoria] = existentes;
    });

    root.innerHTML = `
      <h1>${idHogar ? 'Editar hogar' : 'Censar hogar nuevo'}</h1>
      <form id="form-hogar" class="card" novalidate>
        <div class="form-row cols-2">
          <div class="field">
            <label for="h-bloque">Sector</label>
            <select id="h-bloque" required>
              <option value="">Selecciona…</option>
              ${bloquesVisibles.map((b) => `<option value="${esc(b.id)}" ${h0.id_bloque === b.id ? 'selected' : ''}>${esc(b.nombre)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="h-agrupacion">Agrupación</label>
            <select id="h-agrupacion">
              <option value="">Selecciona…</option>
              ${filtrarAgrupaciones(agrupacionesIniciales, h0.id_bloque).map((a) => `<option value="${esc(a.id)}" ${h0.id_agrupacion === a.id ? 'selected' : ''}>Agrupación ${esc(a.numero)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row cols-2">
          <div class="field">
            <label for="h-torre">Torre</label>
            <select id="h-torre">
              <option value="">Selecciona…</option>
              ${filtrarTorres(torresIniciales, h0.id_agrupacion).map((t) => `<option value="${esc(t.letra_torre)}" ${h0.id_torre === t.letra_torre ? 'selected' : ''}>${esc(t.letra_torre)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="h-apto">Apartamento / unidad</label>
            <input id="h-apto" type="text" value="${esc(h0.apartamento_unidad || '')}">
          </div>
        </div>
        <div class="field">
          <label for="h-jefe">Nombre del jefe de hogar</label>
          <input id="h-jefe" type="text" required value="${esc(h0.nombre_jefe_hogar || '')}">
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

        <div class="section-title">Integrantes (opcional)</div>
        <p class="text-muted text-sm">Agrega el nombre y, si aplica, las afectaciones de salud de cada persona contada arriba.</p>
        <div id="miembros-region"></div>

        <div class="switch-row" style="margin-top:16px;">
          <label for="h-es-lider" style="margin:0;">¿El jefe de este hogar es líder de torre?</label>
          <span class="switch">
            <input id="h-es-lider" type="checkbox" ${h0.es_lider ? 'checked' : ''}>
            <span class="track"></span><span class="thumb"></span>
          </span>
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

    function pintarMiembros() {
      const region = qs('#miembros-region', root);
      region.innerHTML = CATEGORIAS.map(([, categoria, etiqueta]) => {
        const filas = miembros[categoria];
        if (!filas.length) return '';
        return `
          <div class="miembros-categoria">
            <div class="miembros-categoria-titulo">${esc(etiqueta)}${filas.length > 1 ? 's' : ''}</div>
            ${filas.map((m, i) => `
              <div class="card miembro-card" data-categoria="${categoria}" data-indice="${i}">
                <div class="field mb-0">
                  <label>Nombre (opcional)</label>
                  <input type="text" data-miembro-nombre value="${esc(m.nombre)}" placeholder="${esc(etiqueta)} ${i + 1}">
                </div>
                <div class="field mb-0" style="margin-top:8px;">
                  <label>Afectaciones de salud (opcional)</label>
                  <div class="chip-group">
                    ${afectacionesCatalogo.map((a) => `<button type="button" class="chip ${m.afectaciones.includes(a.nombre) ? 'selected' : ''}" data-miembro-afectacion="${esc(a.nombre)}">${esc(a.nombre)}</button>`).join('')}
                  </div>
                </div>
              </div>`).join('')}
          </div>`;
      }).join('') || '<p class="text-muted text-sm">Aumenta los contadores de arriba para agregar integrantes.</p>';
    }

    function sincronizarMiembros(categoria, nuevoValor) {
      const filas = miembros[categoria];
      while (filas.length < nuevoValor) filas.push({ nombre: '', afectaciones: [] });
      while (filas.length > nuevoValor) filas.pop();
      pintarMiembros();
    }

    const CAMPO_A_CATEGORIA = Object.fromEntries(CATEGORIAS.map(([campo, categoria]) => [campo, categoria]));

    activarContadores(form, recalcularTotal);
    qsa('[data-counter]', form).forEach((box) => {
      const nombreCampo = box.dataset.counter;
      const categoria = CAMPO_A_CATEGORIA[nombreCampo];
      if (!categoria) return;
      box.addEventListener('click', () => sincronizarMiembros(categoria, valorContador(form, nombreCampo)));
    });
    recalcularTotal();
    pintarMiembros();

    qs('#miembros-region', root).addEventListener('input', (e) => {
      const input = e.target.closest('[data-miembro-nombre]');
      if (!input) return;
      const cardEl = input.closest('.miembro-card');
      miembros[cardEl.dataset.categoria][Number(cardEl.dataset.indice)].nombre = input.value;
    });
    qs('#miembros-region', root).addEventListener('click', (e) => {
      const chip = e.target.closest('[data-miembro-afectacion]');
      if (!chip) return;
      const cardEl = chip.closest('.miembro-card');
      const fila = miembros[cardEl.dataset.categoria][Number(cardEl.dataset.indice)];
      const nombreAfectacion = chip.dataset.miembroAfectacion;
      if (fila.afectaciones.includes(nombreAfectacion)) {
        fila.afectaciones = fila.afectaciones.filter((a) => a !== nombreAfectacion);
        chip.classList.remove('selected');
      } else {
        fila.afectaciones.push(nombreAfectacion);
        chip.classList.add('selected');
      }
    });

    qs('#h-bloque', root).addEventListener('change', async (e) => {
      const agrupacionSelect = qs('#h-agrupacion', root);
      const torreSelect = qs('#h-torre', root);
      torreSelect.innerHTML = '<option value="">Selecciona…</option>';
      if (!e.target.value) { agrupacionSelect.innerHTML = '<option value="">Selecciona…</option>'; return; }
      try {
        const agrupaciones = filtrarAgrupaciones(await DB.listarAgrupaciones(e.target.value), e.target.value);
        agrupacionSelect.innerHTML = '<option value="">Selecciona…</option>' + agrupaciones.map((a) => `<option value="${esc(a.id)}">Agrupación ${esc(a.numero)}</option>`).join('');
      } catch (ex) { toast(errorAmigable(ex), 'error'); }
    });

    qs('#h-agrupacion', root).addEventListener('change', async (e) => {
      const torreSelect = qs('#h-torre', root);
      if (!e.target.value) { torreSelect.innerHTML = '<option value="">Selecciona…</option>'; return; }
      try {
        const torres = filtrarTorres(await DB.listarTorres(e.target.value), e.target.value);
        torreSelect.innerHTML = '<option value="">Selecciona…</option>' + torres.map((t) => `<option value="${esc(t.letra_torre)}">${esc(t.letra_torre)}</option>`).join('');
      } catch (ex) { toast(errorAmigable(ex), 'error'); }
    });

    qs('#h-medica', root).addEventListener('change', (e) => {
      qs('#campo-descripcion-medica', root).style.display = e.target.checked ? '' : 'none';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = qs('#btn-guardar-hogar', root);
      const errBox = qs('#form-hogar-error', root);
      errBox.textContent = '';
      const idBloque = qs('#h-bloque', root).value;
      const idAgrupacion = qs('#h-agrupacion', root).value || null;
      const idTorre = qs('#h-torre', root).value || null;
      const jefe = qs('#h-jefe', root).value.trim();
      if (!idBloque) { errBox.textContent = 'Selecciona el sector.'; return; }
      if (!jefe) { errBox.textContent = 'Escribe el nombre del jefe de hogar.'; return; }
      if (!esCoordinador() && !misBloques().includes(idBloque) && !misBloquesPorTorre().includes(idBloque)) { errBox.textContent = 'No tienes permiso para censar en ese sector.'; return; }
      if (esLiderDeTorre && !misTorres().includes(`${idAgrupacion || ''}-${idTorre || ''}`)) { errBox.textContent = 'No tienes permiso para censar en esa agrupación/torre.'; return; }

      const miembrosPlanos = CATEGORIAS.flatMap(([, categoria]) =>
        miembros[categoria]
          .filter((m) => m.nombre.trim() || m.afectaciones.length)
          .map((m) => ({ categoria, nombre: m.nombre.trim() || null, afectaciones: m.afectaciones }))
      );

      const payload = {
        id_bloque: idBloque,
        id_agrupacion: idAgrupacion,
        id_torre: idTorre,
        apartamento_unidad: qs('#h-apto', root).value.trim(),
        nombre_jefe_hogar: jefe,
        telefono: qs('#h-tel', root).value.trim(),
        mujeres_adultas: valorContador(form, 'mujeres_adultas'),
        hombres_adultos: valorContador(form, 'hombres_adultos'),
        ninas: valorContador(form, 'ninas'),
        ninos: valorContador(form, 'ninos'),
        abuelas: valorContador(form, 'abuelas'),
        abuelos: valorContador(form, 'abuelos'),
        tiene_afectacion_medica: qs('#h-medica', root).checked || miembrosPlanos.some((m) => m.afectaciones.length > 0),
        requerimiento_prioritario: qs('#h-medica', root).checked ? qs('#h-descripcion', root).value.trim() : null,
        es_lider: qs('#h-es-lider', root).checked,
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
        await DB.reemplazarMiembros(hogarId, miembrosPlanos);
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
        <div class="section-title">Destino de la entrega</div>
        <div class="chip-group" id="e-destino-tabs">
          <button type="button" class="chip selected" data-destino="hogar">Hogar específico</button>
          <button type="button" class="chip" data-destino="grupal">Líder / torre completa</button>
        </div>

        <div id="e-destino-hogar" class="mt-4">
          <div class="field">
            <label for="e-buscar">Buscar hogar (apto, nombre o teléfono)</label>
            <input id="e-buscar" type="search" autocomplete="off" placeholder="Escribe para buscar…">
            <div id="e-resultados" role="listbox" aria-label="Resultados"></div>
          </div>
          <div id="e-hogar-seleccionado" class="text-sm text-muted"></div>
        </div>

        <div id="e-destino-grupal" class="mt-4" style="display:none;">
          <div class="field">
            <label for="e-lider-grupal">Líder que recibe para repartir en su torre</label>
            <select id="e-lider-grupal">
              <option value="">Selecciona…</option>
              ${lideres.map((l) => `<option value="${l.id}" data-torres='${JSON.stringify(l.torres_permitidas || [])}' data-bloques='${JSON.stringify(l.bloques_permitidos || [])}'>${esc(l.nombre)}</option>`).join('')}
            </select>
          </div>
          <div class="field" id="e-torre-grupal-wrap" style="display:none;">
            <label for="e-torre-grupal">Torre a la que se entrega</label>
            <select id="e-torre-grupal"></select>
          </div>
        </div>

        <div class="section-title">Tipos de ayuda entregados</div>
        <div class="chip-group" id="e-chips">
          ${tipos.map((t) => `<button type="button" class="chip" data-tipo="${t.id}" data-nombre="${esc(t.nombre)}">${esc(t.nombre)}</button>`).join('')}
        </div>
        <div id="e-detalle-cantidades" class="mt-4"></div>

        <div class="section-title">Quién recibió</div>
        <div class="form-row cols-2">
          <div class="field" id="e-lider-hogar-wrap">
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
            <thead><tr><th>Fecha</th><th>Destino</th><th>Sector</th><th>Ayuda</th><th>Evidencia</th></tr></thead>
            <tbody>${entregas.map((e) => `
              <tr>
                <td>${fmtFecha(e.fecha_hora)}</td>
                <td>${e.id_hogar ? esc(e.hogares?.nombre_jefe_hogar || '—') : `Entrega grupal${e.id_torre ? ' — Torre ' + esc(e.id_torre) : ''}`}</td>
                <td>${esc(e.id_bloque)}</td>
                <td>${(e.entrega_items || []).map((it) => `${esc(it.tipos_ayuda?.nombre)}${it.cantidad > 1 ? ' x' + it.cantidad : ''}`).join(', ') || '—'}</td>
                <td>${e.foto_evidencia_url ? `<a href="${e.foto_evidencia_url}" target="_blank" rel="noopener">Ver foto</a>` : '—'}</td>
              </tr>`).join('')}</tbody>
          </table></div>`}
      </div>`;

    let hogarSeleccionado = null;
    let destino = 'hogar';
    const tiposSeleccionados = new Set();

    qs('#e-destino-tabs', root).addEventListener('click', (e) => {
      const chip = e.target.closest('[data-destino]');
      if (!chip) return;
      destino = chip.dataset.destino;
      qsa('[data-destino]', root).forEach((c) => c.classList.toggle('selected', c === chip));
      qs('#e-destino-hogar', root).style.display = destino === 'hogar' ? '' : 'none';
      qs('#e-destino-grupal', root).style.display = destino === 'grupal' ? '' : 'none';
      qs('#e-lider-hogar-wrap', root).style.display = destino === 'hogar' ? '' : 'none';
    });

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
          <span class="subtitle">Sector ${esc(h.id_bloque)} · Apto ${esc(h.apartamento_unidad || '—')}</span></div>
        </div>`).join('') || '<p class="text-muted text-sm">Sin resultados.</p>';
    }, 200));

    resultadosBox.addEventListener('click', (e) => {
      const row = e.target.closest('[data-elegir]');
      if (!row) return;
      hogarSeleccionado = hogares.find((h) => h.id === row.dataset.elegir);
      qs('#e-hogar-seleccionado', root).innerHTML = `Hogar seleccionado: <strong>${esc(hogarSeleccionado.nombre_jefe_hogar)}</strong> (Sector ${esc(hogarSeleccionado.id_bloque)}, Apto ${esc(hogarSeleccionado.apartamento_unidad || '—')})`;
      buscarInput.value = '';
      resultadosBox.innerHTML = '';
    });

    qs('#e-lider-grupal', root).addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      const torreSelect = qs('#e-torre-grupal', root);
      const wrap = qs('#e-torre-grupal-wrap', root);
      if (!opt || !opt.value) { wrap.style.display = 'none'; return; }
      const torres = JSON.parse(opt.dataset.torres || '[]');
      if (torres.length === 0) { wrap.style.display = 'none'; return; }
      torreSelect.innerHTML = torres.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
      wrap.style.display = '';
    });

    function actualizarDetalleCantidades() {
      const tiposConDetalle = tipos.filter((t) => tiposSeleccionados.has(t.id));
      const box = qs('#e-detalle-cantidades', root);
      box.innerHTML = tiposConDetalle.map((t) => `
        <div class="field">
          <label for="cant-${t.id}">${esc(t.nombre)} — ${esc(t.campo_adicional || 'cantidad de unidades')}</label>
          <input id="cant-${t.id}" type="number" min="1" data-cantidad-tipo="${t.id}" placeholder="Ej. 30" value="1">
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
      if (tiposSeleccionados.size === 0) { errBox.textContent = 'Marca al menos un tipo de ayuda entregado.'; return; }

      let entregaBase;
      if (destino === 'hogar') {
        if (!hogarSeleccionado) { errBox.textContent = 'Busca y selecciona el hogar que recibe la ayuda.'; return; }
        entregaBase = {
          id_hogar: hogarSeleccionado.id,
          id_bloque: hogarSeleccionado.id_bloque,
          id_torre: hogarSeleccionado.id_torre,
          recibido_por_lider: qs('#e-lider', root).value || null,
          es_entrega_grupal: false
        };
      } else {
        const liderId = qs('#e-lider-grupal', root).value;
        if (!liderId) { errBox.textContent = 'Selecciona el líder que recibe la entrega grupal.'; return; }
        const lider = lideres.find((l) => l.id === liderId);
        const torreElegida = qs('#e-torre-grupal', root).style.display !== 'none' ? qs('#e-torre-grupal', root).value : null;
        const idBloque = torreElegida ? torreElegida.split('-')[0] : (lider.bloques_permitidos || [])[0];
        if (!idBloque) { errBox.textContent = 'Ese líder no tiene sector ni torre asignada.'; return; }
        entregaBase = {
          id_hogar: null,
          id_bloque: idBloque,
          id_torre: torreElegida ? torreElegida.split('-').slice(1).join('-') : null,
          recibido_por_lider: liderId,
          es_entrega_grupal: true
        };
      }

      const btn = qs('#btn-guardar-entrega', root);
      btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        const entrega = await DB.crearEntrega({
          ...entregaBase,
          entregado_por: state.perfil.id,
          nombre_quien_recibio: qs('#e-nombre-recibe', root).value.trim() || null,
          observaciones: qs('#e-obs', root).value.trim() || null
        }, Array.from(tiposSeleccionados).map((tid) => {
          const inputCant = qs(`[data-cantidad-tipo="${tid}"]`, root);
          const itemInv = inventario.find((i) => i.tipo_ayuda_id === tid);
          const cantidad = inputCant?.value ? Number(inputCant.value) || 1 : 1;
          return { tipo_ayuda_id: tid, item_inventario_id: itemInv ? itemInv.id : null, cantidad, detalle: null };
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
  // ADMINISTRACIÓN — sectores / agrupaciones / torres / líderes (coordinador)
  // =====================================================================
  async function vistaAdministracion(root) {
    const [bloques, agrupaciones, torres, lideres, coordinadores, hogares] = await Promise.all([
      DB.listarBloques(), DB.listarAgrupaciones(), DB.listarTorres(), DB.listarLideres(), DB.listarCoordinadores(), DB.listarHogares()
    ]);

    root.innerHTML = `
      <h1>Administración</h1>

      <div class="card">
        <div class="card-header"><h2>Sincronizar censo maestro</h2></div>
        <p class="text-muted text-sm">Compara el censo maestro (sector, agrupación, torre y apto reales de cada hogar) contra lo que ya está cargado, y arma una vista previa de qué hogares hay que actualizar o crear. No escribe nada hasta que confirmes.</p>
        <button class="btn btn-primary mt-4" id="btn-sincronizar" type="button">Detectar cambios</button>
        <div id="sincronizar-preview-region" class="mt-4"></div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Sectores</h2><button class="btn btn-sm btn-secondary" id="btn-nuevo-bloque" type="button">+ Sector</button></div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>ID</th><th>Nombre</th><th>Agrupaciones</th><th>Hogares censados</th></tr></thead>
          <tbody>${bloques.map((b) => `<tr><td>${esc(b.id)}</td><td>${esc(b.nombre)}</td><td>${agrupaciones.filter((a) => a.id_bloque === b.id).length}</td><td>${hogares.filter((h) => h.id_bloque === b.id).length}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Agrupaciones</h2><button class="btn btn-sm btn-secondary" id="btn-nueva-agrupacion" type="button">+ Agrupación</button></div>
        <p class="text-muted text-sm">Cada sector tiene sus propias agrupaciones — no se comparten entre sectores.</p>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Sector</th><th>Agrupación</th><th>Torres</th></tr></thead>
          <tbody>${agrupaciones.map((a) => `<tr><td>${esc(a.id_bloque)}</td><td>${esc(a.numero)}${a.nombre ? ' · ' + esc(a.nombre) : ''}</td><td>${torres.filter((t) => t.id_agrupacion === a.id).length}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted">Sin agrupaciones registradas todavía.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Torres</h2><button class="btn btn-sm btn-secondary" id="btn-nueva-torre" type="button">+ Torre</button></div>
        <p class="text-muted text-sm">"Esperados" son cifras de referencia (ej. del censo original) para comparar contra lo ya censado — no limitan cuántos hogares se pueden agregar.</p>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Sector</th><th>Agrupación</th><th>Letra</th><th>Hogares censados / esperados</th><th>Personas esperadas</th><th></th></tr></thead>
          <tbody>${torres.map((t) => `<tr><td>${esc(t.id_bloque)}</td><td>${esc((agrupaciones.find((a) => a.id === t.id_agrupacion) || {}).numero || '—')}</td><td>${esc(t.letra_torre)}</td><td>${hogares.filter((h) => h.id_torre === t.letra_torre && h.id_agrupacion === t.id_agrupacion).length} / ${t.hogares_esperados ?? '—'}</td><td>${t.personas_esperadas ?? '—'}</td><td><button class="btn btn-sm btn-ghost" data-editar-torre="${esc(t.id)}" type="button">Editar cifras</button></td></tr>`).join('') || '<tr><td colspan="6" class="text-muted">Sin torres registradas todavía.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Administradores</h2><button class="btn btn-sm btn-secondary" id="btn-nuevo-admin" type="button">+ Administrador</button></div>
        <p class="text-muted text-sm">Un administrador (coordinador) ve y edita todo: todos los sectores, entregas, inventario y esta misma pantalla de Administración. Créalos solo para personas de confianza total.</p>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Nombre</th><th>Teléfono</th><th>Estado</th><th></th></tr></thead>
          <tbody>${coordinadores.map((c) => `<tr><td>${esc(c.nombre)}</td><td>${telLinkHTML(c.telefono)}</td><td>${c.activo ? '<span class="badge badge-success">Activo</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td><td><button class="btn btn-sm btn-ghost" data-resetear-pin="${esc(c.id)}" data-nombre-lider="${esc(c.nombre)}" type="button">Resetear PIN</button></td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">Sin administradores adicionales todavía.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Líderes</h2><button class="btn btn-sm btn-secondary" id="btn-nuevo-lider" type="button">+ Líder</button></div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Nombre</th><th>Teléfono</th><th>Torres</th><th>Sectores</th><th>Estado</th><th></th></tr></thead>
          <tbody>${lideres.map((l) => `<tr><td>${esc(l.nombre)}</td><td>${telLinkHTML(l.telefono)}</td><td>${(l.torres_permitidas || []).join(', ') || '—'}</td><td>${(l.bloques_permitidos || []).join(', ') || '—'}</td><td>${l.activo ? '<span class="badge badge-success">Activo</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td><td><button class="btn btn-sm btn-ghost" data-resetear-pin="${esc(l.id)}" data-nombre-lider="${esc(l.nombre)}" type="button">Resetear PIN</button></td></tr>`).join('') || '<tr><td colspan="6" class="text-muted">Sin líderes registrados todavía.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Crear líderes del censo maestro</h2></div>
        <p class="text-muted text-sm">Busca hogares marcados como líder (con su sector/agrupación/torre ya resueltos y teléfono conocido) que todavía no tienen cuenta de acceso, y te ofrece crearla con un PIN generado para cada uno.</p>
        <p class="text-muted text-sm"><strong>Requisito:</strong> corre primero "Sincronizar censo maestro" (arriba) y aplica los cambios — sin eso, ningún hogar queda marcado como líder todavía.</p>
        <button class="btn btn-secondary mt-4" id="btn-detectar-lideres" type="button">Detectar líderes pendientes de cuenta</button>
        <div id="lideres-preview-region" class="mt-4"></div>
      </div>`;

    qs('#btn-nuevo-bloque', root).addEventListener('click', async () => {
      const id = prompt('ID del sector (ej. "8"):'); if (!id) return;
      const nombre = prompt('Nombre a mostrar (ej. "Sector 8"):', `Sector ${id}`); if (!nombre) return;
      try { await DB.crearBloque({ id, nombre }); toast('Sector creado', 'success'); router(); }
      catch (ex) { toast(errorAmigable(ex), 'error'); }
    });

    qs('#btn-nueva-agrupacion', root).addEventListener('click', async () => {
      const idBloque = prompt(`¿De qué sector es esta agrupación? (${bloques.map((b) => b.id).join(', ')}):`); if (!idBloque) return;
      const numero = prompt('Número o código de la agrupación (ej. "1"):'); if (!numero) return;
      const nombre = prompt('Nombre descriptivo (opcional):') || null;
      try { await DB.crearAgrupacion({ id_bloque: idBloque, numero, nombre }); toast('Agrupación creada', 'success'); router(); }
      catch (ex) { toast(errorAmigable(ex), 'error'); }
    });

    qs('#btn-nueva-torre', root).addEventListener('click', async () => {
      const idBloque = prompt(`¿De qué sector es esta torre? (${bloques.map((b) => b.id).join(', ')}):`); if (!idBloque) return;
      const agrupacionesDelSector = agrupaciones.filter((a) => a.id_bloque === idBloque);
      if (agrupacionesDelSector.length === 0) { toast('Ese sector todavía no tiene agrupaciones. Crea una agrupación primero.', 'error'); return; }
      const numero = prompt(`¿Agrupación? (${agrupacionesDelSector.map((a) => a.numero).join(', ')}):`); if (!numero) return;
      const agrupacion = agrupacionesDelSector.find((a) => a.numero === numero);
      if (!agrupacion) { toast('Esa agrupación no existe en ese sector.', 'error'); return; }
      const letra = prompt('Letra de la torre (ej. "F"):'); if (!letra) return;
      try { await DB.crearTorre({ id_bloque: idBloque, id_agrupacion: agrupacion.id, letra_torre: letra }); toast('Torre creada', 'success'); router(); }
      catch (ex) { toast(errorAmigable(ex), 'error'); }
    });

    qsa('[data-editar-torre]', root).forEach((btn) => btn.addEventListener('click', async () => {
      const torre = torres.find((t) => t.id === btn.dataset.editarTorre);
      const hogaresEsperados = prompt('Hogares esperados en esta torre (deja vacío para quitarlo):', torre.hogares_esperados ?? '');
      if (hogaresEsperados === null) return;
      const personasEsperadas = prompt('Personas esperadas en esta torre (deja vacío para quitarlo):', torre.personas_esperadas ?? '');
      if (personasEsperadas === null) return;
      try {
        await DB.actualizarTorre(torre.id, {
          hogares_esperados: hogaresEsperados.trim() === '' ? null : Number(hogaresEsperados) || 0,
          personas_esperadas: personasEsperadas.trim() === '' ? null : Number(personasEsperadas) || 0
        });
        toast('Actualizado', 'success'); router();
      } catch (ex) { toast(errorAmigable(ex), 'error'); }
    }));

    qs('#btn-nuevo-admin', root).addEventListener('click', () => abrirModalNuevoAdministrador());

    qs('#btn-nuevo-lider', root).addEventListener('click', () => abrirModalNuevoLider(torres, agrupaciones));

    qsa('[data-resetear-pin]', root).forEach((btn) => btn.addEventListener('click', async () => {
      const nombreLider = btn.dataset.nombreLider;
      const ok = await confirmar(`Se le va a asignar un PIN nuevo a ${nombreLider}. El PIN anterior deja de servir de inmediato. ¿Continuar?`, { textoOk: 'Resetear PIN' });
      if (!ok) return;
      const nuevoPin = DB.pinAleatorio();
      try {
        await DB.resetearPinLider(btn.dataset.resetearPin, nuevoPin);
        await confirmar(`Nuevo PIN de ${nombreLider}: ${nuevoPin} — cópialo ahora, no se puede volver a consultar después de cerrar este mensaje.`, { titulo: 'PIN actualizado', textoOk: 'Ya lo copié' });
      } catch (ex) { toast(errorAmigable(ex), 'error'); }
    }));

    qs('#btn-detectar-lideres', root).addEventListener('click', () => {
      const region = qs('#lideres-preview-region', root);
      const hogaresLider = hogares.filter((h) => h.es_lider);
      if (hogaresLider.length === 0) {
        region.innerHTML = '<p class="text-muted text-sm">⚠️ No hay ningún hogar marcado como líder todavía. Corre primero "Sincronizar censo maestro" (arriba) y aplica los cambios — ese paso es el que marca es_lider y resuelve la torre de cada líder; recién después va a haber candidatos aquí.</p>';
        return;
      }

      const telefonosConCuenta = new Set(lideres.map((l) => normTelSimple(l.telefono)));
      const candidatos = [];
      const sinDatos = [];
      hogaresLider.forEach((h) => {
        const torreId = h.id_agrupacion && h.id_torre ? `${h.id_agrupacion}-${h.id_torre}` : null;
        if (!torreId || !h.telefono) { sinDatos.push(h); return; }
        if (telefonosConCuenta.has(normTelSimple(h.telefono))) return; // ya tiene cuenta
        candidatos.push({ nombre: h.nombre_jefe_hogar || '(Sin nombre)', telefono: h.telefono, torreId });
      });

      if (candidatos.length === 0 && sinDatos.length === 0) {
        region.innerHTML = '<p class="text-muted text-sm">Todos los hogares marcados como líder ya tienen cuenta de acceso.</p>';
        return;
      }
      region.innerHTML = `
        ${candidatos.length === 0 ? '' : `
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Nombre</th><th>Teléfono</th><th>Torre</th></tr></thead>
            <tbody>${candidatos.map((c) => `<tr><td>${esc(c.nombre)}</td><td>${esc(c.telefono)}</td><td>${esc(c.torreId)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        <button class="btn btn-primary mt-4" id="btn-crear-lideres" type="button">Crear ${candidatos.length} cuenta${candidatos.length === 1 ? '' : 's'}</button>`}
        ${sinDatos.length === 0 ? '' : `
        <div class="section-title">Sin torre o sin teléfono — no se puede crear cuenta (${sinDatos.length})</div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>Nombre</th><th>Sector</th><th>Torre</th><th>Teléfono</th></tr></thead>
            <tbody>${sinDatos.map((h) => `<tr><td>${esc(h.nombre_jefe_hogar || '(Sin nombre)')}</td><td>${esc(h.id_bloque || '—')}</td><td>${esc(h.id_torre || '—')}</td><td>${esc(h.telefono || '—')}</td></tr>`).join('')}</tbody>
          </table>
        </div>`}`;

      qs('#btn-crear-lideres', region)?.addEventListener('click', async () => {
        const ok = await confirmar(`Se crearán ${candidatos.length} cuentas de líder con PIN generado automáticamente. Vas a necesitar copiar la lista de teléfono+PIN para entregársela — no se puede recuperar después. ¿Continuar?`, { textoOk: 'Crear cuentas' });
        if (!ok) return;
        try {
          const { creados, errores } = await DB.crearLideresDesdeCensoMaestro(candidatos);
          region.innerHTML = `
            ${creados.length === 0 ? '' : `
            <div class="section-title">Cuentas creadas — copia esta lista, el PIN no se puede volver a ver</div>
            <div class="table-scroll">
              <table class="data-table">
                <thead><tr><th>Nombre</th><th>Teléfono</th><th>PIN</th><th>Torre</th></tr></thead>
                <tbody>${creados.map((c) => `<tr><td>${esc(c.nombre)}</td><td>${esc(c.telefono)}</td><td><strong>${esc(c.pin)}</strong></td><td>${esc(c.torreId)}</td></tr>`).join('')}</tbody>
              </table>
            </div>`}
            ${errores.length === 0 ? '' : `
            <div class="section-title">Errores (${errores.length})</div>
            <div class="table-scroll">
              <table class="data-table">
                <thead><tr><th>Nombre</th><th>Teléfono</th><th>Error</th></tr></thead>
                <tbody>${errores.map((e) => `<tr><td>${esc(e.nombre)}</td><td>${esc(e.telefono)}</td><td>${esc(errorAmigable({ message: e.error }))}</td></tr>`).join('')}</tbody>
              </table>
            </div>`}`;
          toast(`${creados.length} cuentas creadas.`, 'success');
        } catch (ex) { toast(errorAmigable(ex), 'error'); }
      });
    });

    qs('#btn-sincronizar', root).addEventListener('click', () => {
      const resultado = DB.reconciliarCensoMaestro(hogares, window.SEED_HOGARES);
      const region = qs('#sincronizar-preview-region', root);
      const { actualizaciones, nuevos, ambiguos, pendientes } = resultado;

      if (actualizaciones.length === 0 && nuevos.length === 0 && ambiguos.length === 0 && pendientes.length === 0) {
        region.innerHTML = '<p class="text-muted text-sm">El censo ya está al día con el maestro. Nada que sincronizar.</p>';
        return;
      }

      const filaMaestro = (f) => `Sector ${esc(f.bloque || '—')}${f.agrupacion ? ' · Agrupación ' + esc(f.agrupacion) : ''}${f.torre ? ' · Torre ' + esc(f.torre) : ''} · Apto ${esc(f.apto || '—')} · ${esc(f.jefe_hogar || '(Sin nombre)')}`;

      region.innerHTML = `
        ${actualizaciones.length === 0 ? '' : `
        <div class="section-title">Se actualizarán (${actualizaciones.length})</div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Hogar existente</th><th>Datos correctos (maestro)</th></tr></thead>
          <tbody>${actualizaciones.map(({ hogar, fila }) => `<tr><td>${esc(hogar.nombre_jefe_hogar || '(Sin nombre)')} — Sector ${esc(hogar.id_bloque)}, Apto ${esc(hogar.apartamento_unidad || '—')}</td><td>${filaMaestro(fila)}</td></tr>`).join('')}</tbody>
        </table></div>`}
        ${nuevos.length === 0 ? '' : `
        <div class="section-title">Se crearán (${nuevos.length})</div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Datos (maestro)</th></tr></thead>
          <tbody>${nuevos.map((f) => `<tr><td>${filaMaestro(f)}</td></tr>`).join('')}</tbody>
        </table></div>`}
        ${ambiguos.length === 0 ? '' : `
        <div class="section-title">Revisar a mano — más de una coincidencia (${ambiguos.length})</div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Fila del maestro</th><th>Candidatos encontrados</th></tr></thead>
          <tbody>${ambiguos.map(({ fila, candidatos }) => `<tr><td>${filaMaestro(fila)}</td><td>${candidatos.map((c) => `${esc(c.nombre_jefe_hogar || '(Sin nombre)')} (Apto ${esc(c.apartamento_unidad || '—')})`).join('; ')}</td></tr>`).join('')}</tbody>
        </table></div>`}
        ${pendientes.length === 0 ? '' : `
        <div class="section-title">Sin sector definido — no se pueden crear solos (${pendientes.length})</div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Jefe de hogar</th><th>Observaciones</th></tr></thead>
          <tbody>${pendientes.map((f) => `<tr><td>${esc(f.jefe_hogar || '(Sin nombre)')}</td><td>${esc(f.observaciones || '—')}</td></tr>`).join('')}</tbody>
        </table></div>`}
        ${actualizaciones.length === 0 && nuevos.length === 0 ? '' : `<button class="btn btn-primary mt-4" id="btn-aplicar-sincronizar" type="button">Aplicar ${actualizaciones.length} actualización${actualizaciones.length === 1 ? '' : 'es'} y ${nuevos.length} creación${nuevos.length === 1 ? '' : 'es'}</button>`}`;

      qs('#btn-aplicar-sincronizar', region)?.addEventListener('click', async () => {
        const ok = await confirmar(`Se actualizarán ${actualizaciones.length} hogares y se crearán ${nuevos.length} nuevos según la vista previa. ¿Continuar?`, { textoOk: 'Aplicar' });
        if (!ok) return;
        try {
          const { actualizados, creados } = await DB.aplicarSincronizacionCensoMaestro(resultado, state.perfil.id);
          toast(`Listo: ${actualizados} hogares actualizados, ${creados} creados.`, 'success');
          router();
        } catch (ex) { toast(errorAmigable(ex), 'error'); }
      });
    });
  }

  function abrirModalNuevoLider(torres, agrupaciones) {
    const agrupacionPorId = new Map(agrupaciones.map((a) => [a.id, a]));
    const torresDisponibles = torres.slice().sort((a, b) => a.id.localeCompare(b.id, 'es'));

    const backdrop = h(`
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Nuevo líder">
        <div class="modal-box">
          <h3>Nuevo líder de torre</h3>
          <div class="field"><label for="nl-nombre">Nombre completo</label><input id="nl-nombre" type="text"></div>
          <div class="field"><label for="nl-tel">Teléfono (será su usuario)</label><input id="nl-tel" type="tel" inputmode="numeric"></div>
          <div class="field"><label for="nl-pin">PIN de 6 dígitos</label><input id="nl-pin" type="password" inputmode="numeric" maxlength="6"></div>
          <div class="field">
            <label>Torres asignadas</label>
            <div class="chip-group">${torresDisponibles.map((t) => {
              const agrupacion = agrupacionPorId.get(t.id_agrupacion);
              return `<button type="button" class="chip" data-torre-chip="${esc(t.id)}">Sector ${esc(t.id_bloque)} · Agrupación ${esc(agrupacion ? agrupacion.numero : '—')} · Torre ${esc(t.letra_torre)}</button>`;
            }).join('') || '<p class="text-muted text-sm">Todavía no hay torres en el catálogo. Corre "Sincronizar censo maestro" o crea una torre a mano primero.</p>'}</div>
          </div>
          <p class="error-text" id="nl-error" role="alert" aria-live="polite"></p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
            <button type="button" class="btn btn-primary" id="nl-guardar">Crear líder</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(backdrop);
    const torresElegidas = new Set();
    qsa('[data-torre-chip]', backdrop).forEach((chip) => chip.addEventListener('click', () => {
      const id = chip.dataset.torreChip;
      if (torresElegidas.has(id)) { torresElegidas.delete(id); chip.classList.remove('selected'); }
      else { torresElegidas.add(id); chip.classList.add('selected'); }
    }));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-cancel]')) backdrop.remove(); });
    qs('#nl-guardar', backdrop).addEventListener('click', async () => {
      const nombre = qs('#nl-nombre', backdrop).value.trim();
      const telefono = qs('#nl-tel', backdrop).value.trim();
      const pin = qs('#nl-pin', backdrop).value.trim();
      const err = qs('#nl-error', backdrop);
      if (!nombre || !telefono || pin.length !== 6 || torresElegidas.size === 0) {
        err.textContent = 'Completa nombre, teléfono, un PIN de 6 dígitos y al menos una torre.'; return;
      }
      try {
        await DB.crearLider({ nombre, telefono, pin, bloques: [], torres: Array.from(torresElegidas) });
        toast('Líder creado. Ya puede iniciar sesión con su teléfono y PIN.', 'success');
        backdrop.remove();
        router();
      } catch (ex) { err.textContent = errorAmigable(ex); }
    });
  }

  function abrirModalNuevoAdministrador() {
    const backdrop = h(`
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Nuevo administrador">
        <div class="modal-box">
          <h3>Nuevo administrador</h3>
          <p class="text-muted text-sm">⚠️ Un administrador ve y edita <strong>todo</strong>: todos los sectores, entregas, inventario y esta misma pantalla. Créalo solo para alguien de total confianza.</p>
          <div class="field"><label for="na-nombre">Nombre completo</label><input id="na-nombre" type="text"></div>
          <div class="field"><label for="na-tel">Teléfono (será su usuario)</label><input id="na-tel" type="tel" inputmode="numeric"></div>
          <div class="field"><label for="na-pin">PIN de 6 dígitos</label><input id="na-pin" type="password" inputmode="numeric" maxlength="6"></div>
          <p class="error-text" id="na-error" role="alert" aria-live="polite"></p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
            <button type="button" class="btn btn-primary" id="na-guardar">Crear administrador</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-cancel]')) backdrop.remove(); });
    qs('#na-guardar', backdrop).addEventListener('click', async () => {
      const nombre = qs('#na-nombre', backdrop).value.trim();
      const telefono = qs('#na-tel', backdrop).value.trim();
      const pin = qs('#na-pin', backdrop).value.trim();
      const err = qs('#na-error', backdrop);
      if (!nombre || !telefono || pin.length !== 6) {
        err.textContent = 'Completa nombre, teléfono y un PIN de 6 dígitos.'; return;
      }
      const ok = await confirmar(`¿Confirmas que quieres darle acceso total de administrador a ${nombre}?`, { titulo: 'Confirmar administrador', textoOk: 'Sí, crear administrador', peligroso: true });
      if (!ok) return;
      try {
        await DB.crearCoordinador({ nombre, telefono, pin });
        toast('Administrador creado. Ya puede iniciar sesión con su teléfono y PIN.', 'success');
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
      const [hogares, agrupaciones] = await Promise.all([DB.listarHogares(), DB.listarAgrupaciones()]);
      const numeroPorAgrupacion = new Map(agrupaciones.map((a) => [a.id, a.numero]));
      exportarCSV('censo_hogares.csv', hogares, [
        { titulo: 'Sector', valor: (h) => h.id_bloque },
        { titulo: 'Agrupación', valor: (h) => h.id_agrupacion ? numeroPorAgrupacion.get(h.id_agrupacion) : '' },
        { titulo: 'Torre', valor: (h) => h.id_torre },
        { titulo: 'Apto', valor: (h) => h.apartamento_unidad },
        { titulo: 'Jefe de hogar', valor: (h) => h.nombre_jefe_hogar },
        { titulo: 'Teléfono', valor: (h) => h.telefono },
        { titulo: 'Total personas', valor: (h) => h.total_personas },
        { titulo: 'Afectación médica', valor: (h) => h.tiene_afectacion_medica ? 'Sí' : 'No' },
        { titulo: 'Descripción', valor: (h) => h.requerimiento_prioritario },
        { titulo: 'Mascotas', valor: (h) => h.tiene_mascotas ? 'Sí' : 'No' },
        { titulo: 'Es líder', valor: (h) => h.es_lider ? 'Sí' : 'No' },
        { titulo: 'Fecha censo', valor: (h) => h.fecha_censo }
      ]);
    });

    qs('#exp-entregas', root).addEventListener('click', async () => {
      const entregas = await DB.listarEntregas(1000);
      exportarCSV('entregas.csv', entregas, [
        { titulo: 'Fecha', valor: (e) => e.fecha_hora },
        { titulo: 'Tipo', valor: (e) => e.id_hogar ? 'Por hogar' : 'Grupal (líder/torre)' },
        { titulo: 'Hogar', valor: (e) => e.hogares?.nombre_jefe_hogar },
        { titulo: 'Sector', valor: (e) => e.id_bloque },
        { titulo: 'Torre', valor: (e) => e.id_torre },
        { titulo: 'Ayudas', valor: (e) => (e.entrega_items || []).map((it) => `${it.tipos_ayuda?.nombre}${it.cantidad > 1 ? ' x' + it.cantidad : ''}`).join(' / ') },
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
