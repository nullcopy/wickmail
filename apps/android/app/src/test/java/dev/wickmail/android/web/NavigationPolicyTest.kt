package dev.wickmail.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationPolicyTest {
    private val policy =
        NavigationPolicy(
            managementOrigin = "https://wickmail.example.com",
            approvedIdentityOrigins = listOf("https://login.example.com"),
        )

    @Test
    fun managementOriginLoadsInternally() {
        assertEquals(NavigationTarget.INTERNAL, policy.classify("https://wickmail.example.com/"))
        assertEquals(
            NavigationTarget.INTERNAL,
            policy.classify("https://wickmail.example.com/#/aliases/abc"),
        )
    }

    @Test
    fun managementOriginHostIsCaseInsensitive() {
        assertEquals(
            NavigationTarget.INTERNAL,
            policy.classify("https://WICKMAIL.EXAMPLE.COM/aliases/abc"),
        )
    }

    @Test
    fun explicitDefaultPortStillMatches() {
        assertEquals(
            NavigationTarget.INTERNAL,
            policy.classify("https://wickmail.example.com:443/"),
        )
    }

    @Test
    fun relativeUrlResolvesAgainstManagementOrigin() {
        assertEquals(NavigationTarget.INTERNAL, policy.classify("/aliases/abc"))
        assertEquals(NavigationTarget.INTERNAL, policy.classify("//wickmail.example.com/aliases/abc"))
    }

    @Test
    fun approvedIdentityOriginLoadsInternally() {
        assertEquals(
            NavigationTarget.INTERNAL,
            policy.classify("https://login.example.com/authorize?client=wickmail"),
        )
    }

    @Test
    fun otherHttpsOriginOpensExternally() {
        assertEquals(
            NavigationTarget.EXTERNAL,
            policy.classify("https://example.org/article"),
        )
    }

    @Test
    fun subdomainIsNotTheManagementOrigin() {
        assertEquals(
            NavigationTarget.EXTERNAL,
            policy.classify("https://mail.wickmail.example.com/"),
        )
    }

    @Test
    fun differentPortIsNotTheManagementOrigin() {
        assertEquals(
            NavigationTarget.EXTERNAL,
            policy.classify("https://wickmail.example.com:8443/"),
        )
    }

    @Test
    fun cleartextManagementOriginIsNotInternal() {
        assertEquals(
            NavigationTarget.EXTERNAL,
            policy.classify("http://wickmail.example.com/"),
        )
    }

    @Test
    fun safeExternalSchemesOpenExternally() {
        assertEquals(NavigationTarget.EXTERNAL, policy.classify("mailto:help@example.com"))
        assertEquals(NavigationTarget.EXTERNAL, policy.classify("tel:+15550100"))
        assertEquals(NavigationTarget.EXTERNAL, policy.classify("sms:+15550100"))
    }

    @Test
    fun unsafeSchemesAreBlocked() {
        assertEquals(NavigationTarget.BLOCKED, policy.classify("javascript:alert(1)"))
        assertEquals(NavigationTarget.BLOCKED, policy.classify("file:///etc/passwd"))
        assertEquals(NavigationTarget.BLOCKED, policy.classify("data:text/html,hello"))
        assertEquals(NavigationTarget.BLOCKED, policy.classify("content://com.example/data"))
        assertEquals(NavigationTarget.BLOCKED, policy.classify("intent://scan/#Intent;scheme=zxing;end"))
        assertEquals(NavigationTarget.BLOCKED, policy.classify(""))
    }

    @Test
    fun isManagementOnlyForTheManagementOrigin() {
        assertTrue(policy.isManagement("https://wickmail.example.com/#/settings"))
        assertFalse(policy.isManagement("https://login.example.com/"))
        assertFalse(policy.isManagement("https://example.org/"))
    }
}
