import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { searchMessages } from '../src/browser-search.js';

// --- MOCK CHROME API ---
if (!global.chrome) {
    global.chrome = {
        storage: {
            local: {
                get: async (keys) => {
                    return {
                        api_config: {
                            supabaseUrl: process.env.SUPABASE_URL,
                            supabaseKey: process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
                            openaiKey: process.env.OPENAI_API_KEY,
                            disableQueryTransformation: true // Disable for raw precision testing
                        }
                    };
                }
            }
        }
    };
}

// --- CONFIG ---
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Force load .env file to bypass stale shell variables
const envConfig = dotenv.parse(fs.readFileSync(path.resolve('.env')));
for (const k in envConfig) {
    process.env[k] = envConfig[k];
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
let OPENAI_KEY = process.env.OPENAI_API_KEY;

if (OPENAI_KEY) {
    OPENAI_KEY = OPENAI_KEY.trim();
    if (OPENAI_KEY.startsWith('"') && OPENAI_KEY.endsWith('"')) {
        OPENAI_KEY = OPENAI_KEY.slice(1, -1);
    }
}

console.log('🔑 Debug Config:');
console.log(`   SUPABASE_URL: ${SUPABASE_URL ? 'Set' : 'Missing'}`);
console.log(`   SUPABASE_KEY: ${SUPABASE_KEY ? 'Set (' + SUPABASE_KEY.length + ' chars)' : 'Missing'}`);
console.log(`   OPENAI_KEY: ${OPENAI_KEY ? 'Set (' + OPENAI_KEY.length + ' chars, starts with ' + OPENAI_KEY.substring(0, 7) + '...)' : 'Missing'}`);

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) {
    console.error('❌ Missing .env variables:');
    if (!SUPABASE_URL) console.error('   - SUPABASE_URL');
    if (!SUPABASE_KEY) console.error('   - SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY)');
    if (!OPENAI_KEY) console.error('   - OPENAI_API_KEY');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- TEST DATA ---
const RELEVANT_FACTS = [
    "TON 618 is a hyperluminous broad-absorption-line radio-loud quasar located near the border of the constellations Canes Venatici and Coma Berenices.",
    "It possesses one of the most massive black holes ever found, with a mass of 66 billion solar masses.",
    "The event horizon of TON 618 has a radius of 1,300 astronomical units (AU).",
    "TON 618's accretion disk shines with the luminosity of 140 trillion Suns.",
    "It is located about 10.4 billion light-years away from Earth.",
    "The quasar was first discovered in a 1957 survey of faint blue stars.",
    "TON 618 is so large that it could swallow the entire Solar System multiple times over.",
    "Its Schwarzschild radius is approximately 190 billion kilometers.",
    "The surrounding galaxy is not visible from Earth because the quasar outshines it.",
    "TON 618 is a relic from the early universe, offering clues about galaxy formation."
];

const NOISE_FACTS = [
    "The weather in Paris is currently 15 degrees Celsius with light rain.",
    "How to bake a chocolate cake: preheat oven to 350 degrees.",
    "Python is a high-level programming language known for its readability.",
    "The mitochondria is the powerhouse of the cell.",
    "React is a JavaScript library for building user interfaces.",
    "The Great Wall of China is visible from space (myth).",
    "Elon Musk is the CEO of Tesla and SpaceX.",
    "Photosynthesis converts light energy into chemical energy.",
    "The capital of Japan is Tokyo.",
    "E=mc^2 is Einstein's famous equation.",
    "Docker containers are lightweight and portable.",
    "Kubernetes is an orchestration platform for containers.",
    "Supabase is an open-source Firebase alternative.",
    "PostgreSQL is a powerful object-relational database system.",
    "JavaScript was created by Brendan Eich in 10 days.",
    "The speed of light is approximately 299,792,458 meters per second.",
    "Water boils at 100 degrees Celsius at sea level.",
    "The human body has 206 bones.",
    "The Eiffel Tower is located in Paris, France.",
    "Artificial Intelligence is transforming industries."
];

// --- SEEDING ---
async function generateEmbedding(text) {
    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_KEY}`
            },
            body: JSON.stringify({
                model: 'text-embedding-3-small',
                input: text,
                encoding_format: 'float'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ OpenAI API Error (${response.status}):`, errorText);
            throw new Error(`OpenAI API Error: ${response.statusText}`);
        }

        const data = await response.json();
        if (!data.data || !data.data[0]) {
            console.error('❌ Unexpected OpenAI response format:', JSON.stringify(data));
            throw new Error('Invalid OpenAI response');
        }
        return data.data[0].embedding;
    } catch (error) {
        console.error('❌ generateEmbedding failed:', error);
        throw error;
    }
}

async function seedData() {
    console.log('🌱 Seeding test data...');

    // Check if already seeded (simple check)
    const { count } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('source', 'precision_test');
    if (count > 0) {
        console.log(`   Data already seeded (${count} records). Skipping.`);
        return;
    }

    const allFacts = [...RELEVANT_FACTS, ...NOISE_FACTS];
    const messages = [];

    for (const fact of allFacts) {
        const embedding = await generateEmbedding(fact);
        messages.push({
            content: fact,
            role: 'assistant',
            source: 'precision_test', // Tag for easy cleanup/filtering
            timestamp: Date.now(),
            message_id: `test_${Math.random().toString(36).substr(2, 9)}`,
            embedding: embedding
        });
        process.stdout.write('.');
    }
    console.log('');

    const { error } = await supabase.from('messages').insert(messages);
    if (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    }
    console.log(`✅ Seeded ${messages.length} messages.`);
}

// --- TEST HARNESS ---
const TEST_CASES = [
    // Relevant
    { query: "What is TON 618?", expected: "TON 618", type: "relevant" },
    { query: "How massive is the black hole?", expected: "66 billion solar masses", type: "relevant" },
    { query: "How far away is it?", expected: "10.4 billion light-years", type: "relevant" },
    { query: "What is its luminosity?", expected: "140 trillion Suns", type: "relevant" },
    { query: "When was it discovered?", expected: "1957", type: "relevant" },
    { query: "How big is the event horizon?", expected: "1,300 astronomical units", type: "relevant" },
    { query: "Can we see the galaxy?", expected: "not visible", type: "relevant" },
    { query: "What is the Schwarzschild radius?", expected: "190 billion kilometers", type: "relevant" },
    { query: "Is it bigger than the solar system?", expected: "swallow the entire Solar System", type: "relevant" },
    { query: "What constellation is it in?", expected: "Canes Venatici", type: "relevant" },

    // Irrelevant
    { query: "What is the weather in Paris?", expected: null, type: "irrelevant" },
    { query: "How do I bake a cake?", expected: null, type: "irrelevant" },
    { query: "Who created Python?", expected: null, type: "irrelevant" },
    { query: "What is the powerhouse of the cell?", expected: null, type: "irrelevant" },
    { query: "Tell me about React.", expected: null, type: "irrelevant" },
    { query: "Is the Great Wall visible from space?", expected: null, type: "irrelevant" },
    { query: "Who is Elon Musk?", expected: null, type: "irrelevant" },
    { query: "How does photosynthesis work?", expected: null, type: "irrelevant" },
    { query: "Capital of Japan?", expected: null, type: "irrelevant" },
    { query: "Explain E=mc^2", expected: null, type: "irrelevant" },
    { query: "What is Docker?", expected: null, type: "irrelevant" },
    { query: "What is Kubernetes?", expected: null, type: "irrelevant" },
    { query: "What is Supabase?", expected: null, type: "irrelevant" },
    { query: "Tell me about PostgreSQL.", expected: null, type: "irrelevant" },
    { query: "Who made JavaScript?", expected: null, type: "irrelevant" },
    { query: "Speed of light?", expected: null, type: "irrelevant" },
    { query: "Boiling point of water?", expected: null, type: "irrelevant" },
    { query: "How many bones in human body?", expected: null, type: "irrelevant" },
    { query: "Where is Eiffel Tower?", expected: null, type: "irrelevant" },
    { query: "Future of AI?", expected: null, type: "irrelevant" }
];

async function runTests(threshold) {
    console.log(`\n🧪 Running tests with threshold: ${threshold}`);
    let correctRetrievals = 0;
    let totalRelevant = 0;
    let falsePositives = 0;
    let totalIrrelevant = 0;

    for (const test of TEST_CASES) {
        // We only want to search our test data, so we filter by source='precision_test'
        // Note: searchMessages supports 'source' filter
        const results = await searchMessages(test.query, {
            limit: 5,
            threshold: threshold,
            source: 'precision_test'
        });

        if (test.type === 'relevant') {
            totalRelevant++;
            const found = results.some(r => r.content.toLowerCase().includes(test.expected.toLowerCase()));
            if (found) {
                correctRetrievals++;
                // console.log(`   ✅ Found: "${test.query}" -> "${results[0].content.substring(0, 30)}..."`);
            } else {
                console.log(`   ❌ Missed: "${test.query}" (Expected: "${test.expected}")`);
                if (results.length > 0) console.log(`      Got: "${results[0].content.substring(0, 50)}..."`);
            }
        } else {
            totalIrrelevant++;
            if (results.length > 0) {
                falsePositives++;
                console.log(`   ⚠️  False Positive: "${test.query}" -> "${results[0].content.substring(0, 50)}..."`);
            }
        }
    }

    const precision = totalRelevant > 0 ? correctRetrievals / totalRelevant : 0;
    const fpRate = totalIrrelevant > 0 ? falsePositives / totalIrrelevant : 0;

    console.log(`\n📊 Results (Threshold ${threshold}):`);
    console.log(`   Precision (Recall for Relevant): ${(precision * 100).toFixed(1)}% (${correctRetrievals}/${totalRelevant})`);
    console.log(`   False Positive Rate: ${(fpRate * 100).toFixed(1)}% (${falsePositives}/${totalIrrelevant})`);

    return { precision, fpRate };
}

async function main() {
    await seedData();

    // Test multiple thresholds
    const thresholds = [0.5, 0.6, 0.7, 0.8];
    const results = [];

    for (const t of thresholds) {
        const res = await runTests(t);
        results.push({ threshold: t, ...res });
    }

    console.log('\n🏆 Final Summary:');
    console.table(results);

    // Recommendation
    const optimal = results.find(r => r.precision >= 0.9 && r.fpRate < 0.1);
    if (optimal) {
        console.log(`\n✅ Optimal Threshold: ${optimal.threshold}`);
    } else {
        console.log(`\n⚠️  No threshold met strict criteria (>90% Precision, <10% FP). Consider 0.7 or 0.8.`);
    }
}

main().catch(console.error);
