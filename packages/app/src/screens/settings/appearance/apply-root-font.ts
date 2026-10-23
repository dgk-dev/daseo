// Native: React Native has no global font cascade. Daseo delta 53 patches React Native's
// Text and TextInput (patches/react-native+0.81.5.patch) to use the published family when a
// root text element sets none, so the interface font reaches every screen, not only the
// components that read theme.fontFamily.ui. The web build (apply-root-font.web.ts)
// applies the same font through one CSS rule.
import { setNativeRootFont } from "./native-root-font";

export function applyRootUiFont(uiFontStack: string): void {
  setNativeRootFont(uiFontStack);
}
