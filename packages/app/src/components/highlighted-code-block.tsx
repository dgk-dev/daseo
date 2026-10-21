import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownTextSpan } from "@/components/markdown-text";
import * as Clipboard from "expo-clipboard";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { HighlightToken } from "@getpaseo/highlight";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Button } from "@/components/ui/button";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { highlightToKeyedLines, type KeyedLine } from "@/utils/highlight-cache";
import {
  markdownCopyCodeBlockDataSet,
  markdownCopyDataSet,
  TRAILING_CODE_LINE_BREAKS,
} from "@/assistant-selection-copy/markup";

interface HighlightedCodeBlockProps {
  code: string;
  language: string | null | undefined;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

// Fence info strings ("```ts", "```typescript", "```ts {1,3}") map to the
// extension-based parser table in @getpaseo/highlight. Aliases here only
// cover names that don't already match an extension key in parsers.ts.
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  objc: "m",
  "objective-c": "m",
  markdown: "md",
  elixir: "ex",
};

function fenceLanguageToExtension(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  const normalized = first.replace(/^\./, "");
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

// A block longer than this opens folded at its first CODE_FOLD_VISIBLE_LINES lines, so one long
// file dump does not push the rest of the answer screens away (the Ovis/herdr web UI rule: past
// 30 lines, show 20 behind "Show all N lines"). Copy always takes the whole block.
const CODE_FOLD_THRESHOLD_LINES = 30;
const CODE_FOLD_VISIBLE_LINES = 20;
const FOLDED_STATE = { expanded: false } as const;
const UNFOLDED_STATE = { expanded: true } as const;

function stripTerminalFenceNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

export const HighlightedCodeBlock = React.memo(function HighlightedCodeBlock({
  code,
  language,
  inheritedStyles,
  textStyle,
}: HighlightedCodeBlockProps) {
  // Box styles (bg / padding / border / radius / margin) go on the wrapper View
  // so the absolute copy button positions relative to the visible code area,
  // not to a parent that includes the Text's own marginVertical.
  const { containerStyle, innerTextStyle } = useMemo(
    () => splitFenceStyle(inheritedStyles, textStyle),
    [inheritedStyles, textStyle],
  );
  const renderedCode = useMemo(() => stripTerminalFenceNewline(code), [code]);
  const copyDataSet = useMemo(
    () => ({ ...CODE_SURFACE_DATASET, ...markdownCopyCodeBlockDataSet(language) }),
    [language],
  );

  const keyedLines = useMemo<KeyedLine[] | null>(
    () => highlightToKeyedLines(renderedCode, fenceLanguageToExtension(language)),
    [renderedCode, language],
  );
  const codeLines = useMemo(() => renderedCode.split("\n"), [renderedCode]);
  const lineCount = codeLines.length;
  const isFoldable = lineCount > CODE_FOLD_THRESHOLD_LINES;
  const [isUnfolded, setIsUnfolded] = useState(false);
  const isFolded = isFoldable && !isUnfolded;
  const toggleFold = useCallback(() => setIsUnfolded((previous) => !previous), []);

  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const controlsVisible = isHovered || isNative || isCompact;
  // Copy the code without its trailing blank lines. A fence body ends in a newline,
  // and ends in more than one when the author left a blank line before the closing
  // fence; pasting any of them into a terminal runs the last line.
  const getCode = useCallback(() => code.replace(TRAILING_CODE_LINE_BREAKS, ""), [code]);

  return (
    <View
      style={containerStyle}
      dataSet={copyDataSet}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {keyedLines ? (
        <MarkdownTextSpan style={innerTextStyle} copyTag="code">
          {renderCodeSegments(isFolded ? keyedLines.slice(0, CODE_FOLD_VISIBLE_LINES) : keyedLines)}
        </MarkdownTextSpan>
      ) : (
        <MarkdownTextSpan style={innerTextStyle} copyTag="code">
          {isFolded ? codeLines.slice(0, CODE_FOLD_VISIBLE_LINES).join("\n") : renderedCode}
        </MarkdownTextSpan>
      )}
      {isFoldable ? (
        <CodeFoldToggle isFolded={isFolded} lineCount={lineCount} onToggle={toggleFold} />
      ) : null}
      <CopyButton getCode={getCode} visible={controlsVisible} />
    </View>
  );
});

function renderCodeSegments(keyedLines: KeyedLine[]): React.ReactNode[] {
  const segments: React.ReactNode[] = [];
  for (let lineIndex = 0; lineIndex < keyedLines.length; lineIndex += 1) {
    const line = keyedLines[lineIndex];
    if (lineIndex > 0) {
      segments.push(<CodeTextSpan key={`${line.key}-newline`} text={"\n"} />);
    }
    for (const { key, token } of line.tokens) {
      segments.push(<TokenSpan key={`${line.key}-${key}`} token={token} />);
    }
  }
  return segments;
}

interface TokenSpanProps {
  token: HighlightToken;
}

const TokenSpan = React.memo(function TokenSpan({ token }: TokenSpanProps) {
  return (
    <MarkdownTextSpan style={token.style ? syntaxTokenStyleFor(token.style) : undefined}>
      {token.text}
    </MarkdownTextSpan>
  );
});

interface CodeTextSpanProps {
  text: string;
}

const CodeTextSpan = React.memo(function CodeTextSpan({ text }: CodeTextSpanProps) {
  return <MarkdownTextSpan>{text}</MarkdownTextSpan>;
});

interface SplitStyles {
  containerStyle: StyleProp<ViewStyle>;
  innerTextStyle: StyleProp<TextStyle>;
}

const CONTAINER_BASE: ViewStyle = { position: "relative" };
const WEB_SELECTABLE: TextStyle = isWeb ? ({ userSelect: "text" } as TextStyle) : {};

function splitFenceStyle(inheritedStyles: TextStyle, textStyle: TextStyle): SplitStyles {
  const { fontFamily, fontSize, color, ...box } = textStyle;
  const textOnly: TextStyle = { ...WEB_SELECTABLE };
  if (fontFamily !== undefined) textOnly.fontFamily = fontFamily;
  if (fontSize !== undefined) textOnly.fontSize = fontSize;
  if (fontSize !== undefined) textOnly.lineHeight = Math.round(fontSize * 1.45);
  if (color !== undefined) textOnly.color = color;
  return {
    containerStyle: [box as ViewStyle, CONTAINER_BASE],
    innerTextStyle: [inheritedStyles, textOnly],
  };
}

interface CodeFoldToggleProps {
  isFolded: boolean;
  lineCount: number;
  onToggle: () => void;
}

const CodeFoldToggle = React.memo(function CodeFoldToggle({
  isFolded,
  lineCount,
  onToggle,
}: CodeFoldToggleProps) {
  const { t } = useTranslation();
  return (
    <View style={codeFoldStyles.row} dataSet={markdownCopyDataSet.ignore}>
      <Button
        variant="ghost"
        size="xs"
        leftIcon={isFolded ? ChevronDown : ChevronUp}
        onPress={onToggle}
        accessibilityState={isFolded ? FOLDED_STATE : UNFOLDED_STATE}
        testID="code-block-fold-toggle"
        style={codeFoldStyles.button}
      >
        {isFolded
          ? t("message.actions.showAllLines", { count: lineCount })
          : t("message.actions.showLess")}
      </Button>
    </View>
  );
});

const codeFoldStyles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    marginTop: theme.spacing[2],
  },
  button: {
    // The icon sits on the code's left rail; the xs padding grows the hit area outward from it.
    marginLeft: -theme.spacing[3],
  },
}));

interface CopyButtonProps {
  getCode: () => string;
  visible: boolean;
}

const COPIED_RESET_MS = 1500;

const CopyButton = React.memo(function CopyButton({ getCode, visible }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const handlePress = useCallback(async () => {
    const content = getCode();
    if (!content) return;
    await Clipboard.setStringAsync(content);
    setCopied(true);
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => {
      setCopied(false);
      resetRef.current = null;
    }, COPIED_RESET_MS);
  }, [getCode]);

  const visibilityStyle = visible
    ? copyButtonStyles.containerVisible
    : copyButtonStyles.containerHidden;
  const wrapperStyle = useMemo(
    () => [copyButtonStyles.container, visibilityStyle],
    [visibilityStyle],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={wrapperStyle}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityRole="button"
      accessibilityLabel={copied ? t("message.actions.copied") : t("message.actions.copyCode")}
      hitSlop={8}
      dataSet={markdownCopyDataSet.ignore}
    >
      {({ hovered }) => {
        const iconColor = hovered
          ? copyButtonStyles.iconHoveredColor.color
          : copyButtonStyles.iconColor.color;
        return copied ? (
          <Check size={14} color={iconColor} />
        ) : (
          <Copy size={14} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const copyButtonStyles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    padding: theme.spacing[1],
  },
  containerVisible: {
    opacity: 1,
  },
  containerHidden: {
    opacity: 0,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));
