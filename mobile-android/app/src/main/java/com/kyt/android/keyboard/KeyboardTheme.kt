package com.kyt.android.keyboard

import android.graphics.Color

/**
 * K.Y.T. Keyboard — Color and dimension constants.
 * Single source of truth for all visual parameters.
 *
 * Target device: Samsung Galaxy A22 (720x1600px, ~2.0x density)
 * 360dp effective width → 10 keys/row at 36dp each
 */
object KeyboardTheme {

    // ── Colors ───────────────────────────────────────────────

    val BG            = Color.parseColor("#0A0A0C")
    val KEY_SURFACE   = Color.parseColor("#1A1A2E")
    val KEY_PRESSED   = Color.parseColor("#2D5016")
    val TEXT_COLOR    = Color.parseColor("#E8E8EC")
    val ACCENT        = Color.parseColor("#39FF14")
    val BORDER        = Color.parseColor("#2A2A3E")
    val CONTEXT_BG    = Color.parseColor("#111114")
    val FUNC_TEXT     = Color.parseColor("#A0A0A8")

    // ── Dimensions (dp) ──────────────────────────────────────

    const val KEY_WIDTH_DP     = 36f
    const val KEY_HEIGHT_DP    = 58f
    const val KEY_RADIUS_DP    = 6f
    const val KEY_GAP_DP       = 3f
    const val CONTEXT_BAR_DP   = 28f

    // Touch target expansion: visual 36dp, touch 44dp (4dp overlap each side)
    const val TOUCH_EXPAND_DP  = 4f

    // ── Text sizes (sp) ──────────────────────────────────────

    const val TEXT_SIZE_SP     = 18f
    const val FUNC_TEXT_SP     = 12f
    const val CONTEXT_TEXT_SP  = 11f

    // ── Timing ───────────────────────────────────────────────

    const val BACKSPACE_INITIAL_DELAY_MS = 400L
    const val BACKSPACE_REPEAT_MS        = 50L
    const val DOUBLE_TAP_MS              = 300L

    // ── Scanline overlay ─────────────────────────────────────

    const val SCANLINE_GAP_DP  = 3f
    const val SCANLINE_ALPHA   = 10  // 4% of 255
}
