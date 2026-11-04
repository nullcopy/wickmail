package dev.wickmail.android.web

import dev.wickmail.android.config.WebOrigin
import java.net.URI

/** Where a navigation request should be sent. */
enum class NavigationTarget {
    /** Load inside the privileged management WebView. */
    INTERNAL,

    /** Hand to the user's browser or another external app. */
    EXTERNAL,

    /** Refuse the navigation entirely. */
    BLOCKED,
}

/**
 * Decides whether a URL loads in the management WebView, opens in another app,
 * or is refused.
 *
 * Only the management origin and explicitly approved identity origins load
 * internally, and only over HTTPS. Other `http` and `https` URLs and the safe
 * external schemes open in the user's browser or another app. Everything else,
 * including `javascript:`, `data:`, `file:`, and `content:`, is refused.
 *
 * The shell does not evaluate leases or choose reply identities; this policy is
 * purely about which origin a navigation belongs to.
 */
class NavigationPolicy(
    managementOrigin: String,
    approvedIdentityOrigins: List<String> = emptyList(),
) {
    private val managementUri: URI = requireHttpsOrigin(managementOrigin, "management origin")
    private val management: WebOrigin =
        WebOrigin.fromUri(managementUri) ?: error("invalid management origin: $managementOrigin")
    private val identities: List<WebOrigin> =
        approvedIdentityOrigins
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { requireHttpsOrigin(it, "identity origin") }
            .map { WebOrigin.fromUri(it) ?: error("invalid identity origin: $it") }

    /** Whether the URL belongs to the management origin. */
    fun isManagement(url: String): Boolean {
        val origin = originOf(resolve(url)) ?: return false
        return origin.scheme == "https" && origin.matches(management)
    }

    /** Classify a navigation request. */
    fun classify(url: String): NavigationTarget {
        val resolved = resolve(url) ?: return NavigationTarget.BLOCKED
        val scheme = resolved.scheme?.lowercase()
        if (scheme == "http" || scheme == "https") {
            val origin = WebOrigin.fromUri(resolved) ?: return NavigationTarget.BLOCKED
            val internal =
                scheme == "https" &&
                    (origin.matches(management) || identities.any { origin.matches(it) })
            return if (internal) NavigationTarget.INTERNAL else NavigationTarget.EXTERNAL
        }
        if (scheme != null && scheme in EXTERNAL_SCHEMES) {
            return NavigationTarget.EXTERNAL
        }
        return NavigationTarget.BLOCKED
    }

    private fun resolve(rawUrl: String): URI? {
        val trimmed = rawUrl.trim()
        if (trimmed.isEmpty()) {
            return null
        }
        return try {
            val uri = URI(trimmed)
            if (uri.scheme == null) managementUri.resolve(trimmed) else uri
        } catch (e: Exception) {
            null
        }
    }

    private fun originOf(uri: URI?): WebOrigin? = uri?.let { WebOrigin.fromUri(it) }

    companion object {
        /** Schemes that are safe to hand to another installed app. */
        val EXTERNAL_SCHEMES: Set<String> = setOf("http", "https", "mailto", "tel", "sms", "smsto")

        private fun requireHttpsOrigin(value: String, label: String): URI {
            val uri =
                try {
                    URI(value.trim())
                } catch (e: Exception) {
                    throw IllegalArgumentException("invalid $label: $value")
                }
            if (uri.scheme?.lowercase() != "https" || uri.host.isNullOrEmpty()) {
                throw IllegalArgumentException("$label must be an absolute HTTPS URL: $value")
            }
            return uri
        }
    }
}
