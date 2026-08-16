import Svg, { Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";

interface PaseoLogoProps {
  size?: number;
  color?: string;
}

export const DASEO_LOGO_PATH =
  "M110 150H170C230 150 265 190 265 256C265 322 230 362 170 362H110V150ZM153 193V319H168C202 319 222 297 222 256C222 215 202 193 168 193H153Z M270 362L316 150H356L402 362H359L336 220L313 362H270Z";

export function PaseoLogo({ size = 64, color }: PaseoLogoProps) {
  const { theme } = useUnistyles();
  const fill = color ?? theme.colors.foreground;

  return (
    <Svg width={size} height={size} viewBox="0 0 512 512" fill="none">
      <Path d={DASEO_LOGO_PATH} fill={fill} fillRule="evenodd" clipRule="evenodd" />
    </Svg>
  );
}
