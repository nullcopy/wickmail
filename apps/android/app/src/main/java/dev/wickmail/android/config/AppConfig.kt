package dev.wickmail.android.config

/**
 * Build-time configuration for the shell.
 *
 * The values come from Gradle properties and contain no secrets. The
 * management origin and any approved identity origins must be absolute HTTPS
 * URLs; a build without a valid management origin reports a configuration error
 * instead of loading an arbitrary origin.
 */
data class AppConfig(
    /** The HTTPS origin of the Wickmail management app. */
    val managementOrigin: String,
    /** Additional HTTPS origins whose pages may load inside the privileged WebView. */
    val identityOrigins: List<String>,
    /** Hostnames that may deliver alias app links. */
    val appLinkHosts: List<String>,
) {
    companion object {
        /** Parse the raw build configuration, or return null when it is unusable. */
        fun parse(
            managementOrigin: String,
            identityOrigins: String,
            appLinkHosts: String,
        ): AppConfig? {
            val management = WebOrigin.parse(managementOrigin)
            if (management == null || management.scheme != "https") {
                return null
            }
            val identities = splitList(identityOrigins).map { WebOrigin.parse(it) }
            if (identities.any { it == null || it.scheme != "https" }) {
                return null
            }
            return AppConfig(
                managementOrigin = management.toOriginString(),
                identityOrigins = identities.map { it!!.toOriginString() },
                appLinkHosts = splitList(appLinkHosts),
            )
        }

        /** Split a comma-separated configuration value into trimmed, non-empty entries. */
        fun splitList(value: String): List<String> =
            value.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    }
}
