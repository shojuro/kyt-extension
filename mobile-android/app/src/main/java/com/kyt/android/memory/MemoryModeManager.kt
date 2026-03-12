package com.kyt.android.memory

import android.content.Context
import android.content.SharedPreferences

/**
 * Memory Mode Manager — Kotlin port of src/memory-mode.js
 *
 * Controls capture and injection behavior:
 *   full       — capture + inject (default)
 *   clean_room — capture only, no injection
 *   incognito  — no capture, no injection
 *
 * Stored in SharedPreferences (local to device, not synced to DB).
 */
object MemoryModeManager {

    private const val PREFS_NAME = "kyt_memory_mode_prefs"
    private const val KEY_MODE = "kyt_memory_mode"

    enum class Mode(val value: String) {
        FULL("full"),
        CLEAN_ROOM("clean_room"),
        INCOGNITO("incognito");

        companion object {
            fun fromString(s: String?): Mode = entries.find { it.value == s } ?: FULL
        }
    }

    private fun getPrefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getMode(context: Context): Mode =
        Mode.fromString(getPrefs(context).getString(KEY_MODE, null))

    fun setMode(context: Context, mode: Mode) {
        getPrefs(context).edit().putString(KEY_MODE, mode.value).apply()
    }

    /** Should we capture/save this message? */
    fun shouldCapture(context: Context): Boolean =
        getMode(context) != Mode.INCOGNITO

    /** Should we inject memory context? */
    fun shouldInject(context: Context): Boolean =
        getMode(context) == Mode.FULL
}
