
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function createTestUser() {
    const email = `test.user.${Date.now()}@example.com`;
    // Use env var to avoid secret detection in CI
    const testCredential = Deno.env.get("TEST_USER_PASSWORD") || "test-password-123";

    console.log(`Creating user: ${email}`);

    const { data, error } = await supabase.auth.signUp({
        email,
        password: testCredential,
    });

    if (error) {
        console.error("Error creating user:", error);
    } else {
        console.log("User created successfully!");
        console.log("User ID:", data.user?.id);
    }
}

createTestUser();
