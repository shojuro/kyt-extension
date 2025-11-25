import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateGravityScore, classifyImpact } from '../src/gravity-scorer.js';

// Load .env manually
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
        // Strip quotes from value if present
        const cleanValue = value.trim().replace(/^['"]|['"]$/g, '');
        env[key.trim()] = cleanValue;
    }
});

const OPENAI_API_KEY = env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not found in .env');
    process.exit(1);
}

// Test Data: 50 diverse messages
const testMessages = [
    // Critical (Death, Divorce, Jail, Major Illness)
    "My wife passed away yesterday.",
    "I am getting a divorce.",
    "I was diagnosed with cancer.",
    "My son was arrested.",
    "My house burned down.",
    "My partner left me.",
    "I had a heart attack.",
    "My mother died.",
    "I'm going to jail.",
    "I lost custody of my children.",

    // Major (Fired, Moving, Pregnancy, Marriage)
    "I got fired from my job.",
    "I'm moving to a new city next month.",
    "We are expecting a baby!",
    "I just got married.",
    "I bought a new house.",
    "I'm retiring next year.",
    "I started a new business.",
    "I graduated from college.",
    "I'm changing careers.",
    "I have a large debt to pay off.",

    // Moderate (Trouble with boss, Mortgage, School)
    "My boss is being difficult.",
    "My mortgage payments are going up.",
    "My daughter is failing math.",
    "I had a fight with my neighbor.",
    "I need to find a new roommate.",
    "My car broke down.",
    "I'm learning to play the guitar.",
    "I'm training for a marathon.",
    "I'm renovating the kitchen.",
    "I'm planning a family reunion.",

    // Minor (Traffic, Vacation, Holidays)
    "Traffic was terrible today.",
    "I'm going on vacation to Hawaii.",
    "Christmas is coming up.",
    "I got a speeding ticket.",
    "I need to renew my license.",
    "I'm trying a new diet.",
    "I joined a gym.",
    "I'm reading a good book.",
    "I watched a great movie.",
    "I'm going to a concert.",

    // Trivial (Weather, Greetings, Random)
    "The weather is nice today.",
    "Hello, how are you?",
    "I like pizza.",
    "Did you see the game?",
    "I'm tired.",
    "What's for dinner?",
    "I need to buy milk.",
    "The sky is blue.",
    "I saw a cute dog.",
    "Just checking in."
];

async function runSimulation() {
    console.log('🚀 Starting Gravity Simulation...');
    console.log(`📊 Processing ${testMessages.length} messages...`);
    console.log('--------------------------------------------------');
    console.log('Message | Impact | Reasoning | 1h | 24h | 7d | 30d');
    console.log('--------------------------------------------------');

    const results = [];

    for (const msg of testMessages) {
        // 1. Classify
        const { score: impact, reasoning } = await classifyImpact(msg, OPENAI_API_KEY);

        // 2. Calculate Decay
        const score1h = calculateGravityScore(impact, 1);
        const score24h = calculateGravityScore(impact, 24);
        const score7d = calculateGravityScore(impact, 24 * 7);
        const score30d = calculateGravityScore(impact, 24 * 30);

        // Log row
        console.log(`"${msg.substring(0, 20)}..." | ${impact} | ${reasoning.substring(0, 20)}... | ${score1h.toFixed(1)} | ${score24h.toFixed(1)} | ${score7d.toFixed(1)} | ${score30d.toFixed(1)}`);

        results.push({
            message: msg,
            impact,
            reasoning,
            score1h,
            score24h,
            score7d,
            score30d
        });

        // Rate limit
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log('--------------------------------------------------');
    console.log('✅ Simulation Complete.');

    // Save to CSV
    const csvContent = [
        'Message,Impact,Reasoning,Score_1h,Score_24h,Score_7d,Score_30d',
        ...results.map(r => `"${r.message}",${r.impact},"${r.reasoning}",${r.score1h.toFixed(2)},${r.score24h.toFixed(2)},${r.score7d.toFixed(2)},${r.score30d.toFixed(2)}`)
    ].join('\n');

    fs.writeFileSync('gravity_results.csv', csvContent);
    console.log('💾 Results saved to gravity_results.csv');
}

runSimulation().catch(console.error);
