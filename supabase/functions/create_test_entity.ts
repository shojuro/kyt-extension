
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HuggingFaceClient } from "./_shared/huggingface-client.ts";

// Load env vars
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const hfApiKey = Deno.env.get("HUGGINGFACE_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const hfClient = new HuggingFaceClient(hfApiKey);

const USER_ID = "0499c405-3bff-4901-bc94-d5d0a0c301e4";
const CHAT_TURN_ID = "d6e34b2d-f59a-43d6-abb6-41948b439003"; // One of the "Jenn is my nanny" turns

async function createTestEntity() {
    console.log("Creating test entity...");

    // 1. Generate embedding for "Jenn" (the query term)
    // We want the entity "Jennifer" to be found when searching for "Jenn"
    const embedding = await hfClient.generateEmbeddings("Jenn");

    // 2. Insert Entity
    const { data: entity, error: entityError } = await supabase
        .from("entities")
        .insert({
            user_id: USER_ID,
            entity_text: "Jennifer",
            entity_type: "PER",
            canonical_name: "jennifer_nanny",
            embedding: embedding[0],
            normalized_name: "jennifer"
        })
        .select()
        .single();

    if (entityError) {
        console.error("Error creating entity:", entityError);
        return;
    }
    console.log("Entity created:", entity.id);

    // 3. Insert Mention
    const { error: mentionError } = await supabase
        .from("entity_mentions")
        .insert({
            entity_id: entity.id,
            chat_turn_id: CHAT_TURN_ID,
            mention_text: "Jenn",
            confidence: 0.95
        });

    if (mentionError) {
        console.error("Error creating mention:", mentionError);
        return;
    }
    console.log("Mention created linking Entity to Chat Turn.");
}

createTestEntity();
