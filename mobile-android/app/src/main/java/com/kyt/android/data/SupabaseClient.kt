package com.kyt.android.data

import android.content.Context
import com.kyt.android.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Supabase client singleton — mirrors mcp/src/lib/supabase-client.js:callEdgeFunction() contract.
 *
 * callEdgeFunction(name, body): Result<JSONObject>
 * JWT in Authorization: Bearer header, auto-refresh via AuthManager.
 */
object SupabaseClient {
    private lateinit var appContext: Context

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS) // 15s for LLM calls
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

    private val supabaseUrl: String
        get() = BuildConfig.SUPABASE_URL

    private val supabaseAnonKey: String
        get() = BuildConfig.SUPABASE_ANON_KEY

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * Call a Supabase edge function.
     * Mirrors the mcp/src/lib/supabase-client.js contract.
     */
    suspend fun callEdgeFunction(
        functionName: String,
        body: JSONObject
    ): Result<JSONObject> = withContext(Dispatchers.IO) {
        try {
            AuthManager.validateConfig()?.let {
                return@withContext Result.failure(IOException(it))
            }

            val token = AuthManager.getAccessToken(appContext) ?: supabaseAnonKey

            val request = Request.Builder()
                .url("$supabaseUrl/functions/v1/$functionName")
                .post(body.toString().toRequestBody(JSON_MEDIA))
                .addHeader("Content-Type", "application/json")
                .addHeader("Authorization", "Bearer $token")
                .addHeader("apikey", supabaseAnonKey)
                .build()

            val response = httpClient.newCall(request).execute()

            if (!response.isSuccessful) {
                val errBody = response.body?.string() ?: ""
                val errMsg = try {
                    JSONObject(errBody).optString("error", "HTTP ${response.code}")
                } catch (_: Exception) {
                    "Edge function $functionName returned ${response.code}"
                }
                return@withContext Result.failure(IOException(errMsg))
            }

            val responseBody = response.body?.string() ?: "{}"
            Result.success(JSONObject(responseBody))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
