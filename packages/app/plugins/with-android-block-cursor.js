const fs = require("node:fs");
const path = require("node:path");
const { withAndroidStyles, withDangerousMod } = require("expo/config-plugins");

// Daseo delta 55: text fields draw a terminal block cursor instead of the thin I-beam. The
// cursor is a drawable on the app theme, so every EditText (the composer's paste input
// included) uses it; React Native's cursor/selection color tints it.
const DRAWABLE_NAME = "daseo_block_cursor";
const APP_THEME_NAME = "AppTheme";
const CURSOR_ITEM = "android:textCursorDrawable";

// A translucent block keeps the glyph under the cursor readable.
const DRAWABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <size android:width="9dp" />
    <solid android:color="#B37AA2F7" />
</shape>
`;

function withBlockCursorDrawable(config) {
  return withDangerousMod(config, [
    "android",
    async (modConfig) => {
      const directory = path.join(
        modConfig.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "drawable",
      );
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `${DRAWABLE_NAME}.xml`), DRAWABLE_XML);
      return modConfig;
    },
  ]);
}

function configureBlockCursor(styles) {
  const appTheme = styles.resources?.style?.find((style) => style.$?.name === APP_THEME_NAME);
  if (!appTheme) throw new Error(`Could not configure the block cursor without ${APP_THEME_NAME}`);
  appTheme.item ??= [];
  const existing = appTheme.item.find((item) => item.$?.name === CURSOR_ITEM);
  if (existing) existing._ = `@drawable/${DRAWABLE_NAME}`;
  else appTheme.item.push({ _: `@drawable/${DRAWABLE_NAME}`, $: { name: CURSOR_ITEM } });
  return styles;
}

function withAndroidBlockCursor(config) {
  const withDrawable = withBlockCursorDrawable(config);
  return withAndroidStyles(withDrawable, (modConfig) => {
    modConfig.modResults = configureBlockCursor(modConfig.modResults);
    return modConfig;
  });
}

module.exports = withAndroidBlockCursor;
module.exports.configureBlockCursor = configureBlockCursor;
