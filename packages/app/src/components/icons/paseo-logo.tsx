import Svg, { Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";
import { DASEO_LOGO_PATH, DASEO_LOGO_VIEW_BOX } from "./daseo-logo-path.generated";

export { DASEO_LOGO_PATH } from "./daseo-logo-path.generated";

interface PaseoLogoProps {
  size?: number;
  color?: string;
}

export function PaseoLogo({ size = 64, color }: PaseoLogoProps) {
  const { theme } = useUnistyles();
  const fill = color ?? theme.colors.foreground;

  return (
    <Svg width={size} height={size} viewBox={DASEO_LOGO_VIEW_BOX} fill="none">
      <Path d={DASEO_LOGO_PATH} fill={fill} fillRule="evenodd" clipRule="evenodd" />
    </Svg>
  );
}
