package dev.wickmail.android

import android.app.Application
import android.webkit.WebView
import dev.wickmail.android.config.AppConfig

/** Holds the parsed build configuration for the shell. */
class WickmailApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // WebView debugging is enabled only in debug builds. Setting it here,
        // before any WebView is created, applies it to the whole process.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }

    /** The parsed configuration, or null when the build has no usable management origin. */
    val config: AppConfig? by lazy {
        AppConfig.parse(
            managementOrigin = BuildConfig.MANAGEMENT_ORIGIN,
            identityOrigins = BuildConfig.IDENTITY_ORIGINS,
            appLinkHosts = BuildConfig.APP_LINK_HOSTS,
        )
    }
}
