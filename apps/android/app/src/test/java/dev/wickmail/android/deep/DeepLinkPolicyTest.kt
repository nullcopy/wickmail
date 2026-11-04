package dev.wickmail.android.deep

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeepLinkPolicyTest {
    private val policy =
        DeepLinkPolicy(
            managementOrigin = "https://wickmail.example.com",
            approvedAppLinkHosts = listOf("wickmail.example.com"),
        )

    @Test
    fun pathFormResolvesToAliasRoute() {
        assertEquals(
            "https://wickmail.example.com/#/aliases/abc",
            policy.aliasUrl("https://wickmail.example.com/aliases/abc"),
        )
    }

    @Test
    fun hashFormResolvesToAliasRoute() {
        assertEquals(
            "https://wickmail.example.com/#/aliases/abc",
            policy.aliasUrl("https://wickmail.example.com/#/aliases/abc"),
        )
    }

    @Test
    fun hostIsCaseInsensitive() {
        assertEquals(
            "https://wickmail.example.com/#/aliases/abc",
            policy.aliasUrl("https://WICKMAIL.EXAMPLE.COM/aliases/abc"),
        )
    }

    @Test
    fun identifierIsPercentEncoded() {
        assertEquals(
            "https://wickmail.example.com/#/aliases/a%20b",
            policy.aliasUrl("https://wickmail.example.com/aliases/a%20b"),
        )
    }

    @Test
    fun otherHostIsRejected() {
        assertNull(policy.aliasUrl("https://evil.example.com/aliases/abc"))
    }

    @Test
    fun nonAliasPathIsRejected() {
        assertNull(policy.aliasUrl("https://wickmail.example.com/settings"))
        assertNull(policy.aliasUrl("https://wickmail.example.com/aliases"))
        assertNull(policy.aliasUrl("https://wickmail.example.com/aliases/a/b"))
    }

    @Test
    fun cleartextIsRejected() {
        assertNull(policy.aliasUrl("http://wickmail.example.com/aliases/abc"))
    }

    @Test
    fun unsafeSchemeIsRejected() {
        assertNull(policy.aliasUrl("javascript:alert(1)"))
        assertNull(policy.aliasUrl("file:///etc/passwd"))
    }

    @Test
    fun noConfiguredHostsRejectsEverything() {
        val unconfigured =
            DeepLinkPolicy("https://wickmail.example.com", approvedAppLinkHosts = emptyList())
        assertNull(unconfigured.aliasUrl("https://wickmail.example.com/aliases/abc"))
    }
}
