package dev.wickmail.android

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.wickmail.android.bridge.BridgeScript
import dev.wickmail.android.bridge.NativeBridge
import dev.wickmail.android.bridge.NativeRequest
import dev.wickmail.android.config.AppConfig
import dev.wickmail.android.deep.DeepLinkPolicy
import dev.wickmail.android.lock.AppLockController
import dev.wickmail.android.share.NativeActions
import dev.wickmail.android.web.NavigationPolicy
import dev.wickmail.android.web.NavigationTarget

/**
 * Hosts the Wickmail management app in a locked-down WebView.
 *
 * The shell provides navigation, connectivity handling, external-link routing,
 * copy and share, and an optional app lock. It contains no alias, lease, or
 * reply-identity logic: the server remains the source of truth.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var errorView: View
    private lateinit var errorMessage: TextView
    private lateinit var retryButton: Button
    private lateinit var lockView: View
    private lateinit var unlockButton: Button
    private lateinit var lockMessage: TextView

    private var deepLinks: DeepLinkPolicy? = null
    private var appLock: AppLockController? = null
    private var pendingUrl: String? = null
    private var bridgeAvailable = false
    private var suppressNextMainFrameError = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        bindViews()

        val config = (application as WickmailApplication).config
        if (config == null) {
            showConfigurationError()
            return
        }

        val navigationPolicy = NavigationPolicy(config.managementOrigin, config.identityOrigins)
        deepLinks = DeepLinkPolicy(config.managementOrigin, config.appLinkHosts)
        appLock =
            AppLockController(
                activity = this,
                lockView = lockView,
                unlockButton = unlockButton,
                lockMessage = lockMessage,
                prefs = getSharedPreferences(PREFS, MODE_PRIVATE),
            )

        configureWebView(navigationPolicy, config)
        setupBackNavigation()

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
            deepLinkUrl(intent)?.let { load(it) }
        } else {
            load(deepLinkUrl(intent) ?: config.managementOrigin)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deepLinkUrl(intent)?.let { load(it) }
    }

    override fun onStart() {
        super.onStart()
        appLock?.onActivityStarted()
    }

    override fun onStop() {
        appLock?.onActivityStopped()
        super.onStop()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun bindViews() {
        webView = findViewById(R.id.web_view)
        errorView = findViewById(R.id.error_view)
        errorMessage = findViewById(R.id.error_message)
        retryButton = findViewById(R.id.retry_button)
        lockView = findViewById(R.id.lock_view)
        unlockButton = findViewById(R.id.unlock_button)
        lockMessage = findViewById(R.id.lock_message)
        retryButton.setOnClickListener { pendingUrl?.let { load(it) } }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(navigationPolicy: NavigationPolicy, config: AppConfig) {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString WickmailAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.webViewClient = WickmailWebViewClient(navigationPolicy)
        setupBridge(config)
    }

    private fun setupBridge(config: AppConfig) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Without an origin-scoped message channel the shell stays out of the
            // way and the web app's own copy and share behavior applies.
            bridgeAvailable = false
            return
        }
        bridgeAvailable = true
        WebViewCompat.addWebMessageListener(
            webView,
            BRIDGE_NAME,
            setOf(config.managementOrigin),
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceOrigin: Uri,
                    isMainFrame: Boolean,
                    replyProxy: JavaScriptReplyProxy,
                ) {
                    if (!isMainFrame) {
                        return
                    }
                    handleNativeRequest(NativeBridge.parse(message.data))
                }
            },
        )
    }

    private fun handleNativeRequest(request: NativeRequest) {
        when (request) {
            is NativeRequest.Copy -> NativeActions.copy(this, request.text)
            is NativeRequest.Share -> NativeActions.share(this, request.text)
            is NativeRequest.SetAppLock ->
                appLock?.let { lock ->
                    lock.enabled = request.enabled
                    request.timeoutMs?.let { if (it >= 0L) lock.timeoutMs = it }
                }
            NativeRequest.Invalid -> Unit
        }
    }

    private fun setupBackNavigation() {
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

    private fun load(url: String) {
        pendingUrl = url
        if (!isOnline()) {
            showConnectivityError()
            return
        }
        hideError()
        webView.loadUrl(url)
    }

    private fun deepLinkUrl(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_VIEW) {
            return null
        }
        val data = intent.data?.toString() ?: return null
        return deepLinks?.aliasUrl(data)
    }

    private fun openExternal(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.open_external_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun isOnline(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return true
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun showConnectivityError() {
        errorMessage.text = getString(R.string.error_message)
        retryButton.visibility = View.VISIBLE
        errorView.visibility = View.VISIBLE
    }

    private fun showConfigurationError() {
        errorMessage.text = getString(R.string.config_error_message)
        retryButton.visibility = View.GONE
        errorView.visibility = View.VISIBLE
    }

    private fun hideError() {
        errorView.visibility = View.GONE
    }

    private inner class WickmailWebViewClient(private val navigationPolicy: NavigationPolicy) :
        WebViewClientCompat() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            return when (navigationPolicy.classify(url)) {
                NavigationTarget.INTERNAL -> false
                NavigationTarget.EXTERNAL -> {
                    if (request.isForMainFrame) {
                        suppressNextMainFrameError = true
                        openExternal(url)
                    }
                    true
                }
                NavigationTarget.BLOCKED -> true
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            hideError()
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (bridgeAvailable && navigationPolicy.isManagement(url)) {
                view.evaluateJavascript(BridgeScript.JS, null)
            }
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceErrorCompat,
        ) {
            if (!request.isForMainFrame) {
                return
            }
            if (suppressNextMainFrameError) {
                suppressNextMainFrameError = false
                return
            }
            showConnectivityError()
        }
    }

    companion object {
        /** The name the management page uses to reach the bridge. */
        private const val BRIDGE_NAME = "WickmailNative"

        /** Shared preferences for shell-level settings such as the app lock. */
        private const val PREFS = "wickmail_shell"
    }
}
