
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Lazy initialization helper
let supabaseInstance: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
    if (supabaseInstance) return supabaseInstance;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
        console.warn("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Cost tracking disabled.");
        return null;
    }

    supabaseInstance = createClient(supabaseUrl, supabaseServiceKey);
    return supabaseInstance;
}

/**
 * Retry wrapper with exponential backoff and timeout.
 *
 * Enhanced resilience for embedding generation:
 * - 403 (provider down): longer delay (30s) since it's likely a sustained outage
 * - 429 (rate limit): standard exponential backoff
 * - 500/503 (server error): standard exponential backoff
 * - timeout: standard exponential backoff
 */
export async function retryWrapper<T>(
    fn: () => Promise<T>,
    options: {
        maxRetries?: number;
        baseDelayMs?: number;
        timeoutMs?: number;
    } = {}
): Promise<T> {
    const { maxRetries = 3, baseDelayMs = 1000, timeoutMs = 10000 } = options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Wrap with timeout
            const result = await Promise.race([
                fn(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
                )
            ]);
            return result;
        } catch (e: any) {
            if (attempt === maxRetries) throw e;

            // 403 = provider unavailable (sustained outage) → longer backoff
            const is403 = e.message?.includes('403');
            const delay = is403
                ? 30000 // 30s for provider outages (403)
                : baseDelayMs * Math.pow(2, attempt); // standard exponential

            console.warn(`Attempt ${attempt + 1}/${maxRetries + 1} failed: ${e.message}. Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error('Unreachable');
}

/**
 * Entry for granular cost logging.
 * Accepts either this object form or legacy positional args.
 */
export interface CostLogEntry {
    service: string;
    model: string;
    operation: string;
    cost: number;
    requestId?: string;
    userId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    edgeFunction?: string;
    latencyMs?: number;
}

/**
 * Cost Monitor for tracking API usage.
 */
export class CostMonitor {
    private static THRESHOLDS = [10, 25, 50, 100];

    /**
     * Log API usage cost. Accepts either:
     * - A CostLogEntry object (new form)
     * - Legacy positional args: (service, model, operation, cost, requestId?, userId?)
     */
    static async logUsage(
        serviceOrEntry: string | CostLogEntry,
        model?: string,
        operation?: string,
        cost?: number,
        requestId?: string,
        userId?: string
    ) {
        // Normalize to CostLogEntry
        const entry: CostLogEntry = typeof serviceOrEntry === 'string'
            ? { service: serviceOrEntry, model: model!, operation: operation!, cost: cost!, requestId, userId }
            : serviceOrEntry;

        try {
            const supabase = getSupabaseClient();
            if (!supabase) return;

            // 1. Log to DB
            await supabase.from('cost_tracking').insert({
                service: entry.service,
                model: entry.model,
                operation: entry.operation,
                estimated_cost_usd: entry.cost,
                request_id: entry.requestId,
                user_id: entry.userId,
                input_tokens: entry.inputTokens || 0,
                output_tokens: entry.outputTokens || 0,
                cache_creation_tokens: entry.cacheCreationTokens || 0,
                cache_read_tokens: entry.cacheReadTokens || 0,
                edge_function: entry.edgeFunction || null,
                latency_ms: entry.latencyMs || null,
            });

            // 2. Check Daily Total (simple check)
            // We check the last 24 hours
            const yesterday = new Date(Date.now() - 86400000).toISOString();
            const { data } = await supabase
                .from('cost_tracking')
                .select('estimated_cost_usd')
                .gte('created_at', yesterday);

            const dailyTotal = data?.reduce((sum, r) => sum + (r.estimated_cost_usd || 0), 0) ?? 0;

            // Check thresholds
            for (const threshold of this.THRESHOLDS) {
                // If we just crossed the threshold
                if (dailyTotal >= threshold && dailyTotal - entry.cost < threshold) {
                    console.error(JSON.stringify({
                        level: 'alert',
                        message: `Daily cost threshold reached: $${threshold}`,
                        daily_total: dailyTotal,
                        timestamp: new Date().toISOString()
                    }));
                }
            }

        } catch (e) {
            // Don't fail the request if logging fails
            console.error("Failed to log cost:", e);
        }
    }
}

/**
 * Structured Logger.
 */
export class Logger {
    static info(message: string, context: Record<string, any> = {}) {
        console.log(JSON.stringify({ level: 'info', message, ...context, timestamp: new Date().toISOString() }));
    }

    static warn(message: string, context: Record<string, any> = {}) {
        console.warn(JSON.stringify({ level: 'warn', message, ...context, timestamp: new Date().toISOString() }));
    }

    static error(message: string, context: Record<string, any> = {}) {
        console.error(JSON.stringify({ level: 'error', message, ...context, timestamp: new Date().toISOString() }));
    }
}
