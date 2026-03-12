package com.kyt.android.voice

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kyt.android.BuildConfig
import com.kyt.android.data.AuthManager
import com.kyt.android.memory.MemoryModeManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

enum class SessionState {
    IDLE, CONNECTING, LISTENING, THINKING, SPEAKING, ERROR
}

data class ConversationTurn(val text: String, val isUser: Boolean)

data class VoiceUiState(
    val sessionState: SessionState = SessionState.IDLE,
    val liveTranscript: String = "",
    val conversationHistory: List<ConversationTurn> = emptyList(),
    val memoryMode: String = "full",
    val errorMessage: String? = null
)

/**
 * Voice ViewModel — manages WebSocket connection to K.Y.T. Voice Proxy.
 *
 * The proxy handles OpenAI Realtime API, memory injection, and turn saving.
 * This client just streams audio and displays transcriptions.
 */
class VoiceViewModel(application: Application) : AndroidViewModel(application) {

    private val _uiState = MutableStateFlow(VoiceUiState())
    val uiState: StateFlow<VoiceUiState> = _uiState.asStateFlow()

    private var webSocket: WebSocket? = null
    private val okHttpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS) // No read timeout for WebSocket
        .build()

    init {
        _uiState.value = _uiState.value.copy(
            memoryMode = MemoryModeManager.getMode(application).value
        )
    }

    fun startSession() {
        val context = getApplication<Application>()

        // Memory mode gate: incognito blocks voice entirely
        if (!MemoryModeManager.shouldCapture(context) && !MemoryModeManager.shouldInject(context)) {
            _uiState.value = _uiState.value.copy(
                sessionState = SessionState.ERROR,
                errorMessage = "Voice disabled in incognito mode"
            )
            return
        }

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(sessionState = SessionState.CONNECTING)

            val token = AuthManager.getAccessToken(context)
            if (token == null) {
                _uiState.value = _uiState.value.copy(
                    sessionState = SessionState.ERROR,
                    errorMessage = "Not authenticated"
                )
                return@launch
            }

            val proxyUrl = BuildConfig.VOICE_PROXY_URL
            if (proxyUrl.isBlank()) {
                _uiState.value = _uiState.value.copy(
                    sessionState = SessionState.ERROR,
                    errorMessage = "Voice proxy not configured"
                )
                return@launch
            }

            val request = Request.Builder()
                .url("$proxyUrl?token=$token")
                .build()

            webSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    _uiState.value = _uiState.value.copy(sessionState = SessionState.LISTENING)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleProxyMessage(text)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    _uiState.value = _uiState.value.copy(
                        sessionState = SessionState.ERROR,
                        errorMessage = "Connection failed: ${t.message}"
                    )
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    _uiState.value = _uiState.value.copy(sessionState = SessionState.IDLE)
                }
            })
        }
    }

    fun stopSession() {
        webSocket?.close(1000, "User stopped session")
        webSocket = null
        _uiState.value = _uiState.value.copy(sessionState = SessionState.IDLE)
    }

    private fun handleProxyMessage(text: String) {
        try {
            val msg = JSONObject(text)
            when (msg.optString("type")) {
                // Live transcription of user speech
                "conversation.item.input_audio_transcription.completed" -> {
                    val transcript = msg.optString("transcript", "")
                    if (transcript.isNotEmpty()) {
                        val history = _uiState.value.conversationHistory +
                            ConversationTurn(transcript, isUser = true)
                        _uiState.value = _uiState.value.copy(
                            conversationHistory = history,
                            liveTranscript = "",
                            sessionState = SessionState.THINKING
                        )
                    }
                }

                // Partial transcription update
                "conversation.item.input_audio_transcription.delta" -> {
                    val delta = msg.optString("delta", "")
                    _uiState.value = _uiState.value.copy(
                        liveTranscript = _uiState.value.liveTranscript + delta
                    )
                }

                // AI response audio transcript
                "response.audio_transcript.done" -> {
                    val transcript = msg.optString("transcript", "")
                    if (transcript.isNotEmpty()) {
                        val history = _uiState.value.conversationHistory +
                            ConversationTurn(transcript, isUser = false)
                        _uiState.value = _uiState.value.copy(
                            conversationHistory = history,
                            sessionState = SessionState.LISTENING
                        )
                    }
                }

                // AI starts generating
                "response.created" -> {
                    _uiState.value = _uiState.value.copy(sessionState = SessionState.THINKING)
                }

                // AI audio streaming
                "response.audio.delta" -> {
                    _uiState.value = _uiState.value.copy(sessionState = SessionState.SPEAKING)
                    // Audio playback handled by AudioTrack (TODO: wire PCM16 frames)
                }

                // AI finished responding
                "response.done" -> {
                    _uiState.value = _uiState.value.copy(sessionState = SessionState.LISTENING)
                }

                "error" -> {
                    val error = msg.optJSONObject("error")
                    _uiState.value = _uiState.value.copy(
                        sessionState = SessionState.ERROR,
                        errorMessage = error?.optString("message") ?: "Unknown error"
                    )
                }
            }
        } catch (e: Exception) {
            // Ignore malformed messages
        }
    }

    override fun onCleared() {
        super.onCleared()
        stopSession()
    }
}
