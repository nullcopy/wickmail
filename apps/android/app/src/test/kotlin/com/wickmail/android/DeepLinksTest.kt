package com.wickmail.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeepLinksTest {
    private val origin = "https://wickmail.example"

    @Test
    fun acceptsAliasDetailLink() {
        val link = DeepLinks.aliasLink("https://wickmail.example/aliases/abc123", origin)
        assertEquals("abc123", link?.aliasId)
        assertEquals("https://wickmail.example/aliases/abc123", link?.url)
    }

    @Test
    fun rejectsForeignOrigin() {
        assertNull(DeepLinks.aliasLink("https://evil.example/aliases/abc123", origin))
    }

    @Test
    fun rejectsCleartext() {
        assertNull(DeepLinks.aliasLink("http://wickmail.example/aliases/abc123", origin))
    }

    @Test
    fun rejectsNonAliasPaths() {
        assertNull(DeepLinks.aliasLink("https://wickmail.example/settings", origin))
        assertNull(DeepLinks.aliasLink("https://wickmail.example/aliases/", origin))
    }

    @Test
    fun rejectsNestedPaths() {
        assertNull(DeepLinks.aliasLink("https://wickmail.example/aliases/a/b", origin))
    }

    @Test
    fun preservesEncodedIdentifier() {
        val link = DeepLinks.aliasLink("https://wickmail.example/aliases/a%2Fb", origin)
        assertEquals("a%2Fb", link?.aliasId)
        assertEquals("https://wickmail.example/aliases/a%2Fb", link?.url)
    }

    @Test
    fun dropsQueryAndFragment() {
        val link = DeepLinks.aliasLink("https://wickmail.example/aliases/abc?x=1#frag", origin)
        assertEquals("https://wickmail.example/aliases/abc", link?.url)
    }

    @Test
    fun acceptsTrailingSlash() {
        assertEquals(
            "abc",
            DeepLinks.aliasLink("https://wickmail.example/aliases/abc/", origin)?.aliasId,
        )
    }
}
