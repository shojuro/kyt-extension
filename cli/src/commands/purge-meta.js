import chalk from 'chalk';
import authService from '../lib/auth.js';

/**
 * Purge polluted memories by marking them as meta
 * This adds the meta column if needed and flags all K.Y.T. system discussions
 */
async function purgeMeta() {
    try {
        console.log(chalk.cyan('🔧 Running meta flag migration...\n'));

        // Initialize auth
        const initialized = await authService.initialize();
        if (!initialized) {
            console.error(chalk.red('❌ Not logged in. Run "mem login" first.'));
            return;
        }

        const supabase = authService.getClient();

        // Step 1: Check if meta column exists, add if not
        console.log(chalk.gray('Checking for meta column...'));

        // Try to query meta column - if it fails, column doesn't exist
        const { error: checkError } = await supabase
            .from('messages')
            .select('meta')
            .limit(1);

        if (checkError && checkError.message.includes('column')) {
            console.log(chalk.yellow('⚠️  Meta column does not exist'));
            console.log(chalk.red('❌ Please add the meta column via Supabase SQL Editor:'));
            console.log(chalk.gray('\nALTER TABLE messages ADD COLUMN meta BOOLEAN DEFAULT FALSE;'));
            console.log(chalk.gray('CREATE INDEX idx_messages_meta ON messages(meta) WHERE meta = FALSE;\n'));
            return;
        }

        console.log(chalk.green('✓ Meta column exists'));

        // Step 2: Mark polluted memories as meta
        console.log(chalk.cyan('\nMarking polluted memories as meta...'));

        const patterns = [
            'xylophone dust',
            'K.Y.T. MEMORY INJECTION',
            '[Memory Context',
            'taxonomy',
            'MMR',
            'retrieval pollution',
            'ranking',
            'boosting',
            'reranking',
            'semantic search',
            'BM25',
            'hybrid search'
        ];

        let totalMarked = 0;

        for (const pattern of patterns) {
            const { data, error } = await supabase
                .from('messages')
                .select('message_id')
                .ilike('content', `%${pattern}%`)
                .eq('meta', false);

            if (error) {
                console.error(chalk.red(`❌ Error searching for "${pattern}":`, error.message));
                continue;
            }

            if (data && data.length > 0) {
                const { error: updateError } = await supabase
                    .from('messages')
                    .update({ meta: true })
                    .ilike('content', `%${pattern}%`)
                    .eq('meta', false);

                if (updateError) {
                    console.error(chalk.red(`❌ Error marking "${pattern}":`, updateError.message));
                } else {
                    console.log(chalk.gray(`  ✓ Marked ${data.length} messages containing "${pattern}"`));
                    totalMarked += data.length;
                }
            }
        }

        // Step 3: Show summary
        console.log(chalk.cyan('\n📊 Summary:'));

        const { data: summary, error: summaryError } = await supabase
            .from('messages')
            .select('meta');

        if (summaryError) {
            console.error(chalk.red('❌ Error getting summary:', summaryError.message));
        } else {
            const metaCount = summary.filter(m => m.meta === true).length;
            const activeCount = summary.filter(m => m.meta === false || m.meta === null).length;

            console.log(chalk.green(`  Meta messages: ${metaCount}`));
            console.log(chalk.green(`  Active messages: ${activeCount}`));
            console.log(chalk.green(`  Total messages: ${summary.length}`));
        }

        console.log(chalk.green(`\n✅ Migration complete! Marked ${totalMarked} messages as meta.`));
        console.log(chalk.gray('These messages will be excluded from future retrievals.'));

    } catch (error) {
        console.error(chalk.red('❌ Purge failed:'), error.message);
    }
}

export default purgeMeta;
