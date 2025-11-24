import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Force load .env file
const envConfig = dotenv.parse(fs.readFileSync(path.resolve('.env')));
for (const k in envConfig) {
    process.env[k] = envConfig[k];
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function generateEmbedding(text) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: text,
            encoding_format: 'float'
        })
    });
    const data = await response.json();
    return data.data[0].embedding;
}

async function runCalibration() {
    console.log('📏 Calibration Run (Inspecting Distances)');

    // 1. True Positives (Should have LOW distance)
    const tpQuery = "What is TON 618?";
    console.log(`\n🔍 TP Query: "${tpQuery}"`);
    const tpEmbedding = await generateEmbedding(tpQuery);
    const { data: tpData } = await supabase.rpc('match_messages_v2', {
        query_embedding: tpEmbedding,
        match_threshold: 1.0, // Get everything
        match_count: 5,
        filter: { source: 'precision_test' }
    });
    tpData.forEach(m => console.log(`   - [Dist: ${m.distance.toFixed(4)}] ${m.content.substring(0, 60)}...`));

    // 2. True Negatives (Should have HIGH distance)
    const tnQuery = "What is the capital of Mars?";
    console.log(`\n🔍 TN Query: "${tnQuery}"`);
    const tnEmbedding = await generateEmbedding(tnQuery);
    const { data: tnData } = await supabase.rpc('match_messages_v2', {
        query_embedding: tnEmbedding,
        match_threshold: 1.0, // Get everything
        match_count: 5,
        filter: { source: 'precision_test' }
    });
    tnData.forEach(m => console.log(`   - [Dist: ${m.distance.toFixed(4)}] ${m.content.substring(0, 60)}...`));
}

runCalibration();
