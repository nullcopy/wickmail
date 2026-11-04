package dev.wickmail.android.lock

/**
 * Decides whether the shell should show its lock screen.
 *
 * The app lock is a local privacy gate for the UI. It never replaces server
 * authentication, and it is skipped entirely when no biometric or device
 * credential is available.
 */
object LockPolicy {
    /** Default grace period between backgrounding and locking. */
    const val DEFAULT_TIMEOUT_MS = 30_000L

    /**
     * @param enabled whether the app lock is enabled
     * @param available whether a biometric or device credential is available
     * @param nowMs the current time
     * @param backgroundedAtMs when the app last went to the background, or null if never
     * @param timeoutMs the grace period after backgrounding before locking
     */
    fun shouldLock(
        enabled: Boolean,
        available: Boolean,
        nowMs: Long,
        backgroundedAtMs: Long?,
        timeoutMs: Long,
    ): Boolean {
        if (!enabled || !available) {
            return false
        }
        if (backgroundedAtMs == null) {
            return false
        }
        if (timeoutMs <= 0L) {
            return true
        }
        return nowMs - backgroundedAtMs >= timeoutMs
    }
}
