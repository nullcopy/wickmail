package dev.wickmail.android.lock

import android.content.SharedPreferences
import android.os.Build
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import dev.wickmail.android.BuildConfig
import dev.wickmail.android.R

/**
 * Gates the UI behind a biometric or device-credential prompt after the app has
 * been in the background.
 *
 * The lock is a local privacy gate and never replaces server authentication. It
 * degrades gracefully: when no biometric or device credential is available it
 * stays out of the way and the app opens normally.
 */
class AppLockController(
    private val activity: FragmentActivity,
    private val lockView: View,
    private val unlockButton: Button,
    private val lockMessage: TextView,
    private val prefs: SharedPreferences,
) {
    private val authenticators: Int = chooseAuthenticators()

    /** Whether any biometric or device credential is available on this device. */
    val available: Boolean = authenticators != 0

    private var authenticating = false

    init {
        unlockButton.setOnClickListener { prompt() }
    }

    /** Whether the app lock is enabled. */
    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, BuildConfig.APP_LOCK_DEFAULT)
        set(value) {
            prefs.edit().putBoolean(KEY_ENABLED, value).apply()
        }

    /** The grace period after backgrounding before the app locks. */
    var timeoutMs: Long
        get() = prefs.getLong(KEY_TIMEOUT, LockPolicy.DEFAULT_TIMEOUT_MS)
        set(value) {
            prefs.edit().putLong(KEY_TIMEOUT, value).apply()
        }

    /** Called from the host's `onStart`. */
    fun onActivityStarted() {
        if (authenticating) {
            return
        }
        val backgroundedAt =
            if (prefs.contains(KEY_BACKGROUNDED_AT)) {
                prefs.getLong(KEY_BACKGROUNDED_AT, 0L)
            } else {
                null
            }
        val shouldLock =
            LockPolicy.shouldLock(
                enabled = enabled,
                available = available,
                nowMs = System.currentTimeMillis(),
                backgroundedAtMs = backgroundedAt,
                timeoutMs = timeoutMs,
            )
        if (shouldLock) {
            lockView.visibility = View.VISIBLE
            prompt()
        }
    }

    /** Called from the host's `onStop`. */
    fun onActivityStopped() {
        if (authenticating) {
            return
        }
        prefs.edit().putLong(KEY_BACKGROUNDED_AT, System.currentTimeMillis()).apply()
    }

    private fun prompt() {
        if (!available) {
            hideLock()
            return
        }
        authenticating = true
        val prompt =
            BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(
                        result: BiometricPrompt.AuthenticationResult,
                    ) {
                        authenticating = false
                        hideLock()
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        authenticating = false
                        lockMessage.text = errString
                    }

                    override fun onAuthenticationFailed() {
                        // The prompt stays open so the user can retry.
                    }
                },
            )
        val info =
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(activity.getString(R.string.biometric_title))
                .setSubtitle(activity.getString(R.string.biometric_subtitle))
        if (authenticators == (BIOMETRIC_WEAK or DEVICE_CREDENTIAL)) {
            info.setAllowedAuthenticators(authenticators)
        } else {
            info.setAllowedAuthenticators(BIOMETRIC_WEAK)
            info.setNegativeButtonText(activity.getString(R.string.biometric_cancel))
        }
        prompt.authenticate(info.build())
    }

    private fun hideLock() {
        lockView.visibility = View.GONE
        lockMessage.text = activity.getString(R.string.lock_message)
        prefs.edit().putLong(KEY_BACKGROUNDED_AT, System.currentTimeMillis()).apply()
    }

    private fun chooseAuthenticators(): Int {
        val manager = BiometricManager.from(activity)
        val biometricOrCredential = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        // The combined biometric and device-credential prompt is supported from
        // Android 11. Older devices use biometrics only and fall back gracefully.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            manager.canAuthenticate(biometricOrCredential) == BiometricManager.BIOMETRIC_SUCCESS
        ) {
            return biometricOrCredential
        }
        if (manager.canAuthenticate(BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS) {
            return BIOMETRIC_WEAK
        }
        return 0
    }

    companion object {
        private const val KEY_ENABLED = "app_lock_enabled"
        private const val KEY_TIMEOUT = "app_lock_timeout_ms"
        private const val KEY_BACKGROUNDED_AT = "app_lock_backgrounded_at"
    }
}
