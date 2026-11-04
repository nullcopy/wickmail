package com.wickmail.android

/**
 * Build-time configuration for the shell.
 *
 * The management origin and the approved identity origins come from Gradle
 * properties so each deployment can point the app at its own server.
 */
internal data class AppConfig(
    val managementOrigin: String,
    val identityOrigins: List<String>,
) {
    companion object {
        fun fromBuildConfig(): AppConfig =
            AppConfig(
                managementOrigin = BuildConfig.MANAGEMENT_ORIGIN,
                identityOrigins =
                    BuildConfig.IDENTITY_ORIGINS
                        .split(',')
                        .map(String::trim)
                        .filter(String::isNotEmpty),
            )
    }
}
