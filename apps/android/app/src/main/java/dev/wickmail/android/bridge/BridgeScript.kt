package dev.wickmail.android.bridge

/**
 * Injected into the management page only.
 *
 * It installs Web Share and clipboard fallbacks that forward to the native
 * bridge, so the existing web app's copy and share controls gain native
 * behavior without any web-side change. It runs only after the management
 * origin has loaded and only when the bridge is available.
 */
object BridgeScript {
    val JS: String =
        """
        (function () {
          var bridge = window.WickmailNative;
          if (!bridge || typeof bridge.postMessage !== "function") return;
          if (window.__wickmailBridgeInstalled) return;
          window.__wickmailBridgeInstalled = true;

          function send(payload) {
            try {
              bridge.postMessage(JSON.stringify(payload));
            } catch (e) {}
          }

          if (typeof navigator.share !== "function") {
            try {
              Object.defineProperty(navigator, "share", {
                configurable: true,
                value: function (data) {
                  var text = "";
                  if (data) {
                    text = data.text || data.url || data.title || "";
                  }
                  send({ type: "share", text: String(text) });
                  return Promise.resolve();
                },
              });
            } catch (e) {}
          }

          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
            try {
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                  writeText: function (text) {
                    send({ type: "copy", text: String(text) });
                    return Promise.resolve();
                  },
                },
              });
            } catch (e) {}
          }
        })();
        """.trimIndent()
}
