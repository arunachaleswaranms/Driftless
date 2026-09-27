import { Experiment } from "./experiment.mjs";

const $ = (id) => document.getElementById(id);
const exp = new Experiment({ video: $("video"), onUpdate: () => render() });
let renderTimer;
function render() {
  const sn = exp.snapshot();
  $("status").textContent = `${sn.state} / ${sn.role ?? "none"} / peer ${sn.peer ?? "none"} / channel ${sn.channel ?? "none"}`;
  $("diagnostics").textContent = JSON.stringify(sn, null, 2);
}
$("start").addEventListener("click", async () => {
  try {
    const role = $("role").value;
    const file = $("file").files?.[0];
    if (role === "host" && !file) throw new Error("Select a local MP4 on the host.");
    await exp.start({ role, room: $("room").value, file, profile: $("profile").value });
    clearInterval(renderTimer); renderTimer = setInterval(render, 250);
  } catch (e) { $("status").textContent = e.message; }
});
$("close").addEventListener("click", async () => { clearInterval(renderTimer); await exp.close(); render(); });
$("play").addEventListener("click", () => exp.play());
$("hold").addEventListener("click", () => exp.hold());
$("resume").addEventListener("click", () => exp.resume());
$("seek").addEventListener("click", () => { try { exp.seek(Number($("seek-time").value)); } catch (e) { $("status").textContent = e.message; } });
$("invalid").addEventListener("click", () => { try { exp.injectInvalid(); } catch (e) { $("status").textContent = e.message; } });
$("refresh-pair").addEventListener("click", async () => { await exp.refreshPair(); render(); });
$("profile").addEventListener("change", () => { if (exp.role === "host") exp.setProfile($("profile").value); });
window.addEventListener("pagehide", () => { clearInterval(renderTimer); void exp.close(); });
window.__spike07 = exp; // Lab automation hook; no production API.
render();
