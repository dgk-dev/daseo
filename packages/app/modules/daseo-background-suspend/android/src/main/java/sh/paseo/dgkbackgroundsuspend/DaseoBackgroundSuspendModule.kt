package sh.paseo.dgkbackgroundsuspend

import android.content.ComponentCallbacks2
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.ReactApplication
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Daseo delta 86: the native half of the background suspend (`src/runtime/background-suspend`).
 *
 * - A one-shot timer that fires while the Activity is paused. React Native's JS timers run on
 *   Choreographer frames and stop at onHostPause (JavaTimerManager), so a JS `setTimeout`
 *   started when the app leaves the screen never fires until the app returns. A main-looper
 *   Handler keeps running while the process is alive and not frozen, and module events reach
 *   JS without a frame.
 * - `releaseMemory` asks the JS VM to collect once the app is suspended. React Native collects
 *   only on TRIM_MEMORY_BACKGROUND or worse, which an app left on top with the screen off never
 *   receives, so stale Fabric shadow-node revisions (delta 63) stay alive while nothing is on
 *   screen. Measured on the Fold 7 (0.5.97, 9.7 h process): native heap 360 → 267 MB.
 */
class DaseoBackgroundSuspendModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  // `schedule`/`cancel` run on the JS thread, the runnables on the main thread.
  private val pending = HashMap<Int, Runnable>()

  override fun definition() = ModuleDefinition {
    Name("DaseoBackgroundSuspend")

    Events(FIRE_EVENT)

    Function("schedule") { id: Int, delayMs: Double ->
      cancel(id)
      val runnable =
          object : Runnable {
            override fun run() {
              val current =
                  synchronized(pending) {
                    if (pending[id] === this) pending.remove(id) != null else false
                  }
              if (current) sendEvent(FIRE_EVENT, mapOf("id" to id))
            }
          }
      synchronized(pending) { pending[id] = runnable }
      handler.postDelayed(runnable, delayMs.toLong().coerceAtLeast(0L))
    }

    Function("cancel") { id: Int -> cancel(id) }

    Function("releaseMemory") {
      val application = appContext.reactContext?.applicationContext as? ReactApplication
      val router = application?.reactHost?.memoryPressureRouter ?: return@Function
      val before = Debug.getNativeHeapAllocatedSize()
      // Same level and path as DaseoMemoryGuard (delta 63).
      handler.post { router.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) }
      handler.postDelayed(
          {
            val after = Debug.getNativeHeapAllocatedSize()
            Log.i(TAG, "suspended: native heap ${before / MB} -> ${after / MB} MB")
          },
          AFTER_RELEASE_SAMPLE_MS,
      )
    }

    OnDestroy {
      handler.removeCallbacksAndMessages(null)
      synchronized(pending) { pending.clear() }
    }
  }

  private fun cancel(id: Int) {
    synchronized(pending) { pending.remove(id) }?.let { handler.removeCallbacks(it) }
  }

  private companion object {
    const val TAG = "DaseoBackgroundSuspend"
    const val FIRE_EVENT = "onFire"
    const val AFTER_RELEASE_SAMPLE_MS = 3_000L
    const val MB = 1024 * 1024
  }
}
