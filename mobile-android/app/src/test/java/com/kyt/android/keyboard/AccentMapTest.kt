package com.kyt.android.keyboard

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for long-press accent character mappings.
 */
class AccentMapTest {

    @Test
    fun `accent map has entries for common vowels`() {
        for (vowel in listOf("A", "E", "I", "O", "U")) {
            assertNotNull("Accent map has $vowel", KytKeyboardView.ACCENT_MAP[vowel])
            assertTrue("$vowel has accents", KytKeyboardView.ACCENT_MAP[vowel]!!.isNotEmpty())
        }
    }

    @Test
    fun `accent map has entries for C N S Y Z`() {
        for (letter in listOf("C", "N", "S", "Y", "Z")) {
            assertNotNull("Accent map has $letter", KytKeyboardView.ACCENT_MAP[letter])
        }
    }

    @Test
    fun `accent map uses uppercase keys`() {
        for (key in KytKeyboardView.ACCENT_MAP.keys) {
            assertEquals("Key $key is uppercase", key, key.uppercase())
        }
    }

    @Test
    fun `accent chars are lowercase`() {
        for ((key, chars) in KytKeyboardView.ACCENT_MAP) {
            for (char in chars) {
                assertEquals("$key accent '$char' is lowercase", char, char.lowercase())
            }
        }
    }

    @Test
    fun `A includes common accents`() {
        val accents = KytKeyboardView.ACCENT_MAP["A"]!!
        assertTrue("à", accents.contains("à"))
        assertTrue("á", accents.contains("á"))
        assertTrue("ä", accents.contains("ä"))
        assertTrue("â", accents.contains("â"))
    }

    @Test
    fun `E includes common accents`() {
        val accents = KytKeyboardView.ACCENT_MAP["E"]!!
        assertTrue("è", accents.contains("è"))
        assertTrue("é", accents.contains("é"))
        assertTrue("ê", accents.contains("ê"))
    }

    @Test
    fun `N includes ñ`() {
        assertTrue(KytKeyboardView.ACCENT_MAP["N"]!!.contains("ñ"))
    }

    @Test
    fun `C includes ç`() {
        assertTrue(KytKeyboardView.ACCENT_MAP["C"]!!.contains("ç"))
    }

    @Test
    fun `S includes ß`() {
        assertTrue(KytKeyboardView.ACCENT_MAP["S"]!!.contains("ß"))
    }

    @Test
    fun `no accent map entry exceeds 10 chars`() {
        for ((key, chars) in KytKeyboardView.ACCENT_MAP) {
            assertTrue("$key has ${chars.size} accents <= 10", chars.size <= 10)
        }
    }

    @Test
    fun `letters without accents are not in map`() {
        for (letter in listOf("B", "D", "F", "G", "H", "J", "K", "L", "M", "P", "Q", "R", "T", "V", "W", "X")) {
            assertNull("$letter should not have accents", KytKeyboardView.ACCENT_MAP[letter])
        }
    }
}
