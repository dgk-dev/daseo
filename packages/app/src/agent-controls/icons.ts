import { createElement, type ComponentType } from "react";
import {
  Bot,
  Brain,
  ListTodo,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
  Zap,
  ZapOff,
} from "lucide-react-native";
import type { AgentFeatureToggle } from "@getpaseo/protocol/agent-types";
import { getModeVisuals, type AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { resolveFeatureToggleIconName } from "@/agent-controls/policy";

export interface AgentControlIconProps {
  size: number;
  color: string;
}

export type AgentControlIcon = ComponentType<AgentControlIconProps>;

export const ThinkingIcon = Brain;
export const PlanModeIcon = ListTodo;

const MODE_ICONS: Record<string, AgentControlIcon> = {
  Bot,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
};

const FilledZap: AgentControlIcon = ({ size, color }) =>
  createElement(Zap, { size, color, fill: color });

const FEATURE_ICONS: Record<string, AgentControlIcon> = {
  "list-todo": ListTodo,
  "shield-check": ShieldCheck,
  zap: Zap,
  "zap-filled": FilledZap,
  "zap-off": ZapOff,
};

export function getAgentModeIcon(
  provider: string,
  modeId: string,
  providerDefinitions: AgentProviderDefinition[],
): AgentControlIcon {
  const icon = getModeVisuals(provider, modeId, providerDefinitions)?.icon;
  return (icon ? MODE_ICONS[icon] : undefined) ?? Bot;
}

export function getAgentModeOptionIcon(
  provider: string,
  modeId: string,
  providerDefinitions: AgentProviderDefinition[],
): AgentControlIcon | undefined {
  const icon = getModeVisuals(provider, modeId, providerDefinitions)?.icon;
  return icon ? MODE_ICONS[icon] : undefined;
}

export function getAgentFeatureIcon(icon?: string): AgentControlIcon {
  return (icon ? FEATURE_ICONS[icon] : undefined) ?? Settings2;
}

export function getAgentFeatureToggleIcon(
  feature: Pick<AgentFeatureToggle, "id" | "icon" | "value">,
): AgentControlIcon {
  return getAgentFeatureIcon(resolveFeatureToggleIconName(feature));
}
