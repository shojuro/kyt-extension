import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

console.log('Current working directory:', process.cwd());
console.log('__dirname:', path.dirname(fileURLToPath(import.meta.url)));

const keys = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];

console.log('--- Environment Variable Check ---');
keys.forEach(key => {
    const value = process.env[key];
    if (value) {
        console.log(`✅ ${key}: Present (Length: ${value.length})`);
        console.log(`   Prefix: ${value.substring(0, 3)}...`);
    } else {
        console.log(`❌ ${key}: MISSING`);
    }
});
console.log('----------------------------------');
