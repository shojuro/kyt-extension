import inquirer from 'inquirer';
import chalk from 'chalk';
import authService from '../lib/auth.js';

async function login() {
    console.log(chalk.blue('🤖 AI Memory CLI Login'));
    console.log(chalk.gray('Please visit the following URL to get your access token:'));
    console.log(chalk.underline('https://your-supabase-app-url.com/cli-login')); // Placeholder
    console.log('');

    const answers = await inquirer.prompt([
        {
            type: 'password',
            name: 'token',
            message: 'Paste your Access Token:',
            mask: '*'
        }
    ]);

    if (!answers.token) {
        console.log(chalk.red('❌ Token is required.'));
        return;
    }

    try {
        await authService.login(answers.token);
        console.log(chalk.green('✅ Successfully logged in!'));
        console.log(chalk.gray('Token stored securely in system keychain.'));
    } catch (error) {
        console.error(chalk.red('❌ Login failed:'), error.message);
    }
}

export default login;
