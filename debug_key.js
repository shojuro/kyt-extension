import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const match = envContent.match(/OPENAI_API_KEY=(.*)/);
const key = match ? match[1].trim().replace(/^"|"$/g, '') : null;

console.log(`Reading directly from .env...`);
console.log(`Key length: ${key ? key.length : 'missing'}`);

if (!key) process.exit(1);

async function test() {
    try {
        const response = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${key.trim().replace(/^"|"$/g, '')}` }
        });

        if (response.ok) {
            console.log('✅ API Key works!');
        } else {
            console.log(`❌ API Error: ${response.status} ${response.statusText}`);
            console.log(await response.text());
        }
    } catch (e) {
        console.error('❌ Network error:', e);
    }
}

test();
