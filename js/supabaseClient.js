import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Public anon key — safe to expose in a static site. Data access is
// controlled by Postgres Row Level Security policies, not by hiding this key.
const SUPABASE_URL = 'https://qshrulbcfchmrwffgbes.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzaHJ1bGJjZmNobXJ3ZmZnYmVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MzkzMTQsImV4cCI6MjEwNDIxNTMxNH0.zMRrDTszdUKuRozNBFYnK3DcJebz81oH_igZU2vqlx4';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
