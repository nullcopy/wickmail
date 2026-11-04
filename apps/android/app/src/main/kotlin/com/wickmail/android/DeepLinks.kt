package com.wickmail.android

/**
 * Validates app-link destinations.
 *
 * A deep link is accepted only when it points at the configured management
 * origin and resolves to an alias detail path. The canonical URL is rebuilt
 * from the validated parts so a malformed or hostile intent can never steer
 * the WebView at an arbitrary address.
 */
internal object DeepLinks {
    private val ALIAS_PATH = Regex("^/aliases/([^/]+)/?$")

    /** A validated alias detail link. */
    data class AliasLink(val aliasId: String, val url: String)

    /** Returns the alias link for `rawUrl`, or null when it is not one. */
    fun aliasLink(rawUrl: String, managementOrigin: String): AliasLink? {
        val management = Origin.parse(managementOrigin) ?: return null
        val uri = Origin.parseUri(rawUrl) ?: return null
        val origin = Origin.parse(rawUrl) ?: return null
        if (origin != management || origin.scheme != "https") return null
        val path = uri.rawPath ?: return null
        val match = ALIAS_PATH.matchEntire(path) ?: return null
        val aliasId = match.groupValues[1]
        if (aliasId.isEmpty()) return null
        val canonical = managementOrigin.trimEnd('/') + "/aliases/" + aliasId
        return AliasLink(aliasId, canonical)
    }
}
