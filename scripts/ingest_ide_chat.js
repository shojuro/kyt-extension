import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Configuration
const CONFIG = {
    embeddingModel: 'text-embedding-3-small',
    source: 'cli', // Special source for IDE chats
    batchSize: 5
};

// Initialize clients
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY || !process.env.OPENAI_API_KEY) {
    console.error('❌ Missing required environment variables in .env');
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const apiKey = process.env.OPENAI_API_KEY?.trim();
console.log(`🔑 API Key loaded (Length: ${apiKey?.length})`);
const openai = new OpenAI({ apiKey: apiKey });

async function generateEmbedding(text) {
    try {
        if (!text) {
            throw new Error('Text for embedding is empty or null');
        }

        const response = await openai.embeddings.create({
            model: CONFIG.embeddingModel,
            input: text,
            encoding_format: 'float'
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error(`❌ Embedding failed for text: "${text?.substring(0, 50)}..."`);
        if (error.response) {
            console.error('   API Response:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('   Error details:', error.message);
        }
        throw error;
    }
}

async function ingestChat() {
    try {
        console.log('🚀 Starting IDE Chat Ingestion...');

        // Read history file
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const historyPath = path.join(__dirname, '../ide_chat_history.json');
        const rawData = await fs.readFile(historyPath, 'utf-8');
        const messages = JSON.parse(rawData);

        console.log(`📦 Loaded ${messages.length} messages from history.`);

        // Process messages
        let processed = 0;
        const records = [];

        for (const msg of messages) {
            console.log(`🔹 Processing message ${processed + 1}/${messages.length}...`);

            // Generate embedding
            const embedding = await generateEmbedding(msg.content);

            // Create record
            const record = {
                content: msg.content,
                role: msg.role,
                timestamp: msg.timestamp,
                source: CONFIG.source,
                embedding: embedding,
                // Generate a deterministic but unique ID for this import
                message_id: `ide_${msg.timestamp}_${processed}`,
                synced_from_extension: new Date().toISOString()
            };

            records.push(record);
            processed++;

            // Rate limit helper
            await new Promise(r => setTimeout(r, 200));
        }

        // Bulk insert to Supabase
        console.log(`📤 Uploading ${records.length} records to Supabase...`);

        const { data, error } = await supabase
            .from('messages')
            .upsert(records, { onConflict: 'message_id' });

        if (error) {
            throw new Error(`Supabase insert failed: ${error.message}`);
        }

        console.log('✅ Ingestion Complete!');
        console.log(`   - ${processed} messages saved.`);
        console.log(`   - Source: '${CONFIG.source}'`);
        console.log('   - You can now search this conversation in your extension.');

    } catch (error) {
        console.error('❌ Ingestion failed:', error);
        process.exit(1);
    }
}

ingestChat();
