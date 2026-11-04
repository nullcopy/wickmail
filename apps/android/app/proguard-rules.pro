# The shell has no JavaScript bridge methods annotated for reflection; keep the
# rules minimal and let the optimizer shrink the rest of the app.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
