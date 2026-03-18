package com.kyt.android.keyboard

/**
 * K.Y.T. Keyboard — Layout data classes and computation.
 *
 * Computes pixel positions for all keys given screen width and density.
 * Three layers: ALPHA, SYMBOLS, SYMBOLS_2.
 */

enum class KeyType {
    LETTER, SPACE, BACKSPACE, ENTER, SHIFT, SYMBOL, GLOBE, PERIOD
}

enum class ShiftState {
    OFF, SINGLE, CAPS_LOCK
}

enum class KeyboardLayer {
    ALPHA, SYMBOLS, SYMBOLS_2
}

data class KeyDef(
    val label: String,
    val code: Int,           // KeyEvent.KEYCODE_* or custom negative codes
    val widthMultiplier: Float = 1.0f,
    val type: KeyType = KeyType.LETTER
)

data class KeyRect(
    val def: KeyDef,
    // Visual bounds (where key is drawn)
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
    // Expanded touch bounds (for hit testing)
    val touchLeft: Float,
    val touchTop: Float,
    val touchRight: Float,
    val touchBottom: Float
)

// Custom key codes for non-character keys
object KeyCodes {
    const val SHIFT = -1
    const val SYMBOL = -2
    const val GLOBE = -3
    const val BACKSPACE = -4
    const val ENTER = -5
    const val SPACE = -6
    const val SYMBOL_2 = -7
    const val ALPHA = -8
}

object KeyboardLayout {

    // ── Alpha layer ──────────────────────────────────────────

    private val ALPHA_ROWS: List<List<KeyDef>> = listOf(
        // Row 0: Q W E R T Y U I O P
        "QWERTYUIOP".map { KeyDef(it.toString(), it.code) },

        // Row 1: A S D F G H J K L
        "ASDFGHJKL".map { KeyDef(it.toString(), it.code) },

        // Row 2: [Shift] Z X C V B N M [Backspace]
        listOf(
            KeyDef("⇧", KeyCodes.SHIFT, 1.44f, KeyType.SHIFT),
            *"ZXCVBNM".map { KeyDef(it.toString(), it.code) }.toTypedArray(),
            KeyDef("⌫", KeyCodes.BACKSPACE, 1.44f, KeyType.BACKSPACE)
        ),

        // Row 3: [Globe] [?123] [Space] [.] [Enter]
        listOf(
            KeyDef("🌐", KeyCodes.GLOBE, 1.17f, KeyType.GLOBE),
            KeyDef("?123", KeyCodes.SYMBOL, 1.44f, KeyType.SYMBOL),
            KeyDef(" ", KeyCodes.SPACE, 4.61f, KeyType.SPACE),
            KeyDef(".", '.'.code, 1.17f, KeyType.PERIOD),
            KeyDef("↵", KeyCodes.ENTER, 1.44f, KeyType.ENTER)
        )
    )

    // ── Symbols layer ────────────────────────────────────────

    private val SYMBOLS_ROWS: List<List<KeyDef>> = listOf(
        // Row 0: 1 2 3 4 5 6 7 8 9 0
        "1234567890".map { KeyDef(it.toString(), it.code) },

        // Row 1: @ # $ % & - + ( )
        listOf(
            KeyDef("@", '@'.code),
            KeyDef("#", '#'.code),
            KeyDef("$", '$'.code),
            KeyDef("%", '%'.code),
            KeyDef("&", '&'.code),
            KeyDef("-", '-'.code),
            KeyDef("+", '+'.code),
            KeyDef("(", '('.code),
            KeyDef(")", ')'.code)
        ),

        // Row 2: [=\\<] ! " ' : ; / ? [Backspace]
        listOf(
            KeyDef("=\\<", KeyCodes.SYMBOL_2, 1.44f, KeyType.SYMBOL),
            KeyDef("!", '!'.code),
            KeyDef("\"", '"'.code),
            KeyDef("'", '\''.code),
            KeyDef(":", ':'.code),
            KeyDef(";", ';'.code),
            KeyDef("/", '/'.code),
            KeyDef("?", '?'.code),
            KeyDef("⌫", KeyCodes.BACKSPACE, 1.44f, KeyType.BACKSPACE)
        ),

        // Row 3: [Globe] [ABC] [Space] [.] [Enter]
        listOf(
            KeyDef("🌐", KeyCodes.GLOBE, 1.17f, KeyType.GLOBE),
            KeyDef("ABC", KeyCodes.ALPHA, 1.44f, KeyType.SYMBOL),
            KeyDef(" ", KeyCodes.SPACE, 4.61f, KeyType.SPACE),
            KeyDef(".", '.'.code, 1.17f, KeyType.PERIOD),
            KeyDef("↵", KeyCodes.ENTER, 1.44f, KeyType.ENTER)
        )
    )

    // ── Symbols 2 layer ──────────────────────────────────────

    private val SYMBOLS_2_ROWS: List<List<KeyDef>> = listOf(
        // Row 0: ~ ` | · √ π ÷ × ¶ Δ
        listOf(
            KeyDef("~", '~'.code),
            KeyDef("`", '`'.code),
            KeyDef("|", '|'.code),
            KeyDef("·", '·'.code),
            KeyDef("√", '√'.code),
            KeyDef("π", 'π'.code),
            KeyDef("÷", '÷'.code),
            KeyDef("×", '×'.code),
            KeyDef("¶", '¶'.code),
            KeyDef("Δ", 'Δ'.code)
        ),

        // Row 1: £ € ¥ ¢ ^ ° = { }
        listOf(
            KeyDef("£", '£'.code),
            KeyDef("€", '€'.code),
            KeyDef("¥", '¥'.code),
            KeyDef("¢", '¢'.code),
            KeyDef("^", '^'.code),
            KeyDef("°", '°'.code),
            KeyDef("=", '='.code),
            KeyDef("{", '{'.code),
            KeyDef("}", '}'.code)
        ),

        // Row 2: [?123] _ \\ < > [ ] * [Backspace]
        listOf(
            KeyDef("?123", KeyCodes.SYMBOL, 1.44f, KeyType.SYMBOL),
            KeyDef("_", '_'.code),
            KeyDef("\\", '\\'.code),
            KeyDef("<", '<'.code),
            KeyDef(">", '>'.code),
            KeyDef("[", '['.code),
            KeyDef("]", ']'.code),
            KeyDef("*", '*'.code),
            KeyDef("⌫", KeyCodes.BACKSPACE, 1.44f, KeyType.BACKSPACE)
        ),

        // Row 3: same as SYMBOLS
        listOf(
            KeyDef("🌐", KeyCodes.GLOBE, 1.17f, KeyType.GLOBE),
            KeyDef("ABC", KeyCodes.ALPHA, 1.44f, KeyType.SYMBOL),
            KeyDef(" ", KeyCodes.SPACE, 4.61f, KeyType.SPACE),
            KeyDef(".", '.'.code, 1.17f, KeyType.PERIOD),
            KeyDef("↵", KeyCodes.ENTER, 1.44f, KeyType.ENTER)
        )
    )

    fun getRows(layer: KeyboardLayer): List<List<KeyDef>> = when (layer) {
        KeyboardLayer.ALPHA -> ALPHA_ROWS
        KeyboardLayer.SYMBOLS -> SYMBOLS_ROWS
        KeyboardLayer.SYMBOLS_2 -> SYMBOLS_2_ROWS
    }

    /**
     * Compute pixel positions for all keys.
     *
     * @param widthPx Total keyboard width in pixels
     * @param density Display density (dp → px multiplier)
     * @param layer Which keyboard layer to compute
     * @return List of rows, each containing positioned KeyRects
     */
    fun computeLayout(
        widthPx: Int,
        density: Float,
        layer: KeyboardLayer = KeyboardLayer.ALPHA
    ): List<List<KeyRect>> {
        val gap = KeyboardTheme.KEY_GAP_DP * density
        val keyHeight = KeyboardTheme.KEY_HEIGHT_DP * density
        val touchExpand = KeyboardTheme.TOUCH_EXPAND_DP * density
        val contextBarHeight = KeyboardTheme.CONTEXT_BAR_DP * density
        val rows = getRows(layer)
        val result = mutableListOf<List<KeyRect>>()

        for ((rowIndex, row) in rows.withIndex()) {
            val totalMultiplier = row.sumOf { it.widthMultiplier.toDouble() }.toFloat()
            val totalGaps = (row.size - 1) * gap
            val availableWidth = widthPx - totalGaps
            val unitWidth = availableWidth / totalMultiplier

            var x = 0f
            val y = contextBarHeight + rowIndex * (keyHeight + gap)
            val rowRects = mutableListOf<KeyRect>()

            for ((keyIndex, keyDef) in row.withIndex()) {
                val keyWidth = unitWidth * keyDef.widthMultiplier
                val left = x
                val right = x + keyWidth
                val top = y
                val bottom = y + keyHeight

                rowRects.add(
                    KeyRect(
                        def = keyDef,
                        left = left,
                        top = top,
                        right = right,
                        bottom = bottom,
                        touchLeft = (left - touchExpand).coerceAtLeast(0f),
                        touchTop = (top - touchExpand).coerceAtLeast(0f),
                        touchRight = (right + touchExpand).coerceAtMost(widthPx.toFloat()),
                        touchBottom = bottom + touchExpand
                    )
                )

                x = right + gap
            }

            result.add(rowRects)
        }

        return result
    }

    /**
     * Total keyboard height including context bar.
     */
    fun totalHeightPx(density: Float): Int {
        val gap = KeyboardTheme.KEY_GAP_DP * density
        val keyHeight = KeyboardTheme.KEY_HEIGHT_DP * density
        val contextBarHeight = KeyboardTheme.CONTEXT_BAR_DP * density
        return (contextBarHeight + 4 * keyHeight + 3 * gap).toInt()
    }
}
