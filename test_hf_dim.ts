import { HuggingFaceClient } from './supabase/functions/_shared/huggingface-client.ts';
import { config } from "https://deno.land/x/dotenv/mod.ts";

const env = config();
const apiKey = Deno.env.get("HUGGINGFACE_API_KEY") || env.HUGGINGFACE_API_KEY;

if (!apiKey) {
    console.error("No API Key found");
    Deno.exit(1);
}

const client = new HuggingFaceClient(apiKey);

try {
    console.log("Generating embedding...");
    const embeddings = await client.generateEmbeddings("Hello world");
    console.log("Success!");
    console.log("Number of embeddings:", embeddings.length);
    console.log("Dimension:", embeddings[0].length);
} catch (e) {
    console.error("Error:", e);
}
