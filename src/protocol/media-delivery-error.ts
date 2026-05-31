export type ChannelMediaErrorStage = "resolve" | "validate" | "upload" | "send" | "permission" | "link" | "list" | "download";

export class ChannelMediaDeliveryError extends Error {
  readonly stage: ChannelMediaErrorStage;
  readonly reasonCode: string;

  constructor(message: string, options: { stage: ChannelMediaErrorStage; reasonCode: string; cause?: unknown }) {
    super(message);
    this.name = "ChannelMediaDeliveryError";
    this.stage = options.stage;
    this.reasonCode = options.reasonCode;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isChannelMediaDeliveryError(error: unknown): error is ChannelMediaDeliveryError {
  return error instanceof ChannelMediaDeliveryError;
}
