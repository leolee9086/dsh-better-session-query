import { openVectorDB, type CreateDatasetOptions } from "@leolee9086/vectordb";

/**
 * 用真实基础库提供记忆向量测试所需的 Dataset 接口。
 * 这里验证数据持久化与召回协作，不模拟 Cordis 装配，也不导入相邻插件源码。
 */
export async function openTestVectorStore(path: string) {
  const db = await openVectorDB({ path });
  return {
    async dataset(name: string, options: CreateDatasetOptions) {
      const existing = await db.listDatasets();
      return existing.some(item => item.name === name)
        ? db.openDataset(name)
        : db.createDataset(name, options);
    },
    close: () => db.close(),
  };
}
