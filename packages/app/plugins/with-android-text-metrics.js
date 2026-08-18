const { withAndroidStyles } = require("expo/config-plugins");

const APP_THEME_NAME = "AppTheme";
const TEXT_VIEW_STYLE_NAME = "PaseoTextViewStyle";
const TEXT_VIEW_STYLE_PARENT = "Widget.AppCompat.TextView";
const TEXT_VIEW_STYLE_ITEM = "android:textViewStyle";
const USE_BOUNDS_FOR_WIDTH_ITEM = "android:useBoundsForWidth";

function findStyle(resources, name) {
  return resources.style?.find((style) => style.$?.name === name);
}

function upsertStyleItem(style, name, value, attributes = {}) {
  style.item ??= [];
  const existing = style.item.find((item) => item.$?.name === name);
  if (existing) {
    existing._ = value;
    existing.$ = { ...existing.$, ...attributes, name };
    return;
  }

  style.item.push({
    _: value,
    $: { ...attributes, name },
  });
}

function configureAndroidTextMetrics(styles) {
  const resources = styles.resources;
  if (!resources) {
    throw new Error("Could not configure Android text metrics without style resources");
  }

  const appTheme = findStyle(resources, APP_THEME_NAME);
  if (!appTheme) {
    throw new Error(`Could not configure Android text metrics without ${APP_THEME_NAME}`);
  }

  resources.style ??= [];
  let textViewStyle = findStyle(resources, TEXT_VIEW_STYLE_NAME);
  if (!textViewStyle) {
    textViewStyle = {
      $: { name: TEXT_VIEW_STYLE_NAME, parent: TEXT_VIEW_STYLE_PARENT },
      item: [],
    };
    resources.style.push(textViewStyle);
  } else {
    textViewStyle.$ = {
      ...textViewStyle.$,
      name: TEXT_VIEW_STYLE_NAME,
      parent: TEXT_VIEW_STYLE_PARENT,
    };
  }

  // COMPAT(android-text-bounds): added in v0.4, remove after 2027-08-01 once
  // React Native #56402 ships a stable Android 15+ measurement fix and the
  // API 35/36 folded-device matrix passes without this TextView override.
  // RN 0.81 measures advance width while targetSdk 35+ TextView renders with
  // visual glyph bounds. Keep both sides on advance width so a rendered wrap
  // cannot exceed Yoga's measured line count and clip the final line.
  upsertStyleItem(textViewStyle, USE_BOUNDS_FOR_WIDTH_ITEM, "false", {
    "tools:targetApi": "35",
  });
  upsertStyleItem(appTheme, TEXT_VIEW_STYLE_ITEM, `@style/${TEXT_VIEW_STYLE_NAME}`);

  return styles;
}

function withAndroidTextMetrics(config) {
  return withAndroidStyles(config, (modConfig) => {
    modConfig.modResults = configureAndroidTextMetrics(modConfig.modResults);
    return modConfig;
  });
}

module.exports = withAndroidTextMetrics;
module.exports.configureAndroidTextMetrics = configureAndroidTextMetrics;
