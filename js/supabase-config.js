// =====================================================================
// Configuración de conexión a Supabase
// =====================================================================
// PASO A PASO (ver también README.md):
//   1. Crea una cuenta gratis en https://supabase.com y un proyecto nuevo.
//   2. En el panel del proyecto ve a Settings → API.
//   3. Copia el valor "Project URL" y pégalo abajo en SUPABASE_URL.
//   4. Copia el valor "anon public" (la llave pública, NO la "service_role")
//      y pégalo abajo en SUPABASE_ANON_KEY.
//   5. Guarda este archivo y vuelve a desplegar el sitio en Netlify.
//
// La "anon key" es segura de exponer en el navegador: todo el control de
// acceso real lo hacen las políticas de Row Level Security (RLS) definidas
// en supabase/schema.sql, no esta llave. NUNCA pongas aquí la
// "service_role key" (esa sí es secreta y nunca debe ir en el frontend).
// =====================================================================

window.SUPABASE_URL = 'https://TU-PROYECTO.supabase.co';
window.SUPABASE_ANON_KEY = 'TU-ANON-KEY-PUBLICA-AQUI';

// Dominio sintético usado para mapear teléfono -> correo interno, para
// poder usar Supabase Auth (que requiere un correo) sin pedirle un
// correo real a los líderes de bloque. No necesitas cambiar esto.
window.DOMINIO_CORREO_INTERNO = 'albergue.local';
