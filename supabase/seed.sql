-- =====================================================================
-- Sistema de Censo y Ayudas — Albergue Chimi
-- Datos iniciales: bloques conocidos y catálogo de tipos de ayuda.
-- Corre esto DESPUÉS de schema.sql, en el mismo SQL Editor de Supabase.
-- Es seguro volver a ejecutarlo (usa "on conflict do nothing").
--
-- El censo de los 202 hogares NO se carga aquí: se importa desde la
-- propia aplicación con el botón "Importar censo inicial" del panel del
-- coordinador (usa el archivo js/seed-hogares.js, ya incluido en la
-- app). Así se evita pegar 202 INSERT a mano y el sistema puede detectar
-- si un hogar ya fue importado antes de duplicarlo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Bloques conocidos del albergue
-- ---------------------------------------------------------------------
insert into bloques (id, nombre) values
  ('2', 'Bloque 2'),
  ('3', 'Bloque 3'),
  ('4', 'Bloque 4'),
  ('6', 'Bloque 6'),
  ('7', 'Bloque 7')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Catálogo de tipos de ayuda (ver references/catalogo_ayudas.md)
-- El coordinador puede agregar más desde el panel "Catálogo de ayudas".
-- ---------------------------------------------------------------------
insert into tipos_ayuda (nombre, campo_adicional, orden) values
  ('Desayuno',        'Número de raciones', 1),
  ('Almuerzo',         'Número de raciones', 2),
  ('Cena',             'Número de raciones', 3),
  ('Refrigerio',       'Número de raciones', 4),
  ('Pañales',          'Talla y cantidad de paquetes', 5),
  ('Productos de aseo','Tipo de kit y cantidad', 6),
  ('Mercado',          'Número de mercados o kilos', 7),
  ('Insumos médicos',  'Descripción y cantidad', 8),
  ('Otro',             'Descripción libre corta', 9)
on conflict (nombre) do nothing;

-- ---------------------------------------------------------------------
-- Ítems de inventario de ejemplo (el coordinador ajusta cantidades
-- reales desde el panel "Inventario" apenas reciba mercancía).
-- personas_por_unidad: para ítems dimensionados por persona (ej. un kit
-- de aseo alcanza para 1 persona); si el ítem es por familia, se deja
-- dimensionado_por_persona = false y se usa el tamaño del hogar solo
-- como referencia informativa.
-- ---------------------------------------------------------------------
insert into inventario_items (nombre, unidad, tipo_ayuda_id, cantidad_disponible, dimensionado_por_persona, personas_por_unidad, stock_minimo)
select 'Mercado familiar', 'kit', (select id from tipos_ayuda where nombre = 'Mercado'), 0, false, 1, 10
where not exists (select 1 from inventario_items where nombre = 'Mercado familiar');

insert into inventario_items (nombre, unidad, tipo_ayuda_id, cantidad_disponible, dimensionado_por_persona, personas_por_unidad, stock_minimo)
select 'Pañales talla G', 'paquete', (select id from tipos_ayuda where nombre = 'Pañales'), 0, false, 1, 5
where not exists (select 1 from inventario_items where nombre = 'Pañales talla G');

insert into inventario_items (nombre, unidad, tipo_ayuda_id, cantidad_disponible, dimensionado_por_persona, personas_por_unidad, stock_minimo)
select 'Kit de aseo personal', 'kit', (select id from tipos_ayuda where nombre = 'Productos de aseo'), 0, true, 1, 10
where not exists (select 1 from inventario_items where nombre = 'Kit de aseo personal');

insert into inventario_items (nombre, unidad, tipo_ayuda_id, cantidad_disponible, dimensionado_por_persona, personas_por_unidad, stock_minimo)
select 'Botiquín básico', 'unidad', (select id from tipos_ayuda where nombre = 'Insumos médicos'), 0, false, 1, 3
where not exists (select 1 from inventario_items where nombre = 'Botiquín básico');

-- =====================================================================
-- Siguiente paso: crea el primer usuario coordinador (ver README.md,
-- sección "Crear el primer coordinador") y luego entra a la app para
-- importar el censo inicial desde el panel de administración.
-- =====================================================================
