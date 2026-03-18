package com.kyt.android.keyboard

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for KeyboardLayout — pure Kotlin, no Android dependencies.
 *
 * Target: Samsung Galaxy A22 (720px wide, 2.0x density)
 */
class KeyboardLayoutTest {

    // A22 display params
    private val A22_WIDTH_PX = 720
    private val A22_DENSITY = 2.0f

    // ── Row structure tests ──────────────────────────────────

    @Test
    fun `alpha layer has 4 rows`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        assertEquals(4, rows.size)
    }

    @Test
    fun `alpha row 0 has 10 keys QWERTYUIOP`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        assertEquals(10, rows[0].size)
        assertEquals("QWERTYUIOP", rows[0].joinToString("") { it.label })
    }

    @Test
    fun `alpha row 1 has 9 keys ASDFGHJKL`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        assertEquals(9, rows[1].size)
        assertEquals("ASDFGHJKL", rows[1].joinToString("") { it.label })
    }

    @Test
    fun `alpha row 2 has shift + 7 letters + backspace`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        assertEquals(9, rows[2].size)
        assertEquals(KeyType.SHIFT, rows[2].first().type)
        assertEquals(KeyType.BACKSPACE, rows[2].last().type)
        val letters = rows[2].filter { it.type == KeyType.LETTER }
        assertEquals(7, letters.size)
        assertEquals("ZXCVBNM", letters.joinToString("") { it.label })
    }

    @Test
    fun `alpha row 3 has globe + symbol + space + period + enter`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val types = rows[3].map { it.type }
        assertEquals(
            listOf(KeyType.GLOBE, KeyType.SYMBOL, KeyType.SPACE, KeyType.PERIOD, KeyType.ENTER),
            types
        )
    }

    @Test
    fun `symbols layer has 4 rows`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.SYMBOLS)
        assertEquals(4, rows.size)
    }

    @Test
    fun `symbols row 0 has digits 0-9`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.SYMBOLS)
        assertEquals(10, rows[0].size)
        assertEquals("1234567890", rows[0].joinToString("") { it.label })
    }

    @Test
    fun `symbols_2 layer has 4 rows`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.SYMBOLS_2)
        assertEquals(4, rows.size)
    }

    // ── Layout computation tests ─────────────────────────────

    @Test
    fun `computeLayout returns 4 rows for alpha`() {
        val layout = KeyboardLayout.computeLayout(A22_WIDTH_PX, A22_DENSITY)
        assertEquals(4, layout.size)
    }

    @Test
    fun `all keys have positive dimensions`() {
        val layout = KeyboardLayout.computeLayout(A22_WIDTH_PX, A22_DENSITY)
        for (row in layout) {
            for (key in row) {
                assertTrue("Key ${key.def.label} width > 0", key.right > key.left)
                assertTrue("Key ${key.def.label} height > 0", key.bottom > key.top)
            }
        }
    }

    @Test
    fun `keys do not exceed screen width`() {
        val layout = KeyboardLayout.computeLayout(A22_WIDTH_PX, A22_DENSITY)
        for (row in layout) {
            for (key in row) {
                assertTrue("Key ${key.def.label} right <= width", key.right <= A22_WIDTH_PX)
                assertTrue("Key ${key.def.label} left >= 0", key.left >= 0f)
            }
        }
    }

    @Test
    fun `touch bounds expand beyond visual bounds`() {
        val layout = KeyboardLayout.computeLayout(A22_WIDTH_PX, A22_DENSITY)
        // Check a middle key (not edge — edge keys are clamped)
        val middleKey = layout[0][4] // T key
        assertTrue(middleKey.touchLeft < middleKey.left)
        assertTrue(middleKey.touchRight > middleKey.right)
    }

    @Test
    fun `touch bounds are clamped to screen edges`() {
        val layout = KeyboardLayout.computeLayout(A22_WIDTH_PX, A22_DENSITY)
        val firstKey = layout[0][0] // Q key
        assertTrue("Left touch bound >= 0", firstKey.touchLeft >= 0f)
        val lastKey = layout[0][9] // P key
        assertTrue("Right touch bound <= width", lastKey.touchRight <= A22_WIDTH_PX)
    }

    @Test
    fun `key height matches theme constant`() {
        val layout = KeyboardLayout.computeLayout(A22_WIDTH_PX, A22_DENSITY)
        val expectedHeight = KeyboardTheme.KEY_HEIGHT_DP * A22_DENSITY
        val key = layout[0][0]
        assertEquals(expectedHeight, key.bottom - key.top, 0.5f)
    }

    @Test
    fun `context bar offsets keys vertically`() {
        val layout = KeyboardLayout.computeLayout(A22_WIDTH_PX, A22_DENSITY)
        val contextBarHeight = KeyboardTheme.CONTEXT_BAR_DP * A22_DENSITY
        val firstKeyTop = layout[0][0].top
        assertEquals(contextBarHeight, firstKeyTop, 0.5f)
    }

    @Test
    fun `space bar is wider than regular keys`() {
        val layout = KeyboardLayout.computeLayout(A22_WIDTH_PX, A22_DENSITY)
        val spaceKey = layout[3].find { it.def.type == KeyType.SPACE }!!
        val letterKey = layout[0][0] // Q
        val spaceWidth = spaceKey.right - spaceKey.left
        val letterWidth = letterKey.right - letterKey.left
        assertTrue("Space ($spaceWidth) > letter ($letterWidth)", spaceWidth > letterWidth * 3)
    }

    @Test
    fun `shift and backspace are wider than letter keys`() {
        val layout = KeyboardLayout.computeLayout(A22_WIDTH_PX, A22_DENSITY)
        val shiftKey = layout[2].find { it.def.type == KeyType.SHIFT }!!
        val letterKey = layout[2].find { it.def.type == KeyType.LETTER }!!
        val shiftWidth = shiftKey.right - shiftKey.left
        val letterWidth = letterKey.right - letterKey.left
        assertTrue("Shift ($shiftWidth) > letter ($letterWidth)", shiftWidth > letterWidth)
    }

    // ── Total height ─────────────────────────────────────────

    @Test
    fun `total height is approximately 224dp at 2x density`() {
        val heightPx = KeyboardLayout.totalHeightPx(A22_DENSITY)
        val heightDp = heightPx / A22_DENSITY
        // 28dp context + 4×48dp keys + 3×3dp gaps = 28 + 192 + 9 = 229dp
        assertTrue("Height ${heightDp}dp in reasonable range", heightDp in 220f..240f)
    }

    // ── Multi-density tests ──────────────────────────────────

    @Test
    fun `layout scales with density`() {
        val layout1x = KeyboardLayout.computeLayout(360, 1.0f)
        val layout2x = KeyboardLayout.computeLayout(720, 2.0f)
        val key1x = layout1x[0][0]
        val key2x = layout2x[0][0]
        val height1x = key1x.bottom - key1x.top
        val height2x = key2x.bottom - key2x.top
        assertEquals(height1x * 2, height2x, 1f)
    }

    // ── Key type tests ───────────────────────────────────────

    @Test
    fun `all layers have backspace`() {
        for (layer in KeyboardLayer.entries) {
            val rows = KeyboardLayout.getRows(layer)
            val hasBackspace = rows.any { row -> row.any { it.type == KeyType.BACKSPACE } }
            assertTrue("Layer $layer has backspace", hasBackspace)
        }
    }

    @Test
    fun `all layers have enter`() {
        for (layer in KeyboardLayer.entries) {
            val rows = KeyboardLayout.getRows(layer)
            val hasEnter = rows.any { row -> row.any { it.type == KeyType.ENTER } }
            assertTrue("Layer $layer has enter", hasEnter)
        }
    }

    @Test
    fun `all layers have space`() {
        for (layer in KeyboardLayer.entries) {
            val rows = KeyboardLayout.getRows(layer)
            val hasSpace = rows.any { row -> row.any { it.type == KeyType.SPACE } }
            assertTrue("Layer $layer has space", hasSpace)
        }
    }

    @Test
    fun `all layers have globe for keyboard switching`() {
        for (layer in KeyboardLayer.entries) {
            val rows = KeyboardLayout.getRows(layer)
            val hasGlobe = rows.any { row -> row.any { it.type == KeyType.GLOBE } }
            assertTrue("Layer $layer has globe", hasGlobe)
        }
    }

    // ── Width multiplier tests ───────────────────────────────

    @Test
    fun `alpha row 0 all keys have 1x multiplier`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        assertTrue(rows[0].all { it.widthMultiplier == 1.0f })
    }

    @Test
    fun `shift has wider multiplier than letter keys`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val shift = rows[2].first { it.type == KeyType.SHIFT }
        assertTrue(shift.widthMultiplier > 1.0f)
    }
}
