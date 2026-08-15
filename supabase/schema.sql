-- =====================================================================
-- Sistema de Censo y Ayudas — Albergue Chimi
-- Esquema de base de datos (Supabase / PostgreSQL)
-- =====================================================================
-- Cómo usar este archivo: copia todo el contenido y pégalo en
-- Supabase → SQL Editor → New query → Run. Es seguro volver a correrlo
-- (usa "if not exists" donde Postgres lo permite); las partes que no lo
-- permiten (policies, triggers) se borran primero con "drop ... if exists"
-- antes de recrearse, así que también puedes reejecutarlo sin miedo si
-- necesitas actualizar el esquema.
-- =====================================================================

create extension if not exists "pgcrypto"; -- para gen_random_uuid()

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'rol_usuario') then
    create type rol_usuario as enum ('coordinador', 'lider_bloque');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'prioridad_necesidad') then
    create type prioridad_necesidad as enum ('alta', 'media', 'baja');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'estado_necesidad') then
    create type estado_necesidad as enum ('pendiente', 'en_proceso', 'atendida');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tipo_movimiento_inventario') then
    create type tipo_movimiento_inventario as enum ('entrada', 'salida', 'ajuste');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- TABLAS
-- ---------------------------------------------------------------------

-- Bloques del albergue (2, 3, 4, 6, 7 ...)
create table if not exists bloques (
  id                  text primary key,
  nombre              text not null,
  capacidad_estimada  integer,
  observaciones       text,
  created_at          timestamptz not null default now()
);

-- Torres dentro de un bloque
create table if not exists torres (
  id            text primary key, -- ej. "3-F"
  id_bloque     text not null references bloques(id) on delete cascade,
  letra_torre   text not null,
  created_at    timestamptz not null default now(),
  unique (id_bloque, letra_torre)
);

-- Perfiles de usuarios (1 a 1 con auth.users). El rol y los bloques
-- permitidos viven aquí, NUNCA en el frontend.
create table if not exists perfiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  nombre               text not null,
  telefono             text not null unique,
  rol                  rol_usuario not null default 'lider_bloque',
  bloques_permitidos   text[] not null default '{}',
  es_quien_recibe_ayudas boolean not null default false,
  activo               boolean not null default true,
  created_at           timestamptz not null default now()
);

-- Hogares (unidad central del censo)
create table if not exists hogares (
  id                          uuid primary key default gen_random_uuid(),
  id_bloque                   text not null references bloques(id),
  -- id_torre es texto libre (solo la letra, ej. "F"), NO hace referencia
  -- a torres(id) porque en el censo real no todos los hogares tienen una
  -- torre pre-registrada; la tabla "torres" queda como catálogo de apoyo
  -- para reportes, no como restricción obligatoria del censo.
  id_torre                    text,
  apartamento_unidad          text,
  nombre_jefe_hogar           text not null default '',
  telefono                    text,
  mujeres_adultas             integer not null default 0 check (mujeres_adultas >= 0),
  hombres_adultos             integer not null default 0 check (hombres_adultos >= 0),
  ninas                       integer not null default 0 check (ninas >= 0),
  ninos                       integer not null default 0 check (ninos >= 0),
  abuelas                     integer not null default 0 check (abuelas >= 0),
  abuelos                     integer not null default 0 check (abuelos >= 0),
  -- columna calculada: total de personas del hogar
  total_personas integer generated always as
    (mujeres_adultas + hombres_adultos + ninas + ninos + abuelas + abuelos) stored,
  tiene_afectacion_medica     boolean not null default false,
  requerimiento_prioritario   text,
  tiene_mascotas              boolean not null default false,
  lider_que_censo             uuid references perfiles(id),
  fecha_censo                 timestamptz not null default now(),
  fecha_actualizacion         timestamptz not null default now(),
  observaciones                text,
  -- campos legacy (solo censo importado, que no separaba por sexo)
  legacy_ninos_sin_sexo       integer,
  legacy_adultos_sin_sexo     integer,
  censo_inicial_importado     boolean not null default false
);

create index if not exists idx_hogares_bloque on hogares(id_bloque);
create index if not exists idx_hogares_torre on hogares(id_torre);
create index if not exists idx_hogares_jefe on hogares using gin (to_tsvector('spanish', coalesce(nombre_jefe_hogar,'')));

-- Mascotas por hogar
create table if not exists mascotas (
  id          uuid primary key default gen_random_uuid(),
  id_hogar    uuid not null references hogares(id) on delete cascade,
  tipo        text not null default 'otro', -- perro / gato / otro
  cantidad    integer not null default 1 check (cantidad > 0),
  necesidad   text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_mascotas_hogar on mascotas(id_hogar);

-- Necesidades / afectaciones (permite dar seguimiento a la prioridad)
create table if not exists necesidades (
  id               uuid primary key default gen_random_uuid(),
  id_hogar         uuid not null references hogares(id) on delete cascade,
  tipo_necesidad   text not null default 'medica',
  descripcion      text,
  prioridad        prioridad_necesidad not null default 'media',
  estado           estado_necesidad not null default 'pendiente',
  fecha_registro   timestamptz not null default now(),
  fecha_atencion   timestamptz
);
create index if not exists idx_necesidades_hogar on necesidades(id_hogar);
create index if not exists idx_necesidades_estado on necesidades(estado);

-- Catálogo de tipos de ayuda (editable por el coordinador)
create table if not exists tipos_ayuda (
  id                uuid primary key default gen_random_uuid(),
  nombre            text not null unique,
  campo_adicional   text, -- ej. "número de raciones", "talla y cantidad"
  orden             integer not null default 0,
  activo            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- Ítems de inventario (stock físico: mercados, pañales, kits...)
create table if not exists inventario_items (
  id                        uuid primary key default gen_random_uuid(),
  nombre                    text not null,
  unidad                    text not null default 'unidad',
  tipo_ayuda_id             uuid references tipos_ayuda(id),
  cantidad_disponible       numeric not null default 0 check (cantidad_disponible >= 0),
  dimensionado_por_persona  boolean not null default false,
  personas_por_unidad       numeric not null default 1 check (personas_por_unidad > 0),
  stock_minimo              numeric not null default 0,
  activo                    boolean not null default true,
  created_at                timestamptz not null default now()
);

-- Movimientos de inventario (entradas del coordinador, salidas automáticas)
create table if not exists inventario_movimientos (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references inventario_items(id) on delete cascade,
  tipo              tipo_movimiento_inventario not null,
  cantidad          numeric not null check (cantidad > 0),
  motivo            text,
  registrado_por    uuid references perfiles(id),
  entrega_id        uuid, -- se referencia más abajo, sin fk dura por orden de creación
  created_at        timestamptz not null default now()
);
create index if not exists idx_inv_mov_item on inventario_movimientos(item_id);

-- Entregas de ayuda: SOLO las registra el coordinador general.
create table if not exists entregas (
  id                    uuid primary key default gen_random_uuid(),
  id_hogar              uuid not null references hogares(id),
  id_bloque             text not null references bloques(id),
  id_torre              text, -- texto libre, ver nota en hogares.id_torre
  entregado_por         uuid not null references perfiles(id), -- siempre coordinador
  recibido_por_lider    uuid references perfiles(id),
  nombre_quien_recibio  text,
  fecha_hora            timestamptz not null default now(),
  observaciones         text,
  foto_evidencia_url    text
);
create index if not exists idx_entregas_hogar on entregas(id_hogar);
create index if not exists idx_entregas_bloque on entregas(id_bloque);
create index if not exists idx_entregas_fecha on entregas(fecha_hora desc);

alter table inventario_movimientos
  drop constraint if exists inventario_movimientos_entrega_id_fkey;
alter table inventario_movimientos
  add constraint inventario_movimientos_entrega_id_fkey
  foreign key (entrega_id) references entregas(id) on delete set null;

-- Ítems entregados dentro de cada entrega
create table if not exists entrega_items (
  id                    uuid primary key default gen_random_uuid(),
  entrega_id            uuid not null references entregas(id) on delete cascade,
  tipo_ayuda_id         uuid not null references tipos_ayuda(id),
  item_inventario_id    uuid references inventario_items(id),
  cantidad              numeric not null default 1 check (cantidad > 0),
  detalle               text
);
create index if not exists idx_entrega_items_entrega on entrega_items(entrega_id);

-- ---------------------------------------------------------------------
-- FUNCIONES DE APOYO (security definer para evitar recursión en RLS)
-- ---------------------------------------------------------------------

create or replace function public.mi_rol()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select rol::text from perfiles where id = auth.uid();
$$;

create or replace function public.mis_bloques()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(bloques_permitidos, '{}'::text[]) from perfiles where id = auth.uid();
$$;

create or replace function public.soy_coordinador()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select rol = 'coordinador' from perfiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------

-- Mantiene fecha_actualizacion al día en cada UPDATE de hogares
create or replace function public.trg_hogares_actualizar_fecha()
returns trigger language plpgsql as $$
begin
  new.fecha_actualizacion := now();
  return new;
end;
$$;

drop trigger if exists set_fecha_actualizacion on hogares;
create trigger set_fecha_actualizacion
  before update on hogares
  for each row execute function public.trg_hogares_actualizar_fecha();

-- Crea/actualiza automáticamente una fila en "necesidades" cuando un
-- hogar se marca con afectación médica o especial (evita perder el
-- registro aunque solo se use el interruptor rápido del censo).
create or replace function public.trg_hogares_sincroniza_necesidad()
returns trigger language plpgsql as $$
begin
  if new.tiene_afectacion_medica then
    if not exists (
      select 1 from necesidades
      where id_hogar = new.id and estado <> 'atendida'
    ) then
      insert into necesidades (id_hogar, tipo_necesidad, descripcion, prioridad, estado)
      values (new.id, 'medica', coalesce(new.requerimiento_prioritario, 'Sin descripción'), 'alta', 'pendiente');
    else
      update necesidades
        set descripcion = coalesce(new.requerimiento_prioritario, descripcion)
        where id_hogar = new.id and estado <> 'atendida';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sincroniza_necesidad on hogares;
create trigger sincroniza_necesidad
  after insert or update of tiene_afectacion_medica, requerimiento_prioritario on hogares
  for each row execute function public.trg_hogares_sincroniza_necesidad();

-- Descuenta inventario automáticamente al registrar un ítem de entrega,
-- y deja constancia del movimiento de salida.
create or replace function public.trg_entrega_items_descuenta_inventario()
returns trigger language plpgsql as $$
begin
  if new.item_inventario_id is not null then
    update inventario_items
      set cantidad_disponible = cantidad_disponible - new.cantidad
      where id = new.item_inventario_id;

    insert into inventario_movimientos (item_id, tipo, cantidad, motivo, registrado_por, entrega_id)
    select new.item_inventario_id, 'salida', new.cantidad, 'Entrega registrada', e.entregado_por, new.entrega_id
    from entregas e where e.id = new.entrega_id;
  end if;
  return new;
end;
$$;

drop trigger if exists descuenta_inventario on entrega_items;
create trigger descuenta_inventario
  after insert on entrega_items
  for each row execute function public.trg_entrega_items_descuenta_inventario();

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

alter table bloques enable row level security;
alter table torres enable row level security;
alter table perfiles enable row level security;
alter table hogares enable row level security;
alter table mascotas enable row level security;
alter table necesidades enable row level security;
alter table tipos_ayuda enable row level security;
alter table inventario_items enable row level security;
alter table inventario_movimientos enable row level security;
alter table entregas enable row level security;
alter table entrega_items enable row level security;

-- ===== perfiles =====
-- Cualquier usuario autenticado puede leer su propia fila (para saber su
-- rol y bloques al iniciar sesión). El coordinador puede leer y escribir
-- todas las filas (para administrar líderes). Un líder no puede leer los
-- perfiles de otros líderes ni cambiar su propio rol/bloques.
drop policy if exists perfiles_select_propio_o_coordinador on perfiles;
create policy perfiles_select_propio_o_coordinador on perfiles
  for select using (id = auth.uid() or soy_coordinador());

drop policy if exists perfiles_insert_coordinador on perfiles;
create policy perfiles_insert_coordinador on perfiles
  for insert with check (soy_coordinador() or id = auth.uid());

drop policy if exists perfiles_update_coordinador on perfiles;
create policy perfiles_update_coordinador on perfiles
  for update using (soy_coordinador()) with check (soy_coordinador());

drop policy if exists perfiles_delete_coordinador on perfiles;
create policy perfiles_delete_coordinador on perfiles
  for delete using (soy_coordinador());

-- ===== bloques =====
-- Lectura: coordinador ve todos; líder solo ve los bloques que tiene
-- asignados en su perfil. Escritura: solo coordinador.
drop policy if exists bloques_select on bloques;
create policy bloques_select on bloques
  for select using (soy_coordinador() or id = any(mis_bloques()));

drop policy if exists bloques_write_coordinador on bloques;
create policy bloques_write_coordinador on bloques
  for insert with check (soy_coordinador());
drop policy if exists bloques_update_coordinador on bloques;
create policy bloques_update_coordinador on bloques
  for update using (soy_coordinador()) with check (soy_coordinador());
drop policy if exists bloques_delete_coordinador on bloques;
create policy bloques_delete_coordinador on bloques
  for delete using (soy_coordinador());

-- ===== torres =====
drop policy if exists torres_select on torres;
create policy torres_select on torres
  for select using (soy_coordinador() or id_bloque = any(mis_bloques()));

drop policy if exists torres_write_coordinador on torres;
create policy torres_write_coordinador on torres
  for insert with check (soy_coordinador());
drop policy if exists torres_update_coordinador on torres;
create policy torres_update_coordinador on torres
  for update using (soy_coordinador()) with check (soy_coordinador());
drop policy if exists torres_delete_coordinador on torres;
create policy torres_delete_coordinador on torres
  for delete using (soy_coordinador());

-- ===== hogares =====
-- El coordinador ve/edita todos los hogares. Un líder de bloque SOLO
-- puede leer, crear y actualizar hogares cuyo id_bloque esté en su lista
-- de bloques_permitidos. Nadie borra hogares desde la app (evita perder
-- censo por error); solo el coordinador puede hacerlo si es necesario.
drop policy if exists hogares_select on hogares;
create policy hogares_select on hogares
  for select using (soy_coordinador() or id_bloque = any(mis_bloques()));

drop policy if exists hogares_insert on hogares;
create policy hogares_insert on hogares
  for insert with check (soy_coordinador() or id_bloque = any(mis_bloques()));

drop policy if exists hogares_update on hogares;
create policy hogares_update on hogares
  for update using (soy_coordinador() or id_bloque = any(mis_bloques()))
  with check (soy_coordinador() or id_bloque = any(mis_bloques()));

drop policy if exists hogares_delete_coordinador on hogares;
create policy hogares_delete_coordinador on hogares
  for delete using (soy_coordinador());

-- ===== mascotas =====
-- Heredan el permiso del hogar al que pertenecen.
drop policy if exists mascotas_select on mascotas;
create policy mascotas_select on mascotas
  for select using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = mascotas.id_hogar and h.id_bloque = any(mis_bloques())
    )
  );
drop policy if exists mascotas_write on mascotas;
create policy mascotas_write on mascotas
  for insert with check (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = mascotas.id_hogar and h.id_bloque = any(mis_bloques())
    )
  );
drop policy if exists mascotas_update on mascotas;
create policy mascotas_update on mascotas
  for update using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = mascotas.id_hogar and h.id_bloque = any(mis_bloques())
    )
  );
drop policy if exists mascotas_delete on mascotas;
create policy mascotas_delete on mascotas
  for delete using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = mascotas.id_hogar and h.id_bloque = any(mis_bloques())
    )
  );

-- ===== necesidades =====
-- Igual criterio que mascotas: heredan el bloque del hogar. El líder
-- puede leer y crear/actualizar (para reportar), pero no marcar como
-- "atendida" salvo que también sea coordinador (se restringe en la app).
drop policy if exists necesidades_select on necesidades;
create policy necesidades_select on necesidades
  for select using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = necesidades.id_hogar and h.id_bloque = any(mis_bloques())
    )
  );
drop policy if exists necesidades_write on necesidades;
create policy necesidades_write on necesidades
  for insert with check (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = necesidades.id_hogar and h.id_bloque = any(mis_bloques())
    )
  );
drop policy if exists necesidades_update on necesidades;
create policy necesidades_update on necesidades
  for update using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = necesidades.id_hogar and h.id_bloque = any(mis_bloques())
    )
  );

-- ===== tipos_ayuda =====
-- SOLO el coordinador general puede ver y administrar el catálogo de
-- ayudas. Los líderes de bloque no entregan ayuda física directamente
-- en el sistema, así que no necesitan (ni deben) ver esta tabla.
drop policy if exists tipos_ayuda_todo_coordinador on tipos_ayuda;
create policy tipos_ayuda_todo_coordinador on tipos_ayuda
  for all using (soy_coordinador()) with check (soy_coordinador());

-- ===== inventario_items =====
-- SOLO coordinador. Un líder autenticado no debe poder leer el stock.
drop policy if exists inventario_items_todo_coordinador on inventario_items;
create policy inventario_items_todo_coordinador on inventario_items
  for all using (soy_coordinador()) with check (soy_coordinador());

-- ===== inventario_movimientos =====
drop policy if exists inventario_movimientos_todo_coordinador on inventario_movimientos;
create policy inventario_movimientos_todo_coordinador on inventario_movimientos
  for all using (soy_coordinador()) with check (soy_coordinador());

-- ===== entregas =====
-- SOLO el coordinador general registra y consulta entregas. Regla de
-- negocio explícita: la ayuda física solo se entrega a los líderes de
-- bloque, y es el coordinador quien deja constancia en el sistema.
drop policy if exists entregas_todo_coordinador on entregas;
create policy entregas_todo_coordinador on entregas
  for all using (soy_coordinador()) with check (soy_coordinador());

-- ===== entrega_items =====
drop policy if exists entrega_items_todo_coordinador on entrega_items;
create policy entrega_items_todo_coordinador on entrega_items
  for all using (soy_coordinador()) with check (soy_coordinador());

-- ---------------------------------------------------------------------
-- STORAGE: bucket de evidencias de entrega
-- ---------------------------------------------------------------------
-- Crea el bucket "evidencias": público de solo lectura, subida solo por
-- usuarios autenticados (en la práctica, solo el coordinador sube fotos
-- porque solo él tiene acceso a la pantalla de entregas).
insert into storage.buckets (id, name, public)
values ('evidencias', 'evidencias', true)
on conflict (id) do nothing;

drop policy if exists evidencias_lectura_publica on storage.objects;
create policy evidencias_lectura_publica on storage.objects
  for select using (bucket_id = 'evidencias');

drop policy if exists evidencias_subida_autenticados on storage.objects;
create policy evidencias_subida_autenticados on storage.objects
  for insert to authenticated with check (bucket_id = 'evidencias');

drop policy if exists evidencias_borrado_coordinador on storage.objects;
create policy evidencias_borrado_coordinador on storage.objects
  for delete to authenticated using (bucket_id = 'evidencias' and soy_coordinador());

-- =====================================================================
-- MIGRACIÓN v2 — líderes por torre, corrección de torres, composición
-- nominal del hogar, catálogo de afectaciones y entregas grupales.
-- Seguro de re-ejecutar junto con el resto del archivo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Líder acotado a torre(s) específicas (además del bloque, que se deja
-- como fallback para líderes ya creados). Cada valor tiene el mismo
-- formato que torres.id: "<id_bloque>-<letra_torre>", ej. "7-B".
-- ---------------------------------------------------------------------
alter table perfiles add column if not exists torres_permitidas text[] not null default '{}';

create or replace function public.mis_torres()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(torres_permitidas, '{}'::text[]) from perfiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- Marca si el jefe del hogar es líder de torre (para resaltar la card
-- y poder filtrar "solo líderes" en el censo).
-- ---------------------------------------------------------------------
alter table hogares add column if not exists es_lider boolean not null default false;

-- ---------------------------------------------------------------------
-- Integrantes nombrados del hogar (opcional, complementa los contadores
-- de composición que se mantienen en hogares para no romper reportes).
-- ---------------------------------------------------------------------
create table if not exists miembros_hogar (
  id            uuid primary key default gen_random_uuid(),
  id_hogar      uuid not null references hogares(id) on delete cascade,
  categoria     text not null check (categoria in ('mujer','hombre','nina','nino','abuela','abuelo')),
  nombre        text,
  afectaciones  text[] not null default '{}',
  created_at    timestamptz not null default now()
);
create index if not exists idx_miembros_hogar_hogar on miembros_hogar(id_hogar);

-- ---------------------------------------------------------------------
-- Catálogo editable de afectaciones de salud (mismo patrón que
-- tipos_ayuda), para el select múltiple por integrante.
-- ---------------------------------------------------------------------
create table if not exists afectaciones_catalogo (
  id       uuid primary key default gen_random_uuid(),
  nombre   text not null unique,
  orden    integer not null default 0,
  activo   boolean not null default true
);

insert into afectaciones_catalogo (nombre, orden) values
  ('Discapacidad física', 1),
  ('Discapacidad cognitiva', 2),
  ('Enfermedad crónica', 3),
  ('Movilidad reducida', 4),
  ('Embarazo', 5),
  ('Adulto mayor dependiente', 6),
  ('Salud mental', 7),
  ('Otra', 8)
on conflict (nombre) do nothing;

-- ---------------------------------------------------------------------
-- Entregas grupales a un líder/torre completa (ej. "30 desayunos a la
-- líder de la torre A"), además de las entregas por hogar existentes.
-- ---------------------------------------------------------------------
alter table entregas alter column id_hogar drop not null;
alter table entregas add column if not exists es_entrega_grupal boolean not null default false;
alter table entregas drop constraint if exists entregas_destino_check;
alter table entregas add constraint entregas_destino_check
  check (id_hogar is not null or recibido_por_lider is not null);

-- ---------------------------------------------------------------------
-- RLS: extender hogares/mascotas/necesidades para el permiso por torre,
-- habilitar RLS en las tablas nuevas.
-- ---------------------------------------------------------------------
alter table miembros_hogar enable row level security;
alter table afectaciones_catalogo enable row level security;

drop policy if exists hogares_select on hogares;
create policy hogares_select on hogares
  for select using (
    soy_coordinador() or id_bloque = any(mis_bloques())
    or (id_bloque || '-' || coalesce(id_torre,'')) = any(mis_torres())
  );

drop policy if exists hogares_insert on hogares;
create policy hogares_insert on hogares
  for insert with check (
    soy_coordinador() or id_bloque = any(mis_bloques())
    or (id_bloque || '-' || coalesce(id_torre,'')) = any(mis_torres())
  );

drop policy if exists hogares_update on hogares;
create policy hogares_update on hogares
  for update using (
    soy_coordinador() or id_bloque = any(mis_bloques())
    or (id_bloque || '-' || coalesce(id_torre,'')) = any(mis_torres())
  )
  with check (
    soy_coordinador() or id_bloque = any(mis_bloques())
    or (id_bloque || '-' || coalesce(id_torre,'')) = any(mis_torres())
  );

drop policy if exists mascotas_select on mascotas;
create policy mascotas_select on mascotas
  for select using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = mascotas.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );
drop policy if exists mascotas_write on mascotas;
create policy mascotas_write on mascotas
  for insert with check (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = mascotas.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );
drop policy if exists mascotas_update on mascotas;
create policy mascotas_update on mascotas
  for update using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = mascotas.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );
drop policy if exists mascotas_delete on mascotas;
create policy mascotas_delete on mascotas
  for delete using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = mascotas.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );

drop policy if exists necesidades_select on necesidades;
create policy necesidades_select on necesidades
  for select using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = necesidades.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );
drop policy if exists necesidades_write on necesidades;
create policy necesidades_write on necesidades
  for insert with check (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = necesidades.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );
drop policy if exists necesidades_update on necesidades;
create policy necesidades_update on necesidades
  for update using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = necesidades.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );

-- ===== miembros_hogar ===== (mismo criterio: heredan el permiso del hogar)
drop policy if exists miembros_hogar_select on miembros_hogar;
create policy miembros_hogar_select on miembros_hogar
  for select using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = miembros_hogar.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );
drop policy if exists miembros_hogar_write on miembros_hogar;
create policy miembros_hogar_write on miembros_hogar
  for insert with check (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = miembros_hogar.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );
drop policy if exists miembros_hogar_update on miembros_hogar;
create policy miembros_hogar_update on miembros_hogar
  for update using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = miembros_hogar.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );
drop policy if exists miembros_hogar_delete on miembros_hogar;
create policy miembros_hogar_delete on miembros_hogar
  for delete using (
    soy_coordinador() or exists (
      select 1 from hogares h where h.id = miembros_hogar.id_hogar
        and (h.id_bloque = any(mis_bloques()) or (h.id_bloque || '-' || coalesce(h.id_torre,'')) = any(mis_torres()))
    )
  );

-- ===== afectaciones_catalogo ===== (lectura para cualquier autenticado,
-- escritura solo coordinador — igual que tipos_ayuda pero de lectura
-- abierta porque los líderes también censan afectaciones)
drop policy if exists afectaciones_catalogo_select on afectaciones_catalogo;
create policy afectaciones_catalogo_select on afectaciones_catalogo
  for select using (true);
drop policy if exists afectaciones_catalogo_write_coordinador on afectaciones_catalogo;
create policy afectaciones_catalogo_write_coordinador on afectaciones_catalogo
  for insert with check (soy_coordinador());
drop policy if exists afectaciones_catalogo_update_coordinador on afectaciones_catalogo;
create policy afectaciones_catalogo_update_coordinador on afectaciones_catalogo
  for update using (soy_coordinador()) with check (soy_coordinador());
drop policy if exists afectaciones_catalogo_delete_coordinador on afectaciones_catalogo;
create policy afectaciones_catalogo_delete_coordinador on afectaciones_catalogo
  for delete using (soy_coordinador());

-- =====================================================================
-- Fin del esquema. Sigue con seed.sql para cargar catálogo y bloques.
-- =====================================================================
