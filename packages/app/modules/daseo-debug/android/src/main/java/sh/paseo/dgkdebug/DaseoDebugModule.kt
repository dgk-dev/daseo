package sh.paseo.dgkdebug

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.TimeUnit

/**
 * Daseo delta 68: the app reads its own logs so the Mac can pull them over the app's own
 * connection, without wireless ADB. An unprivileged app's `logcat` returns only lines written
 * by its own UID (logd LogPermissions: "they can only read entries from their UID"), so this
 * covers every Daseo process (main and :assistant) and nothing else on the device.
 */
class DaseoDebugModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DaseoDebug")

    AsyncFunction("collectLogcat") { maxLines: Int, maxChars: Int ->
      collectLogcat(maxLines.coerceIn(1, 20_000), maxChars.coerceIn(1_000, 1_000_000))
    }

    AsyncFunction("collectExitInfo") { maxTraceChars: Int ->
      val context = appContext.reactContext ?: return@AsyncFunction emptyList<Map<String, Any?>>()
      collectExitInfo(context, maxTraceChars.coerceIn(0, 200_000))
    }
  }

  private fun collectLogcat(maxLines: Int, maxChars: Int): String {
    val process =
        ProcessBuilder("logcat", "-d", "-v", "threadtime", "-t", maxLines.toString())
            .redirectErrorStream(true)
            .start()
    // `-d` exits after the dump; the watchdog only guards a logd that never answers.
    val watchdog = Thread {
      try {
        if (!process.waitFor(LOGCAT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) process.destroy()
      } catch (_: InterruptedException) {}
    }
    watchdog.isDaemon = true
    watchdog.start()
    val output = process.inputStream.bufferedReader().use { it.readText() }
    watchdog.interrupt()
    return if (output.length > maxChars) output.takeLast(maxChars) else output
  }

  private fun collectExitInfo(context: Context, maxTraceChars: Int): List<Map<String, Any?>> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
    val manager = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
    return manager.getHistoricalProcessExitReasons(context.packageName, 0, MAX_EXITS).map { info ->
      val trace =
          if (maxTraceChars > 0 && info.reason == ApplicationExitInfo.REASON_ANR) {
            try {
              info.traceInputStream?.bufferedReader()?.use { reader ->
                val text = reader.readText()
                if (text.length > maxTraceChars) text.take(maxTraceChars) else text
              }
            } catch (_: Exception) {
              null
            }
          } else {
            null
          }
      mapOf(
          "at" to info.timestamp.toDouble(),
          "reason" to reasonName(info.reason),
          "processName" to info.processName,
          "description" to
              listOfNotNull(
                      info.description,
                      "status=${info.status}",
                      "pss=${info.pss}kB rss=${info.rss}kB",
                      if (info.reason == ApplicationExitInfo.REASON_CRASH_NATIVE)
                          "native tombstone kept by the system (protobuf, not decoded)"
                      else null,
                  )
                  .joinToString("; ")
                  .take(2000),
          "trace" to trace,
      )
    }
  }

  private fun reasonName(reason: Int): String =
      when (reason) {
        ApplicationExitInfo.REASON_ANR -> "anr"
        ApplicationExitInfo.REASON_CRASH -> "crash"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash_native"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency_died"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive_resource_usage"
        ApplicationExitInfo.REASON_EXIT_SELF -> "exit_self"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialization_failure"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
        ApplicationExitInfo.REASON_OTHER -> "other"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission_change"
        ApplicationExitInfo.REASON_SIGNALED -> "signaled"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "user_requested"
        ApplicationExitInfo.REASON_USER_STOPPED -> "user_stopped"
        else -> "reason_$reason"
      }

  private companion object {
    const val LOGCAT_TIMEOUT_SECONDS = 8L
    const val MAX_EXITS = 5
  }
}
