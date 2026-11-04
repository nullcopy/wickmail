package dev.wickmail.android.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeBridgeTest {
    @Test
    fun parsesShare() {
        assertEquals(
            NativeRequest.Share("green.farm@example.com"),
            NativeBridge.parse("""{"type":"share","text":"green.farm@example.com"}"""),
        )
    }

    @Test
    fun parsesCopy() {
        assertEquals(
            NativeRequest.Copy("green.farm@example.com"),
            NativeBridge.parse("""{"type":"copy","text":"green.farm@example.com"}"""),
        )
    }

    @Test
    fun parsesSetAppLock() {
        assertEquals(
            NativeRequest.SetAppLock(enabled = true, timeoutMs = 15000L),
            NativeBridge.parse("""{"type":"setAppLock","enabled":true,"timeoutMs":15000}"""),
        )
        assertEquals(
            NativeRequest.SetAppLock(enabled = false, timeoutMs = null),
            NativeBridge.parse("""{"type":"setAppLock","enabled":false}"""),
        )
    }

    @Test
    fun rejectsMalformedMessages() {
        assertEquals(NativeRequest.Invalid, NativeBridge.parse(null))
        assertEquals(NativeRequest.Invalid, NativeBridge.parse(""))
        assertEquals(NativeRequest.Invalid, NativeBridge.parse("not json"))
        assertEquals(NativeRequest.Invalid, NativeBridge.parse("{}"))
        assertEquals(NativeRequest.Invalid, NativeBridge.parse("""{"type":"unknown"}"""))
        assertEquals(NativeRequest.Invalid, NativeBridge.parse("""{"type":"share"}"""))
        assertEquals(NativeRequest.Invalid, NativeBridge.parse("""{"type":"share","text":""}"""))
        assertEquals(NativeRequest.Invalid, NativeBridge.parse("""{"type":"setAppLock"}"""))
    }

    @Test
    fun rejectsOversizedText() {
        val text = "a".repeat(NativeBridge.MAX_TEXT_LENGTH + 1)
        assertEquals(NativeRequest.Invalid, NativeBridge.parse("""{"type":"share","text":"$text"}"""))
    }

    @Test
    fun acceptsMaximumLengthText() {
        val text = "a".repeat(NativeBridge.MAX_TEXT_LENGTH)
        assertEquals(NativeRequest.Share(text), NativeBridge.parse("""{"type":"share","text":"$text"}"""))
    }
}
