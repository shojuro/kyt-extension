package com.kyt.android.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.kyt.android.data.AuthManager
import com.kyt.android.memory.MemoryModeManager
import com.kyt.android.memory.MemoryModeManager.Mode

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onLogout: () -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    var currentMode by remember { mutableStateOf(MemoryModeManager.getMode(context)) }
    var showLogoutConfirm by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    TextButton(onClick = onBack) { Text("Back") }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp)
        ) {
            // Memory Mode Section
            Text(
                text = "Memory Mode",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = 16.dp, bottom = 8.dp)
            )

            Mode.entries.forEach { mode ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp)
                ) {
                    RadioButton(
                        selected = currentMode == mode,
                        onClick = {
                            currentMode = mode
                            MemoryModeManager.setMode(context, mode)
                        }
                    )
                    Column(modifier = Modifier.padding(start = 8.dp)) {
                        Text(
                            text = when (mode) {
                                Mode.FULL -> "Full Memory"
                                Mode.CLEAN_ROOM -> "Clean Room"
                                Mode.INCOGNITO -> "Incognito"
                            },
                            style = MaterialTheme.typography.bodyLarge
                        )
                        Text(
                            text = when (mode) {
                                Mode.FULL -> "Capture conversations and inject memory context"
                                Mode.CLEAN_ROOM -> "Capture only, no memory injection"
                                Mode.INCOGNITO -> "No capture, no injection"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 16.dp))

            // Account Section
            Text(
                text = "Account",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(bottom = 8.dp)
            )

            val userId = AuthManager.getUserId(context)
            if (userId != null) {
                Text(
                    text = "User ID: ${userId.take(8)}...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 16.dp)
                )
            }

            Button(
                onClick = { showLogoutConfirm = true },
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Sign Out")
            }
        }
    }

    if (showLogoutConfirm) {
        AlertDialog(
            onDismissRequest = { showLogoutConfirm = false },
            title = { Text("Sign Out") },
            text = { Text("Are you sure you want to sign out?") },
            confirmButton = {
                TextButton(onClick = {
                    AuthManager.signOut(context)
                    showLogoutConfirm = false
                    onLogout()
                }) { Text("Sign Out") }
            },
            dismissButton = {
                TextButton(onClick = { showLogoutConfirm = false }) { Text("Cancel") }
            }
        )
    }
}
