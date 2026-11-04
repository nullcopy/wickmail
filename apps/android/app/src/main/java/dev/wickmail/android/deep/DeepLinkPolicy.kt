package dev.wickmail.android.deep

import dev.wickmail.android.config.WebOrigin
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Validates incoming app links and turns an alias link into a management-app
 * URL.
 *
 * App links never carry an arbitrary WebView destination: only the alias detail
 * route is accepted, and only for an approved host over HTTPS. The accepted
 * forms are `https://<host>/aliases/<id>` and `https://<host>/#/aliases/<id>`.
 */
class DeepLinkPolicy(
    managementOrigin: String,
    approvedAppLinkHosts: List<String>,
) {
    private val managementBase = managementOrigin.trim().trimEnd('/')
    private val hosts =
        approvedAppLinkHosts
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
            .toSet()

    init {
        val parsed = WebOrigin.parse(managementOrigin)
        require(parsed != null && parsed.scheme == "https") {
            "management origin must be an absolute HTTPS URL: $managementOrigin"
        }
    }

    /**
     * The management URL for an alias app link, or null when the link is not an
     * accepted alias link for an approved host.
     */
    fun aliasUrl(rawUrl: String): String? {
        if (hosts.isEmpty()) {
            return null
        }
        val uri =
            try {
                URI(rawUrl.trim())
            } catch (e: Exception) {
                return null
            }
        if (uri.scheme?.lowercase() != "https") {
            return null
        }
        val host = uri.host?.lowercase() ?: return null
        if (host !in hosts) {
            return null
        }
        val id = aliasId(uri) ?: return null
        val encoded = URLEncoder.encode(id, StandardCharsets.UTF_8).replace("+", "%20")
        return "$managementBase/#/aliases/$encoded"
    }

    private fun aliasId(uri: URI): String? {
        val segments = (uri.path ?: "").split('/').filter { it.isNotEmpty() }
        if (segments.size == 2 && segments[0] == "aliases") {
            return decode(segments[1])
        }
        val fragment = uri.fragment ?: return null
        val hashSegments = fragment.split('/').filter { it.isNotEmpty() }
        if (hashSegments.size == 2 && hashSegments[0] == "aliases") {
            return decode(hashSegments[1])
        }
        return null
    }

    private fun decode(value: String): String =
        try {
            URLDecoder.decode(value, StandardCharsets.UTF_8)
        } catch (e: Exception) {
            value
        }
}
