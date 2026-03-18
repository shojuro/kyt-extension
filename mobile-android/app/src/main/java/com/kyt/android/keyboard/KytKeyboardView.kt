package com.kyt.android.keyboard

import android.content.Context
import android.graphics.*
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo

/**
 * K.Y.T. Keyboard — Custom View with Canvas rendering.
 *
 * Same approach as AOSP LatinIME: Canvas drawing for fastest render path,
 * full touch control, lowest memory in shared IME process.
 *
 * Target: Samsung Galaxy A22 (720x1600px, ~2.0x density)
 */
class KytKeyboardView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    // ── Listener ─────────────────────────────────────────────

    interface KeyActionListener {
        fun onKeyPress(keyDef: KeyDef)
    }

    var keyActionListener: KeyActionListener? = null

    // ── State ────────────────────────────────────────────────

    private var currentLayer = KeyboardLayer.ALPHA
    var shiftState = ShiftState.OFF
        private set
    private var pressedKey: KeyRect? = null
    private var layoutRows: List<List<KeyRect>> = emptyList()

    // Context bar
    private var contextBarText: String = "K.Y.T."
    private var memoryModeDotColor: Int = KeyboardTheme.ACCENT
    private var enterLabel: String = "↵"
    private var enterGlow: Boolean = false

    // Backspace repeat
    private val handler = Handler(Looper.getMainLooper())
    private var backspaceRepeating = false
    private val backspaceRepeatRunnable = object : Runnable {
        override fun run() {
            val key = pressedKey
            if (key != null && key.def.type == KeyType.BACKSPACE) {
                keyActionListener?.onKeyPress(key.def)
                handler.postDelayed(this, KeyboardTheme.BACKSPACE_REPEAT_MS)
            }
        }
    }

    // Double-tap shift detection
    private var lastShiftTapTime = 0L

    // Long-press accent popup
    private var longPressTriggered = false
    private var accentPopupChars: List<String> = emptyList()
    private var accentPopupKeyRect: KeyRect? = null
    private var accentPopupSelected: Int = -1
    private val longPressRunnable = Runnable { showAccentPopup() }
    companion object {
        private const val LONG_PRESS_DELAY_MS = 300L

        /** Accent characters available per letter on long-press */
        val ACCENT_MAP: Map<String, List<String>> = mapOf(
            "A" to listOf("à", "á", "â", "ä", "ã", "å", "æ"),
            "C" to listOf("ç", "ć", "č"),
            "E" to listOf("è", "é", "ê", "ë", "ę"),
            "I" to listOf("ì", "í", "î", "ï"),
            "N" to listOf("ñ", "ń"),
            "O" to listOf("ò", "ó", "ô", "ö", "õ", "ø", "œ"),
            "S" to listOf("ß", "ś", "š"),
            "U" to listOf("ù", "ú", "û", "ü"),
            "Y" to listOf("ý", "ÿ"),
            "Z" to listOf("ź", "ž", "ż")
        )
    }

    // ── Paints ───────────────────────────────────────────────

    private val bgPaint = Paint().apply { color = KeyboardTheme.BG }

    private val keyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.KEY_SURFACE
    }

    private val keyPressedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.KEY_PRESSED
    }

    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.BORDER
        style = Paint.Style.STROKE
        strokeWidth = 1f
    }

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.TEXT_COLOR
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT
    }

    private val funcTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.FUNC_TEXT
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT
    }

    private val contextBarPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.CONTEXT_BG
    }

    private val contextTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.FUNC_TEXT
        textAlign = Paint.Align.LEFT
    }

    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    private val scanlinePaint = Paint().apply {
        color = KeyboardTheme.ACCENT
        alpha = KeyboardTheme.SCANLINE_ALPHA
        strokeWidth = 1f
    }

    private val accentPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.ACCENT
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT_BOLD
    }

    private val popupBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.KEY_SURFACE
    }

    private val popupSelectedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = KeyboardTheme.KEY_PRESSED
    }

    // ── Measure ──────────────────────────────────────────────

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = KeyboardLayout.totalHeightPx(resources.displayMetrics.density)
        setMeasuredDimension(width, height)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        recomputeLayout()
    }

    private fun recomputeLayout() {
        if (width > 0) {
            layoutRows = KeyboardLayout.computeLayout(
                width, resources.displayMetrics.density, currentLayer
            )
        }
    }

    // ── Drawing ──────────────────────────────────────────────

    override fun onDraw(canvas: Canvas) {
        val density = resources.displayMetrics.density

        // Background
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        // Context bar
        drawContextBar(canvas, density)

        // Keys
        for (row in layoutRows) {
            for (keyRect in row) {
                drawKey(canvas, keyRect, density)
            }
        }

        // Scanline overlay
        drawScanlines(canvas, density)

        // Accent popup (drawn on top of everything)
        if (accentPopupChars.isNotEmpty()) {
            drawAccentPopup(canvas, density)
        }
    }

    private fun drawContextBar(canvas: Canvas, density: Float) {
        val barHeight = KeyboardTheme.CONTEXT_BAR_DP * density
        canvas.drawRect(0f, 0f, width.toFloat(), barHeight, contextBarPaint)

        // Memory mode dot
        val dotRadius = 4f * density
        val dotCx = 12f * density
        val dotCy = barHeight / 2f
        dotPaint.color = memoryModeDotColor
        canvas.drawCircle(dotCx, dotCy, dotRadius, dotPaint)

        // Status text
        contextTextPaint.textSize = KeyboardTheme.CONTEXT_TEXT_SP * resources.displayMetrics.scaledDensity
        val textX = dotCx + dotRadius + 8f * density
        val textY = barHeight / 2f - (contextTextPaint.descent() + contextTextPaint.ascent()) / 2f
        canvas.drawText(contextBarText, textX, textY, contextTextPaint)
    }

    private fun drawKey(canvas: Canvas, keyRect: KeyRect, density: Float) {
        val isPressed = pressedKey == keyRect
        val radius = KeyboardTheme.KEY_RADIUS_DP * density
        val rect = RectF(keyRect.left, keyRect.top, keyRect.right, keyRect.bottom)

        // Key background
        val paint = if (isPressed) keyPressedPaint else keyPaint
        canvas.drawRoundRect(rect, radius, radius, paint)

        // Border
        canvas.drawRoundRect(rect, radius, radius, borderPaint)

        // Label
        val cx = (keyRect.left + keyRect.right) / 2f
        val cy = (keyRect.top + keyRect.bottom) / 2f

        when (keyRect.def.type) {
            KeyType.BACKSPACE -> drawBackspaceIcon(canvas, cx, cy, density)
            KeyType.SHIFT -> drawShiftIcon(canvas, cx, cy, density)
            KeyType.ENTER -> drawEnterKey(canvas, keyRect, cx, cy, density, radius)
            KeyType.SPACE -> { /* Empty spacebar */ }
            KeyType.GLOBE -> {
                textPaint.textSize = KeyboardTheme.TEXT_SIZE_SP * resources.displayMetrics.scaledDensity
                canvas.drawText("🌐", cx, cy - (textPaint.descent() + textPaint.ascent()) / 2f, textPaint)
            }
            KeyType.SYMBOL -> {
                funcTextPaint.textSize = KeyboardTheme.FUNC_TEXT_SP * resources.displayMetrics.scaledDensity
                canvas.drawText(
                    keyRect.def.label, cx,
                    cy - (funcTextPaint.descent() + funcTextPaint.ascent()) / 2f,
                    funcTextPaint
                )
            }
            else -> {
                textPaint.textSize = KeyboardTheme.TEXT_SIZE_SP * resources.displayMetrics.scaledDensity
                val label = when {
                    keyRect.def.type == KeyType.LETTER && shiftState != ShiftState.OFF ->
                        keyRect.def.label.uppercase()
                    keyRect.def.type == KeyType.LETTER ->
                        keyRect.def.label.lowercase()
                    else -> keyRect.def.label
                }
                canvas.drawText(
                    label, cx,
                    cy - (textPaint.descent() + textPaint.ascent()) / 2f,
                    textPaint
                )
            }
        }
    }

    private fun drawBackspaceIcon(canvas: Canvas, cx: Float, cy: Float, density: Float) {
        val size = 10f * density
        val path = Path().apply {
            // Left-pointing arrow with x
            moveTo(cx - size, cy)
            lineTo(cx - size * 0.3f, cy - size * 0.7f)
            lineTo(cx + size, cy - size * 0.7f)
            lineTo(cx + size, cy + size * 0.7f)
            lineTo(cx - size * 0.3f, cy + size * 0.7f)
            close()
        }
        val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = KeyboardTheme.TEXT_COLOR
            style = Paint.Style.STROKE
            strokeWidth = 1.5f * density
        }
        canvas.drawPath(path, iconPaint)

        // X inside
        val xSize = size * 0.3f
        canvas.drawLine(cx + xSize * 0.5f - xSize, cy - xSize, cx + xSize * 0.5f + xSize, cy + xSize, iconPaint)
        canvas.drawLine(cx + xSize * 0.5f + xSize, cy - xSize, cx + xSize * 0.5f - xSize, cy + xSize, iconPaint)
    }

    private fun drawShiftIcon(canvas: Canvas, cx: Float, cy: Float, density: Float) {
        val size = 9f * density
        val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = when (shiftState) {
                ShiftState.OFF -> KeyboardTheme.TEXT_COLOR
                ShiftState.SINGLE -> KeyboardTheme.ACCENT
                ShiftState.CAPS_LOCK -> KeyboardTheme.ACCENT
            }
            style = when (shiftState) {
                ShiftState.CAPS_LOCK -> Paint.Style.FILL_AND_STROKE
                else -> Paint.Style.STROKE
            }
            strokeWidth = 1.5f * density
        }

        val path = Path().apply {
            // Up arrow
            moveTo(cx, cy - size)
            lineTo(cx + size * 0.8f, cy)
            lineTo(cx + size * 0.35f, cy)
            lineTo(cx + size * 0.35f, cy + size * 0.6f)
            lineTo(cx - size * 0.35f, cy + size * 0.6f)
            lineTo(cx - size * 0.35f, cy)
            lineTo(cx - size * 0.8f, cy)
            close()
        }
        canvas.drawPath(path, iconPaint)

        // Underline for caps lock
        if (shiftState == ShiftState.CAPS_LOCK) {
            canvas.drawLine(
                cx - size * 0.5f, cy + size * 0.85f,
                cx + size * 0.5f, cy + size * 0.85f,
                iconPaint
            )
        }
    }

    private fun drawEnterKey(
        canvas: Canvas, keyRect: KeyRect,
        cx: Float, cy: Float, density: Float, radius: Float
    ) {
        if (enterGlow) {
            val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = KeyboardTheme.ACCENT
                alpha = 40
            }
            val rect = RectF(keyRect.left, keyRect.top, keyRect.right, keyRect.bottom)
            canvas.drawRoundRect(rect, radius, radius, glowPaint)
        }

        val paint = if (enterGlow) accentPaint else funcTextPaint
        paint.textSize = KeyboardTheme.FUNC_TEXT_SP * resources.displayMetrics.scaledDensity
        canvas.drawText(
            enterLabel, cx,
            cy - (paint.descent() + paint.ascent()) / 2f,
            paint
        )
    }

    private fun drawScanlines(canvas: Canvas, density: Float) {
        val gap = KeyboardTheme.SCANLINE_GAP_DP * density
        val contextBarHeight = KeyboardTheme.CONTEXT_BAR_DP * density
        var y = contextBarHeight
        while (y < height) {
            canvas.drawLine(0f, y, width.toFloat(), y, scanlinePaint)
            y += gap
        }
    }

    // ── Touch ────────────────────────────────────────────────

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val key = findKeyAt(event.x, event.y)
                if (key != null) {
                    pressedKey = key
                    longPressTriggered = false
                    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    invalidate()

                    // Start backspace repeat
                    if (key.def.type == KeyType.BACKSPACE) {
                        backspaceRepeating = true
                        handler.postDelayed(
                            backspaceRepeatRunnable,
                            KeyboardTheme.BACKSPACE_INITIAL_DELAY_MS
                        )
                    }

                    // Schedule long-press for accent chars
                    if (key.def.type == KeyType.LETTER &&
                        ACCENT_MAP.containsKey(key.def.label.uppercase())
                    ) {
                        handler.postDelayed(longPressRunnable, LONG_PRESS_DELAY_MS)
                    }
                }
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                // If accent popup is showing, update selection
                if (accentPopupChars.isNotEmpty()) {
                    updateAccentPopupSelection(event.x)
                    return true
                }

                val key = findKeyAt(event.x, event.y)
                if (key != pressedKey) {
                    // Finger slid to different key — cancel backspace repeat + long press
                    if (backspaceRepeating) {
                        handler.removeCallbacks(backspaceRepeatRunnable)
                        backspaceRepeating = false
                    }
                    handler.removeCallbacks(longPressRunnable)
                    pressedKey = key
                    invalidate()
                }
                return true
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                handler.removeCallbacks(longPressRunnable)

                // If accent popup is showing, commit selected accent
                if (accentPopupChars.isNotEmpty()) {
                    val selectedChar = dismissAccentPopup()
                    if (selectedChar != null && event.actionMasked == MotionEvent.ACTION_UP) {
                        // Create a temporary KeyDef for the accent char
                        val accentDef = KeyDef(selectedChar, selectedChar[0].code, type = KeyType.LETTER)
                        keyActionListener?.onKeyPress(accentDef)
                    }
                    pressedKey = null
                    invalidate()
                    return true
                }

                val key = pressedKey
                if (key != null && event.actionMasked == MotionEvent.ACTION_UP && !longPressTriggered) {
                    handleKeyAction(key)
                }
                pressedKey = null
                longPressTriggered = false
                if (backspaceRepeating) {
                    handler.removeCallbacks(backspaceRepeatRunnable)
                    backspaceRepeating = false
                }
                invalidate()
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    /**
     * Find key at touch coordinates using expanded touch bounds.
     * Nearest-center disambiguation when touch overlaps multiple keys.
     */
    private fun findKeyAt(x: Float, y: Float): KeyRect? {
        var bestKey: KeyRect? = null
        var bestDist = Float.MAX_VALUE

        for (row in layoutRows) {
            for (keyRect in row) {
                if (x >= keyRect.touchLeft && x <= keyRect.touchRight &&
                    y >= keyRect.touchTop && y <= keyRect.touchBottom
                ) {
                    val cx = (keyRect.left + keyRect.right) / 2f
                    val cy = (keyRect.top + keyRect.bottom) / 2f
                    val dist = (x - cx) * (x - cx) + (y - cy) * (y - cy)
                    if (dist < bestDist) {
                        bestDist = dist
                        bestKey = keyRect
                    }
                }
            }
        }

        return bestKey
    }

    // ── Key actions ──────────────────────────────────────────

    private fun handleKeyAction(keyRect: KeyRect) {
        when (keyRect.def.type) {
            KeyType.SHIFT -> handleShiftTap()
            KeyType.SYMBOL -> switchLayer(
                when (currentLayer) {
                    KeyboardLayer.ALPHA -> KeyboardLayer.SYMBOLS
                    KeyboardLayer.SYMBOLS -> KeyboardLayer.ALPHA
                    KeyboardLayer.SYMBOLS_2 -> KeyboardLayer.SYMBOLS
                }
            )
            KeyType.GLOBE -> {
                // Handled by service via listener
                keyActionListener?.onKeyPress(keyRect.def)
            }
            else -> {
                keyActionListener?.onKeyPress(keyRect.def)
                // Auto-revert shift after typing a letter
                if (keyRect.def.type == KeyType.LETTER && shiftState == ShiftState.SINGLE) {
                    shiftState = ShiftState.OFF
                    invalidate()
                }
            }
        }
    }

    private fun handleShiftTap() {
        val now = System.currentTimeMillis()
        when (shiftState) {
            ShiftState.OFF -> {
                if (now - lastShiftTapTime < KeyboardTheme.DOUBLE_TAP_MS) {
                    shiftState = ShiftState.CAPS_LOCK
                } else {
                    shiftState = ShiftState.SINGLE
                }
            }
            ShiftState.SINGLE -> {
                if (now - lastShiftTapTime < KeyboardTheme.DOUBLE_TAP_MS) {
                    shiftState = ShiftState.CAPS_LOCK
                } else {
                    shiftState = ShiftState.OFF
                }
            }
            ShiftState.CAPS_LOCK -> {
                shiftState = ShiftState.OFF
            }
        }
        lastShiftTapTime = now
        invalidate()
    }

    private fun switchLayer(layer: KeyboardLayer) {
        // When switching to symbol layer where code is SYMBOL_2
        val targetLayer = if (layer == KeyboardLayer.SYMBOLS &&
            currentLayer == KeyboardLayer.SYMBOLS
        ) {
            KeyboardLayer.SYMBOLS_2
        } else {
            layer
        }

        currentLayer = targetLayer
        recomputeLayout()
        invalidate()
    }

    // ── Accent popup ─────────────────────────────────────────

    private fun showAccentPopup() {
        val key = pressedKey ?: return
        if (key.def.type != KeyType.LETTER) return
        val accents = ACCENT_MAP[key.def.label.uppercase()] ?: return

        longPressTriggered = true
        accentPopupChars = accents
        accentPopupKeyRect = key
        accentPopupSelected = -1
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        invalidate()
    }

    private fun drawAccentPopup(canvas: Canvas, density: Float) {
        val key = accentPopupKeyRect ?: return
        val cellWidth = 36f * density
        val cellHeight = 44f * density
        val radius = KeyboardTheme.KEY_RADIUS_DP * density
        val totalWidth = cellWidth * accentPopupChars.size
        val popupLeft = ((key.left + key.right) / 2f - totalWidth / 2f).coerceIn(0f, width - totalWidth)
        val popupTop = key.top - cellHeight - 4f * density

        // Background
        val bgRect = RectF(popupLeft, popupTop, popupLeft + totalWidth, popupTop + cellHeight)
        canvas.drawRoundRect(bgRect, radius, radius, popupBgPaint)
        canvas.drawRoundRect(bgRect, radius, radius, borderPaint)

        // Individual cells
        textPaint.textSize = KeyboardTheme.TEXT_SIZE_SP * resources.displayMetrics.scaledDensity
        for ((i, char) in accentPopupChars.withIndex()) {
            val cellLeft = popupLeft + i * cellWidth
            if (i == accentPopupSelected) {
                val selRect = RectF(cellLeft, popupTop, cellLeft + cellWidth, popupTop + cellHeight)
                canvas.drawRoundRect(selRect, radius, radius, popupSelectedPaint)
            }
            val cx = cellLeft + cellWidth / 2f
            val cy = popupTop + cellHeight / 2f
            canvas.drawText(char, cx, cy - (textPaint.descent() + textPaint.ascent()) / 2f, textPaint)
        }
    }

    private fun dismissAccentPopup(): String? {
        val selected = if (accentPopupSelected in accentPopupChars.indices) {
            accentPopupChars[accentPopupSelected]
        } else null
        accentPopupChars = emptyList()
        accentPopupKeyRect = null
        accentPopupSelected = -1
        longPressTriggered = false
        return selected
    }

    private fun updateAccentPopupSelection(x: Float) {
        val key = accentPopupKeyRect ?: return
        val density = resources.displayMetrics.density
        val cellWidth = 36f * density
        val totalWidth = cellWidth * accentPopupChars.size
        val popupLeft = ((key.left + key.right) / 2f - totalWidth / 2f).coerceIn(0f, width - totalWidth)
        val index = ((x - popupLeft) / cellWidth).toInt()
        val newSelected = if (index in accentPopupChars.indices) index else -1
        if (newSelected != accentPopupSelected) {
            accentPopupSelected = newSelected
            invalidate()
        }
    }

    // ── Public API ───────────────────────────────────────────

    fun updateContextBar(text: String, dotColor: Int = KeyboardTheme.ACCENT) {
        contextBarText = text
        memoryModeDotColor = dotColor
        invalidate()
    }

    /**
     * Update enter key label based on IME options.
     */
    fun updateEnterKey(editorInfo: EditorInfo?) {
        val imeAction = editorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: 0
        enterLabel = when (imeAction) {
            EditorInfo.IME_ACTION_SEND -> "Send"
            EditorInfo.IME_ACTION_SEARCH -> "Search"
            EditorInfo.IME_ACTION_GO -> "Go"
            EditorInfo.IME_ACTION_DONE -> "Done"
            EditorInfo.IME_ACTION_NEXT -> "Next"
            else -> "↵"
        }
        invalidate()
    }

    fun setEnterGlow(glow: Boolean) {
        if (enterGlow != glow) {
            enterGlow = glow
            invalidate()
        }
    }

    /**
     * Switch to alpha layer and reset shift.
     * Called after symbol key actions to return to letters.
     */
    fun switchToAlpha() {
        currentLayer = KeyboardLayer.ALPHA
        shiftState = ShiftState.OFF
        recomputeLayout()
        invalidate()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        handler.removeCallbacksAndMessages(null)
    }
}
