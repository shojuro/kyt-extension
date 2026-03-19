package com.kyt.android.memory

/**
 * Injection Builder — Kotlin port of kyt-memory-injection-builder.js
 *
 * Builds formatted context block for keyboard injection.
 * Compact mobile format: top 2 items, no ASCII boxes, minimal headers.
 */

data class MemoryItem(
    val id: String,
    val content: String,
    val platform: String,
    val timestamp: String,
    val similarity: Double,
    val role: String? = null,
    val entities: List<String>? = null  // canonical names from server enrichment
)

data class InjectionResult(
    val text: String,
    val itemCount: Int,
    val confidence: Double
)

// ── Prompt Injection Defense ─────────────────────────────────

private val BRACKET_PATTERNS = listOf(
    Regex("\\[SYSTEM]", RegexOption.IGNORE_CASE),
    Regex("\\[INST]", RegexOption.IGNORE_CASE),
    Regex("\\[/INST]", RegexOption.IGNORE_CASE),
    Regex("</?system>", RegexOption.IGNORE_CASE),
    Regex("</?instruction>", RegexOption.IGNORE_CASE),
    Regex("<\\|im_start\\|>"),
    Regex("<\\|im_end\\|>"),
    Regex("<\\|endoftext\\|>"),
    Regex("</s>"),
    Regex("={10,}"),
)

private val BRACKET_CHARS = Regex("[\\[\\]<>|=]")

fun sanitizeForInjection(text: String): String {
    if (text.isEmpty()) return ""
    var sanitized = text
    for (pattern in BRACKET_PATTERNS) {
        sanitized = pattern.replace(sanitized) { match ->
            BRACKET_CHARS.replace(match.value, "_")
        }
    }
    sanitized = sanitized.replace("\n\nHuman:", "\n\n_Human_:")
    sanitized = sanitized.replace("\n\nAssistant:", "\n\n_Assistant_:")
    sanitized = sanitized.replace("\"", "\\\"")
    return sanitized
}

// ── Mini-MMR Diversity Filter ────────────────────────────────

/**
 * Jaccard word similarity between two strings.
 * Returns 0.0 (no overlap) to 1.0 (identical word sets).
 */
private fun jaccardSimilarity(a: String, b: String): Double {
    val wordsA = a.lowercase().split(Regex("\\s+")).filter { it.length > 2 }.toSet()
    val wordsB = b.lowercase().split(Regex("\\s+")).filter { it.length > 2 }.toSet()
    if (wordsA.isEmpty() || wordsB.isEmpty()) return 0.0
    val intersection = wordsA.intersect(wordsB).size
    val union = wordsA.union(wordsB).size
    return if (union == 0) 0.0 else intersection.toDouble() / union.toDouble()
}

/**
 * Select diverse items using mini-MMR (Maximal Marginal Relevance).
 *
 * From a pool of candidates sorted by relevance, greedily picks items that
 * balance relevance score with diversity (low Jaccard similarity to already
 * selected items).
 *
 * @param items Candidate items sorted by relevance (highest first)
 * @param maxItems Maximum number of items to return
 * @param lambda Trade-off: 1.0 = pure relevance, 0.0 = pure diversity. Default 0.5.
 */
fun selectDiverseItems(
    items: List<MemoryItem>,
    maxItems: Int = 2,
    lambda: Double = 0.5
): List<MemoryItem> {
    if (items.size <= maxItems) return items
    if (items.isEmpty()) return emptyList()

    val selected = mutableListOf<MemoryItem>()
    val remaining = items.toMutableList()

    // Always pick the highest-scored item first
    selected.add(remaining.removeAt(0))

    while (selected.size < maxItems && remaining.isNotEmpty()) {
        var bestIdx = 0
        var bestScore = Double.NEGATIVE_INFINITY

        for (i in remaining.indices) {
            val candidate = remaining[i]
            // Relevance component: normalized similarity score
            val relevance = candidate.similarity

            // Diversity component: max Jaccard similarity to any already-selected item
            val maxSim = selected.maxOf { jaccardSimilarity(candidate.content, it.content) }

            // MMR score: balance relevance and diversity
            val mmrScore = lambda * relevance - (1.0 - lambda) * maxSim

            if (mmrScore > bestScore) {
                bestScore = mmrScore
                bestIdx = i
            }
        }

        selected.add(remaining.removeAt(bestIdx))
    }

    return selected
}

// ── Content Classification ───────────────────────────────────

private fun classifyContent(content: String): Triple<String, String, String> {
    val lower = content.lowercase()
    val trimmed = content.trim()

    if (trimmed.endsWith("?") || Regex("^(what|who|where|when|why|how|which|is|are)\\b", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
        return Triple("conversation_excerpt", "question_answer", "auto_captured")
    }
    if ("prefer" in lower || "favorite" in lower || "i like" in lower) {
        return Triple("user_preference", "technical_preference", "user_annotated")
    }
    if ("always" in lower || "never" in lower || "when i say" in lower) {
        return Triple("instruction", "response_format", "explicit_save")
    }
    return Triple("conversation_excerpt", "discussion", "auto_captured")
}

// ── Confidence Calculation ───────────────────────────────────

private fun calculateConfidence(items: List<MemoryItem>): Double {
    if (items.isEmpty()) return 0.0
    val maxSim = items.maxOf { it.similarity }
    val avgSim = items.sumOf { it.similarity } / items.size
    return (maxSim * 0.7) + (avgSim * 0.3)
}

// ── Entity Name Sanitization ─────────────────────────────────
// Security: entity canonical_names come from user content via entity extractor.
// Strip characters that could be used for prompt injection in the (Context: ...) line.
private val ENTITY_UNSAFE_CHARS = Regex("[()\\[\\]<>{}|;\"'`\\\\\\n\\r]")

private fun sanitizeEntityName(name: String): String {
    return ENTITY_UNSAFE_CHARS.replace(name, "").trim().take(50)
}

// ── Stop words for content snippet extraction ────────────────
private val SNIPPET_STOP_WORDS = setOf(
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "like",
    "through", "after", "over", "between", "out", "up", "down", "and",
    "but", "or", "not", "no", "so", "if", "that", "this", "it", "its",
    "i", "my", "me", "we", "our", "you", "your", "he", "she", "they",
    "them", "his", "her", "their", "just", "also", "very", "really",
    "some", "any", "all", "each", "every", "user", "assistant"
)

private fun extractSnippet(content: String, maxWords: Int = 8): String {
    return content
        .replace(Regex("[\"'\\n\\r]+"), " ")
        .split(Regex("\\s+"))
        .filter { it.length > 2 && it.lowercase() !in SNIPPET_STOP_WORDS }
        .take(maxWords)
        .joinToString(" ")
}

// ── Compact Mobile Format ────────────────────────────────────

/**
 * Build a compact single-line (Context: ...) injection for keyboard use.
 * Uses entity names when available, falls back to content snippet extraction.
 * Limited to top [maxItems] to fit in input fields.
 */
fun buildCompactInjection(
    items: List<MemoryItem>,
    query: String,
    maxItems: Int = 2
): InjectionResult {
    if (items.isEmpty()) {
        return InjectionResult("", 0, 0.0)
    }

    val sorted = selectDiverseItems(items.sortedByDescending { it.similarity }, maxItems)
    val confidence = calculateConfidence(sorted)

    val platforms = sorted.map { it.platform }.distinct()
    val showPlatform = platforms.size > 1

    val summaries = sorted.map { item ->
        val entityNames = item.entities
            ?.map { sanitizeEntityName(it) }
            ?.filter { it.isNotBlank() }

        val core = if (!entityNames.isNullOrEmpty()) {
            entityNames.take(3).joinToString(", ")
        } else {
            extractSnippet(item.content)
        }

        if (showPlatform) "$core (${item.platform})" else core
    }

    var summary = summaries.joinToString("; ")
    if (summary.length > 150) {
        val truncIdx = summary.lastIndexOf(';', 147)
        summary = if (truncIdx > 0) {
            summary.substring(0, truncIdx) + "..."
        } else {
            summary.take(147) + "..."
        }
    }

    val contextLine = "(Context: $summary)"

    return InjectionResult(contextLine, sorted.size, confidence)
}

/**
 * Build the full injection block (matching JS kyt-memory-injection-builder.js output).
 * Used for share sheet "Search K.Y.T." results display.
 */
fun buildFullInjection(
    items: List<MemoryItem>,
    query: String,
    queryTransformed: String? = null
): String {
    val confidence = calculateConfidence(items)

    val confidenceNote = when {
        confidence > 0.75 -> "High confidence — strong semantic match"
        confidence >= 0.50 -> "Moderate confidence — relevant context found"
        items.isEmpty() -> "No relevant memories found"
        else -> "Low confidence — results may be tangential"
    }

    val sb = StringBuilder()
    sb.appendLine("================================================================================")
    sb.appendLine("K.Y.T. — User's Personal Knowledge Base")
    sb.appendLine("================================================================================")
    sb.appendLine()
    sb.appendLine("[RETRIEVAL_CONTEXT]")
    sb.appendLine("confidence: ${"%.2f".format(confidence)}")
    sb.appendLine("confidence_note: \"$confidenceNote\"")
    sb.appendLine("results_found: ${items.size}")
    sb.appendLine("query: \"${sanitizeForInjection(query)}\"")
    sb.appendLine()

    if (items.isEmpty()) {
        sb.appendLine("(No relevant items found)")
    } else {
        val sorted = items.sortedBy { -(it.timestamp.hashCode().toLong()) }
        for ((i, item) in sorted.withIndex()) {
            val (type, subtype, intent) = classifyContent(item.content)
            val speaker = when (item.role) {
                "user" -> "user"
                "assistant" -> "assistant"
                else -> "unknown"
            }
            val matchQuality = when {
                item.similarity >= 0.70 -> "strong match"
                item.similarity >= 0.50 -> "likely relevant"
                else -> "may be relevant"
            }

            sb.appendLine("--- Item ${i + 1} ---")
            sb.appendLine("type: $type | subtype: $subtype | speaker: $speaker")
            sb.appendLine("source: ${item.platform} | confidence: ${"%.2f".format(item.similarity)} | match: \"$matchQuality\"")
            sb.appendLine("content: \"${sanitizeForInjection(item.content.take(500))}\"")
            sb.appendLine()
        }
    }

    sb.appendLine("================================================================================")
    return sb.toString()
}
