import { describe, expect, it } from "vitest";

const {
  addAssistantEntryToManifest,
  buildRecognitionServiceXml,
  buildShortcutsXml,
  buildVoiceInteractionXml,
  patchMainActivity,
  patchMainApplication,
} = require("./with-android-assistant-entry");

interface ManifestNode {
  $: Record<string, string>;
  [child: string]: unknown;
}

function baseManifest() {
  return {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      application: [
        {
          $: { "android:name": ".MainApplication" },
          activity: [
            { $: { "android:name": ".MainActivity", "android:launchMode": "singleTask" } },
          ],
        },
      ],
    },
  };
}

function byName(list: ManifestNode[] | undefined, name: string): ManifestNode | undefined {
  return list?.find((node) => node.$["android:name"] === name);
}

describe("withAndroidAssistantEntry", () => {
  it("declares the ASSIST alias, the voice-interaction triple and the shortcut metadata", () => {
    const { manifest } = baseManifest();
    addAssistantEntryToManifest(manifest);
    const application = manifest.application[0] as unknown as Record<string, ManifestNode[]>;

    const alias = byName(application["activity-alias"], ".DaseoAssistActivity");
    expect(alias?.$).toMatchObject({
      "android:targetActivity": ".MainActivity",
      "android:exported": "true",
    });
    expect(JSON.stringify(alias)).toContain("android.intent.action.ASSIST");
    expect(JSON.stringify(alias)).toContain("android.intent.category.DEFAULT");

    const voice = byName(application.service, ".DaseoVoiceInteractionService");
    expect(voice?.$).toEqual({
      "android:name": ".DaseoVoiceInteractionService",
      "android:permission": "android.permission.BIND_VOICE_INTERACTION",
      "android:exported": "true",
      "android:process": ":assistant",
    });
    expect(JSON.stringify(voice)).toContain("android.service.voice.VoiceInteractionService");
    expect(JSON.stringify(voice)).toContain('"android:name":"android.voice_interaction"');
    expect(JSON.stringify(voice)).toContain("@xml/daseo_voice_interaction_service");

    const session = byName(application.service, ".DaseoVoiceInteractionSessionService");
    expect(session?.$["android:permission"]).toBe("android.permission.BIND_VOICE_INTERACTION");

    const recognizer = byName(application.service, ".DaseoRecognitionService");
    expect(JSON.stringify(recognizer)).toContain("android.speech.RecognitionService");
    expect(JSON.stringify(recognizer)).toContain("@xml/daseo_recognition_service");

    const mainActivity = byName(application.activity, ".MainActivity") as ManifestNode;
    expect(JSON.stringify(mainActivity["meta-data"])).toContain("@xml/daseo_shortcuts");
    const trampoline = byName(application.activity, ".DaseoQuickAskTrampolineActivity");
    expect(trampoline?.$).toMatchObject({
      "android:exported": "false",
      "android:process": ":assistant",
      "android:showWhenLocked": "true",
      "android:excludeFromRecents": "true",
    });
  });

  it("is idempotent across repeated prebuilds", () => {
    const { manifest } = baseManifest();
    addAssistantEntryToManifest(manifest);
    addAssistantEntryToManifest(manifest);
    const application = manifest.application[0] as unknown as Record<string, ManifestNode[]>;
    expect(application["activity-alias"]).toHaveLength(1);
    expect(application.service).toHaveLength(3);
    expect(
      (byName(application.activity, ".MainActivity") as ManifestNode)["meta-data"],
    ).toHaveLength(1);
  });

  it("writes resources that point at the package's own classes and the quick-ask URL", () => {
    const voice = buildVoiceInteractionXml("sh.paseo.dgk");
    expect(voice).toContain(
      'android:sessionService="sh.paseo.dgk.DaseoVoiceInteractionSessionService"',
    );
    expect(voice).toContain('android:recognitionService="sh.paseo.dgk.DaseoRecognitionService"');
    expect(voice).toContain('android:supportsAssist="true"');
    expect(voice).toContain('android:supportsLaunchVoiceAssistFromKeyguard="true"');
    expect(buildRecognitionServiceXml()).toContain('android:selectableAsDefault="false"');
    const shortcuts = buildShortcutsXml("sh.paseo.dgk");
    expect(shortcuts).toContain('android:data="paseo://quick-ask"');
    expect(shortcuts).toContain('android:targetClass="sh.paseo.dgk.MainActivity"');
  });

  it("rewrites the launch intent in MainActivity before React Native starts", () => {
    const source = [
      "package sh.paseo.dgk",
      "import expo.modules.splashscreen.SplashScreenManager",
      "",
      "import android.os.Build",
      "import android.os.Bundle",
      "",
      "class MainActivity : ReactActivity() {",
      "  override fun onCreate(savedInstanceState: Bundle?) {",
      "    SplashScreenManager.registerOnActivity(this)",
      "    super.onCreate(null)",
      "  }",
      "",
      '  override fun getMainComponentName(): String = "main"',
      "}",
    ].join("\n");
    const patched = patchMainActivity(source);

    expect(patched).toContain(
      "    DaseoQuickAsk.trackForeground(this)\n    DaseoQuickAsk.prepareLaunchIntent(intent, fromForeground = false)\n    super.onCreate(null)\n    DaseoQuickAsk.dismissKeyguardIfLocked(this, intent)",
    );
    expect(patched).toContain(
      "  override fun onNewIntent(intent: Intent) {\n    DaseoQuickAsk.prepareLaunchIntent(intent, DaseoQuickAsk.wasInForeground())\n    super.onNewIntent(intent)",
    );
    expect(patched).toContain("import android.content.Intent\nimport android.os.Bundle");
    expect(patchMainActivity(patched)).toBe(patched);
  });

  it("keeps React Native out of the assistant process", () => {
    const source = [
      "  override fun onCreate() {",
      "    super.onCreate()",
      "    loadReactNative(this)",
      "  }",
    ].join("\n");
    const patched = patchMainApplication(source);
    expect(patched).toContain(
      "    super.onCreate()\n    // Daseo delta 64: the assistant services' process never loads React Native.\n    if (DaseoQuickAsk.isAssistantProcess()) return\n    loadReactNative(this)",
    );
    expect(patchMainApplication(patched)).toBe(patched);
  });
});
