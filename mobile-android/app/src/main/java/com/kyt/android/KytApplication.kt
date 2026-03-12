package com.kyt.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.kyt.android.data.SupabaseClient

class KytApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        SupabaseClient.init(this)
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        val voiceChannel = NotificationChannel(
            VOICE_CHANNEL_ID,
            "Voice Session",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Active K.Y.T. voice conversation"
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(voiceChannel)
    }

    companion object {
        const val VOICE_CHANNEL_ID = "kyt_voice"
    }
}
