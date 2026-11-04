package com.wickmail.android

import java.net.URI

/**
 * A web origin: scheme, host, and effective port.
 *
 * Parsing and comparison are pure Kotlin so the navigation policy can be
 * unit-tested on the JVM without an Android runtime.
 */
internal data class Origin(
    val scheme: String,
    val host: String,
    val port: Int,
) {
    companion object {
        /** Parses a URL into an origin, or returns null when it has no usable origin. */
        fun parse(raw: String): Origin? {
            val uri = parseUri(raw) ?: return null
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            if (host.isEmpty()) return null
            val port =
                when {
                    uri.port != -1 -> uri.port
                    scheme == "https" -> 443
                    scheme == "http" -> 80
                    else -> return null
                }
            return Origin(scheme, host, port)
        }

        /** Parses a URL, returning null instead of throwing on malformed input. */
        fun parseUri(raw: String): URI? =
            try {
                URI(raw.trim())
            } catch (_: Exception) {
                null
            }
    }

    /** The rule string accepted by the WebView message bridge origin allowlist. */
    fun rule(): String =
        if ((scheme == "https" && port == 443) || (scheme == "http" && port == 80)) {
            "$scheme://$host"
        } else {
            "$scheme://$host:$port"
        }
}

/**
 * Decides which URLs may load inside the privileged management WebView.
 *
 * Only the configured management origin and an explicit list of approved
 * identity origins are loaded internally; everything else is external. The
 * policy never accepts an origin supplied by page content or an intent.
 */
internal class OriginPolicy(
    managementOrigin: String,
    identityOrigins: List<String>,
) {
    private val management: Origin =
        Origin.parse(managementOrigin)
            ?: throw IllegalArgumentException("invalid management origin: $managementOrigin")

    private val identities: Set<Origin> = identityOrigins.mapNotNull(Origin::parse).toSet()

    /** True when `url` targets the configured management origin over HTTPS. */
    fun isManagement(url: String): Boolean = Origin.parse(url) == management

    /**
     * True when `url` may load inside the WebView.
     *
     * The management origin and approved identity origins qualify, and only
     * over HTTPS.
     */
    fun shouldOpenInternally(url: String): Boolean {
        val origin = Origin.parse(url) ?: return false
        if (origin.scheme != "https") return false
        return origin == management || origin in identities
    }

    /** True when `url` is an http(s) address that must open in the user's browser. */
    fun shouldOpenExternally(url: String): Boolean {
        val uri = Origin.parseUri(url) ?: return false
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme != "https" && scheme != "http") return false
        return !shouldOpenInternally(url)
    }

    /** The origin allowlist for the WebView message bridge. */
    fun bridgeAllowedOrigins(): Set<String> = setOf(management.rule())
}
