import java.net.URI
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// The management origin is baked in at build time. Operators set it with
// `-PwickmailManagementOrigin=https://wickmail.example`. The shell never
// accepts a target origin from an untrusted intent.
val managementOrigin: String =
    (project.findProperty("wickmailManagementOrigin") as String?) ?: "https://wickmail.example"

val managementHost: String =
    runCatching { URI(managementOrigin).host }.getOrNull()
        ?: error("wickmailManagementOrigin must be an absolute URL with a host: $managementOrigin")

// Optional comma-separated list of additional HTTPS origins whose sign-in
// pages may load inside the WebView. Empty by default.
val identityOrigins: String =
    (project.findProperty("wickmailIdentityOrigins") as String?) ?: ""

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties =
    Properties().apply {
        if (keystorePropertiesFile.exists()) {
            keystorePropertiesFile.inputStream().use { load(it) }
        }
    }

android {
    namespace = "com.wickmail.android"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.wickmail.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "MANAGEMENT_ORIGIN", "\"$managementOrigin\"")
        buildConfigField("String", "IDENTITY_ORIGINS", "\"$identityOrigins\"")
        manifestPlaceholders["wickmailHost"] = managementHost
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
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
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        abortOnError = true
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
}
