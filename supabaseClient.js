// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js'

// As variáveis serão lidas do ambiente de produção do Cloudflare
const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
