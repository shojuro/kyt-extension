import LogWatcher from '../lib/watcher.js';
import authService from '../lib/auth.js';
import chalk from 'chalk';
import path from 'path';
        }

const supabase = authService.getClient();

// Check login and set session (only if not in Admin Mode)
if (authService.isAdminMode()) {
    console.log(chalk.yellow('⚠️ Running in Admin Mode (Service Key) - Bypassing RLS'));
} else {
    const token = await authService.getToken();
    if (!token) {
        console.error(chalk.red('❌ Not logged in. Run "mem login" first.'));
        return;
    }

    // Set session for RLS
    const { error: sessionError } = await supabase.auth.setSession({
        access_token: token,
        refresh_token: token
    });

    if (sessionError) {
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            console.error(chalk.red('❌ Invalid or expired token. Run "mem login" again.'));
            return;
        }
        // Fallback for when setSession fails but token is valid (e.g. some token types)
        supabase.realtime.setAuth(token);
        supabase.headers['Authorization'] = `Bearer ${token}`;
    }
}

// Determine log path
const homeDir = os.homedir();
const logPath = path.join(homeDir, '.claude', 'history.jsonl');

const watcher = new LogWatcher(logPath);

console.log(chalk.blue('👀 Starting AI Memory Watcher...'));
console.log(chalk.gray(`Target: ${logPath}`));

watcher.on('memory', async (memory) => {
    console.log(chalk.gray(`Captured: "${memory.content.substring(0, 50)}..."`));

    try {
        const { error } = await supabase
            .from('messages')
            .insert({
                id: uuidv4(),
                content: memory.content,
                role: 'user',
                source: 'cli', // or 'claude-code'
                timestamp: new Date(memory.timestamp).getTime(),
                message_id: uuidv4(),
                model: 'claude-code'
            });

        if (error) throw error;
        console.log(chalk.green('✅ Synced to Supabase'));

    } catch (err) {
        console.error(chalk.red('❌ Sync failed:'), err.message);
    }
});

await watcher.start();

// Keep process alive
if (!options.daemon) {
    console.log(chalk.yellow('Press Ctrl+C to stop.'));
}

    } catch (error) {
    console.error(chalk.red('❌ Watcher failed:'), error.message);
}
}

export default watch;
