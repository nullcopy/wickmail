package com.wickmail.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginPolicyTest {
    private val policy =
        OriginPolicy(
            managementOrigin = "https://wickmail.example",
            identityOrigins = listOf("https://accounts.example.com"),
        )

    @Test
    fun managementOriginLoadsInternally() {
        assertTrue(policy.shouldOpenInternally("https://wickmail.example/"))
        assertTrue(policy.shouldOpenInternally("https://wickmail.example/aliases/abc"))
    }

    @Test
    fun approvedIdentityOriginLoadsInternally() {
        assertTrue(policy.shouldOpenInternally("https://accounts.example.com/signin"))
    }

    @Test
    fun otherOriginOpensExternally() {
        assertFalse(policy.shouldOpenInternally("https://evil.example/"))
        assertTrue(policy.shouldOpenExternally("https://evil.example/"))
    }

    @Test
    fun cleartextIsNeverInternal() {
        assertFalse(policy.shouldOpenInternally("http://wickmail.example/"))
        assertTrue(policy.shouldOpenExternally("http://wickmail.example/"))
    }

    @Test
    fun schemeAndPortMustMatch() {
        assertFalse(policy.shouldOpenInternally("https://wickmail.example:8443/"))
        assertFalse(policy.shouldOpenInternally("ftp://wickmail.example/"))
    }

    @Test
    fun hostComparisonIsCaseInsensitive() {
        assertTrue(policy.shouldOpenInternally("https://WICKMAIL.EXAMPLE/"))
    }

    @Test
    fun lookalikeHostsAreExternal() {
        assertFalse(policy.shouldOpenInternally("https://wickmail.example.evil.test/"))
        assertFalse(policy.shouldOpenInternally("https://wickmail-example/"))
    }

    @Test
    fun nonHttpSchemeIsNotABrowserTarget() {
        assertFalse(policy.shouldOpenExternally("mailto:someone@example.com"))
    }

    @Test
    fun bridgeAllowlistContainsOnlyTheManagementOrigin() {
        assertEquals(setOf("https://wickmail.example"), policy.bridgeAllowedOrigins())
    }

    @Test
    fun isManagementDistinguishesTheOrigin() {
        assertTrue(policy.isManagement("https://wickmail.example/aliases/x"))
        assertFalse(policy.isManagement("https://accounts.example.com/"))
    }
}
