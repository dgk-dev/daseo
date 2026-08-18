import { describe, expect, it } from "vitest";

const { configureAndroidTextMetrics } = require("../../plugins/with-android-text-metrics");

interface AndroidStyleItem {
  _: string;
  $: { name: string; [attribute: string]: string };
}

interface AndroidStyle {
  $: { name: string; parent?: string };
  item?: AndroidStyleItem[];
}

interface AndroidStyles {
  resources: {
    $?: Record<string, string>;
    style?: AndroidStyle[];
  };
}

function createStyles(): AndroidStyles {
  return {
    resources: {
      $: { "xmlns:tools": "http://schemas.android.com/tools" },
      style: [
        {
          $: { name: "AppTheme", parent: "Theme.AppCompat.DayNight.NoActionBar" },
          item: [{ _: "true", $: { name: "android:enforceNavigationBarContrast" } }],
        },
      ],
    },
  };
}

function findStyle(styles: AndroidStyles, name: string): AndroidStyle {
  const style = styles.resources.style?.find((candidate) => candidate.$.name === name);
  if (!style) throw new Error(`Missing style: ${name}`);
  return style;
}

function findItem(style: AndroidStyle, name: string): AndroidStyleItem {
  const item = style.item?.find((candidate) => candidate.$.name === name);
  if (!item) throw new Error(`Missing style item: ${name}`);
  return item;
}

describe("withAndroidTextMetrics", () => {
  it("keeps React Native measurement and Android 15+ TextView wrapping on the same width policy", () => {
    const styles = createStyles();

    configureAndroidTextMetrics(styles);

    const appTheme = findStyle(styles, "AppTheme");
    expect(findItem(appTheme, "android:textViewStyle")).toEqual({
      _: "@style/PaseoTextViewStyle",
      $: { name: "android:textViewStyle" },
    });

    const textViewStyle = findStyle(styles, "PaseoTextViewStyle");
    expect(textViewStyle.$).toEqual({
      name: "PaseoTextViewStyle",
      parent: "Widget.AppCompat.TextView",
    });
    expect(findItem(textViewStyle, "android:useBoundsForWidth")).toEqual({
      _: "false",
      $: {
        name: "android:useBoundsForWidth",
        "tools:targetApi": "35",
      },
    });
    expect(findItem(appTheme, "android:enforceNavigationBarContrast")._).toBe("true");
  });

  it("is idempotent and repairs stale generated values", () => {
    const styles = createStyles();
    styles.resources.style?.push({
      $: { name: "PaseoTextViewStyle", parent: "UnexpectedParent" },
      item: [
        {
          _: "true",
          $: { name: "android:useBoundsForWidth", "tools:targetApi": "34" },
        },
      ],
    });

    configureAndroidTextMetrics(styles);
    configureAndroidTextMetrics(styles);

    expect(
      styles.resources.style?.filter((style) => style.$.name === "PaseoTextViewStyle"),
    ).toHaveLength(1);
    const appTheme = findStyle(styles, "AppTheme");
    expect(appTheme.item?.filter((item) => item.$.name === "android:textViewStyle")).toHaveLength(
      1,
    );
    const textViewStyle = findStyle(styles, "PaseoTextViewStyle");
    expect(textViewStyle.$.parent).toBe("Widget.AppCompat.TextView");
    expect(textViewStyle.item).toEqual([
      {
        _: "false",
        $: {
          name: "android:useBoundsForWidth",
          "tools:targetApi": "35",
        },
      },
    ]);
  });

  it("fails closed when Expo's generated AppTheme contract changes", () => {
    expect(() => configureAndroidTextMetrics({ resources: { style: [] } })).toThrow(
      "Could not configure Android text metrics without AppTheme",
    );
  });
});
