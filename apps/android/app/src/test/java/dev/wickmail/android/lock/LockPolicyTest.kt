package dev.wickmail.android.lock

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LockPolicyTest {
    private val now = 1_000_000L

    @Test
    fun disabledNeverLocks() {
        assertFalse(LockPolicy.shouldLock(false, true, now, now - 60_000L, 30_000L))
    }

    @Test
    fun unavailableCredentialNeverLocks() {
        assertFalse(LockPolicy.shouldLock(true, false, now, now - 60_000L, 30_000L))
    }

    @Test
    fun neverBackgroundedDoesNotLock() {
        assertFalse(LockPolicy.shouldLock(true, true, now, null, 30_000L))
    }

    @Test
    fun withinGracePeriodDoesNotLock() {
        assertFalse(LockPolicy.shouldLock(true, true, now, now - 5_000L, 30_000L))
    }

    @Test
    fun pastGracePeriodLocks() {
        assertTrue(LockPolicy.shouldLock(true, true, now, now - 30_000L, 30_000L))
        assertTrue(LockPolicy.shouldLock(true, true, now, now - 60_000L, 30_000L))
    }

    @Test
    fun zeroTimeoutLocksImmediately() {
        assertTrue(LockPolicy.shouldLock(true, true, now, now, 0L))
    }
}
