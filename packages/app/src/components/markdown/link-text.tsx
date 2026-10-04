import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, type StyleProp, type TextStyle } from "react-native";
import { useStableEvent } from "@/hooks/use-stable-event";
import { markdownLinkTextStyle } from "./link-children";

interface MarkdownLinkTextProps {
  style: StyleProp<TextStyle>;
  dataSet?: Record<string, string>;
  onPress(): void;
  onHoverIn?(): void;
  onHoverOut?(): void;
  children?: ReactNode;
}

export function MarkdownLinkText({
  style,
  dataSet,
  onPress,
  onHoverIn,
  onHoverOut,
  children,
}: MarkdownLinkTextProps) {
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useStableEvent(() => {
    setHovered(true);
    onHoverIn?.();
  });
  const handleHoverOut = useStableEvent(() => {
    setHovered(false);
    onHoverOut?.();
  });
  const textStyle = useMemo(() => markdownLinkTextStyle(style, hovered), [hovered, style]);

  return (
    <Pressable
      accessibilityRole="link"
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
    >
      <Text dataSet={dataSet} style={textStyle}>
        {children}
      </Text>
    </Pressable>
  );
}
