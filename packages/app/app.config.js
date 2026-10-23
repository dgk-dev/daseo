const fs = require("node:fs");
const path = require("node:path");
const pkg = require("./package.json");
const withAndroidAsyncStorageSize = require("./plugins/with-android-async-storage-size");
const withAndroidFoldConfigChanges = require("./plugins/with-android-fold-config-changes");
const withAndroidProfileable = require("./plugins/with-android-profileable");
const withAndroidTextMetrics = require("./plugins/with-android-text-metrics");
const withAndroidBlockCursor = require("./plugins/with-android-block-cursor");
const withFdroidAutolinking = require("./plugins/with-fdroid-autolinking");
const withPasteInput = require("./plugins/with-paste-input");
const { getNativeReleaseVersion } = require("./native-release-version");
const appVariant = process.env.APP_VARIANT ?? "production";
const isFdroidBuild = process.env.PASEO_FDROID_BUILD === "1";
const isProfileBuild = process.env.PASEO_PROFILE_BUILD === "1";

const buildProfile = isFdroidBuild
  ? {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
      ],
      cameraPlugins: [],
      fdroidPlugins: [withFdroidAutolinking],
      notificationPlugins: [],
    }
  : {
      androidPermissions: [
        "RECORD_AUDIO",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "CAMERA",
        "android.permission.CAMERA",
      ],
      cameraPlugins: [
        [
          "expo-camera",
          {
            cameraPermission:
              "Allow $(PRODUCT_NAME) to access your camera to scan pairing QR codes.",
          },
        ],
      ],
      fdroidPlugins: [],
      notificationPlugins: [
        [
          "expo-notifications",
          {
            icon: "./assets/images/notification-icon.png",
            color: "#20744A",
            // Copied to res/raw, so names are [a-z0-9_] only. agent_needs_you.wav is generated:
            // ffmpeg -f lavfi -i "sine=frequency=880:duration=0.16:sample_rate=44100" \
            //   -f lavfi -i "anullsrc=r=44100:cl=mono" \
            //   -f lavfi -i "sine=frequency=1318.5:duration=0.26:sample_rate=44100" \
            //   -filter_complex "[0]afade=t=in:d=0.01,afade=t=out:st=0.13:d=0.03,volume=0.6[a];[1]atrim=duration=0.06[g];[2]afade=t=in:d=0.01,afade=t=out:st=0.18:d=0.08,volume=0.6[b];[a][g][b]concat=n=3:v=0:a=1,aformat=sample_fmts=s16:channel_layouts=mono" \
            //   -ar 44100 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact -flags:a +bitexact \
            //   assets/audio/agent_needs_you.wav
            sounds: ["./assets/audio/agent_needs_you.wav"],
          },
        ],
      ],
    };

function resolveSecretFile(params) {
  const fromEnv = process.env[params.envKey];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  const fallbackAbsolutePath = path.resolve(__dirname, params.fallbackRelativePath);
  if (fs.existsSync(fallbackAbsolutePath)) {
    return params.fallbackRelativePath;
  }

  return undefined;
}

const variants = {
  production: {
    name: "Paseo",
    packageId: "sh.paseo",
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_PROD",
      fallbackRelativePath: "./.secrets/google-services.prod.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "GOOGLE_SERVICE_INFO_PLIST_PROD",
      fallbackRelativePath: "./.secrets/GoogleService-Info.prod.plist",
    }),
  },
  personal: {
    name: "Daseo",
    packageId: "sh.paseo.dgk",
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_PERSONAL",
      fallbackRelativePath: "./.secrets/google-services.personal.json",
    }),
    googleServiceInfoPlist: undefined,
    directFcmPush: true,
  },
  development: {
    name: "Paseo Debug",
    packageId: "sh.paseo.debug",
    googleServicesFile: resolveSecretFile({
      envKey: "GOOGLE_SERVICES_FILE_DEBUG",
      fallbackRelativePath: "./.secrets/google-services.debug.json",
    }),
    googleServiceInfoPlist: resolveSecretFile({
      envKey: "GOOGLE_SERVICE_INFO_PLIST_DEBUG",
      fallbackRelativePath: "./.secrets/GoogleService-Info.debug.plist",
    }),
  },
};

const variant = variants[appVariant] ?? variants.production;
const nativeReleaseVersion = getNativeReleaseVersion(pkg.version);

export default {
  expo: {
    name: variant.name,
    slug: "voice-mobile",
    version: nativeReleaseVersion.appVersion,
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "paseo",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      infoPlist: {
        NSMicrophoneUsageDescription: "This app needs access to the microphone for voice commands.",
        ITSAppUsesNonExemptEncryption: false,
      },
      bundleIdentifier: variant.packageId,
      ...(variant.googleServiceInfoPlist
        ? { googleServicesFile: variant.googleServiceInfoPlist }
        : {}),
      buildNumber: nativeReleaseVersion.iosBuildNumber,
    },
    android: {
      adaptiveIcon: {
        backgroundColor: "#000000",
        foregroundImage: "./assets/images/android-icon-foreground.png",
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      softwareKeyboardLayoutMode: "resize",
      // Allow HTTP connections for local network hosts (required for release builds)
      usesCleartextTraffic: true,
      permissions: buildProfile.androidPermissions,
      package: variant.packageId,
      versionCode: nativeReleaseVersion.androidVersionCode,
      ...(variant.googleServicesFile ? { googleServicesFile: variant.googleServicesFile } : {}),
    },
    web: {
      output: "single",
      favicon: "./assets/images/favicon.png",
    },
    autolinking: {
      searchPaths: ["../../node_modules", "./node_modules"],
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      withPasteInput,
      [withAndroidAsyncStorageSize, 64],
      withAndroidTextMetrics,
      withAndroidBlockCursor,
      withAndroidFoldConfigChanges,
      // Daseo delta 51: NAVER's D2Coding, a monospace whose Hangul sits on the same grid as
      // its Latin, for code and machine-shaped text. Android here; web loads the same files
      // through src/styles/bundled-fonts.web.ts.
      [
        "expo-font",
        {
          android: {
            fonts: [
              {
                fontFamily: "D2Coding",
                fontDefinitions: [
                  { path: "./assets/fonts/D2Coding-Regular.ttf", weight: 400 },
                  { path: "./assets/fonts/D2Coding-Bold.ttf", weight: 700 },
                ],
              },
            ],
          },
        },
      ],
      ...buildProfile.cameraPlugins,
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#050506",
          dark: {
            backgroundColor: "#050506",
          },
        },
      ],
      ...buildProfile.notificationPlugins,
      "expo-audio",
      [
        "expo-gradle-jvmargs",
        {
          xmx: "4096m",
          maxMetaspace: "1024m",
        },
      ],
      [
        "expo-build-properties",
        {
          android: {
            minSdkVersion: 29,
            kotlinVersion: "2.1.20",
            // Allow HTTP connections for local network hosts in release builds
            usesCleartextTraffic: true,
          },
        },
      ],
      ...buildProfile.fdroidPlugins,
      ...(isProfileBuild ? [withAndroidProfileable] : []),
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
      autolinkingModuleResolution: true,
    },
    extra: {
      fdroidBuild: isFdroidBuild,
      profileBuild: isProfileBuild,
      directFcmPush: variant.directFcmPush === true,
      ...(appVariant === "personal" && process.env.DASEO_SOURCE_COMMIT
        ? { daseoSourceCommit: process.env.DASEO_SOURCE_COMMIT }
        : {}),
      router: {},
      eas: {
        projectId: "0e7f65ce-0367-46c8-a238-2b65963d235a",
      },
    },
    owner: "getpaseo",
  },
};
