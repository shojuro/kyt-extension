package com.kyt.android.voice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kyt.android.auth.LoginScreen
import com.kyt.android.data.AuthManager

/**
 * Main Activity — Voice conversation UI.
 *
 * Handles:
 * - Auth deep link callback (kyt://auth-callback)
 * - Audio permission request
 * - Voice session lifecycle
 */
class VoiceActivity : ComponentActivity() {

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        // Permission result handled by recomposition
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Handle deep link from magic link email
        handleIntent(intent)

        setContent {
            MaterialTheme {
                val isAuthenticated = remember { mutableStateOf(AuthManager.isAuthenticated(this)) }

                if (!isAuthenticated.value) {
                    LoginScreen(
                        onLoginSuccess = { isAuthenticated.value = true }
                    )
                } else {
                    VoiceScreen()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "kyt" && uri.host == "auth-callback") {
            AuthManager.handleDeepLink(this, uri)
        }
    }

    fun requestAudioPermission() {
        requestPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    fun hasAudioPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
}

@Composable
fun VoiceScreen(viewModel: VoiceViewModel = viewModel()) {
    val uiState by viewModel.uiState.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // Header
        Text(
            text = "K.Y.T.",
            style = MaterialTheme.typography.headlineLarge,
            modifier = Modifier.padding(top = 32.dp)
        )
        Text(
            text = "Know Your Things",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        Spacer(modifier = Modifier.weight(1f))

        // Conversation history
        if (uiState.conversationHistory.isNotEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(3f)
                    .padding(vertical = 8.dp)
            ) {
                for (turn in uiState.conversationHistory.takeLast(10)) {
                    val label = if (turn.isUser) "You" else "K.Y.T."
                    Text(
                        text = "$label: ${turn.text}",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(vertical = 4.dp)
                    )
                }
            }
        }

        // Live transcription
        if (uiState.liveTranscript.isNotEmpty()) {
            Text(
                text = uiState.liveTranscript,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(16.dp)
            )
        }

        // Status indicator
        Text(
            text = when (uiState.sessionState) {
                SessionState.IDLE -> "Tap to start talking"
                SessionState.CONNECTING -> "Connecting..."
                SessionState.LISTENING -> "Listening..."
                SessionState.THINKING -> "Thinking..."
                SessionState.SPEAKING -> "Speaking..."
                SessionState.ERROR -> uiState.errorMessage ?: "Error"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(8.dp)
        )

        // Mic button
        Button(
            onClick = {
                when (uiState.sessionState) {
                    SessionState.IDLE, SessionState.ERROR -> viewModel.startSession()
                    else -> viewModel.stopSession()
                }
            },
            modifier = Modifier
                .size(80.dp)
                .padding(bottom = 32.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (uiState.sessionState == SessionState.LISTENING)
                    MaterialTheme.colorScheme.error
                else
                    MaterialTheme.colorScheme.primary
            )
        ) {
            Text(
                text = if (uiState.sessionState == SessionState.IDLE || uiState.sessionState == SessionState.ERROR) "MIC" else "STOP"
            )
        }

        // Memory mode badge
        Text(
            text = "Mode: ${uiState.memoryMode}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 16.dp)
        )
    }
}
