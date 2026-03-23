package com.kyt.android.auth

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.kyt.android.BuildConfig
import com.kyt.android.data.AuthManager
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(onLoginSuccess: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf(TextFieldValue("")) }
    var status by remember { mutableStateOf("") }
    var isSending by remember { mutableStateOf(false) }
    var showDebug by remember { mutableStateOf(false) }
    var debugToken by remember { mutableStateOf(TextFieldValue("")) }
    var debugRefresh by remember { mutableStateOf(TextFieldValue("")) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = "K.Y.T.",
            style = MaterialTheme.typography.headlineLarge
        )
        Text(
            text = "Keep Your Thoughts",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 48.dp)
        )

        if (!showDebug) {
            // ── Magic Link Login ─────────────────────────────
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("Email") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(modifier = Modifier.height(16.dp))

            Button(
                onClick = {
                    isSending = true
                    scope.launch {
                        val result = AuthManager.signInWithMagicLink(context, email.text)
                        isSending = false
                        status = if (result.isSuccess) {
                            "Check your email for the login link!"
                        } else {
                            "Failed: ${result.exceptionOrNull()?.message}"
                        }
                    }
                },
                enabled = !isSending && email.text.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) {
                if (isSending) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp
                    )
                } else {
                    Text("Sign in with Magic Link")
                }
            }

            // Debug toggle (only in debug builds)
            if (BuildConfig.DEBUG) {
                TextButton(
                    onClick = { showDebug = true },
                    modifier = Modifier.padding(top = 24.dp)
                ) {
                    Text("Debug: Paste JWT", style = MaterialTheme.typography.labelSmall)
                }
            }
        } else {
            // ── Debug Token Login ────────────────────────────
            Text(
                text = "Paste tokens from browser devtools",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 8.dp)
            )

            OutlinedTextField(
                value = debugToken,
                onValueChange = { debugToken = it },
                label = { Text("Access Token (JWT)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(modifier = Modifier.height(8.dp))

            OutlinedTextField(
                value = debugRefresh,
                onValueChange = { debugRefresh = it },
                label = { Text("Refresh Token") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(modifier = Modifier.height(16.dp))

            Button(
                onClick = {
                    val ok = AuthManager.debugLogin(
                        context,
                        debugToken.text.trim(),
                        debugRefresh.text.trim()
                    )
                    if (ok) {
                        onLoginSuccess()
                    } else {
                        status = "Invalid JWT — could not decode user ID"
                    }
                },
                enabled = debugToken.text.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Debug Login")
            }

            TextButton(
                onClick = { showDebug = false },
                modifier = Modifier.padding(top = 8.dp)
            ) {
                Text("Back to Magic Link")
            }
        }

        if (status.isNotEmpty()) {
            Text(
                text = status,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 16.dp)
            )
        }
    }
}
