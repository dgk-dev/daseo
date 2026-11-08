package sh.paseo.dgkapplinks

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Daseo delta 85: a web link for a site whose browser page is blocked on the phone (Coupang)
 * opens in that site's app. The VIEW intent names the package, so Android hands it to that app's
 * own link filter even when the app holds no verified App Link for the host, and never to the
 * browser or a chooser. Resolves false when the package is missing or has no activity for the
 * link, so the caller falls back to the browser exactly once.
 */
class DaseoAppLinksModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DaseoAppLinks")

    AsyncFunction("openUrlInPackage") { url: String, packageName: String ->
      val context =
          appContext.currentActivity ?: appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent =
          Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            setPackage(packageName)
            addCategory(Intent.CATEGORY_BROWSABLE)
            // The app runs in its own task, not stacked inside Daseo's.
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
      try {
        context.startActivity(intent)
        true
      } catch (_: ActivityNotFoundException) {
        false
      }
    }
  }
}
