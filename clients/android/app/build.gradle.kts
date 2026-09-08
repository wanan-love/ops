plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.wananlove.openprintshare"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.wananlove.openprintshare"
        minSdk = 24
        targetSdk = 34
        // 版本号与 Host 单一来源：CI / scripts/build-android.sh 通过 -PopsVersion=<host版本>
        // 注入（mini-services/ops-host/src/core/types.ts OPS_VERSION）；缺省回落 0.3.0（本地 IDE 调试）
        // versionCode 由 opsVersionCode 注入（major*10000+minor*100+patch，如 0.4.8 → 408）
        versionCode = (project.findProperty("opsVersionCode") as String?)?.toInt() ?: 3
        versionName = (project.findProperty("opsVersion") as String?) ?: "0.3.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.webkit:webkit:1.11.0")
}
