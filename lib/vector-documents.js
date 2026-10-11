// 一条记忆可以有多个文本片段/图片实体；最后检索按blockId合并，避免长文本被截尾。
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
export const hashValue = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function memoryDocuments(item) {
  const documents = [];
  const text = `${item.q}\n${item.a}`;
  // 每段最多12000 UTF-16单元，保留少量重叠帮助跨段检索。
  for (let offset = 0, part = 0; offset < text.length; offset += 11800, part++) {
    let end = Math.min(text.length, offset + 12000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const input = { text: text.slice(offset, end) };
    documents.push({ id: hashValue([item.blockId, "text", part]), input, inputHash: hashValue(input), modality: "text" });
  }
  for (const [index, attachment] of (item.attachments ?? []).entries()) {
    const input = { image: attachment.path, sha256: attachment.sha256, cwd: item.cwd };
    documents.push({ id: hashValue([item.blockId, "image", index]), input, inputHash: hashValue(input), modality: "image" });
  }
  return documents;
}

export async function imageInput(input, { local = true } = {}) {
  // 必须固定字节身份。图片文件事后被替换时拒绝使用旧记忆的向量，不能静默换图。
  if (!/^[a-f0-9]{64}$/i.test(input.sha256 ?? "")) throw new Error("图片附件缺少内容SHA256，需重新记忆该附件");
  if (typeof input.image !== "string" || /^[a-z]+:\/\//i.test(input.image)) throw new Error("图片附件需为本地路径");
  if (!isAbsolute(input.image) && !input.cwd) throw new Error("相对图片路径缺少记忆工作区");
  const path = isAbsolute(input.image) ? input.image : resolve(input.cwd, input.image);
  const info = await stat(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("图片附件不存在或超过16MiB");
  const bytes = await readFile(path);
  if (hashBytes(bytes) !== input.sha256.toLowerCase()) throw new Error("图片附件字节已变化");
  if (local) return { image: path };
  let mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216) mime = "image/jpeg";
  else if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") mime = "image/webp";
  if (!mime) throw new Error("远端图片附件只支持PNG/JPEG/WebP");
  return { image: `data:${mime};base64,${bytes.toString("base64")}` };
}
