package com.kyt.android.auth

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.kyt.android.data.AuthManager
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(onLoginSuccess: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf(TextFieldValue("")) }
    var status by remember { mutableStateOf("") }
    var isSending by remember { mutableStateOf(false) }

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
            text = "Know Your Things",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 48.dp)
        )

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

        if (status.isNotEmpty()) {
            Text(
                text = status,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 16.dp)
            )
        }
    }
}
