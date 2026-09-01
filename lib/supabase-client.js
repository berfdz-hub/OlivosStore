import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

export const CONFIGURED = /^https?:\/\//.test(SUPABASE_URL) && SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith("PON_AQUI");

export const supabase = CONFIGURED ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
