import chalk from 'chalk';
import authService from '../lib/auth.js';
import { v4 as uuidv4 } from 'uuid';

async function save(text, options) {
    try {
        // Initialize auth
        const initialized = await authService.initialize();
        if (!initialized) {
            console.error(chalk.red('❌ Not logged in. Run "mem login" first.'));
            return;
        }

        const supabase = authService.getClient();
        const content = text || await readStdin();

        if (!content || !content.trim()) {
            console.error(chalk.red('❌ No content provided.'));
            return;
        }

        console.log(chalk.gray('Saving memory...'));

        const message = {
            message_id: uuidv4(),
            content: content.trim(),
            role: 'user',
            source: 'cli',
            timestamp: Date.now()
        };

        const { error } = await supabase
            .from('messages')
            .insert(message);

        if (error) {
            throw error;
        }

        console.log(chalk.green('✅ Memory saved!'));

    } catch (error) {
        console.error(chalk.red('❌ Save failed:'), error.message);
    }
}

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        const stdin = process.stdin;

        if (stdin.isTTY) {
            resolve('');
            return;
        }

        stdin.setEncoding('utf8');
        stdin.on('readable', () => {
            const chunk = stdin.read();
            if (chunk !== null) {
                data += chunk;
            }
        });
        stdin.on('end', () => resolve(data));
        stdin.on('error', reject);
    });
}

export default save;
