/**
 * bus.js —— 全局事件总线（对应 bus.ts 的 emit/on 语义）
 * 所有跨视图数据关联都通过事件驱动即时刷新，禁止任何手动刷新。
 */
(function (global) {
  const handlers = new Map();

  const Bus = {
    /** 订阅事件，返回取消函数 */
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => Bus.off(event, fn);
    },
    /** 取消订阅 */
    off(event, fn) {
      const set = handlers.get(event);
      if (set) set.delete(fn);
    },
    /** 广播事件 */
    emit(event, data) {
      const set = handlers.get(event);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try {
          fn(data);
        } catch (err) {
          console.error("[bus] handler error:", err);
        }
      }
    },
    /** 只订阅一次 */
    once(event, fn) {
      const off = Bus.on(event, (data) => {
        off();
        fn(data);
      });
    },
  };

  global.Bus = Bus;
})(window);
