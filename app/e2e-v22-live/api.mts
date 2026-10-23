import { openSession } from "./harness.mts";
const s = await openSession("api-probe");
try {
  for (const p of process.argv.slice(2)) {
    const r = await s.page.request.get(new URL(p, s.page.url()).toString());
    const t = await r.text();
    console.log(`== ${p} ${r.status()}\n${t.slice(0, 1500)}`);
  }
} finally { await s.close(); }
