import { supabase, CONFIGURED } from "./supabase-client.js";

const SETUP_MSG = `
  <div style="max-width:520px;margin:80px auto;padding:0 20px;font:15px/1.5 system-ui,sans-serif;color:#3E4A42">
    <h1 style="font:800 26px 'Big Shoulders Display',system-ui;color:#12201A;margin-bottom:8px">Falta configurar Supabase</h1>
    <p>Esta app todavía no está conectada a una base de datos. Abre <code>config.js</code> y pon ahí el <b>Project URL</b> y la <b>anon public key</b> de tu proyecto Supabase (Project Settings &rarr; API).</p>
  </div>`;

function renderNotConfigured() {
  document.body.innerHTML = SETUP_MSG;
}

// Sesión + perfil (id, full_name, role, active) del usuario actual.
// Devuelve null si no hay sesión activa.
export async function getCurrentProfile() {
  if (!CONFIGURED) { renderNotConfigured(); return null; }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, active")
    .eq("id", session.user.id)
    .single();
  if (error) {
    console.error("No se pudo leer el perfil:", error.message);
    return null;
  }
  return { ...data, email: session.user.email };
}

// Protege una página: si no hay sesión, manda a index.html.
// Si allowedRoles no incluye el rol del usuario, manda a su home correcto.
export async function requireRole(allowedRoles) {
  if (!CONFIGURED) { renderNotConfigured(); return null; }
  const profile = await getCurrentProfile();
  if (!profile) {
    window.location.href = "index.html";
    return null;
  }
  if (!profile.active) {
    await supabase.auth.signOut();
    window.location.href = "index.html?inactive=1";
    return null;
  }
  if (!allowedRoles.includes(profile.role)) {
    window.location.href = profile.role === "admin" ? "reportes.html" : "operador.html";
    return null;
  }
  return profile;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = "index.html";
}
