import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env manually
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env');

try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const env = {};
    envContent.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join('=').trim(); // Handle values with =
            env[key] = value;
        }
    });

    const apiKey = env.OPENAI_API_KEY;

    console.log('--- Debugging OpenAI Connection ---');
    console.log(`Env Path: ${envPath}`);
    console.log(`API Key Found: ${!!apiKey}`);
    if (apiKey) {
        console.log(`API Key Length: ${apiKey.length}`);
        console.log(`API Key Start: ${apiKey.substring(0, 7)}...`);
    } else {
        console.error('❌ No OPENAI_API_KEY found in .env');
        process.exit(1);
    }

    // Test Request
    console.log('\nSending test request to OpenAI...');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'Say "Hello"' }],
            max_tokens: 5
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ API Error: ${response.status} ${response.statusText}`);
        console.error(`Response Body: ${errorText}`);
    } else {
        const data = await response.json();
        console.log('✅ API Success!');
        console.log('Response:', JSON.stringify(data, null, 2));
    }

} catch (error) {
    console.error('❌ Script Error:', error);
}
