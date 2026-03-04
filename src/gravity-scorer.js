/**
 * KYT Gravity Scorer
 *
 * Implements Priority 3: Gravity/Semantic Decay
 *
 * Purpose:
 * Prioritize memories based on their emotional impact (Holmes-Rahe scale)
 * and apply a logarithmic time decay to ensure important memories stick around.
 *
 * Formula:
 * Score = Impact / (log(Time + 2))^Gravity
 *
 * LLM: Claude Haiku 4.5 via llm_completion edge function (migrated from OpenAI).
 */

import { callEdgeFunction } from './api-client.js';

/**
 * Calculate Gravity Score
 * @param {number} impact - Holmes-Rahe Impact Score (0-100)
 * @param {number} hoursPassed - Hours since the event occurred
 * @param {number} gravity - Decay constant (default: 1.8)
 * @returns {number} Gravity Score (0-100)
 */
export function calculateGravityScore(impact, hoursPassed, gravity = 1.8) {
    // Prevent division by zero or negative logs
    // Time + 2 ensures log base is always > 0.3 (log(2) ≈ 0.301)
    // We use log10 for the scale
    const timeFactor = Math.log10(hoursPassed + 2);

    // Apply gravity power
    const decay = Math.pow(timeFactor, gravity);

    // Calculate score
    // Ensure decay is at least 1 to prevent boosting
    const finalDecay = Math.max(1, decay);

    return impact / finalDecay;
}

/**
 * Classify Impact using LLM (Holmes-Rahe Scale)
 * @param {string} text - Memory content
 * @returns {Promise<{score: number, reasoning: string}>} Impact score and reasoning
 */
export async function classifyImpact(text) {
    try {
        const result = await callEdgeFunction('llm_completion', {
            system: `You are an expert psychologist specializing in the Holmes-Rahe Stress Scale.
Your task is to rate the "Life Impact" of a given user memory on a scale of 0-100.

Guidelines:
- 80-100: Critical Life Events (Death, Divorce, Jail, Major Illness)
- 50-79: Major Life Changes (Marriage, Fired, Moving, Pregnancy)
- 30-49: Moderate Changes (Trouble with boss, Mortgage, Child leaving home)
- 10-29: Minor Hassles (Traffic, Vacation, Holidays, Minor violations)
- 0-9: Trivial/Chatter (Weather, Greetings, Random thoughts)

Return JSON only: { "score": number, "reasoning": "short explanation" }`,
            user: text,
            temperature: 0.0,
            json_mode: true,
            operation: 'gravity_scoring',
        }, { timeoutMs: 8000 });

        if (result.error) {
            throw new Error(result.error);
        }

        const parsed = typeof result.content === 'string'
            ? JSON.parse(result.content)
            : result.content;

        return {
            score: parsed.score,
            reasoning: parsed.reasoning
        };

    } catch (error) {
        console.error('❌ Impact classification failed:', error);
        // Fallback to neutral score
        return { score: 10, reasoning: "Classification failed, default low score" };
    }
}
