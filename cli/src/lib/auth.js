import Conf from 'conf';
import { createClient } from '@supabase/supabase-js';

const SERVICE_NAME = 'ai-memory-cli';
const ACCOUNT_NAME = 'user-token';

class AuthService {
    constructor() {
        this.conf = new Conf({ projectName: SERVICE_NAME });
        this.conf = new Conf({ projectName: SERVICE_NAME });
        this.supabase = null;
        this.isAdmin = false;
    }

    async initialize() {
        if (!process.env.SUPABASE_URL || (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_SERVICE_KEY)) {
            return { success: false, error: 'MISSING_ENV' };
        }

        if (process.env.SUPABASE_SERVICE_KEY) {
            this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
            this.isAdmin = true;
        } else {
            this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        }
        return { success: true };
    }

    isAdminMode() {
        return this.isAdmin;
    }

    async setToken(token) {
        this.conf.set(ACCOUNT_NAME, token);
    }

    async login(token) {
        await this.setToken(token);
        return true;
    }

    async getToken() {
        return this.conf.get(ACCOUNT_NAME);
    }

    async deleteToken() {
        this.conf.delete(ACCOUNT_NAME);
    }

    async getUser() {
        const token = await this.getToken();
        if (!token) return null;

        if (!this.supabase) return null;

        const { data: { user }, error } = await this.supabase.auth.getUser(token);

        if (error || !user) {
            console.error('DEBUG: getUser failed', error);
            return null;
        }
        return user;
    }

    getClient() {
        if (!this.supabase) {
            throw new Error('Not initialized. Supabase client is not available.');
        }
        return this.supabase;
    }
}

export const authService = new AuthService();
export default authService;
