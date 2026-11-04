package com.wickmail.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.webkit.WebView
import android.widget.Toast
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * The only channel between web content and native code.
 *
 * The bridge exposes explicit copy, share, and app-lock operations. It is
 * scoped to the management origin, runs no general network primitives, and
 * never exposes session cookies or tokens.
 */
internal class NativeBridge(
    private val context: Context,
    private val policy: OriginPolicy,
    private val appLock: AppLockController,
) {
    private var scriptHandler: ScriptHandler? = null
    private var installed = false

    /** Installs the bridge, returning whether the WebView supports it. */
    fun install(webView: WebView): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        val origins = policy.bridgeAllowedOrigins()
        WebViewCompat.addWebMessageListener(
            webView,
            BRIDGE_OBJECT,
            origins,
        ) { _, message, _, isMainFrame, replyProxy ->
            if (isMainFrame) {
                message.data?.let { handle(it, replyProxy) }
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            scriptHandler = WebViewCompat.addDocumentStartJavaScript(webView, SHIM, origins)
        }
        installed = true
        return true
    }

    /** Removes the bridge from the WebView. */
    fun destroy(webView: WebView) {
        if (!installed) return
        scriptHandler?.remove()
        scriptHandler = null
        runCatching { WebViewCompat.removeWebMessageListener(webView, BRIDGE_OBJECT) }
        installed = false
    }

    private fun handle(raw: String, replyProxy: JavaScriptReplyProxy) {
        val message = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val id = message.optString("id")
        when (message.optString("op")) {
            "copy" -> {
                copy(message.optString("text"))
                replyProxy.postMessage(reply(id, ok = true))
            }

            "share" -> {
                share(message.optString("title"), message.optString("text"))
                replyProxy.postMessage(reply(id, ok = true))
            }

            "getAppLock" -> replyProxy.postMessage(lockState(id))

            "setAppLock" -> {
                appLock.enabled = message.optBoolean("enabled")
                replyProxy.postMessage(lockState(id))
            }

            "setLockTimeout" -> {
                appLock.timeoutSeconds = message.optInt("seconds", appLock.timeoutSeconds)
                replyProxy.postMessage(lockState(id))
            }
        }
    }

    private fun copy(text: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        clipboard?.setPrimaryClip(ClipData.newPlainText(context.getString(R.string.app_name), text))
        Toast.makeText(context, R.string.copied, Toast.LENGTH_SHORT).show()
    }

    private fun share(title: String, text: String) {
        val send =
            Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, title)
                putExtra(Intent.EXTRA_TEXT, text)
            }
        val chooser = Intent.createChooser(send, context.getString(R.string.share_via))
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
    }

    private fun reply(id: String, ok: Boolean): String =
        JSONObject()
            .put("replyTo", id)
            .put("ok", ok)
            .toString()

    private fun lockState(id: String): String =
        JSONObject()
            .put("replyTo", id)
            .put("ok", true)
            .put("available", appLock.isAvailable())
            .put("enabled", appLock.enabled)
            .put("timeoutSeconds", appLock.timeoutSeconds)
            .toString()

    private companion object {
        const val BRIDGE_OBJECT = "wickmailBridge"

        /**
         * Injected before page scripts run. It exposes `window.wickmailNative`
         * and fills the gaps in WebView browser behavior (no Web Share API)
         * without granting page content access to any other device data.
         */
        val SHIM: String =
            """
            (function () {
              if (window.wickmailNative) return;
              var pending = {};
              var seq = 0;
              var attempts = 300;
              var settle;
              var ready = new Promise(function (resolve) { settle = resolve; });
              (function wait() {
                if (window.wickmailBridge) { settle(true); return; }
                if (--attempts <= 0) { settle(false); return; }
                setTimeout(wait, 10);
              })();
              function call(op, payload) {
                return ready.then(function (isReady) {
                  if (!isReady || !window.wickmailBridge) {
                    return Promise.reject(new Error("native bridge unavailable"));
                  }
                  return new Promise(function (resolve) {
                    var id = "r" + (++seq);
                    pending[id] = resolve;
                    var message = { id: id, op: op };
                    if (payload) {
                      for (var key in payload) {
                        if (Object.prototype.hasOwnProperty.call(payload, key)) {
                          message[key] = payload[key];
                        }
                      }
                    }
                    window.wickmailBridge.postMessage(JSON.stringify(message));
                  });
                });
              }
              window.addEventListener("message", function (event) {
                if (typeof event.data !== "string") return;
                var data;
                try { data = JSON.parse(event.data); } catch (error) { return; }
                if (!data || !data.replyTo) return;
                var resolve = pending[data.replyTo];
                if (resolve) { delete pending[data.replyTo]; resolve(data); }
              });
              var native = {
                isAvailable: true,
                copy: function (text) { return call("copy", { text: String(text) }); },
                share: function (title, text) {
                  return call("share", { title: String(title), text: String(text) });
                },
                getAppLock: function () { return call("getAppLock", null); },
                setAppLock: function (enabled) { return call("setAppLock", { enabled: !!enabled }); },
                setLockTimeout: function (seconds) {
                  return call("setLockTimeout", { seconds: Number(seconds) });
                }
              };
              window.wickmailNative = native;
              try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  var original = navigator.clipboard.writeText.bind(navigator.clipboard);
                  navigator.clipboard.writeText = function (text) {
                    return native.copy(String(text)).then(function (reply) {
                      if (!reply || !reply.ok) { return original(text); }
                    }, function () { return original(text); });
                  };
                }
              } catch (error) { /* clipboard is unavailable; the web app falls back. */ }
              try {
                if (typeof navigator.share !== "function") {
                  Object.defineProperty(navigator, "share", {
                    configurable: true,
                    value: function (data) {
                      var title = (data && data.title) || document.title || "Wickmail";
                      var text = (data && data.text) || (data && data.url) || "";
                      return native.share(title, text).then(function (reply) {
                        if (!reply || !reply.ok) { throw new Error("Share dismissed"); }
                      });
                    }
                  });
                }
              } catch (error) { /* Web Share is already provided by the platform. */ }
            })();
            """.trimIndent()
    }
}
