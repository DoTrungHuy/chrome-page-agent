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
      process.exit(failed ? 1 : 0);
    },
  };
}
