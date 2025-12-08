/**
 * Sanitizer for removing secrets from captured text
 */

const SECRET_PATTERNS = [
    // Standard Env Vars (KEY=VALUE)
    /([A-Z_]{3,30})\s*=\s*([a-zA-Z0-9_\-\.]{8,})/g,

    // AWS Keys
    /(AKIA[0-9A-Z]{16})/g,
    /(aws_secret_access_key)\s*=\s*([a-zA-Z0-9\/+]{40})/g,

    // Private Keys
    /-----BEGIN [A-Z]+ PRIVATE KEY-----/g,

    // Generic Tokens (Bearer ...)
    /(Bearer)\s+([a-zA-Z0-9\-\._~\+\/]{20,})/g,

    // GitHub Tokens
    /(gh[pousr]_[a-zA-Z0-9]{36})/g
];

export function sanitize(text) {
    if (!text) return text;

    let sanitized = text;

    for (const pattern of SECRET_PATTERNS) {
        sanitized = sanitized.replace(pattern, (match, p1) => {
            // If it's a key=value pair, keep key, redact value
            if (match.includes('=')) {
                const parts = match.split('=');
                return `${parts[0]}=[REDACTED]`;
            }
            // Otherwise redact the whole thing or the capture group
            return '[REDACTED_SECRET]';
        });
    }

    return sanitized;
}
