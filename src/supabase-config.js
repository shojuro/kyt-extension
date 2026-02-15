/**
 * Supabase public configuration constants.
 *
 * These values are intentionally hardcoded:
 * - SUPABASE_URL is a public project endpoint (no secret)
 * - SUPABASE_ANON_KEY is a public "anonymous" key scoped by RLS policies
 *
 * Both are safe to embed in client-side code.  All data access is gated by
 * Row Level Security on the Supabase side.
 */

export const SUPABASE_URL = 'https://svrcvfzlwhnixzuxaccf.supabase.co';

export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2cmN2Znpsd2huaXh6dXhhY2NmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIxMzkwNjIsImV4cCI6MjA3NzcxNTA2Mn0.AGh-FsrTLjGuRL0aolR4HYjI6rIE1mpk8X9Fa-E-dUU';
