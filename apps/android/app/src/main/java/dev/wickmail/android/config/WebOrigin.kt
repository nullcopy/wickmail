package dev.wickmail.android.config

import java.net.URI
import java.net.URISyntaxException

/**
 * A normalized web origin: scheme, lower-cased host, and effective port.
 *
 * The navigation and deep-link policies compare a URL's origin against the
 * configured management and identity origins. This type holds no Android or
 * WebView dependency so the policies can be unit tested on the JVM.
 */
data class WebOrigin(val scheme: String, val host: String, val port: Int) {
    /** Whether two origins share scheme, host, and effective port. */
    fun matches(other: WebOrigin): Boolean =
        scheme == other.scheme && host == other.host && port == other.port

    /** The canonical `scheme://host[:port]` form, with the default port omitted. */
    fun toOriginString(): String =
        if (port == defaultPort(scheme)) "$scheme://$host" else "$scheme://$host:$port"

    companion object {
        /** The default port for a scheme, or -1 when the scheme has no default. */
        fun defaultPort(scheme: String): Int =
            when (scheme.lowercase()) {
                "https" -> 443
                "http" -> 80
                else -> -1
            }

        /** Parse an absolute origin, or return null when it is not a valid absolute URL. */
        fun parse(value: String): WebOrigin? {
            val uri =
                try {
                    URI(value.trim())
                } catch (e: URISyntaxException) {
                    return null
                }
            return fromUri(uri)
        }

        /** Derive the origin of a parsed URI, or return null when it has no host. */
        fun fromUri(uri: URI): WebOrigin? {
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            val port = if (uri.port != -1) uri.port else defaultPort(scheme)
            return WebOrigin(scheme, host, port)
        }
    }
}
