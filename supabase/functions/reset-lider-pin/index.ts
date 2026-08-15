// =====================================================================
// Edge Function: reset-lider-pin
// Le permite al coordinador cambiar el PIN (contraseña) de un líder que
// lo olvidó. Solo puede correr aquí (con la llave service_role, que nunca
// debe vivir en el navegador) — el frontend solo llama a esta función.
//
// Cómo desplegarla: Supabase → Edge Functions → Create a new function →
// nómbrala "reset-lider-pin" → pega este archivo → Deploy. Las variables
// SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY ya están
// disponibles automáticamente dentro de la función, no hay que
// configurar nada más.
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Falta el token de autenticación.');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Cliente "de quien llama": solo sirve para confirmar quién es y que
    // sea coordinador, usando su propio token (respeta RLS normal).
    const clienteQuienLlama = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userError } = await clienteQuienLlama.auth.getUser();
    if (userError || !userData.user) throw new Error('No se pudo identificar al usuario que llama.');

    const { data: perfil, error: perfilError } = await clienteQuienLlama
      .from('perfiles')
      .select('rol')
      .eq('id', userData.user.id)
      .single();
    if (perfilError || !perfil || perfil.rol !== 'coordinador') {
      throw new Error('Solo el coordinador puede resetear PINes.');
    }

    const { lider_id, nuevo_pin } = await req.json();
    if (!lider_id || !nuevo_pin || String(nuevo_pin).length !== 6 || !/^\d{6}$/.test(String(nuevo_pin))) {
      throw new Error('Falta el líder o el PIN debe tener exactamente 6 dígitos.');
    }

    // Cliente "admin": solo se usa para esta única operación con la llave
    // de servicio, nunca se expone al navegador.
    const clienteAdmin = createClient(supabaseUrl, serviceRoleKey);
    const { error: updateError } = await clienteAdmin.auth.admin.updateUserById(lider_id, { password: String(nuevo_pin) });
    if (updateError) throw updateError;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400
    });
  }
});
