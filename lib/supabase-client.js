import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

// La librería se aloja con la aplicación. Así el acceso no depende de que
// esm.sh esté disponible o permitido por la red del teléfono.
const createClient = globalThis.supabase?.createClient;
export const CONFIGURED = Boolean(createClient) && /^https?:\/\//.test(SUPABASE_URL) && SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith("PON_AQUI");

export const supabase = CONFIGURED ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
