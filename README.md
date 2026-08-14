# Sistema de Censo y Ayudas — Albergue Chimi

Aplicación web para censar hogares por bloque y registrar entregas de
ayuda, con **varios líderes censando al mismo tiempo desde celulares
distintos** y los datos sincronizados en vivo entre todos los
dispositivos. No hay que instalar nada: se abre desde el navegador.

Esta guía está escrita para alguien **sin experiencia técnica**. Sigue
los pasos en orden. Te tomará entre 20 y 30 minutos la primera vez.

---

## Qué necesitas antes de empezar

- Un correo electrónico (para crear la cuenta de Supabase, que es gratis).
- Esta carpeta (`app-censo-chimi`) completa, tal como está.

---

## Paso 1 — Crear tu base de datos gratis en Supabase

1. Ve a [supabase.com](https://supabase.com) y crea una cuenta gratis
   (puedes usar tu cuenta de Google).
2. Haz clic en **New project**.
3. Ponle un nombre, por ejemplo `censo-chimi`, elige una contraseña de
   base de datos (guárdala en un lugar seguro, no la necesitarás para el
   día a día) y elige la región más cercana. Espera 1-2 minutos a que el
   proyecto se termine de crear.

## Paso 2 — Crear las tablas (ejecutar `schema.sql`)

1. En el menú izquierdo de Supabase, entra a **SQL Editor**.
2. Haz clic en **New query**.
3. Abre el archivo `supabase/schema.sql` de esta carpeta con el Bloc de
   notas (o cualquier editor de texto), selecciona todo (Ctrl+A), cópialo
   (Ctrl+C) y pégalo en el SQL Editor de Supabase.
4. Haz clic en **Run** (o presiona Ctrl+Enter). Debe decir "Success" al
   final. Esto crea todas las tablas, reglas de seguridad y el bucket de
   fotos de evidencia.

## Paso 3 — Cargar los datos iniciales (ejecutar `seed.sql`)

1. Abre una **New query** otra vez en el SQL Editor.
2. Copia y pega el contenido de `supabase/seed.sql` y haz clic en **Run**.
   Esto crea los 5 bloques conocidos (2, 3, 4, 6, 7) y el catálogo de
   tipos de ayuda (Desayuno, Almuerzo, Cena, Refrigerio, Pañales, Aseo,
   Mercado, Insumos médicos, Otro).

> El censo de los 202 hogares **no** se carga aquí: se importa después,
> con un botón dentro de la propia aplicación (ver Paso 7).

## Paso 4 — Revisar la configuración de acceso (importante)

Como los líderes no tienen correo electrónico, la app usa su número de
teléfono con un correo interno inventado (ej. `t3001234567@albergue.local`)
y no reciben ningún correo de verificación real. Para que esto funcione:

1. En Supabase, ve a **Authentication → Providers → Email**.
2. Busca la opción **"Confirm email"** y **desactívala** (Disable).
   Guarda los cambios.

Sin este paso, los usuarios nuevos quedarán "por confirmar" y no podrán
iniciar sesión.

## Paso 5 — Copiar tus llaves a la aplicación

1. En Supabase, ve a **Settings → API**.
2. Copia el valor de **Project URL**.
3. Copia el valor de **anon public** (la llave pública; NO copies la
   llave "service_role", esa nunca debe usarse en el navegador).
4. Abre el archivo `js/supabase-config.js` de esta carpeta con el Bloc de
   notas y reemplaza:
   - `https://TU-PROYECTO.supabase.co` por tu Project URL.
   - `TU-ANON-KEY-PUBLICA-AQUI` por tu anon public key.
5. Guarda el archivo.

## Paso 6 — Crear el primer usuario coordinador

El coordinador general es quien administra todo el sistema, así que el
primer usuario hay que crearlo manualmente desde el panel de Supabase
(los líderes siguientes ya los crea el propio coordinador desde la app,
ver más abajo).

1. En Supabase, ve a **Authentication → Users** y haz clic en **Add user
   → Create new user**.
2. En **Email** escribe un correo interno con el mismo formato que usa la
   app: `t` + tu número de teléfono sin espacios + `@albergue.local`.
   Ejemplo, si tu teléfono es `3001234567`: `t3001234567@albergue.local`.
3. En **Password** escribe un PIN de **6 dígitos** (ej. `482913`). Ese
   será tu PIN para entrar a la app.
4. Marca la casilla **Auto Confirm User** si aparece disponible, y crea
   el usuario. Copia el **User UID** que se generó (aparece en la lista
   de usuarios, es un código largo tipo `a1b2c3d4-...`).
5. Vuelve al **SQL Editor**, abre una New query y pega esto (cambia los
   valores por los tuyos):

```sql
insert into perfiles (id, nombre, telefono, rol, bloques_permitidos)
values ('PEGA-AQUI-EL-USER-UID', 'Tu nombre completo', '3001234567', 'coordinador', '{}');
```

6. Haz clic en **Run**. Ya tienes tu usuario coordinador.

## Paso 7 — Publicar el sitio en Netlify

1. Ve a [app.netlify.com](https://app.netlify.com) y crea una cuenta
   gratis (puedes usar tu cuenta de Google o GitHub).
2. En el panel principal busca la zona que dice algo como **"Drag and
   drop your site output folder here"** (arrastra aquí la carpeta de tu
   sitio).
3. Abre el explorador de archivos de tu computador, entra a la carpeta
   `app-censo-chimi` y arrástrala completa a esa zona de Netlify.
4. En un minuto tendrás una URL pública (algo como
   `https://nombre-al-azar.netlify.app`). Esa es la dirección que vas a
   compartir con los líderes de bloque para que la abran desde su
   celular (puedes guardarla como acceso directo en la pantalla de
   inicio del celular, como si fuera una app).

> Alternativa para quien sepa usar Git: puedes conectar un repositorio
> (GitHub/GitLab) en vez de arrastrar la carpeta, y Netlify lo desplegará
> automáticamente cada vez que subas cambios. El archivo `netlify.toml`
> ya está listo para ese flujo (no requiere ningún comando de build).

## Paso 8 — Entrar por primera vez e importar el censo

1. Abre la URL de Netlify, ingresa con tu teléfono y el PIN de 6 dígitos
   que creaste en el Paso 6.
2. Ve a la pestaña **Administración**.
3. Haz clic en **"Importar censo inicial (202 hogares)"**. Espera a que
   termine la barra de progreso (puede tardar uno o dos minutos). Los
   hogares importados quedan marcados como "Censo inicial (importado)"
   en sus observaciones.

## Paso 9 — Crear los líderes de bloque

1. En **Administración → Líderes de bloque**, haz clic en **+ Líder**.
2. Escribe su nombre, su número de teléfono y crea un PIN de 6 dígitos
   para él/ella (puede ser una fecha, o algo fácil de recordar). Marca
   el o los bloques que va a atender.
3. Haz clic en **Crear líder**. Avísale su teléfono y PIN — con eso ya
   puede entrar desde su propio celular a `#/censo` y solo verá los
   hogares de su bloque.

Si al crear un líder aparece un error de "confirmación de correo", vuelve
al Paso 4 y confirma que "Confirm email" quede desactivado.

---

## Cómo usan la app cada rol

**Líder de bloque**: entra con teléfono + PIN, ve solo el censo de su(s)
bloque(s) asignado(s). Puede censar hogares nuevos y editar los que ya
existen en su bloque (personas, mascotas, necesidad médica). No ve
entregas, inventario ni el catálogo de ayudas — esas pantallas ni
siquiera aparecen en su menú, y aunque alguien intentara acceder
manipulando la aplicación, la base de datos (Supabase) también lo
bloquea con reglas de seguridad a nivel de fila (RLS).

**Coordinador general**: ve y administra todo — todos los bloques,
torres, líderes, el censo completo, registra las entregas de ayuda (a
quién, qué, cuánto, con foto opcional de evidencia), administra el
inventario y el catálogo de tipos de ayuda, y puede exportar reportes en
CSV desde la pestaña Reportes.

Por qué solo el coordinador registra entregas: la ayuda física siempre
llega primero a manos del coordinador, quien se la entrega a cada líder
de bloque para que la reparta puerta a puerta. Por eso es el coordinador
quien dice en el sistema "esto se le entregó a esta familia / a este
bloque", no cada líder.

## Respaldo y datos sin conexión

Los datos viven en Supabase (la nube), no en el celular, así que varios
líderes pueden censar al mismo tiempo y todos ven lo mismo casi al
instante. Si un celular pierde la señal, la aplicación muestra un aviso
("Sin conexión a internet") y evita que se pierdan cambios a medias;
simplemente espera a recuperar señal y vuelve a intentar guardar.

Puedes exportar respaldos en CSV en cualquier momento desde
**Reportes → Exportar a CSV**.

## Agregar un nuevo tipo de ayuda o un ítem de inventario

Desde **Catálogo de ayudas** (coordinador) puedes agregar tipos nuevos
(ej. "Ropa", "Kit escolar") sin tocar código. Desde **Inventario** puedes
crear ítems nuevos, asociarlos a un tipo de ayuda, y registrar entradas
de mercancía cuando llegue una donación; el sistema descuenta el stock
automáticamente cada vez que ese ítem se usa en una entrega.

## Preguntas frecuentes

**¿Puedo cambiar los colores o el texto?** Sí — todo el diseño está en
`css/styles.css` (colores, tamaños) y los textos están directamente en
`js/app.js`. Son archivos de texto plano, no requieren instalar nada
para editarlos, solo un editor de texto.

**¿Puedo usar esto sin Netlify?** Sí, cualquier hosting de archivos
estáticos sirve (GitHub Pages, Vercel, un servidor propio). Lo único
obligatorio es tener configurado `js/supabase-config.js` con tus llaves.

**¿Es seguro que la "anon key" quede visible en el navegador?** Sí, está
diseñada para eso. La seguridad real la dan las políticas de Row Level
Security definidas en `supabase/schema.sql`, que se ejecutan en el
servidor de Supabase pase lo que pase en el navegador del usuario.
