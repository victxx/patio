/** One-instance local inspector adapter. Never enumerates scopes or account properties.
 * Does not start B3. Requires inspector already enabled on the verified target PID. */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const mode = process.argv[2];
if (!["install", "canonical-route", "close"].includes(mode))
  throw Error("Explicit operation required");
const pid = 13717;
const expectedSession = "0x03eC71DE6C2abf4E792A6574CbF3371baE83a60A";
const expectedReview =
  "0x0af4cf1b064e7c78e70ca0c708f2ace0177186ec23a79420d04333661a59a74d";
const expectedFile = fileURLToPath(new URL("./run.ts", import.meta.url));
const targets = await fetch("http://127.0.0.1:9229/json/list", {
  signal: AbortSignal.timeout(3000),
}).then((r) => r.json());
if (targets.length !== 1)
  throw Error("Expected exactly one local debug target");
const target = new URL(targets[0].webSocketDebuggerUrl);
if (target.hostname !== "127.0.0.1" || target.port !== "9229")
  throw Error("Non-loopback inspector refused");
const ws = new WebSocket(target);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(Error("Inspector connection failed"));
});
let seq = 0;
const pending = new Map();
const scripts = [];
let onPaused;
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) {
    const entry = pending.get(m.id);
    if (!entry) return;
    pending.delete(m.id);
    clearTimeout(entry.timer);
    if (m.error)
      entry.reject(Error(`Inspector ${entry.method} failed (${m.error.code})`));
    else entry.resolve(m.result);
  } else if (m.method === "Debugger.scriptParsed")
    scripts.push({ id: m.params.scriptId, url: m.params.url });
  else if (m.method === "Debugger.paused") onPaused?.(m.params);
};
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`Inspector ${method} timed out`));
    }, 15000);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function scalar(method, params) {
  const r = await call(method, { ...params, returnByValue: true });
  if (r.exceptionDetails) {
    const exception = r.exceptionDetails.exception;
    const missing = /^ReferenceError: ([A-Za-z_$][\w$]*) is not defined/.exec(
      exception?.description ?? "",
    );
    throw Error(
      `Inspector expression failed: ${exception?.className ?? "unknown"}${missing ? ` missing binding ${missing[1]}` : " (details not exported)"}`,
    );
  }
  return r.result.value;
}
let paused = false;
try {
  const identity = await scalar("Runtime.evaluate", {
    expression: "({pid:process.pid,entry:process.argv.at(-1)})",
  });
  if (
    identity.pid !== pid ||
    !identity.entry.endsWith("apps/web/test-fixtures/hoodi-hash-canary/run.ts")
  )
    throw Error("Wrong live process; no change applied");
  if (mode === "close") {
    await scalar("Runtime.evaluate", {
      expression:
        "setTimeout(()=>process.getBuiltinModule('node:inspector').close(),50); true",
    });
    console.log(JSON.stringify({ pid, inspectorClosureScheduled: true }));
  } else {
    await call("Debugger.enable");
    const script = scripts.find((s) => {
      const path = s.url.startsWith("file:")
        ? decodeURIComponent(new URL(s.url).pathname)
        : s.url;
      return path === expectedFile;
    });
    if (!script) throw Error("Expected loaded file absent");
    const { scriptSource } = await call("Debugger.getScriptSource", {
      scriptId: script.id,
    });
    const match =
      mode === "canonical-route"
        ? /report.signatures=session.signatures/.exec(scriptSource)
        : /if\s*\(\s*command\s*===\s*["']status["']\s*\)\s*\{\s*persistSession\(\)/.exec(
            scriptSource,
          );
    if (!match) throw Error("Expected loaded status branch absent");
    const offset =
      match.index +
      match[0].lastIndexOf(
        mode === "canonical-route" ? "report.signatures" : "persistSession",
      );
    const before = scriptSource.slice(0, offset).split("\n");
    const { breakpointId } = await call("Debugger.setBreakpoint", {
      location: {
        scriptId: script.id,
        lineNumber: before.length - 1,
        columnNumber: before.at(-1).length,
      },
    });
    const pause = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("No target status callback; no repair applied")),
        60000,
      );
      onPaused = (p) => {
        clearTimeout(timer);
        paused = true;
        resolve(p);
      };
    });
    console.log(
      JSON.stringify({
        pid,
        loadedFile: expectedFile,
        loadedSourceSha256: createHash("sha256")
          .update(scriptSource)
          .digest("hex"),
        armed:
          mode === "canonical-route"
            ? "Send repair-check to retained runner; pauses only at persistence"
            : "Send status to existing runner now; no signer inspected",
      }),
    );
    const p = await pause;
    const frame = p.callFrames.find((f) => f.location.scriptId === script.id);
    if (!frame) throw Error("Wrong paused frame");
    const state = await scalar("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrameId,
      expression: `({pid:process.pid,session:session.input.account.address,review:session.input.attemptId,busy,
        signatures:session.signatures.length,signatureAttempted:permit.signatureAttempted,
        sends:report.publicSends,frozen:session.frozen,entries:lines.listenerCount('line'),requireAvailable:typeof require==='function'})`,
    });
    if (
      state.pid !== pid ||
      state.session !== expectedSession ||
      state.review !== expectedReview ||
      state.busy ||
      state.signatures ||
      state.signatureAttempted ||
      state.sends ||
      state.frozen ||
      state.entries !== 1 ||
      !state.requireAvailable
    )
      throw Error("Live invariants fail; no install");
    console.log(JSON.stringify({ liveSanitizedPreconditions: state }));
    const expression =
      mode === "canonical-route"
        ? `(()=>{
      if(!report.liveFundingRepair?.installed||report.liveFundingRepair.startClaimed)throw Error('Not idle repair');
      permit.assertCancellationAvailable(session);
      const {installCanonicalFundingRead}=require(${JSON.stringify(expectedFile.replace("run.ts", "canonical-funding-read.ts"))});
      return installCanonicalFundingRead(read,rpcs[1],report);
    })()`
        : `(()=>{
      if(globalThis.__patioB3RepairInstalled) throw Error('Already installed');
      const {installRepair}=require(${JSON.stringify(expectedFile.replace("run.ts", "repair.ts"))});
      const safeJson=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2);
      const api=installRepair({review,session,permit,read,cancellation,report,
        isBusy:()=>busy,setBusy:v=>{busy=v},setPhase:v=>{phase=v},
        detachPreviousEntry:()=>{if(lines.listenerCount('line')!==1)throw Error('Unexpected entries');lines.removeAllListeners('line')},
        executeOriginal:()=>execute(),persist:persistSession},
        {reviewId:${JSON.stringify(expectedReview)},fundings:[
          {hash:'0xac074662a2d530b9665c18084cc59a6319ec5e1e09565731f3bd19bb6e5248c0',nonce:47n,value:1833273404123638n},
          {hash:'0x92a88fabd6c4c1f20977c38a76baf719d872facf4f88b0b0ac40c6e3c720cd62',nonce:48n,value:1833273404123638n}
        ]});
      let commandBusy=false;
      lines.on('line',line=>{
        const [command,id]=line.trim().split(/\\s+/);
        if(command==='status'||command==='repair-status'){console.log(safeJson({...api.status(),commandBusy}));return;}
        if(commandBusy){console.log('Repair command already active; no duplicate');return;}
        if(command!=='repair-check'&&command!=='repair-start'){console.log('Previous financial entries disabled; no action');return;}
        if(command==='repair-start'&&id!==${JSON.stringify(expectedReview)}){console.log('Exact existing approval required');return;}
        commandBusy=true;
        Promise.resolve().then(()=>command==='repair-check'?api.revalidate():api.start())
          .then(result=>console.log(safeJson({repairResult:command,result:result??api.status()})))
          .catch(()=>console.log(safeJson({repairResult:'held',...api.status()})))
          .finally(()=>{commandBusy=false;persistSession()});
      });
      globalThis.__patioB3RepairInstalled=true;
      return {...api.status(),entryCount:lines.listenerCount('line')};
    })()`;
    const result = await scalar("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrameId,
      expression,
    });
    console.log(JSON.stringify({ installed: result }));
    await call("Debugger.removeBreakpoint", { breakpointId });
    await call("Debugger.resume");
    paused = false;
  }
} catch (e) {
  console.log(JSON.stringify({ stopped: true, reason: e.message }));
  process.exitCode = 1;
} finally {
  if (paused) await call("Debugger.resume").catch(() => {});
  ws.close();
}
