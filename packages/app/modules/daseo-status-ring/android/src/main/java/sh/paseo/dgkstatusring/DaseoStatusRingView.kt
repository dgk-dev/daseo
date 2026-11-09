package sh.paseo.dgkstatusring

import android.content.Context
import android.graphics.Canvas
import android.graphics.drawable.AnimatedVectorDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.SystemClock
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * Daseo delta 88: the running ring's turning quarter on Android.
 *
 * The quarter is an AnimatedVectorDrawable, which since API 25 animates on the RenderThread:
 * once started, each frame of the turn is produced there, so the main thread does not traverse
 * the window, the composer's cursor-position pre-draw listener does not run, and Reanimated's
 * frame callback is not scheduled. Before this, the rotation was a Reanimated style updated on
 * the UI thread every frame (85% of the main thread's time with a finished conversation open).
 *
 * Phase: every Android ring turns in step on one 900 ms clock (SystemClock.uptimeMillis). A
 * drawable animation cannot start mid-turn, so a ring starts at the next quarter boundary of
 * that clock (at most 225 ms) with its drawing turned by that many quarters. Whole quarter
 * turns move the vector's cached bitmap pixel for pixel; any other static angle would resample
 * it and soften the arc against React Native's border drawing.
 *
 * The ring turns only while JS says so (`spinning`: its retained panel is visible and reduce
 * motion is off) and while the view is actually visible: window hidden, app in the background,
 * an ancestor hidden, or detached all stop it and reset it to the resting angle.
 */
class DaseoStatusRingView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val arc: AnimatedVectorDrawable =
    checkNotNull(context.getDrawable(R.drawable.daseo_status_ring_arc)).mutate() as AnimatedVectorDrawable
  private var spinningRequested = false
  private var aggregatedVisible = false
  private var turning = false
  private var quarterTurns = 0
  private val startOnQuarter = Runnable {
    if (turning) {
      arc.start()
    }
  }

  init {
    setWillNotDraw(false)
    arc.callback = this
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      // Daseo delta 88: the ring needs no more than 60 frames a second. A view's vote never
      // lowers the window below what other content asks for (the highest vote wins).
      requestedFrameRate = RING_FRAME_RATE
    }
  }

  fun setSpinning(spinning: Boolean) {
    spinningRequested = spinning
    update()
  }

  fun setArcColor(color: Int) {
    arc.setTint(color)
    invalidate()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    aggregatedVisible = isVisible
    update()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    update()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    update()
  }

  override fun onDetachedFromWindow() {
    stopTurning()
    super.onDetachedFromWindow()
  }

  override fun verifyDrawable(who: Drawable): Boolean = who === arc || super.verifyDrawable(who)

  override fun hasOverlappingRendering(): Boolean = false

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    arc.setBounds(0, 0, width, height)
    if (quarterTurns == 0) {
      arc.draw(canvas)
      return
    }
    val checkpoint = canvas.save()
    canvas.rotate(quarterTurns * 90f, width / 2f, height / 2f)
    arc.draw(canvas)
    canvas.restoreToCount(checkpoint)
  }

  private fun update() {
    val shouldTurn =
      spinningRequested &&
        aggregatedVisible &&
        isAttachedToWindow &&
        windowVisibility == VISIBLE
    if (shouldTurn) startTurning() else stopTurning()
  }

  private fun startTurning() {
    if (turning) {
      return
    }
    turning = true
    val phaseMs = SystemClock.uptimeMillis() % RING_PERIOD_MS
    val quarterMs = RING_PERIOD_MS / 4
    quarterTurns = ((phaseMs / quarterMs + 1) % 4).toInt()
    invalidate()
    postDelayed(startOnQuarter, quarterMs - phaseMs % quarterMs)
  }

  private fun stopTurning() {
    if (!turning) {
      return
    }
    turning = false
    removeCallbacks(startOnQuarter)
    arc.reset()
    quarterTurns = 0
    invalidate()
  }

  companion object {
    /** STATUS_RING_PERIOD_MS in src/components/status-ring/geometry.ts. */
    const val RING_PERIOD_MS = 900L
    const val RING_FRAME_RATE = 60f
  }
}
