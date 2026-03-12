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
import com.kyt.android.settings.SettingsScreen

/**
 * Main Activity — Voice conversation UI.
 *
 * Handles:
 * - Auth deep link callback (kyt://auth-callback)
 * - Audio permission request
 * - Voice session lifecycle
 * - Navigation: Login → Main → Settings
 */
class VoiceActivity : ComponentActivity() {

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        // Permission result handled by recomposition
    }

    // Observable state for Compose recomposition
    private val _isAuthenticated = mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        _isAuthenticated.value = AuthManager.isAuthenticated(this)

        // Handle deep link from magic link email
        handleIntent(intent)

        setContent {
            MaterialTheme {
                var showSettings by remember { mutableStateOf(false) }

                when {
                    !_isAuthenticated.value -> {
                        LoginScreen(
                            onLoginSuccess = { _isAuthenticated.value = true }
                        )
                    }
                    showSettings -> {
                        SettingsScreen(
                            onLogout = {
                                _isAuthenticated.value = false
                                showSettings = false
                            },
                            onBack = { showSettings = false }
                        )
                    }
                    else -> {
                        VoiceScreen(onSettingsClick = { showSettings = true })
                    }
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
            if (AuthManager.handleDeepLink(this, uri)) {
                _isAuthenticated.value = true
            }
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceScreen(
    viewModel: VoiceViewModel = viewModel(),
    onSettingsClick: () -> Unit = {}
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("K.Y.T.") },
                actions = {
                    TextButton(onClick = onSettingsClick) {
                        Text("Settings")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
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
}
