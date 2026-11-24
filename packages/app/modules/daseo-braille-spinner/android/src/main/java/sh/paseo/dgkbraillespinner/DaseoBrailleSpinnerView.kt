package sh.paseo.dgkbraillespinner

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * Daseo: the braille spinner on Android, drawn as dots rather than text (D2Coding has no braille
 * block, so a text glyph would be whatever the system falls back to).
 *
 * The cell is a 2 x 3 dot grid; a frame is a braille dot mask (bit 0 = dot 1, the left column
 * top to bottom, then the right column). All spinners draw `BrailleSpinnerTicker.frame`, so they
 * are in phase, a newly shown one included. A spinner registers with the ticker only while JS
 * says so (`spinning`: its retained panel is visible and reduce motion is off) and while it is
 * really visible: window hidden, app in the background, an ancestor hidden, or detached all
 * unregister it and leave the static all-dots glyph.
 */
class DaseoBrailleSpinnerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private var spinningRequested = false
  private var aggregatedVisible = false
  private var registered = false
  private var radius = 0f
  private var pitch = 0f
  private var originX = 0f
  private var originY = 0f

  init {
    setWillNotDraw(false)
  }

  fun setSpinning(spinning: Boolean) {
    spinningRequested = spinning
    update()
  }

  fun setDotColor(color: Int) {
    paint.color = color
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
    setRegistered(false)
    super.onDetachedFromWindow()
  }

  override fun hasOverlappingRendering(): Boolean = false

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    // The dots fill the middle of the line box like a glyph: the grid is 2.6 dots wide and 4.2
    // dots tall (gaps of 0.6 dot), at most 70% of the cell's height.
    val dot = minOf(w / 2.6f, h * 0.7f / 4.2f)
    radius = dot / 2f
    pitch = dot * 1.6f
    originX = (w - dot * 2.6f) / 2f + radius
    originY = (h - dot * 4.2f) / 2f + radius
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val mask = if (registered) FRAME_MASKS[BrailleSpinnerTicker.frame] else STATIC_MASK
    for (bit in 0 until 6) {
      if ((mask and (1 shl bit)) == 0) continue
      canvas.drawCircle(originX + (bit / 3) * pitch, originY + (bit % 3) * pitch, radius, paint)
    }
  }

  private fun update() {
    setRegistered(
      spinningRequested && aggregatedVisible && isAttachedToWindow && windowVisibility == VISIBLE,
    )
  }

  private fun setRegistered(next: Boolean) {
    if (registered == next) return
    registered = next
    if (next) BrailleSpinnerTicker.register(this) else BrailleSpinnerTicker.unregister(this)
    invalidate()
  }

  companion object {
    /** BRAILLE_SPINNER_FRAME_MS in src/components/braille-spinner/frames.ts. */
    const val FRAME_MS = 100L

    /** BRAILLE_SPINNER_FRAMES (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) as dot masks. */
    val FRAME_MASKS = intArrayOf(0x0B, 0x19, 0x39, 0x38, 0x3C, 0x34, 0x26, 0x27, 0x07, 0x0F)

    /** BRAILLE_SPINNER_STATIC (⠿). */
    const val STATIC_MASK = 0x3F
  }
}
