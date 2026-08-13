// 极简断言收集器。每个测试文件独立运行、以退出码报告结果，
// 由 tests/run.mjs 汇总。

export function suite(title) {
  let failed = 0;
  let passed = 0;

  return {
    section(name) {
      console.log(`\n=== ${name} ===`);
    },
    /** @param {string} label @param {any} ok @param {string} [detail] 失败时打印的上下文 */
    t(label, ok, detail) {
      if (ok) {
        passed++;
        console.log(`  ✓ ${label}`);
      } else {
        failed++;
        console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
      }
    },
    note(msg) {
      console.log(`  · ${msg}`);
    },
    /** 打印结论并以对应退出码结束进程。 */
    done() {
      console.log(
        `\n${title}：${failed === 0 ? `${passed} 项全部通过 ✓` : `${failed} 项失败 ✗（共 ${passed + failed} 项）`}`
      );
      // 单元测试会起本地 HTTP 服务并用 fetch 访问。让它先完成异步句柄
      // 的清理，避免 Windows + Node 24 在 process.exit 期间触发 libuv 断言。
      // E2E 测试仍然需要立即退出：它们背后有 Chrome 子进程，不能依赖
      // Node 的句柄自然排空。
      if (/[\\/]tests[\\/]unit[\\/]/.test(process.argv[1] || '')) {
        process.exitCode = failed ? 1 : 0;
      } else {
        process.exit(failed ? 1 : 0);
      }
    },
  };
}
