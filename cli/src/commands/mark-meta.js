import chalk from 'chalk';
import authService from '../lib/auth.js';

/**
 * Mark messages as meta-conversations (debug/system discussions)
 * Meta-flagged messages are excluded from retrieval to prevent pollution
 * 
 * Usage:
 *   mem mark-meta --pattern "xylophone"  # Mark all messages containing "xylophone"
 *   mem mark-meta --pattern "K.Y.T."     # Mark all K.Y.T. system discussions
 *   mem mark-meta --id <message_id>      # Mark specific message
 */
async function markMeta(options) {
    try {
        // Initialize auth
        const initialized = await authService.initialize();
        if (!initialized) {
            console.error(chalk.red('❌ Not logged in. Run "mem login" first.'));
            return;
        }

        const supabase = authService.getClient();

        if (options.id) {
            // Mark specific message
            const { error } = await supabase
                .from('messages')
                .update({ meta: true })
                .eq('message_id', options.id);

            if (error) throw error;

            console.log(chalk.green(`✅ Marked message ${options.id} as meta`));

        } else if (options.pattern) {
            // Mark all messages matching pattern
            console.log(chalk.gray(`Searching for messages containing "${options.pattern}"...`));

            const { data, error } = await supabase
                .from('messages')
                .select('message_id, content')
                .ilike('content', `%${options.pattern}%`);

            if (error) throw error;

            if (!data || data.length === 0) {
                console.log(chalk.yellow('⚠️  No messages found matching pattern'));
                return;
            }

            console.log(chalk.cyan(`Found ${data.length} messages. Marking as meta...`));

            // Update all matching messages
            const { error: updateError } = await supabase
                .from('messages')
                .update({ meta: true })
                .ilike('content', `%${options.pattern}%`);

            if (updateError) throw updateError;

            console.log(chalk.green(`✅ Marked ${data.length} messages as meta`));
            console.log(chalk.gray('These messages will be excluded from future retrievals'));

        } else {
            console.error(chalk.red('❌ Must specify either --id or --pattern'));
            console.log(chalk.gray('Usage:'));
            console.log(chalk.gray('  mem mark-meta --pattern "keyword"'));
            console.log(chalk.gray('  mem mark-meta --id <message_id>'));
        }

    } catch (error) {
        console.error(chalk.red('❌ Mark meta failed:'), error.message);
    }
}

export default markMeta;
