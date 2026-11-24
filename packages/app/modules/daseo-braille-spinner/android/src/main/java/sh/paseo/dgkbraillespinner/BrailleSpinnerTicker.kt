package sh.paseo.dgkbraillespinner

import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/**
 * The one clock behind every Android braille spinner. It exists only while at least one spinner
 * is spinning and visible: then it wakes on each 100 ms boundary of `SystemClock.uptimeMillis`,
 * publishes the frame and invalidates exactly those spinners (a draw of a few dots each; no
 * measure or layout). With none registered it posts nothing, so a screen without a visible
 * running spinner costs zero wakeups.
 */
internal object BrailleSpinnerTicker {
  private val handler = Handler(Looper.getMainLooper())
  private val views = LinkedHashSet<DaseoBrailleSpinnerView>()

  /** The frame every registered spinner draws; the same for all of them, so they are in phase. */
  var frame: Int = currentFrame()
    private set

  private val tick =
    object : Runnable {
      override fun run() {
        frame = currentFrame()
        for (view in views) view.invalidate()
        scheduleNext()
      }
    }

  fun register(view: DaseoBrailleSpinnerView) {
    if (!views.add(view)) return
    if (views.size == 1) {
      frame = currentFrame()
      scheduleNext()
    }
  }

  fun unregister(view: DaseoBrailleSpinnerView) {
    if (views.remove(view) && views.isEmpty()) handler.removeCallbacks(tick)
  }

  private fun currentFrame(): Int =
    ((SystemClock.uptimeMillis() / DaseoBrailleSpinnerView.FRAME_MS) %
      DaseoBrailleSpinnerView.FRAME_MASKS.size).toInt()

  private fun scheduleNext() {
    val period = DaseoBrailleSpinnerView.FRAME_MS
    handler.postAtTime(tick, (SystemClock.uptimeMillis() / period + 1) * period)
  }
}
