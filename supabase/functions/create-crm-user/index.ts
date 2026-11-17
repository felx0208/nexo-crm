import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function messageFrom(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const key of ["msg", "message", "error_description", "error"]) {
      if (typeof p[key] === "string" && p[key]) return p[key] as string;
    }
  }
  return fallback;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    console.error("[create-crm-user] Variáveis padrão do Supabase ausentes.");
    return json({ error: "A função de criação de usuários ainda não está configurada no Supabase." }, 500);
  }

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ error: "Entre com a conta de administrador para continuar." }, 401);
  }

  try {
    // Validate the caller's access token against Supabase Auth.
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: authorization },
    });
    if (!authResponse.ok) return json({ error: "Sua sessão expirou. Entre novamente." }, 401);
    const authUser = await authResponse.json();
    if (!authUser?.id) return json({ error: "Não foi possível validar a sessão atual." }, 401);

    // Read the trusted app role on the server; never trust role metadata from the browser.
    const profileResponse = await fetch(
      `${supabaseUrl}/rest/v1/users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=role,is_active&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!profileResponse.ok) {
      console.error("[create-crm-user] Falha ao consultar o perfil do solicitante:", await profileResponse.text());
      return json({ error: "Não foi possível validar as permissões da conta." }, 500);
    }
    const profiles = await profileResponse.json();
    const caller = Array.isArray(profiles) ? profiles[0] : null;
    if (!caller || caller.is_active !== true || caller.role !== "admin") {
      return json({ error: "Somente o administrador pode cadastrar usuários." }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Os dados enviados estão inválidos." }, 400);
    }

    const name = String(body.name || "").trim();
    const username = String(body.username || "").trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const email = username + ".nexo@example.com";

    if (!name || name.length > 120) return json({ error: "Informe um nome com até 120 caracteres." }, 400);
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      return json({ error: "Usuário inválido. Use de 3 a 32 caracteres, letras, números, ponto, hífen ou _." }, 400);
    }
    if (password.length < 12) return json({ error: "A senha precisa ter pelo menos 12 caracteres." }, 400);
    if (password.length > 72) return json({ error: "A senha deve ter no máximo 72 caracteres." }, 400);

    // The Auth trigger creates the linked public.users row with the fixed 'sales' role.
    // No role can be supplied by the browser, so this screen can never create another admin.
    const createResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
      }),
    });
    const created = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok) {
      return json({ error: messageFrom(created, "Não foi possível criar esse acesso. Confira se o nome de usuário já está cadastrado.") }, 400);
    }

    const newAuthId = created?.id;
    if (!newAuthId) return json({ error: "O Supabase não retornou o identificador do novo usuário." }, 500);

    const profileCheck = await fetch(
      `${supabaseUrl}/rest/v1/users?auth_user_id=eq.${encodeURIComponent(newAuthId)}&select=id,name,email,role,is_active&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    const newProfiles = profileCheck.ok ? await profileCheck.json() : [];
    const newProfile = Array.isArray(newProfiles) ? newProfiles[0] : null;
    if (!newProfile) {
      console.error("[create-crm-user] Conta Auth criada, mas o gatilho não criou o perfil público.", newAuthId);
      return json({ error: "A conta foi criada, mas o perfil interno não apareceu. Confira o gatilho de criação de usuários no Supabase." }, 500);
    }

    return json({
      ok: true,
      user: {
        id: Number(newProfile.id),
        name: newProfile.name,
        email: newProfile.email,
        role: "sales",
        is_active: Boolean(newProfile.is_active),
      },
    }, 201);
  } catch (error) {
    console.error("[create-crm-user] Erro interno:", error);
    return json({ error: "Não foi possível concluir o cadastro. Tente novamente." }, 500);
  }
});
