package com.wickmail.android

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * Optional biometric app lock.
 *
 * Locking gates access to the UI after the app has been in the background for
 * a configurable period. It is a local convenience only: it never replaces
 * server authentication and it degrades to an unlocked state when the device
 * cannot authenticate the user.
 */
internal class AppLockController(
    private val activity: FragmentActivity,
    private val onLocked: () -> Unit,
    private val onUnlocked: () -> Unit,
) {
    private val preferences: SharedPreferences =
        activity.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    private var locked = false
    private var backgroundedAt = 0L

    var enabled: Boolean
        get() = preferences.getBoolean(KEY_ENABLED, false)
        set(value) = preferences.edit().putBoolean(KEY_ENABLED, value).apply()

    var timeoutSeconds: Int
        get() = preferences.getInt(KEY_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS)
        set(value) = preferences.edit().putInt(KEY_TIMEOUT_SECONDS, value.coerceAtLeast(0)).apply()

    /** True when the device can authenticate the user at all. */
    fun isAvailable(): Boolean =
        BiometricManager.from(activity).canAuthenticate(authenticators()) ==
            BiometricManager.BIOMETRIC_SUCCESS

    /** Locks immediately on a cold start when the feature is enabled and usable. */
    fun lockIfConfigured() {
        if (enabled && isAvailable()) {
            lock()
        } else {
            unlock()
        }
    }

    /** Records the moment the app left the foreground. */
    fun onBackground() {
        backgroundedAt = System.currentTimeMillis()
    }

    /** Re-locks when the app was away for at least the configured timeout. */
    fun onForeground() {
        if (!enabled || !isAvailable()) {
            if (locked) unlock()
            return
        }
        if (locked) return
        val away = (System.currentTimeMillis() - backgroundedAt) / 1000
        if (backgroundedAt != 0L && away >= timeoutSeconds) {
            lock()
        }
    }

    /** Shows the lock overlay and prompts for authentication. */
    fun lock() {
        if (locked) return
        locked = true
        onLocked()
        prompt()
    }

    /** Clears the lock overlay. */
    fun unlock() {
        locked = false
        onUnlocked()
    }

    private fun authenticators(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_WEAK
        }

    private fun prompt() {
        val executor = ContextCompat.getMainExecutor(activity)
        val prompt =
            BiometricPrompt(
                activity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(
                        result: BiometricPrompt.AuthenticationResult,
                    ) {
                        unlock()
                    }
                },
            )
        val info =
            BiometricPrompt.PromptInfo
                .Builder()
                .setTitle(activity.getString(R.string.lock_title))
                .setSubtitle(activity.getString(R.string.lock_subtitle))
                .setAllowedAuthenticators(authenticators())
                .build()
        prompt.authenticate(info)
    }

    companion object {
        private const val PREFERENCES = "wickmail_app_lock"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_TIMEOUT_SECONDS = "timeout_seconds"
        const val DEFAULT_TIMEOUT_SECONDS = 60
    }
}
