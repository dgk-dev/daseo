import { Asset } from "expo-asset";

// Daseo delta 51: web and Electron draw the interface in Pretendard and code and
// machine-shaped text in NAVER's D2Coding, whose Hangul sits on the same grid as its
// Latin, so Mac and Windows render Korean the same way and a mono line of mixed Korean
// and Latin keeps its columns. Both are SIL OFL 1.1 (assets/fonts); the files ship
// unmodified, in their released formats.
const STYLE_ID = "daseo-bundled-fonts";

function fontUri(moduleId: number): string {
  return Asset.fromModule(moduleId).uri;
}

export function installBundledFonts(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const pretendard = fontUri(require("../../assets/fonts/PretendardVariable.woff2"));
  const monoRegular = fontUri(require("../../assets/fonts/D2Coding-Regular.ttf"));
  const monoBold = fontUri(require("../../assets/fonts/D2Coding-Bold.ttf"));
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
@font-face {
  font-family: "Pretendard Variable";
  font-weight: 45 920;
  font-style: normal;
  font-display: swap;
  src: url("${pretendard}") format("woff2-variations");
}
@font-face {
  font-family: "D2Coding";
  font-weight: 100 549;
  font-style: normal;
  font-display: swap;
  src: url("${monoRegular}") format("truetype");
}
@font-face {
  font-family: "D2Coding";
  font-weight: 550 900;
  font-style: normal;
  font-display: swap;
  src: url("${monoBold}") format("truetype");
}
`;
  document.head.appendChild(style);
}
