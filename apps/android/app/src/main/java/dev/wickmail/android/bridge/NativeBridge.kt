package dev.wickmail.android.bridge

import org.json.JSONException
import org.json.JSONObject

/** A native operation requested by the management page over the bridge. */
sealed interface NativeRequest {
    /** Copy the given text to the system clipboard. */
    data class Copy(val text: String) : NativeRequest

    /** Share the given text through the system share sheet. */
    data class Share(val text: String) : NativeRequest

    /** Enable or disable the optional app lock, optionally setting its timeout. */
    data class SetAppLock(val enabled: Boolean, val timeoutMs: Long?) : NativeRequest

    /** A message the shell does not understand or accept. */
    data object Invalid : NativeRequest
}

/**
 * Parses messages from the management page.
 *
 * The bridge exposes only the explicit operations the shell supports. It never
 * carries session cookies, API tokens, or general network primitives, and it is
 * bound to the exact management origin by the WebView host.
 */
object NativeBridge {
    /** The longest text the bridge will copy or share. */
    const val MAX_TEXT_LENGTH = 4096

    /** Parse a bridge message, returning [NativeRequest.Invalid] for anything else. */
    fun parse(message: String?): NativeRequest {
        if (message.isNullOrBlank()) {
            return NativeRequest.Invalid
        }
        val json =
            try {
                JSONObject(message)
            } catch (e: JSONException) {
                return NativeRequest.Invalid
            }
        return when (json.optString("type")) {
            "copy" -> text(json)?.let { NativeRequest.Copy(it) } ?: NativeRequest.Invalid
            "share" -> text(json)?.let { NativeRequest.Share(it) } ?: NativeRequest.Invalid
            "setAppLock" ->
                if (!json.has("enabled")) {
                    NativeRequest.Invalid
                } else {
                    val timeout = if (json.has("timeoutMs")) json.optLong("timeoutMs") else null
                    NativeRequest.SetAppLock(json.optBoolean("enabled"), timeout)
                }
            else -> NativeRequest.Invalid
        }
    }

    private fun text(json: JSONObject): String? {
        val value = json.optString("text")
        if (value.isEmpty() || value.length > MAX_TEXT_LENGTH) {
            return null
        }
        return value
    }
}
