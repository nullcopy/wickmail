plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Deployment configuration, read from Gradle properties or environment
// variables. None of these values are secrets except the release keystore,
// which is supplied out of band and never committed. See README.md.
fun configValue(property: String, environment: String): String? =
    (findProperty(property) as String?)?.takeIf { it.isNotBlank() }
        ?: System.getenv(environment)?.takeIf { it.isNotBlank() }

val managementOrigin = configValue("wickmail.managementOrigin", "WICKMAIL_MANAGEMENT_ORIGIN").orEmpty()
val identityOrigins = configValue("wickmail.identityOrigins", "WICKMAIL_IDENTITY_ORIGINS").orEmpty()
val appLinkHosts = configValue("wickmail.appLinkHosts", "WICKMAIL_APP_LINK_HOSTS").orEmpty()
val appLockDefault = configValue("wickmail.appLockDefault", "WICKMAIL_APP_LOCK_DEFAULT")
    ?.toBooleanStrictOrNull() ?: true

// Release signing. The keystore and passwords are never stored in the
// repository; provide them through -P flags or environment variables.
val releaseKeystore = configValue("wickmail.release.keystore", "WICKMAIL_KEYSTORE")
val releaseStorePassword = configValue("wickmail.release.storePassword", "WICKMAIL_STORE_PASSWORD")
val releaseKeyAlias = configValue("wickmail.release.keyAlias", "WICKMAIL_KEY_ALIAS")
val releaseKeyPassword = configValue("wickmail.release.keyPassword", "WICKMAIL_KEY_PASSWORD")

android {
    namespace = "dev.wickmail.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.wickmail.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "MANAGEMENT_ORIGIN", "\"$managementOrigin\"")
        buildConfigField("String", "IDENTITY_ORIGINS", "\"$identityOrigins\"")
        buildConfigField("String", "APP_LINK_HOSTS", "\"$appLinkHosts\"")
        buildConfigField("boolean", "APP_LOCK_DEFAULT", appLockDefault.toString())

        // The first configured app-link host is declared in the manifest. The
        // reserved `.invalid` host is used when none is configured so the
        // intent filter never matches a real domain.
        val manifestAppLinkHost = appLinkHosts
            .split(",")
            .map { it.trim() }
            .firstOrNull { it.isNotEmpty() }
            ?: "wickmail.invalid"
        manifestPlaceholders["appLinkHost"] = manifestAppLinkHost
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // Left unset when no keystore is supplied, producing an unsigned
            // release build instead of a build that silently reuses a debug key.
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.lifecycle.runtime.ktx)

    testImplementation(libs.junit)
    // The JVM unit tests run against the Maven Central org.json implementation;
    // Android provides the same API at runtime.
    testImplementation(libs.org.json)

    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(libs.androidx.test.core)
}
