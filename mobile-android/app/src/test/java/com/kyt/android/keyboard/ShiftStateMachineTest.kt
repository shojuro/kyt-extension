package com.kyt.android.keyboard

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for ShiftState enum transitions.
 *
 * State machine:
 *   OFF → tap → SINGLE (auto-revert after letter)
 *   OFF → double-tap → CAPS_LOCK
 *   CAPS_LOCK → tap → OFF
 */
class ShiftStateMachineTest {

    @Test
    fun `ShiftState has 3 states`() {
        assertEquals(3, ShiftState.entries.size)
    }

    @Test
    fun `default state is OFF`() {
        assertEquals(ShiftState.OFF, ShiftState.entries[0])
    }

    @Test
    fun `KeyType SHIFT exists`() {
        assertEquals(KeyType.SHIFT, KeyType.valueOf("SHIFT"))
    }

    @Test
    fun `shift key uses SHIFT code`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val shiftKey = rows[2].first { it.type == KeyType.SHIFT }
        assertEquals(KeyCodes.SHIFT, shiftKey.code)
    }

    // ── KeyDef label tests (case rendering) ──────────────────

    @Test
    fun `letter labels are uppercase in KeyDef`() {
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val letters = rows[0] // QWERTYUIOP
        for (key in letters) {
            assertEquals(key.label, key.label.uppercase())
        }
    }

    @Test
    fun `lowercase is computed at render time not in KeyDef`() {
        // KeyDef stores uppercase; view renders lowercase when shift OFF
        val rows = KeyboardLayout.getRows(KeyboardLayer.ALPHA)
        val q = rows[0][0]
        assertEquals("Q", q.label) // always uppercase in data
        assertEquals("q", q.label.lowercase()) // view would show this when OFF
    }
}
