// test/log-reader-mock.mjs — 把任意假 conversation 适配成索引器要的日志源。
//
// 索引器现在按"文件 + 窗口"读日志;测试里没有文件,就用这份会话的完整事件冒充,
// 并按 offset 切片。事件先按 seq 排序:真实日志是追加写的,顺序即 seq 顺序,
// 而测试数据常常乱序(为了强调"块按事件走")。
export function logReaderFor(conversation) {
  const cache = new Map();
  const idOf = (path) => path.replace("session:", "");
  const eventsOf = async (id) => {
    if (cache.has(id)) return cache.get(id);
    const snapshot = await conversation.readSession(id);
    const events = [...(snapshot?.events ?? [])].sort((left, right) => left.seq - right.seq);
    cache.set(id, events);
    return events;
  };
  return {
    async locateSessionLog(id) {
      const listed = await conversation.listSessions();
      const found = (listed ?? []).some((record) => (record?.header?.id ?? record?.id) === id);
      return found ? "session:" + id : undefined;
    },
    async statSessionLog(path) {
      return { size: (await eventsOf(idOf(path))).length };
    },
    async readSessionBatch(path, offset, limit) {
      const events = await eventsOf(idOf(path));
      const slice = events.slice(offset, offset + limit);
      return { events: slice, nextOffset: offset + slice.length, done: offset + slice.length >= events.length, torn: false };
    },
    /** 让测试能主动失效缓存(推进了事件之后)。 */
    invalidate(id) {
      if (id === undefined) cache.clear();
      else cache.delete(id);
    },
  };
}
