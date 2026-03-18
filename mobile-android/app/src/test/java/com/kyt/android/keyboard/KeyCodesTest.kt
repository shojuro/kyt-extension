package com.kyt.android.keyboard

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for KeyCodes and KeyDef consistency.
 */
class KeyCodesTest {

    @Test
    fun `all custom key codes are negative`() {
        // Custom codes are negative to avoid collision with Char.code values
        assertTrue(KeyCodes.SHIFT < 0)
        assertTrue(KeyCodes.SYMBOL < 0)
        assertTrue(KeyCodes.GLOBE < 0)
        assertTrue(KeyCodes.BACKSPACE < 0)
        assertTrue(KeyCodes.ENTER < 0)
        assertTrue(KeyCodes.SPACE < 0)
        assertTrue(KeyCodes.SYMBOL_2 < 0)
        assertTrue(KeyCodes.ALPHA < 0)
    }

    @Test
    fun `all custom key codes are unique`() {
        val codes = listOf(
            KeyCodes.SHIFT, KeyCodes.SYMBOL, KeyCodes.GLOBE,
            KeyCodes.BACKSPACE, KeyCodes.ENTER, KeyCodes.SPACE,
            KeyCodes.SYMBOL_2, KeyCodes.ALPHA
        )
        assertEquals(codes.size, codes.toSet().size)
    }

    @Test
    fun `letter keys use char code as key code`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val qKey = rows[0][0]
        assertEquals('Q'.code, qKey.code)
        assertEquals(KeyType.LETTER, qKey.type)
    }

    @Test
    fun `period key uses char code`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val periodKey = rows[3].find { it.type == KeyType.PERIOD }!!
        assertEquals('.'.code, periodKey.code)
    }

    @Test
    fun `space key uses SPACE code`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val spaceKey = rows[3].find { it.type == KeyType.SPACE }!!
        assertEquals(KeyCodes.SPACE, spaceKey.code)
    }

    @Test
    fun `enter key uses ENTER code`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val enterKey = rows[3].find { it.type == KeyType.ENTER }!!
        assertEquals(KeyCodes.ENTER, enterKey.code)
    }

    @Test
    fun `symbols layer has ABC key to return to alpha`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.SYMBOLS)
        val abcKey = rows[3].find { it.label == "ABC" }
        assertNotNull("ABC key exists in symbols layer", abcKey)
        assertEquals(KeyCodes.ALPHA, abcKey!!.code)
    }

    @Test
    fun `alpha layer has symbol switch key`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val symKey = rows[3].find { it.label == "?123" }
        assertNotNull("?123 key exists in alpha layer", symKey)
        assertEquals(KeyCodes.SYMBOL, symKey!!.code)
    }

    @Test
    fun `symbols layer has symbols2 switch key`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.SYMBOLS)
        val sym2Key = rows[2].find { it.label == "=\\<" }
        assertNotNull("=\\< key exists in symbols layer", sym2Key)
        assertEquals(KeyCodes.SYMBOL_2, sym2Key!!.code)
    }

    // ── Total key count ──────────────────────────────────────

    @Test
    fun `alpha layer has 33 keys total`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val total = rows.sumOf { it.size }
        assertEquals(33, total) // 10 + 9 + 9 + 5
    }

    @Test
    fun `symbols layer has 33 keys total`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.SYMBOLS)
        val total = rows.sumOf { it.size }
        assertEquals(33, total) // 10 + 9 + 9 + 5
    }
}
