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

// ── Visible Pre-inject Format ────────────────────────────────

/**
 * Build a visible injection line for pre-injecting into the text field.
 *
 * Format: (KYT: snippet [platform] | snippet [platform])
 * Designed to be visible to the user — medium density, single line.
 * The "(KYT:" prefix is used as a guard marker by the injection state machine.
 *
 * @param maxCharsPerItem Maximum characters per content snippet
 */
fun buildVisibleInjection(
    items: List<MemoryItem>,
    query: String,
    maxItems: Int = 2,
    maxCharsPerItem: Int = 80
): InjectionResult {
    if (items.isEmpty()) return InjectionResult("", 0, 0.0)

    val sorted = selectDiverseItems(items.sortedByDescending { it.similarity }, maxItems)
    val confidence = calculateConfidence(sorted)

    val parts = sorted.map { item ->
        val prefix = if (item.role == "user") "You: " else ""
        val content = sanitizeForInjection(item.content)
            .replace(Regex("[\\n\\r]+"), " ")
            .trim()
            .take(maxCharsPerItem)
        "$prefix$content [${item.platform}]"
    }

    var inner = parts.joinToString(" | ")
    if (inner.length > 200) {
        inner = inner.take(197) + "..."
    }

    return InjectionResult("(KYT: $inner)", sorted.size, confidence)
}

// ── Compact Mobile Format ────────────────────────────────────

/**
 * Build a compact injection block for keyboard/share sheet use.
 * Full content quotes — gives the AI enough context to work with.
 * Limited to top [maxItems] via mini-MMR diversity filter.
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

    val sb = StringBuilder()
    sb.appendLine("[K.Y.T. Context — from your stored conversations]")

    for ((i, item) in sorted.withIndex()) {
        val speaker = if (item.role == "user") "You said" else "AI said"
        val platform = item.platform
        val content = sanitizeForInjection(item.content.take(300))

        sb.appendLine("${i + 1}. [$platform] $speaker: \"$content\"")
    }

    sb.appendLine("[End K.Y.T. Context]")

    return InjectionResult(sb.toString(), sorted.size, confidence)
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
