package com.kyt.android.memory

/**
 * Intent Classifier — Kotlin port of src/intent-classifier.js
 *
 * Scored heuristic classifier. Gates memory retrieval.
 * Returns SKIP (no retrieval), QUERY (full retrieval), or PASSIVE (raised threshold).
 *
 * Pure function, ~0.06ms.
 */

data class ClassificationResult(
    val intent: Intent,
    val confidenceThreshold: Double?,
    val reason: String,
    val scores: Scores?
)

enum class Intent { SKIP, QUERY, PASSIVE }

data class Scores(
    val directive: Double,
    val memory: Double,
    val density: Double,
    val question: Double,
    val personal: Double,
    val temporal: Double
)

private const val MIN_QUERY_LENGTH = 8

// ── S1: Directive Strength ───────────────────────────────────

private val PURE_DIRECTIVES =
    Regex("^(thoughts|continue|go\\s*on|proceed|next|agreed|exactly|correct|yes|no|yep|nope|sure|ok|okay|right|thanks|thank\\s*you|perfect|great|good|nice|cool|awesome|interesting|fascinating|noted|understood|got\\s*it|makes\\s*sense|fair\\s*enough|absolutely|definitely|indeed|precisely|true|false|sounds?\\s*good|looks?\\s*good|that\\s*works?|let'?s\\s*(do\\s*(it|that|this)|go|move\\s*on|proceed|continue|start))\\s*[.!?]*$", RegexOption.IGNORE_CASE)

private val EMOTIONAL_RESPONSE =
    Regex("^(haha|lmao|omg|oh\\s*wow|oh\\s*no|oh\\s*man|oh\\s*god|damn|dang|yikes|whoa|geez|sheesh|ugh|meh|sigh|nah|naw|lol|ha+|hmm+|huh|wow)\\s*[.!?]*$", RegexOption.IGNORE_CASE)

private val COMPOUND_DIRECTIVE =
    Regex("^(perfect|great|good|nice|cool|awesome|ok|okay|right|sure|agreed|exactly|sounds?\\s*good|looks?\\s*good|correct|true|fair\\s*enough)[,.]?\\s*(let'?s\\s*)?(do\\s*(it|that|this)|go(\\s*ahead)?|move\\s*on|proceed|continue|start|go\\s*on|keep\\s*going|carry\\s*on)\\s*[.!?]*$", RegexOption.IGNORE_CASE)

private val CONTEXTUAL_RESPONSE =
    Regex("^(exactly\\s*that|not\\s+(quite|exactly|really)|the\\s+(first|second|third|last|other)\\s+one|option\\s+[a-d1-4]|both|neither|all\\s+of\\s+(them|the\\s+above)|that'?s?\\s+(it|right|correct)|bingo|nailed\\s+it|close\\s+enough|not\\s+what\\s+I\\s+meant)", RegexOption.IGNORE_CASE)

private val DIRECTIVE_STRONG = listOf(
    Regex("^(break|review|analyze|summarize|explain|elaborate|expand|rewrite|simplify|translate|proofread|format|fix|check|evaluate|compare|list|outline)\\s*(this|it|that|these|those|them|the\\s)", RegexOption.IGNORE_CASE),
    Regex("^(can\\s+you|could\\s+you|please|help\\s+me|I\\s+need\\s+you\\s+to|go\\s+ahead\\s+and|let'?s)\\s", RegexOption.IGNORE_CASE),
    Regex("^(what\\s+do\\s+you\\s+think|your\\s+(take|thoughts|opinion|assessment)|how\\s+does\\s+(this|that)\\s+(sound|look))\\s*\\??$", RegexOption.IGNORE_CASE),
    Regex("^(and\\??|so\\??|also|then\\??|plus|more|another|what\\s*else|anything\\s*else|go\\s*ahead|keep\\s*going|carry\\s*on|moving\\s*on)\\s*[.!?]*$", RegexOption.IGNORE_CASE),
)

private val DIRECTIVE_MODERATE = listOf(
    Regex("^(let'?s|I\\s+want\\s+to|we\\s+should|we\\s+need\\s+to|time\\s+to|ready\\s+to)\\s", RegexOption.IGNORE_CASE),
    Regex("^(now\\s+(let'?s|I('ll|\\s+will)|we)|after\\s+that|next\\s+up|moving\\s+on\\s+to)", RegexOption.IGNORE_CASE),
    Regex("^(here'?s|here\\s+is|see\\s+below|take\\s+a\\s+look|check\\s+this)", RegexOption.IGNORE_CASE),
    Regex("^(this\\s+is\\s+(the|a|my)|below\\s+is|following\\s+is|attached|pasting|copying)\\b", RegexOption.IGNORE_CASE),
)

private val WEAK_DIRECTIVE =
    Regex("^(make|create|build|write|draft|design|generate|produce|continue|proceed|resume)\\s", RegexOption.IGNORE_CASE)

private fun scoreDirective(message: String, len: Int): Double {
    var score = 0.0
    if (PURE_DIRECTIVES.containsMatchIn(message) && len < 80) return 1.0
    if (EMOTIONAL_RESPONSE.containsMatchIn(message)) return 1.0
    if (COMPOUND_DIRECTIVE.containsMatchIn(message) && len < 120) return 1.0
    if (CONTEXTUAL_RESPONSE.containsMatchIn(message) && len < 100) score = maxOf(score, 0.9)
    for (p in DIRECTIVE_STRONG) {
        if (p.containsMatchIn(message)) { score = maxOf(score, 0.8); break }
    }
    for (p in DIRECTIVE_MODERATE) {
        if (p.containsMatchIn(message)) { score = maxOf(score, 0.7); break }
    }
    if (WEAK_DIRECTIVE.containsMatchIn(message)) score = maxOf(score, 0.4)
    if (len < 60 && '?' !in message && score > 0) score = minOf(score + 0.15, 1.0)
    return score
}

// ── S2: Memory Reference ─────────────────────────────────────

private val MEMORY_STRONG = listOf(
    Regex("\\b(what\\s+(is|are|was|were)\\s+my)\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(what\\s+did\\s+(I|we)\\s+(say|discuss|decide|talk\\s+about|agree|mention))\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(remind\\s+me|do\\s+you\\s+(remember|recall|know))\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(my\\s+favorite|my\\s+preference|I\\s+(like|love|hate|prefer|dislike))\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(we\\s+(talked|discussed|decided|agreed|mentioned))\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(from\\s+(our|my)\\s+(conversation|chat|discussion|session))\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(what\\s+(do|did)\\s+you\\s+know\\s+about\\s+me)\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(what('?s|\\s+is)\\s+my\\s+(name|job|role|car|dog|cat|favorite))\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(when\\s+did\\s+(I|we)\\s+)\\b", RegexOption.IGNORE_CASE),
)

private val MEMORY_MODERATE = listOf(
    Regex("\\b(earlier|previously|before|last\\s+time|the\\s+other\\s+day)\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(we\\s+defined|we\\s+established|we\\s+set\\s+up|we\\s+designed)\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(as\\s+(I|we)\\s+(said|mentioned|noted|discussed))\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(you\\s+(said|told|suggested|recommended|mentioned))\\b", RegexOption.IGNORE_CASE),
    Regex("\\b(remember\\s+(when|that|how))\\b", RegexOption.IGNORE_CASE),
)

private fun scoreMemoryReference(message: String): Double {
    var score = 0.0
    for (p in MEMORY_STRONG) {
        if (p.containsMatchIn(message)) { score = maxOf(score, 0.9); break }
    }
    for (p in MEMORY_MODERATE) {
        if (p.containsMatchIn(message)) { score = maxOf(score, 0.6); break }
    }
    if (Regex("\\bmy\\s+(project|code|app|site|team|company|plan|strategy|budget)\\b", RegexOption.IGNORE_CASE).containsMatchIn(message)) {
        score = maxOf(score, 0.35)
    }
    return score
}

// ── S3: Content Density ──────────────────────────────────────

private fun scoreContentDensity(message: String): Double {
    val len = message.length
    if (len < 12) return 0.0
    if (len < 25) return 0.15

    val lines = message.split('\n')
    if (lines.size > 10) {
        val lastLines = lines.takeLast(3).joinToString(" ").trim()
        if (lastLines.length < 200) return 0.1
    }

    val words = message.trim().split(Regex("\\s+")).size
    if (words in 5..30) return 0.7
    if (words in 31..60) return 0.5
    if (words > 60) return 0.3
    if (len < 50) return 0.3
    return 0.4
}

// ── S4: Question Structure ───────────────────────────────────

private val QUESTION_START = Regex("^(what|who|where|when|why|how|which|is|are|was|were|did|do|does|can|could|would|will|should|have|has)\\s", RegexOption.IGNORE_CASE)
private val REQUEST_START = Regex("^(tell\\s+me|show\\s+me|give\\s+me|find\\s+me|list|name)\\s", RegexOption.IGNORE_CASE)

private fun scoreQuestionStructure(message: String): Double {
    var score = 0.0
    if ('?' in message) score = maxOf(score, 0.6)
    if (QUESTION_START.containsMatchIn(message)) score = maxOf(score, 0.7)
    if (REQUEST_START.containsMatchIn(message)) score = maxOf(score, 0.5)
    return score
}

// ── S5: Personal Reference ───────────────────────────────────

private fun scorePersonalReference(message: String): Double {
    var score = 0.0
    val myCount = Regex("\\bmy\\b", RegexOption.IGNORE_CASE).findAll(message).count()
    if (myCount >= 2) score = maxOf(score, 0.6)
    else if (myCount == 1) score = maxOf(score, 0.3)

    if (Regex("\\bI\\s+(said|told|mentioned|wrote|created|built|designed|chose|decided|started|finished|found|saw|bought|learned|tried|picked)\\b", RegexOption.IGNORE_CASE).containsMatchIn(message)) {
        score = maxOf(score, 0.5)
    }
    if (Regex("\\bI\\s+was\\s+\\w+ing\\b", RegexOption.IGNORE_CASE).containsMatchIn(message)) {
        score = maxOf(score, 0.5)
    }
    if (Regex("\\bwe\\s+(had|made|built|discussed|decided|agreed|defined|established|were)\\b", RegexOption.IGNORE_CASE).containsMatchIn(message)) {
        score = maxOf(score, 0.5)
    }
    return score
}

// ── S6: Temporal Reference ───────────────────────────────────

private fun scoreTemporalReference(message: String): Double {
    var score = 0.0
    if (Regex("\\b(yesterday|last\\s+(week|month|time|session)|earlier\\s+today|the\\s+other\\s+day|most\\s+recent|latest)\\b", RegexOption.IGNORE_CASE).containsMatchIn(message)) {
        score = maxOf(score, 0.7)
    }
    if (Regex("\\b(earlier|previously|before|ago|back\\s+when|at\\s+some\\s+point|once|recently|recent)\\b", RegexOption.IGNORE_CASE).containsMatchIn(message)) {
        score = maxOf(score, 0.4)
    }
    if (Regex("\\bremember\\s+(when|that\\s+time)\\b", RegexOption.IGNORE_CASE).containsMatchIn(message)) {
        score = maxOf(score, 0.8)
    }
    return score
}

// ── Composite Classification ─────────────────────────────────

fun classifyIntent(message: String?): ClassificationResult {
    if (message.isNullOrBlank()) {
        return ClassificationResult(Intent.SKIP, null, "empty_or_invalid", null)
    }

    val trimmed = message.trim()
    if (trimmed.length < MIN_QUERY_LENGTH) {
        return ClassificationResult(Intent.SKIP, null, "too_short", null)
    }

    val lower = trimmed.lowercase()
    val len = trimmed.length

    val scores = Scores(
        directive = scoreDirective(lower, len),
        memory = scoreMemoryReference(lower),
        density = scoreContentDensity(trimmed),
        question = scoreQuestionStructure(lower),
        personal = scorePersonalReference(lower),
        temporal = scoreTemporalReference(lower)
    )

    // SKIP: Strong directive with no memory/personal signal
    if (scores.directive >= 0.7 && scores.memory < 0.3 && scores.personal < 0.3) {
        return ClassificationResult(Intent.SKIP, null, "directive", scores)
    }

    // SKIP: Very low density without memory signal
    if (scores.density <= 0.15 && scores.memory < 0.5) {
        return ClassificationResult(Intent.SKIP, null, "low_density", scores)
    }

    // QUERY: Strong explicit memory request
    if (scores.memory >= 0.7) {
        return ClassificationResult(Intent.QUERY, 0.40, "explicit_memory_query", scores)
    }

    // QUERY: Strong personal + temporal
    if (scores.personal >= 0.4 && scores.temporal >= 0.5) {
        return ClassificationResult(Intent.QUERY, 0.45, "personal_temporal_reference", scores)
    }

    // QUERY: Question + personal
    if (scores.question >= 0.5 && scores.personal >= 0.4) {
        return ClassificationResult(Intent.QUERY, 0.45, "personal_question", scores)
    }

    // MIXED: Directive AND memory
    if (scores.directive >= 0.4 && scores.memory >= 0.3) {
        return ClassificationResult(Intent.QUERY, 0.65, "mixed_directive_memory", scores)
    }

    // MIXED: Directive + temporal
    if (scores.directive >= 0.4 && scores.temporal >= 0.4) {
        return ClassificationResult(Intent.QUERY, 0.60, "mixed_directive_temporal", scores)
    }

    // PASSIVE: Question + density
    if (scores.question >= 0.5 && scores.density >= 0.4) {
        return ClassificationResult(Intent.PASSIVE, 0.60, "generic_question", scores)
    }

    // PASSIVE: Moderate density with substance
    if (scores.density >= 0.4) {
        val wordCount = trimmed.split(Regex("\\s+")).size
        if (wordCount >= 8 || scores.question > 0 || scores.memory > 0 ||
            scores.personal >= 0.3 || scores.temporal > 0
        ) {
            return ClassificationResult(Intent.PASSIVE, 0.60, "default_substantive", scores)
        }
    }

    return ClassificationResult(Intent.SKIP, null, "no_signal", scores)
}
