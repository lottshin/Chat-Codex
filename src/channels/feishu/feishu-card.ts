import type { ChannelActionMessage, ChannelButton, ChannelButtonStyle, ChannelTarget } from "../../protocol/channel.js";

export interface FeishuActionCard {
  config: {
    wide_screen_mode: boolean;
  };
  elements: Array<FeishuCardMarkdownElement | FeishuCardActionElement>;
}

export interface FeishuCardCommandAction {
  text: string;
  routeKey?: string;
}

interface FeishuCardMarkdownElement {
  tag: "markdown";
  content: string;
}

interface FeishuCardActionElement {
  tag: "action";
  actions: FeishuCardButtonElement[];
}

interface FeishuCardButtonElement {
  tag: "button";
  text: {
    tag: "plain_text";
    content: string;
  };
  type: "primary" | "default" | "danger";
  value: {
    action: string;
    routeKey?: string;
  };
}

export function buildFeishuActionCard(message: ChannelActionMessage, target?: ChannelTarget): FeishuActionCard {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: message.text },
      ...message.buttonGroups
        .filter((group) => group.length > 0)
        .map((group) => ({
          tag: "action" as const,
          actions: group.map((button) => feishuButton(button, target)),
        })),
    ],
  };
}

export function feishuCardActionToCommand(rawAction: unknown): FeishuCardCommandAction | undefined {
  const value = objectField(rawAction, "value") ?? objectField(rawAction, "action") ?? (isObject(rawAction) ? rawAction : undefined);
  const action = stringField(value, "action");
  if (!action?.startsWith("cmd:/")) return undefined;
  return {
    text: action.slice("cmd:".length),
    routeKey: stringField(value, "routeKey"),
  };
}

function feishuButton(button: ChannelButton, target: ChannelTarget | undefined): FeishuCardButtonElement {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: button.text,
    },
    type: feishuButtonType(button.style),
    value: {
      action: button.action,
      ...(target ? { routeKey: target.routeKey } : {}),
    },
  };
}

function feishuButtonType(style: ChannelButtonStyle | undefined): "primary" | "default" | "danger" {
  if (style === "primary" || style === "danger") return style;
  return "default";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}
