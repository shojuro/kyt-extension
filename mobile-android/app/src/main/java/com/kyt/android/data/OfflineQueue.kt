package com.kyt.android.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Offline Queue — SQLite-backed queue for failed save_chat_turn_batch calls.
 * Drains on connectivity restoration.
 */
class OfflineQueue(context: Context) :
    SQLiteOpenHelper(context, "kyt_offline_queue.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("""
            CREATE TABLE queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                function_name TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                retry_count INTEGER DEFAULT 0
            )
        """)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS queue")
        onCreate(db)
    }

    fun enqueue(functionName: String, body: JSONObject) {
        val values = ContentValues().apply {
            put("function_name", functionName)
            put("body", body.toString())
            put("created_at", System.currentTimeMillis())
        }
        writableDatabase.insert("queue", null, values)
    }

    data class QueueItem(
        val id: Long,
        val functionName: String,
        val body: JSONObject,
        val retryCount: Int
    )

    fun peek(limit: Int = 10): List<QueueItem> {
        val items = mutableListOf<QueueItem>()
        val cursor = readableDatabase.query(
            "queue", null, null, null, null, null,
            "created_at ASC", limit.toString()
        )
        cursor.use {
            while (it.moveToNext()) {
                items.add(
                    QueueItem(
                        id = it.getLong(it.getColumnIndexOrThrow("id")),
                        functionName = it.getString(it.getColumnIndexOrThrow("function_name")),
                        body = JSONObject(it.getString(it.getColumnIndexOrThrow("body"))),
                        retryCount = it.getInt(it.getColumnIndexOrThrow("retry_count"))
                    )
                )
            }
        }
        return items
    }

    fun remove(id: Long) {
        writableDatabase.delete("queue", "id = ?", arrayOf(id.toString()))
    }

    fun incrementRetry(id: Long) {
        writableDatabase.execSQL("UPDATE queue SET retry_count = retry_count + 1 WHERE id = ?", arrayOf(id))
    }

    fun count(): Int {
        val cursor = readableDatabase.rawQuery("SELECT COUNT(*) FROM queue", null)
        cursor.use {
            if (it.moveToFirst()) return it.getInt(0)
        }
        return 0
    }

    /**
     * Drain queued items by calling edge functions.
     * Called when connectivity is restored.
     */
    suspend fun drain(): Int = withContext(Dispatchers.IO) {
        var drained = 0
        val items = peek(20)
        for (item in items) {
            if (item.retryCount > 5) {
                remove(item.id) // Give up after 5 retries
                continue
            }
            val result = SupabaseClient.callEdgeFunction(item.functionName, item.body)
            if (result.isSuccess) {
                remove(item.id)
                drained++
            } else {
                incrementRetry(item.id)
            }
        }
        drained
    }
}
