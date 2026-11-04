package com.wickmail.android

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import org.json.JSONObject

/**
 * The single activity of the Wickmail Android shell.
 *
 * It hosts the web management app in a locked-down WebView and adds only
 * native conveniences: back navigation, external-link handling, a connectivity
 * retry, copy and share, app links, and an optional biometric lock. It holds no
 * alias, lease, or identity logic.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var errorView: View
    private lateinit var errorMessage: TextView
    private lateinit var lockView: View
    private lateinit var progress: ProgressBar

    private val config: AppConfig by lazy { AppConfig.fromBuildConfig() }
    private val policy: OriginPolicy by lazy {
        OriginPolicy(config.managementOrigin, config.identityOrigins)
    }

    private lateinit var connectivity: ConnectivityMonitor
    private lateinit var appLock: AppLockController
    private lateinit var nativeBridge: NativeBridge

    private var pendingShare: String? = null
    private var lastUrl: String? = null
    private var lockHandled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web_view)
        errorView = findViewById(R.id.error_view)
        errorMessage = findViewById(R.id.error_message)
        lockView = findViewById(R.id.lock_view)
        progress = findViewById(R.id.progress)

        appLock =
            AppLockController(
                this,
                onLocked = { lockView.isVisible = true },
                onUnlocked = { lockView.isVisible = false },
            )
        nativeBridge = NativeBridge(this, policy, appLock)

        configureErrorView()
        configureWebView()
        configureBackNavigation()

        connectivity = ConnectivityMonitor(this) { online ->
            if (online && errorView.isVisible) retry()
        }

        restoreOrLoad(intent, savedInstanceState)
    }

    override fun onStart() {
        super.onStart()
        connectivity.start()
    }

    override fun onStop() {
        connectivity.stop()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        if (!lockHandled) {
            lockHandled = true
            window.decorView.post { appLock.lockIfConfigured() }
        } else {
            appLock.onForeground()
        }
    }

    override fun onPause() {
        appLock.onBackground()
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        loadFromIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        connectivity.stop()
        nativeBridge.destroy(webView)
        webView.destroy()
        super.onDestroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        // WebView debugging is a development-only affordance.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString WickmailAndroid/${BuildConfig.VERSION_NAME}"
        }

        webView.webViewClient =
            object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val url = request.url.toString()
                    return if (request.isForMainFrame) {
                        handleNavigation(url)
                    } else {
                        // Block third-party subframes; the app is same-origin only.
                        !policy.shouldOpenInternally(url)
                    }
                }

                override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                    progress.isVisible = true
                }

                override fun onPageFinished(view: WebView, url: String) {
                    progress.isVisible = false
                    deliverPendingShare()
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    if (request.isForMainFrame) {
                        showError(request.url.toString(), error)
                    }
                }
            }

        webView.webChromeClient = object : WebChromeClient() {}

        nativeBridge.install(webView)
    }

    private fun configureErrorView() {
        findViewById<Button>(R.id.retry_button).setOnClickListener { retry() }
        findViewById<Button>(R.id.unlock_button).setOnClickListener { appLock.lock() }
    }

    private fun configureBackNavigation() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )
    }

    private fun restoreOrLoad(intent: Intent?, savedInstanceState: Bundle?) {
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
            return
        }
        loadFromIntent(intent)
    }

    private fun loadFromIntent(intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_SEND -> {
                pendingShare = intent.getStringExtra(Intent.EXTRA_TEXT)
                load(config.managementOrigin)
            }

            Intent.ACTION_VIEW -> {
                val link =
                    intent.data
                        ?.toString()
                        ?.let { DeepLinks.aliasLink(it, config.managementOrigin) }
                load(link?.url ?: config.managementOrigin)
            }

            else -> load(config.managementOrigin)
        }
    }

    private fun load(url: String) {
        lastUrl = url
        errorView.isVisible = false
        webView.loadUrl(url)
    }

    /** Returns true when the WebView must not load the URL itself. */
    private fun handleNavigation(url: String): Boolean {
        if (policy.shouldOpenInternally(url)) {
            errorView.isVisible = false
            lastUrl = url
            return false
        }
        return openExternally(url)
    }

    private fun openExternally(url: String): Boolean =
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            true
        } catch (_: ActivityNotFoundException) {
            false
        }

    private fun showError(url: String, error: WebResourceError) {
        lastUrl = url
        progress.isVisible = false
        errorMessage.text =
            when (error.errorCode) {
                WebViewClient.ERROR_HOST_LOOKUP,
                WebViewClient.ERROR_CONNECT,
                WebViewClient.ERROR_TIMEOUT,
                WebViewClient.ERROR_IO,
                -> getString(R.string.error_offline_message)

                else -> getString(R.string.error_generic_message)
            }
        errorView.isVisible = true
    }

    private fun retry() {
        if (!connectivity.isOnline()) {
            errorMessage.text = getString(R.string.error_offline_message)
            return
        }
        val target = lastUrl?.takeIf(policy::shouldOpenInternally) ?: config.managementOrigin
        load(target)
    }

    private fun deliverPendingShare() {
        val text = pendingShare ?: return
        pendingShare = null
        val script =
            "window.dispatchEvent(new CustomEvent('wickmail:share', { detail: " +
                JSONObject.quote(text) + " }));"
        webView.evaluateJavascript(script, null)
    }
}
