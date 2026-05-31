import { ChannelMediaDeliveryError } from "../../protocol/media-delivery-error.js";
import type {
  FeishuApiResponse,
  FeishuDriveMeta,
  FeishuSdkClient,
} from "./feishu-types.js";

const FEISHU_DRIVE_UPLOAD_ALL_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_DRIVE_BLOCK_SIZE = 4 * 1024 * 1024;

export interface FeishuDriveUploadParams {
  client: FeishuSdkClient;
  folderToken: string;
  fileName: string;
  buffer: Buffer;
}

export interface FeishuDriveUploadResult {
  fileToken: string;
  url: string;
}

export async function uploadFeishuDriveFile(params: FeishuDriveUploadParams): Promise<FeishuDriveUploadResult> {
  const fileToken = params.buffer.length <= FEISHU_DRIVE_UPLOAD_ALL_MAX_BYTES
    ? await uploadDriveFileAll(params)
    : await uploadDriveFileMultipart(params);
  const url = await queryDriveFileUrl(params.client, fileToken);
  return { fileToken, url };
}

export async function grantFeishuDriveFileView(params: {
  client: FeishuSdkClient;
  fileToken: string;
  openId: string;
}): Promise<void> {
  const response = await requestFeishu<FeishuApiResponse>(params.client, {
    method: "POST",
    url: `/open-apis/drive/v1/permissions/${encodeURIComponent(params.fileToken)}/members?type=file`,
    data: {
      member_type: "openid",
      member_id: params.openId,
      perm: "view",
    },
  }, "permission", "feishu_drive_permission_failed");
  assertFeishuOk(response, "permission", "feishu_drive_permission_failed", "飞书云空间文件授权失败");
}

async function uploadDriveFileAll(params: FeishuDriveUploadParams): Promise<string> {
  const response = await callDriveUpload(
    () => driveFileApi(params.client).uploadAll({
      data: {
        file_name: params.fileName,
        parent_type: "explorer",
        parent_node: params.folderToken,
        size: params.buffer.length,
        file: params.buffer,
      },
    }),
    "upload",
    "feishu_drive_upload_failed",
  );
  const token = typeof response?.file_token === "string" && response.file_token.trim() ? response.file_token : undefined;
  if (!token) {
    throw new ChannelMediaDeliveryError("飞书云空间上传响应缺少 file_token", {
      stage: "upload",
      reasonCode: "feishu_drive_upload_missing_file_token",
    });
  }
  return token;
}

async function uploadDriveFileMultipart(params: FeishuDriveUploadParams): Promise<string> {
  const prepared = await callDriveUpload(
    () => driveFileApi(params.client).uploadPrepare({
      data: {
        file_name: params.fileName,
        parent_type: "explorer",
        parent_node: params.folderToken,
        size: params.buffer.length,
      },
    }),
    "upload",
    "feishu_drive_upload_prepare_failed",
  );
  assertFeishuOk(prepared, "upload", "feishu_drive_upload_prepare_failed", "飞书云空间分片上传预处理失败");
  const uploadId = prepared.data?.upload_id;
  const blockSize = prepared.data?.block_size && prepared.data.block_size > 0 ? prepared.data.block_size : DEFAULT_DRIVE_BLOCK_SIZE;
  const blockNum = prepared.data?.block_num && prepared.data.block_num > 0 ? prepared.data.block_num : Math.ceil(params.buffer.length / blockSize);
  if (!uploadId) {
    throw new ChannelMediaDeliveryError("飞书云空间分片上传响应缺少 upload_id", {
      stage: "upload",
      reasonCode: "feishu_drive_upload_id_missing",
    });
  }
  for (let index = 0; index < blockNum; index += 1) {
    const start = index * blockSize;
    const part = params.buffer.subarray(start, Math.min(start + blockSize, params.buffer.length));
    const partResponse = await callDriveUpload(
      () => driveFileApi(params.client).uploadPart({
        data: {
          upload_id: uploadId,
          seq: index,
          size: part.length,
          file: part,
        },
      }),
      "upload",
      "feishu_drive_upload_part_failed",
    );
    assertFeishuOk(partResponse, "upload", "feishu_drive_upload_part_failed", "飞书云空间分片上传失败");
  }
  const finished = await callDriveUpload(
    () => driveFileApi(params.client).uploadFinish({
      data: {
        upload_id: uploadId,
        block_num: blockNum,
      },
    }),
    "upload",
    "feishu_drive_upload_finish_failed",
  );
  assertFeishuOk(finished, "upload", "feishu_drive_upload_finish_failed", "飞书云空间分片上传完成失败");
  const token = finished.data?.file_token;
  if (!token) {
    throw new ChannelMediaDeliveryError("飞书云空间分片上传完成响应缺少 file_token", {
      stage: "upload",
      reasonCode: "feishu_drive_upload_missing_file_token",
    });
  }
  return token;
}

function driveFileApi(client: FeishuSdkClient): NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]> {
  const api = client.drive?.v1?.file;
  if (!api) {
    throw new ChannelMediaDeliveryError("Feishu SDK client does not support Drive file upload API", {
      stage: "upload",
      reasonCode: "feishu_drive_upload_failed",
    });
  }
  return api;
}

async function callDriveUpload<T>(
  operation: () => Promise<T>,
  stage: "upload",
  reasonCode: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ChannelMediaDeliveryError) throw error;
    throw new ChannelMediaDeliveryError(error instanceof Error ? error.message : String(error), {
      stage,
      reasonCode,
      cause: error,
    });
  }
}

async function queryDriveFileUrl(client: FeishuSdkClient, fileToken: string): Promise<string> {
  const response = await requestFeishu<FeishuApiResponse<{ metas?: FeishuDriveMeta[] }>>(client, {
    method: "POST",
    url: "/open-apis/drive/v1/metas/batch_query",
    data: {
      request_docs: [{ doc_token: fileToken, doc_type: "file" }],
      with_url: true,
    },
  }, "link", "feishu_drive_link_query_failed");
  assertFeishuOk(response, "link", "feishu_drive_link_query_failed", "飞书云空间文件链接查询失败");
  const url = response.data?.metas?.find((meta) => meta.doc_token === fileToken)?.url
    ?? response.data?.metas?.[0]?.url;
  if (!url) {
    throw new ChannelMediaDeliveryError("飞书云空间文件元数据响应缺少 url", {
      stage: "link",
      reasonCode: "feishu_drive_link_missing",
    });
  }
  return url;
}

async function requestFeishu<T>(
  client: FeishuSdkClient,
  payload: { method: string; url: string; data?: unknown },
  stage: "upload" | "permission" | "link",
  reasonCode: string,
): Promise<T> {
  if (!client.request) {
    throw new ChannelMediaDeliveryError("Feishu SDK client does not support raw requests", {
      stage,
      reasonCode,
    });
  }
  try {
    return await client.request<T>(payload);
  } catch (error) {
    throw new ChannelMediaDeliveryError(error instanceof Error ? error.message : String(error), {
      stage,
      reasonCode,
      cause: error,
    });
  }
}

function assertFeishuOk(
  response: unknown,
  stage: "upload" | "permission" | "link",
  reasonCode: string,
  fallback: string,
): void {
  if (!response || typeof response !== "object") return;
  const record = response as { code?: number; msg?: string };
  if (record.code !== undefined && record.code !== 0) {
    throw new ChannelMediaDeliveryError(record.msg ? `${record.msg} (code ${record.code})` : `${fallback}: code ${record.code}`, {
      stage,
      reasonCode,
    });
  }
}
