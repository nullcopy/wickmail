// Root build file. Plugins are declared here without applying them so the
// versions come from a single catalog shared by every module.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
}
