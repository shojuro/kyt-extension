package com.kyt.android.share

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.kyt.android.data.AuthManager
import com.kyt.android.data.SupabaseClient
import com.kyt.android.memory.MemoryModeManager
import com.kyt.android.memory.MemoryItem
import com.kyt.android.memory.buildFullInjection
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Share Sheet Activity — receives ACTION_SEND intents for text/plain.
 *
 * Bottom sheet with two actions:
 * - "Save to K.Y.T." → save_chat_turn_batch
 * - "Search K.Y.T." → search_memories → show results
 *
 * Memory mode gates:
 * - incognito: blocks both
 * - clean_room: blocks search, allows save
 * - full: allows both
 */
class ShareActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val sharedText = intent?.getStringExtra(Intent.EXTRA_TEXT) ?: ""

        setContent {
            MaterialTheme {
                ShareSheet(
                    sharedText = sharedText,
                    onDismiss = { finish() }
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareSheet(sharedText: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val mode = MemoryModeManager.getMode(context)
    var status by remember { mutableStateOf("") }
    var searchResults by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }

    // Gate check
    if (mode == MemoryModeManager.Mode.INCOGNITO) {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text("K.Y.T. is in incognito mode")
            Text("Save and search are disabled", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = onDismiss, modifier = Modifier.padding(top = 16.dp)) {
                Text("Close")
            }
        }
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
    ) {
        // Header
        Text(
            text = "K.Y.T. Share",
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.padding(bottom = 16.dp)
        )

        // Shared text preview
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 16.dp)
        ) {
            Text(
                text = sharedText.take(200) + if (sharedText.length > 200) "..." else "",
                modifier = Modifier.padding(12.dp),
                style = MaterialTheme.typography.bodyMedium
            )
        }

        // Action buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // Save button
            Button(
                onClick = {
                    isLoading = true
                    scope.launch {
                        val userId = AuthManager.getUserId(context)
                        if (userId == null) {
                            status = "Not authenticated"
                            isLoading = false
                            return@launch
                        }

                        val body = JSONObject().apply {
                            put("user_id", userId)
                            put("turns", JSONArray().apply {
                                put(JSONObject().apply {
                                    put("content", sharedText)
                                    put("speakers", JSONArray().apply { put("user") })
                                    put("conversation_id", "share-${System.currentTimeMillis()}")
                                    put("platform", "mobile")
                                    put("content_type", "note")
                                })
                            })
                        }

                        val result = SupabaseClient.callEdgeFunction("save_chat_turn_batch", body)
                        isLoading = false
                        status = if (result.isSuccess) "Saved to K.Y.T.!" else "Save failed: ${result.exceptionOrNull()?.message}"
                    }
                },
                enabled = !isLoading,
                modifier = Modifier.weight(1f)
            ) {
                Text("Save to K.Y.T.")
            }

            // Search button (blocked in clean_room)
            Button(
                onClick = {
                    if (mode == MemoryModeManager.Mode.CLEAN_ROOM) {
                        status = "Search disabled in clean room mode"
                        return@Button
                    }
                    isLoading = true
                    scope.launch {
                        val userId = AuthManager.getUserId(context)
                        if (userId == null) {
                            status = "Not authenticated"
                            isLoading = false
                            return@launch
                        }

                        val body = JSONObject().apply {
                            put("query", sharedText.take(200))
                            put("user_id", userId)
                            put("top_k", 5)
                            put("use_hyde", false)
                            put("platform", "all")
                        }

                        val result = SupabaseClient.callEdgeFunction("search_memories", body)
                        isLoading = false

                        if (result.isSuccess) {
                            val json = result.getOrThrow()
                            val results = json.optJSONArray("results") ?: JSONArray()
                            val items = (0 until results.length()).map { i ->
                                val r = results.getJSONObject(i)
                                MemoryItem(
                                    id = r.optString("id"),
                                    content = r.optString("content"),
                                    platform = r.optString("platform", "unknown"),
                                    timestamp = r.optString("created_at", ""),
                                    similarity = r.optDouble("similarity", 0.0),
                                    role = r.optString("role", null)
                                )
                            }
                            searchResults = buildFullInjection(items, sharedText.take(200))
                            status = "${items.size} results found"
                        } else {
                            status = "Search failed: ${result.exceptionOrNull()?.message}"
                        }
                    }
                },
                enabled = !isLoading && mode != MemoryModeManager.Mode.CLEAN_ROOM,
                modifier = Modifier.weight(1f)
            ) {
                Text("Search K.Y.T.")
            }
        }

        // Loading indicator
        if (isLoading) {
            LinearProgressIndicator(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp)
            )
        }

        // Status message
        if (status.isNotEmpty()) {
            Text(
                text = status,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(vertical = 8.dp)
            )
        }

        // Search results
        if (searchResults.isNotEmpty()) {
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
            ) {
                Text(
                    text = searchResults,
                    modifier = Modifier
                        .padding(12.dp)
                        .verticalScroll(rememberScrollState()),
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }

        // Close button
        TextButton(
            onClick = onDismiss,
            modifier = Modifier
                .align(Alignment.CenterHorizontally)
                .padding(top = 8.dp)
        ) {
            Text("Close")
        }
    }
}
