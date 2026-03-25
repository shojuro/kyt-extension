package com.kyt.android.data

import android.content.Context
import android.net.Uri
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.kyt.android.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Auth Manager — magic link → deep link → EncryptedSharedPreferences.
 *
 * Flow:
 * 1. signInWithMagicLink(email) → Supabase sends email with link
 * 2. User clicks link → kyt://auth-callback?access_token=...&refresh_token=...
 * 3. handleDeepLink(uri) → stores tokens in EncryptedSharedPreferences
 * 4. getAccessToken() → returns stored JWT (auto-refresh when expired)
 */
object AuthManager {

    private const val PREFS_FILE = "kyt_auth_prefs"
    private const val KEY_ACCESS_TOKEN = "access_token"
    private const val KEY_REFRESH_TOKEN = "refresh_token"
    private const val KEY_USER_ID = "user_id"
    private const val KEY_EXPIRES_AT = "expires_at"

    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private fun getEncryptedPrefs(context: Context) =
        EncryptedSharedPreferences.create(
            context,
            PREFS_FILE,
            MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )

    /**
     * Check if Supabase config is set. Returns error message or null if OK.
     */
    fun validateConfig(): String? {
        if (BuildConfig.SUPABASE_URL.isBlank()) {
            return "SUPABASE_URL not configured. Set KYT_SUPABASE_URL in local.properties"
        }
        if (!BuildConfig.SUPABASE_URL.startsWith("https://")) {
            return "SUPABASE_URL must start with https://"
        }
        if (BuildConfig.SUPABASE_ANON_KEY.isBlank()) {
            return "SUPABASE_ANON_KEY not configured. Set KYT_SUPABASE_ANON_KEY in local.properties"
        }
        return null
    }

    /**
     * Send magic link to email via Supabase GoTrue.
     */
    suspend fun signInWithMagicLink(context: Context, email: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            try {
                validateConfig()?.let { return@withContext Result.failure(Exception(it)) }

                val body = JSONObject().apply {
                    put("email", email)
                }

                val request = Request.Builder()
                    .url("${BuildConfig.SUPABASE_URL}/auth/v1/otp?redirect_to=kyt://auth-callback")
                    .post(body.toString().toRequestBody(JSON_MEDIA))
                    .addHeader("Content-Type", "application/json")
                    .addHeader("apikey", BuildConfig.SUPABASE_ANON_KEY)
                    .build()

                val response = httpClient.newCall(request).execute()
                if (response.isSuccessful) {
                    Result.success(Unit)
                } else {
                    Result.failure(Exception("Magic link failed: ${response.code}"))
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    /**
     * Handle deep link callback from magic link email.
     * URI format: kyt://auth-callback#access_token=...&refresh_token=...&expires_in=...
     */
    fun handleDeepLink(context: Context, uri: Uri): Boolean {
        // Supabase puts tokens in the fragment (#), not query (?)
        val fragment = uri.fragment ?: return false
        val params = fragment.split("&").associate {
            val (key, value) = it.split("=", limit = 2)
            key to value
        }

        val accessToken = params["access_token"] ?: return false
        val refreshToken = params["refresh_token"] ?: return false
        val expiresIn = params["expires_in"]?.toLongOrNull() ?: 3600

        // Decode JWT to extract user_id
        val userId = decodeJwtSubject(accessToken) ?: return false

        val prefs = getEncryptedPrefs(context)
        prefs.edit()
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .putString(KEY_USER_ID, userId)
            .putLong(KEY_EXPIRES_AT, System.currentTimeMillis() + (expiresIn * 1000))
            .apply()

        return true
    }

    /**
     * Get current access token. Returns null if not authenticated.
     * Auto-refreshes if expired.
     */
    suspend fun getAccessToken(context: Context): String? {
        val prefs = getEncryptedPrefs(context)
        val token = prefs.getString(KEY_ACCESS_TOKEN, null) ?: return null
        val expiresAt = prefs.getLong(KEY_EXPIRES_AT, 0)

        // Refresh if token expires within 60 seconds
        if (System.currentTimeMillis() > expiresAt - 60_000) {
            val refreshToken = prefs.getString(KEY_REFRESH_TOKEN, null) ?: return null
            return refreshAccessToken(context, refreshToken)
        }

        return token
    }

    private const val TEST_USER_ID = "b0000002-0000-4000-a000-000000000002"

    fun getUserId(context: Context): String? {
        // Test mode: override userId for synthetic data testing
        val prefs = getEncryptedPrefs(context)
        if (prefs.getBoolean("kyt_test_mode", false)) {
            return TEST_USER_ID
        }
        return prefs.getString(KEY_USER_ID, null)
    }

    fun isTestMode(context: Context): Boolean {
        return getEncryptedPrefs(context).getBoolean("kyt_test_mode", false)
    }

    fun setTestMode(context: Context, enabled: Boolean) {
        getEncryptedPrefs(context).edit().putBoolean("kyt_test_mode", enabled).apply()
    }

    fun isAuthenticated(context: Context): Boolean {
        return getEncryptedPrefs(context).getString(KEY_ACCESS_TOKEN, null) != null
    }

    fun signOut(context: Context) {
        getEncryptedPrefs(context).edit().clear().apply()
    }

    /**
     * Debug login — paste a JWT + refresh token directly.
     * For sideload testing only. Skips magic link flow entirely.
     */
    fun debugLogin(context: Context, accessToken: String, refreshToken: String): Boolean {
        val userId = decodeJwtSubject(accessToken) ?: return false

        val prefs = getEncryptedPrefs(context)
        prefs.edit()
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .putString(KEY_USER_ID, userId)
            .putLong(KEY_EXPIRES_AT, System.currentTimeMillis() + (3600 * 1000))
            .apply()

        return true
    }

    private suspend fun refreshAccessToken(
        context: Context,
        refreshToken: String
    ): String? = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().apply {
                put("refresh_token", refreshToken)
            }

            val request = Request.Builder()
                .url("${BuildConfig.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token")
                .post(body.toString().toRequestBody(JSON_MEDIA))
                .addHeader("Content-Type", "application/json")
                .addHeader("apikey", BuildConfig.SUPABASE_ANON_KEY)
                .build()

            val response = httpClient.newCall(request).execute()
            if (!response.isSuccessful) return@withContext null

            val responseBody = JSONObject(response.body?.string() ?: return@withContext null)
            val newAccessToken = responseBody.getString("access_token")
            val newRefreshToken = responseBody.getString("refresh_token")
            val expiresIn = responseBody.optLong("expires_in", 3600)

            val prefs = getEncryptedPrefs(context)
            prefs.edit()
                .putString(KEY_ACCESS_TOKEN, newAccessToken)
                .putString(KEY_REFRESH_TOKEN, newRefreshToken)
                .putLong(KEY_EXPIRES_AT, System.currentTimeMillis() + (expiresIn * 1000))
                .apply()

            newAccessToken
        } catch (_: Exception) {
            null
        }
    }

    private fun decodeJwtSubject(token: String): String? {
        return try {
            val parts = token.split(".")
            if (parts.size != 3) return null
            val payload = String(android.util.Base64.decode(parts[1], android.util.Base64.URL_SAFE))
            JSONObject(payload).getString("sub")
        } catch (_: Exception) {
            null
        }
    }
}
