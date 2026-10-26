import { supabase, CONFIGURED } from "./supabase-client.js";
import { getCurrentProfile } from "./auth.js";
const message = (type, text) => {
  const box = document.getElementById("msgBox");
  box.className = "msg " + type;
  box.textContent = text;
};
const recovering = new URLSearchParams(location.search).has("recover");
function showRecovery() {
  document.getElementById("formLogin").hidden = true;
  document.getElementById("formRecovery").hidden = false;
}
async function enter() {
  const profile = await getCurrentProfile();
  if (!profile) return;
  if (!profile.active) {
    await supabase.auth.signOut();
    message(
      "warn",
      "Tu cuenta está pendiente de aprobación o desactivada. Contacta a la administración.",
    );
    return;
  }
  location.href = profile.role === "admin" ? "reportes.html" : "operador.html";
}
if (!CONFIGURED) {
  message(
    "err",
    "El servicio de acceso no está disponible. Contacta a la administración.",
  );
  document.getElementById("btnLogin").disabled = true;
} else {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") showRecovery();
  });
  if (recovering) {
    showRecovery();
    supabase.auth.getSession().then(({ data, error }) => {
      if (error || !data.session) {
        message("err", "El enlace de recuperación expiró. Solicita uno nuevo.");
        document.getElementById("formRecovery").hidden = true;
        document.getElementById("formLogin").hidden = false;
      }
    });
  } else if (new URLSearchParams(location.search).has("inactive"))
    message(
      "warn",
      "Tu cuenta está pendiente de aprobación o desactivada. Contacta a la administración.",
    );
  else enter().catch((e) => message("err", e.message));
}
document.getElementById("formLogin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btnLogin");
  btn.disabled = true;
  message("info", "Conectando...");
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: document.getElementById("loginEmail").value.trim(),
      password: document.getElementById("loginPassword").value,
    });
    if (error)
      throw new Error(
        error.message === "Invalid login credentials"
          ? "Correo o contraseña incorrectos."
          : "No se pudo iniciar sesión. Inténtalo nuevamente.",
      );
    await enter();
  } catch (error) {
    message("err", error.message);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("btnForgot").addEventListener("click", async () => {
  const email = document.getElementById("loginEmail");
  if (!email.value || !email.checkValidity()) {
    message(
      "warn",
      "Escribe tu correo para solicitar el enlace de recuperación.",
    );
    email.focus();
    return;
  }
  const btn = document.getElementById("btnForgot");
  btn.disabled = true;
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(
      email.value.trim(),
      { redirectTo: new URL("index.html?recover=1", location.href).href },
    );
    if (error) throw error;
    message(
      "ok",
      "Si el correo tiene una cuenta, recibirás un enlace para restablecer la contraseña.",
    );
  } catch (error) {
    message("err", "No se pudo enviar el enlace. Inténtalo nuevamente.");
  } finally {
    btn.disabled = false;
  }
});
document
  .getElementById("formRecovery")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("newPassword").value;
    if (password !== document.getElementById("confirmPassword").value) {
      message("err", "Las contraseñas no coinciden.");
      return;
    }
    const btn = document.getElementById("btnRecover");
    btn.disabled = true;
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      await supabase.auth.signOut();
      history.replaceState(null, "", "index.html");
      document.getElementById("formRecovery").hidden = true;
      document.getElementById("formLogin").hidden = false;
      message("ok", "Contraseña actualizada. Inicia sesión.");
    } catch (error) {
      message(
        "err",
        "No se pudo actualizar la contraseña. Solicita un nuevo enlace e inténtalo otra vez.",
      );
    } finally {
      btn.disabled = false;
    }
  });
