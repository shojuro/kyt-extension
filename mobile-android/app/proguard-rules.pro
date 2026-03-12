# K.Y.T. Android ProGuard rules

# Keep Supabase SDK
-keep class io.github.jan.supabase.** { *; }
-keep class io.ktor.** { *; }

# Keep OkHttp
-keep class okhttp3.** { *; }
-dontwarn okhttp3.**

# Keep Compose
-keep class androidx.compose.** { *; }
