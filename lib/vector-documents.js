// 一条记忆可以有多个文本片段/图片实体；最后检索按blockId合并，避免长文本被截尾。
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
export const hashValue = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * 把一条记忆拆成要进索引的文档。
 * @param item - 记忆行（q/a/attachments）。
 * @param options - `{ chunkChars, chunkOverlap }`：分片大小与重叠。
 *   没有数据能证明某个分片长度更好，所以这两个值走配置，不写成"看起来合理"的常量。
 * @returns 文档数组（文本分片 + 图片实体）。
 */
export function memoryDocuments(item, { chunkChars = 12000, chunkOverlap = 200 } = {}) {
  const documents = [];
  const text = `${item.q}\n${item.a}`;
  const size = Math.max(1, Math.trunc(Number(chunkChars) || 12000));
  const overlap = Math.max(0, Math.min(Math.trunc(Number(chunkOverlap) || 0), size - 1));
  const step = size - overlap;
  // 每段最多 size 个 UTF-16 单元，步长扣掉重叠。
  for (let offset = 0, part = 0; offset < text.length; offset += step, part++) {
    let end = Math.min(text.length, offset + size);
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

/**
 * 外部图片线索 → 内部输入。
 *
 * 外部（工具参数、验收脚本、记忆附件）统一写成 `{path, sha256}`，
 * 内部实体与嵌入调用统一用 `{image, sha256, cwd}`。这里是两者之间唯一的换算点：
 * 少一次换算，就会出现"工具传 path、底层读 image"这种静默失败——计划文档 2026-10-02 记过一次，
 * 今天（2026-11-02）现场跑仍然踩到，表现是查询向量算不出来、召回直接空。
 * @param input - `{path, sha256, cwd?}`，或已经是内部的 `{image, sha256, cwd?}`。
 * @returns 内部输入对象；path 与 image 都没有就报错，不拿空值兜底。
 */
export function imageQuery(input) {
  if (input === null || typeof input !== "object") throw new Error("图片线索需为对象");
  const image = typeof input.image === "string" && input.image !== "" ? input.image : input.path;
  if (typeof image !== "string" || image === "") throw new Error("图片线索需提供 path 或 image");
  return { image, sha256: input.sha256, cwd: input.cwd };
}

export async function imageInput(input, { local = true, maxBytes = 16 * 1024 * 1024 } = {}) {
  // 必须固定字节身份。图片文件事后被替换时拒绝使用旧记忆的向量，不能静默换图。
  if (!/^[a-f0-9]{64}$/i.test(input.sha256 ?? "")) throw new Error("图片附件缺少内容SHA256，需重新记忆该附件");
  if (typeof input.image !== "string" || /^[a-z]+:\/\//i.test(input.image)) throw new Error("图片附件需为本地路径");
  if (!isAbsolute(input.image) && !input.cwd) throw new Error("相对图片路径缺少记忆工作区");
  const path = isAbsolute(input.image) ? input.image : resolve(input.cwd, input.image);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error("图片附件不存在或超过大小上限（" + Math.round(maxBytes / 1048576) + "MiB）");
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
