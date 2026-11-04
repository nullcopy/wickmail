package dev.wickmail.android

import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.Visibility
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withEffectiveVisibility
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumentation smoke tests. These require a connected device or emulator and
 * cannot run in a host-only build environment.
 */
@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @Test
    fun unconfiguredBuildShowsConfigurationError() {
        assumeTrue(BuildConfig.MANAGEMENT_ORIGIN.isBlank())
        ActivityScenario.launch(MainActivity::class.java).use {
            onView(withId(R.id.error_view)).check(matches(isDisplayed()))
            onView(withId(R.id.retry_button))
                .check(matches(withEffectiveVisibility(Visibility.GONE)))
        }
    }
}
