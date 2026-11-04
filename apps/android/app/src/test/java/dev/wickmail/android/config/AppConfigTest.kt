package dev.wickmail.android.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppConfigTest {
    @Test
    fun parsesValidConfiguration() {
        val config =
            AppConfig.parse(
                managementOrigin = "https://wickmail.example.com",
                identityOrigins = "https://login.example.com, https://sso.example.org",
                appLinkHosts = "wickmail.example.com",
            )
        assertEquals("https://wickmail.example.com", config?.managementOrigin)
        assertEquals(
            listOf("https://login.example.com", "https://sso.example.org"),
            config?.identityOrigins,
        )
        assertEquals(listOf("wickmail.example.com"), config?.appLinkHosts)
    }

    @Test
    fun normalizesManagementAndIdentityOrigins() {
        val config =
            AppConfig.parse(
                managementOrigin = "https://wickmail.example.com/",
                identityOrigins = "https://login.example.com:443/",
                appLinkHosts = "",
            )
        assertEquals("https://wickmail.example.com", config?.managementOrigin)
        assertEquals(listOf("https://login.example.com"), config?.identityOrigins)
    }

    @Test
    fun emptyIdentityOriginsAreAllowed() {        val config =
            AppConfig.parse(
                managementOrigin = "https://wickmail.example.com",
                identityOrigins = "",
                appLinkHosts = "",
            )
        assertEquals(emptyList<String>(), config?.identityOrigins)
        assertEquals(emptyList<String>(), config?.appLinkHosts)
    }

    @Test
    fun blankManagementOriginIsRejected() {
        assertNull(AppConfig.parse("", "", ""))
        assertNull(AppConfig.parse("   ", "", ""))
    }

    @Test
    fun cleartextManagementOriginIsRejected() {
        assertNull(AppConfig.parse("http://wickmail.example.com", "", ""))
    }

    @Test
    fun cleartextIdentityOriginIsRejected() {
        assertNull(
            AppConfig.parse(
                managementOrigin = "https://wickmail.example.com",
                identityOrigins = "http://login.example.com",
                appLinkHosts = "",
            ),
        )
    }

    @Test
    fun invalidIdentityOriginIsRejected() {
        assertNull(
            AppConfig.parse(
                managementOrigin = "https://wickmail.example.com",
                identityOrigins = "not a url",
                appLinkHosts = "",
            ),
        )
    }
}
