// WebExtension API 兼容层。
//
// Chromium 浏览器通常提供 chrome.*，Firefox/Safari 更偏向 browser.*。
// 这里优先使用 browser 命名空间，但不引入运行时依赖；这样 Chrome、Edge、
// Vivaldi、Brave 和 Opera 都可以继续使用各自提供的兼容 API。

export const api = globalThis.browser ?? globalThis.chrome;
// 允许 Node 单元测试只导入工具定义；真正调用扩展 API 时仍必须运行在
// 浏览器扩展上下文中，否则调用方会收到清晰的运行时错误。

// Opera 的原生侧边栏 API 使用 opr.sidebarAction，和 Chromium 的
// sidePanel 不是同一个 API。它主要由 manifest.opera.json 声明，
// 这里保留探测结果供后台逻辑和将来的功能扩展使用。
export const operaSidebar = globalThis.opr?.sidebarAction ?? null;
export const isOpera = Boolean(operaSidebar);

/**
 * 尝试打开浏览器侧边栏。
 *
 * Chromium 侧边栏可以在 action/context-menu 手势中直接打开；Opera 的
 * sidebar_action 没有对应的通用 open() 方法，用户点击 Opera 侧边栏里的
 * Page Agent 图标即可打开面板，此时返回 false，调用方继续保存待处理内容。
 */
export async function openPanel({ windowId, tabId } = {}) {
  if (api.sidePanel?.open) {
    const target = tabId != null ? { tabId } : { windowId };
    if (target.tabId == null && target.windowId == null) return false;
    await api.sidePanel.open(target);
    return true;
  }

  // 给未来采用 Firefox sidebarAction.open() 的实现留出兼容路径。
  if (api.sidebarAction?.open) {
    await api.sidebarAction.open();
    return true;
  }

  return false;
}
