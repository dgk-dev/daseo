package sh.paseo.dgkbraillespinner

import android.graphics.Color
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Daseo: the braille spinner's native dots on Android; see DaseoBrailleSpinnerView. */
class DaseoBrailleSpinnerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DaseoBrailleSpinner")

    View(DaseoBrailleSpinnerView::class) {
      Prop("spinning") { view: DaseoBrailleSpinnerView, spinning: Boolean ->
        view.setSpinning(spinning)
      }
      Prop("color") { view: DaseoBrailleSpinnerView, color: Color ->
        view.setDotColor(color.toArgb())
      }
    }
  }
}
