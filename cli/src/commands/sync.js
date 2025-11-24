import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import authService from '../lib/auth.js';
import { execSync } from 'child_process';
import ora from 'ora';

const MEMORY_START = '<!-- MEMORY_START -->';
const MEMORY_END = '<!-- MEMORY_END -->';

async function sync(options) {
    const spinner = ora('Syncing memories...').start();

    try {
        // Initialize auth
        const initialized = await authService.initialize();
        if (!initialized) {
            spinner.fail(chalk.red('Not logged in. Run "mem login" first.'));
            return;
        }

        const supabase = authService.getClient();

        // Get Context (Git Branch)
        let contextQuery = 'global context';
        try {
            const branch = execSync('git branch --show-current', { stdio: 'pipe' }).toString().trim();
            if (branch) {
                contextQuery = `git branch: ${branch}`;
            }
        } catch (e) {
            // Not a git repo
        }

        spinner.text = `Fetching memories for context: "${contextQuery}"...`;

        // Fetch relevant memories
        const { data: memories, error } = await supabase
            .from('messages')
            .select('content, timestamp, source')
            .eq('source', 'cli') // Prioritize CLI notes
            .order('timestamp', { ascending: false })
            .limit(5);

        if (error) throw error;

        if (!memories || memories.length === 0) {
            spinner.info('No CLI memories found to sync.');
            return;
        }

        // Format Memory Block
        let memoryBlock = `${MEMORY_START}\n## Global Memory (Synced)\n\n`;
        memories.forEach(m => {
            const date = new Date(m.timestamp).toLocaleDateString();
            memoryBlock += `- [${date}] ${m.content}\n`;
        });
        memoryBlock += `\n${MEMORY_END}`;

        // Update CLAUDE.md
        const claudeMdPath = path.join(process.cwd(), '.claude', 'CLAUDE.md');

        // Ensure .claude dir exists
        const claudeDir = path.dirname(claudeMdPath);
        if (!fs.existsSync(claudeDir)) {
            fs.mkdirSync(claudeDir, { recursive: true });
        }

        let content = '';
        if (fs.existsSync(claudeMdPath)) {
            content = fs.readFileSync(claudeMdPath, 'utf8');
        } else {
            content = '# Project Rules\n\n'; // Default header if new file
        }

        // Replace or Append
        const regex = new RegExp(`${MEMORY_START}[\\s\\S]*?${MEMORY_END}`);
        if (regex.test(content)) {
            content = content.replace(regex, memoryBlock);
        } else {
            content += `\n\n${memoryBlock}`;
        }

        fs.writeFileSync(claudeMdPath, content, 'utf8');

        spinner.succeed(chalk.green(`Synced ${memories.length} memories to .claude/CLAUDE.md`));

    } catch (error) {
        spinner.fail(chalk.red('Sync failed: ' + error.message));
    }
}

export default sync;
