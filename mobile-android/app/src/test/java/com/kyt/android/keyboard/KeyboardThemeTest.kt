package com.kyt.android.keyboard

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for KeyboardTheme constants.
 * Validates sizing meets Android touch target guidelines.
 */
class KeyboardThemeTest {

    @Test
    fun `key height meets 48dp minimum touch target`() {
        assertTrue(KeyboardTheme.KEY_HEIGHT_DP >= 48f)
    }

    @Test
    fun `key width plus touch expand meets minimum touch target`() {
        // Visual 36dp + 4dp expand each side = 44dp touch target
        val touchWidth = KeyboardTheme.KEY_WIDTH_DP + 2 * KeyboardTheme.TOUCH_EXPAND_DP
        assertTrue("Touch width ${touchWidth}dp >= 44dp", touchWidth >= 44f)
    }

    @Test
    fun `context bar fits status text`() {
        assertTrue(KeyboardTheme.CONTEXT_BAR_DP >= 24f)
    }

    @Test
    fun `text size is readable`() {
        assertTrue(KeyboardTheme.TEXT_SIZE_SP >= 14f)
    }

    @Test
    fun `func text is smaller than main text`() {
        assertTrue(KeyboardTheme.FUNC_TEXT_SP < KeyboardTheme.TEXT_SIZE_SP)
    }

    @Test
    fun `backspace repeat rate is 20 chars per second`() {
        assertEquals(50L, KeyboardTheme.BACKSPACE_REPEAT_MS)
    }

    @Test
    fun `backspace initial delay is longer than repeat`() {
        assertTrue(KeyboardTheme.BACKSPACE_INITIAL_DELAY_MS > KeyboardTheme.BACKSPACE_REPEAT_MS)
    }

    @Test
    fun `double tap window is reasonable`() {
        assertTrue(KeyboardTheme.DOUBLE_TAP_MS in 200L..500L)
    }

    @Test
    fun `scanline alpha is subtle`() {
        // 4% of 255 = ~10
        assertTrue(KeyboardTheme.SCANLINE_ALPHA <= 15)
        assertTrue(KeyboardTheme.SCANLINE_ALPHA > 0)
    }

    @Test
    fun `key gap prevents keys from touching`() {
        assertTrue(KeyboardTheme.KEY_GAP_DP > 0f)
    }

    @Test
    fun `key radius is reasonable for rounded corners`() {
        assertTrue(KeyboardTheme.KEY_RADIUS_DP in 2f..12f)
    }
}
