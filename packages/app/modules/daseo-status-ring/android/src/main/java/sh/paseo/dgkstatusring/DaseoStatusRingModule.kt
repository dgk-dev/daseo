package sh.paseo.dgkstatusring

import android.graphics.Color
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Daseo delta 88: the native turning quarter of the running ring; see DaseoStatusRingView. */
class DaseoStatusRingModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DaseoStatusRing")

    View(DaseoStatusRingView::class) {
      Prop("spinning") { view: DaseoStatusRingView, spinning: Boolean ->
        view.setSpinning(spinning)
      }
      Prop("color") { view: DaseoStatusRingView, color: Color ->
        view.setArcColor(color.toArgb())
      }
    }
  }
}
