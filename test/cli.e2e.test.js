import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("guided demo completes cancel, verification, correction and recreation", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: [
      "1",
      "3",
      "2",
      "1",
      "取消 5678",
      "下单 ¥22.00",
      "",
    ].join("\n"),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /演示模式/);
  assert.match(run.stdout, /旧单已验证取消/);
  assert.match(run.stdout, /新待支付订单已创建/);
  assert.match(run.stdout, /¥22\.00/);
  assert.match(run.stdout, /演示汉堡.*当前 2.*回车保持.*0 删除.*1-20/);
  assert.equal((run.stdout.match(/演示汉堡：2 → 1/g) ?? []).length, 2);
  assert.match(run.stdout, /金额：¥42\.00 → ¥22\.00/);
  assert.doesNotMatch(run.stdout, /P-BURGER|\"original\"/);
});

test("guided demo can cancel without quoting or rebuilding", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: ["1", "3", "1", "取消 5678", ""].join("\n"),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /旧单已验证取消，没有创建新订单/);
  assert.doesNotMatch(run.stdout, /新待支付订单已创建/);
});

test("guided demo stops when the cancellation phrase is not exact", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: ["1", "3", "1", "确认取消", ""].join("\n"),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /没有执行任何写操作/);
  assert.doesNotMatch(run.stdout, /旧单已验证取消/);
});

test("guided demo requires a separate creation confirmation", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: [
      "1",
      "3",
      "2",
      "1",
      "取消 5678",
      "暂不下单",
      "",
    ].join("\n"),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /旧单已验证取消；你没有确认新订单/);
  assert.doesNotMatch(run.stdout, /新待支付订单已创建/);
});

test("guided demo refuses a no-op rebuild before cancellation", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: ["1", "3", "2", "", ""].join("\n"),
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /至少修改一项餐品数量/);
  assert.doesNotMatch(run.stdout, /准备取消旧单/);
});

test("guided demo rejects an invalid order selection", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: ["9", ""].join("\n"),
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /订单序号无效/);
});

test("guided demo rejects an invalid cancellation reason", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: ["1", "9", ""].join("\n"),
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /取消原因无效/);
});

test("guided demo rejects an invalid action", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: ["1", "3", "9", ""].join("\n"),
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /处理方式无效/);
});

test("demo doctor reports the synthetic gateway without a token", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "doctor", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /demo:\/\/local/);
  assert.match(run.stdout, /create-order/);
});

test("demo live verification is non-interactive and exposes no order data", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "verify", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /"mode": "read-only"/);
  assert.match(run.stdout, /"orderList": "ok"/);
  assert.match(run.stdout, /"queryOrder": "ok"/);
  assert.doesNotMatch(
    run.stdout,
    /DEMO-ORDER|100001|P-BURGER|演示餐厅|演示汉堡|选择订单|准备取消|准备创建/,
  );
});

test("an unknown command cannot fall through to the rescue flow", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "verify-live", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /未知命令/);
  assert.doesNotMatch(run.stdout, /近期订单|选择订单|准备取消|准备创建/);
});

test("conflicting commands are rejected before connecting", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "verify", "doctor", "--demo"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /只能指定一个命令/);
  assert.doesNotMatch(run.stdout, /demo:\/\/local|近期订单|选择订单/);
});

test("real rescue refuses non-interactive write execution before connecting", () => {
  const run = spawnSync(process.execPath, ["src/cli.js"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: "",
    env: { ...process.env, MCD_MCP_TOKEN: "must-not-be-used" },
  });

  assert.notEqual(run.status, 0);
  assert.match(`${run.stdout}\n${run.stderr}`, /真实模式必须在交互终端/);
});
