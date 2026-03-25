import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Percolator OpenClaw Workshop",
  description:
    "How Our AI Agents Find Real Bugs and Earn Real Bounties — a 60-minute workshop.",
  robots: { index: false, follow: false },
};

/* ---------- raw HTML sourced from ~/percolator-ops/content/openclaw-workshop.html ---------- */

const workshopStyle = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
    .oc-workshop *, .oc-workshop *::before, .oc-workshop *::after { box-sizing: border-box; margin: 0; padding: 0; }
    .oc-workshop {
      --bg: #0D0D0F; --bg2: #141418; --bg3: #1A1A20; --border: #2A2A35;
      --accent: #FF4444; --accent2: #FF6B6B; --cyan: #22D3EE; --purple: #9945FF;
      --white: #F8F8F2; --muted: #888898; --code-bg: #0A0A0E;
      --font-mono: 'JetBrains Mono','Fira Code','Cascadia Code','Courier New',monospace;
      --font-body: 'Inter','Segoe UI',system-ui,sans-serif;
      font-size:14px; background:var(--bg); color:var(--white); font-family:var(--font-body); line-height:1.6;
    }
    .oc-workshop .page { width:794px; min-height:1123px; margin:0 auto 32px; background:var(--bg); border:1px solid var(--border); position:relative; display:flex; flex-direction:column; overflow:hidden; }
    .oc-workshop .page-num { position:absolute; bottom:20px; right:28px; font-size:11px; color:var(--muted); font-family:var(--font-mono); letter-spacing:0.08em; }
    .oc-workshop .stripe { height:4px; background:linear-gradient(90deg,var(--accent) 0%,var(--accent2) 40%,var(--purple) 100%); flex-shrink:0; }
    .oc-workshop .page-header { display:flex; align-items:center; justify-content:space-between; padding:14px 28px 10px; border-bottom:1px solid var(--border); flex-shrink:0; }
    .oc-workshop .page-header .logo-small { font-family:var(--font-mono); font-size:13px; color:var(--accent); font-weight:600; letter-spacing:0.06em; }
    .oc-workshop .page-header .section-label { font-size:11px; color:var(--muted); letter-spacing:0.1em; text-transform:uppercase; }
    .oc-workshop .content { padding:28px 36px 48px; flex:1; }
    .oc-workshop h1 { font-size:2.6rem; font-weight:800; line-height:1.1; letter-spacing:-0.02em; }
    .oc-workshop h2 { font-size:1.4rem; font-weight:700; color:var(--white); margin-bottom:12px; padding-bottom:6px; border-bottom:2px solid var(--accent); display:inline-block; }
    .oc-workshop h3 { font-size:1rem; font-weight:600; color:var(--accent2); margin:16px 0 6px; }
    .oc-workshop h4 { font-size:0.9rem; font-weight:600; color:var(--cyan); margin:12px 0 4px; font-family:var(--font-mono); }
    .oc-workshop p { margin-bottom:10px; font-size:0.92rem; }
    .oc-workshop pre { background:var(--code-bg); border:1px solid var(--border); border-left:3px solid var(--accent); border-radius:4px; padding:12px 16px; margin:10px 0; font-family:var(--font-mono); font-size:0.78rem; line-height:1.5; overflow-x:auto; white-space:pre; color:#E8E8D4; }
    .oc-workshop code { font-family:var(--font-mono); font-size:0.82rem; background:var(--code-bg); border:1px solid var(--border); border-radius:3px; padding:1px 5px; color:var(--accent2); }
    .oc-workshop pre code { background:none; border:none; padding:0; color:inherit; font-size:inherit; }
    .oc-workshop ul,.oc-workshop ol { margin:8px 0 10px 18px; font-size:0.9rem; }
    .oc-workshop li { margin-bottom:4px; }
    .oc-workshop li strong { color:var(--white); }
    .oc-workshop .badge { display:inline-block; padding:2px 8px; border-radius:3px; font-size:0.72rem; font-weight:600; font-family:var(--font-mono); letter-spacing:0.05em; }
    .oc-workshop .badge-red { background:rgba(255,68,68,0.18); color:var(--accent2); border:1px solid rgba(255,68,68,0.4); }
    .oc-workshop .badge-cyan { background:rgba(34,211,238,0.12); color:var(--cyan); border:1px solid rgba(34,211,238,0.35); }
    .oc-workshop .badge-purple { background:rgba(153,69,255,0.15); color:#b06dff; border:1px solid rgba(153,69,255,0.4); }
    .oc-workshop .badge-green { background:rgba(34,197,94,0.14); color:#4ade80; border:1px solid rgba(34,197,94,0.35); }
    .oc-workshop .callout { background:var(--bg3); border:1px solid var(--border); border-left:3px solid var(--cyan); border-radius:4px; padding:12px 16px; margin:12px 0; font-size:0.88rem; }
    .oc-workshop .callout.warn { border-left-color:var(--accent); }
    .oc-workshop .callout.tip { border-left-color:#4ade80; }
    .oc-workshop .diagram { background:var(--code-bg); border:1px solid var(--border); border-radius:6px; padding:18px 20px; margin:12px 0; font-family:var(--font-mono); font-size:0.8rem; color:#C0C0D0; }
    .oc-workshop .flow { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:10px 0; }
    .oc-workshop .flow-step { background:var(--bg3); border:1px solid var(--border); border-radius:4px; padding:6px 12px; font-size:0.8rem; font-family:var(--font-mono); white-space:nowrap; }
    .oc-workshop .flow-step.accent { border-color:var(--accent); color:var(--accent2); }
    .oc-workshop .flow-arrow { color:var(--muted); font-size:0.9rem; }
    .oc-workshop table { width:100%; border-collapse:collapse; font-size:0.83rem; margin:12px 0; }
    .oc-workshop th { background:var(--bg3); color:var(--muted); font-size:0.72rem; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; padding:8px 10px; border:1px solid var(--border); text-align:left; }
    .oc-workshop td { padding:7px 10px; border:1px solid var(--border); vertical-align:top; }
    .oc-workshop tr:nth-child(even) td { background:rgba(255,255,255,0.02); }
    .oc-workshop .two-col { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
    .oc-workshop .col-block { background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:16px; }
    .oc-workshop .do-dont { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:12px; }
    .oc-workshop .do-list,.oc-workshop .dont-list { border-radius:6px; padding:14px 16px; }
    .oc-workshop .do-list { background:rgba(34,197,94,0.06); border:1px solid rgba(34,197,94,0.25); }
    .oc-workshop .dont-list { background:rgba(255,68,68,0.06); border:1px solid rgba(255,68,68,0.25); }
    .oc-workshop .do-list h3 { color:#4ade80; margin-top:0; }
    .oc-workshop .dont-list h3 { color:var(--accent2); margin-top:0; }
    .oc-workshop .do-list li,.oc-workshop .dont-list li { font-size:0.82rem; margin-bottom:5px; }
    @media (max-width: 820px) {
      .oc-workshop .page { width:100%; min-height:auto; margin-bottom:16px; }
      .oc-workshop .content { padding:20px; }
      .oc-workshop .two-col, .oc-workshop .do-dont { grid-template-columns:1fr; }
    }
    .oc-workshop .step { display:flex; gap:14px; margin-bottom:14px; align-items:flex-start; }
    .oc-workshop .step-num { flex-shrink:0; width:26px; height:26px; background:var(--accent); color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-family:var(--font-mono); font-size:0.75rem; font-weight:700; margin-top:2px; }
    .oc-workshop .step-body { flex:1; }
    .oc-workshop .step-body h4 { margin-top:0; }
    .oc-workshop .qr-card { background:var(--bg2); border:2px solid var(--accent); border-radius:8px; padding:20px 24px; margin:8px 0; }
    .oc-workshop .qr-card h2 { font-size:1.1rem; border-bottom-color:var(--accent); margin-bottom:14px; }
    .oc-workshop .bug-report { background:var(--code-bg); border:1px solid var(--border); border-radius:6px; padding:14px 18px; margin:12px 0; }
    .oc-workshop .bug-report .label { font-size:0.72rem; text-transform:uppercase; letter-spacing:0.1em; color:var(--muted); font-family:var(--font-mono); margin-bottom:2px; }
    .oc-workshop .bug-report .value { font-size:0.88rem; margin-bottom:10px; }
    .oc-workshop .cover-page { min-height:1123px; background:var(--bg); display:flex; flex-direction:column; justify-content:center; align-items:flex-start; padding:60px 64px; position:relative; overflow:hidden; }
    .oc-workshop .cover-page::before { content:''; position:absolute; top:-120px; right:-120px; width:500px; height:500px; background:radial-gradient(circle,rgba(255,68,68,0.12) 0%,transparent 70%); pointer-events:none; }
    .oc-workshop .cover-page::after { content:''; position:absolute; bottom:-80px; left:-80px; width:400px; height:400px; background:radial-gradient(circle,rgba(153,69,255,0.1) 0%,transparent 70%); pointer-events:none; }
    .oc-workshop .cover-eyebrow { font-family:var(--font-mono); font-size:0.78rem; color:var(--accent); letter-spacing:0.18em; text-transform:uppercase; margin-bottom:20px; display:flex; align-items:center; gap:8px; }
    .oc-workshop .cover-eyebrow::before { content:''; display:inline-block; width:32px; height:2px; background:var(--accent); }
    .oc-workshop .cover-title { font-size:3.4rem; font-weight:800; line-height:1.08; letter-spacing:-0.025em; margin-bottom:6px; }
    .oc-workshop .cover-title span { color:var(--accent); }
    .oc-workshop .cover-subtitle { font-size:1.1rem; color:#AAAABC; font-weight:400; line-height:1.5; max-width:520px; margin-top:16px; margin-bottom:40px; }
    .oc-workshop .cover-meta { display:flex; flex-direction:column; gap:6px; }
    .oc-workshop .cover-meta-row { font-family:var(--font-mono); font-size:0.82rem; color:var(--muted); }
    .oc-workshop .cover-meta-row span { color:var(--white); }
    .oc-workshop .cover-logo { position:absolute; top:40px; right:64px; font-family:var(--font-mono); font-size:1.2rem; font-weight:700; color:var(--white); letter-spacing:0.04em; }
    .oc-workshop .cover-logo em { color:var(--accent); font-style:normal; }
    .oc-workshop .cover-bottom-bar { position:absolute; bottom:0; left:0; right:0; height:5px; background:linear-gradient(90deg,var(--accent),var(--accent2),var(--purple)); }
    .oc-workshop .toc-block { margin-top:40px; background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:18px 22px; max-width:480px; }
    .oc-workshop .toc-block h3 { color:var(--muted); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.12em; margin-bottom:10px; }
    .oc-workshop .toc-row { display:flex; justify-content:space-between; font-size:0.82rem; padding:3px 0; border-bottom:1px dotted rgba(255,255,255,0.06); }
    .oc-workshop .toc-row:last-child { border-bottom:none; }
    .oc-workshop .toc-page { font-family:var(--font-mono); color:var(--muted); }
    .oc-workshop .back-cover { min-height:1123px; background:var(--bg); display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; padding:60px 64px; position:relative; overflow:hidden; }
    .oc-workshop .back-cover::before { content:''; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:600px; height:600px; background:radial-gradient(circle,rgba(255,68,68,0.07) 0%,transparent 70%); pointer-events:none; }
`;

const workshopBody = `
<div class="cover-page page">
  <div class="cover-logo">⚗ <em>Percolator</em></div>
  <div class="cover-eyebrow">OpenClaw Workshop</div>
  <h1 class="cover-title">Percolator<br><span>OpenClaw</span><br>Workshop</h1>
  <p class="cover-subtitle">How Our AI Agents Find Real Bugs<br>and Earn Real Bounties</p>
  <div class="cover-meta">
    <div class="cover-meta-row">Duration: <span>60 minutes</span></div>
    <div class="cover-meta-row">Level: <span>Beginner–Intermediate</span></div>
    <div class="cover-meta-row">Discord: <span>discord.gg/guPnxpHkE</span></div>
  </div>
  <div class="toc-block">
    <h3>Contents</h3>
    <div class="toc-row"><span>What Is Percolator?</span><span class="toc-page">01</span></div>
    <div class="toc-row"><span>The Agent Workspace</span><span class="toc-page">02</span></div>
    <div class="toc-row"><span>How Agents Communicate</span><span class="toc-page">03</span></div>
    <div class="toc-row"><span>The Percolator Team</span><span class="toc-page">04</span></div>
    <div class="toc-row"><span>Setup Guide</span><span class="toc-page">05</span></div>
    <div class="toc-row"><span>Debugging &amp; Common Issues</span><span class="toc-page">06</span></div>
    <div class="toc-row"><span>The Bug Bounty Pipeline</span><span class="toc-page">07</span></div>
    <div class="toc-row"><span>Best Practices</span><span class="toc-page">08</span></div>
    <div class="toc-row"><span>Quick Reference Card</span><span class="toc-page">09</span></div>
  </div>
  <div class="cover-bottom-bar"></div>
</div>

<div class="page">
  <div class="stripe"></div>
  <div class="page-header"><span class="logo-small">⚗ Percolator</span><span class="section-label">Minute 0–5</span></div>
  <div class="content">
    <h2>What Is Percolator?</h2>
    <p>Percolator is a team of AI agents that scans open source code, finds real security vulnerabilities, writes structured bug reports, and submits them to bug bounty programs — autonomously, 24 hours a day. Each agent is a Claude Code instance with a specific role: PM picks the target, Coder reads the code, QA verifies the findings, Security assesses severity, DevOps submits the report, bounty gets paid. The system runs on a cron schedule with no human in the loop. This workshop shows you how it works and how to build your own.</p>
    <h3>How a bounty gets paid</h3>
    <div class="flow">
      <div class="flow-step accent">PM</div><div class="flow-arrow">→</div>
      <div class="flow-step">Picks target</div><div class="flow-arrow">→</div>
      <div class="flow-step accent">Coder</div><div class="flow-arrow">→</div>
      <div class="flow-step">Scans repo</div><div class="flow-arrow">→</div>
      <div class="flow-step accent">QA</div><div class="flow-arrow">→</div>
      <div class="flow-step">Verifies finding</div>
    </div>
    <div class="flow">
      <div class="flow-step accent">Security</div><div class="flow-arrow">→</div>
      <div class="flow-step">Rates severity</div><div class="flow-arrow">→</div>
      <div class="flow-step accent">DevOps</div><div class="flow-arrow">→</div>
      <div class="flow-step">Submits report</div><div class="flow-arrow">→</div>
      <div class="flow-step" style="border-color:#4ade80;color:#4ade80;">💰 Bounty paid</div>
    </div>
    <div class="callout">Each agent is a <strong>Claude Code instance</strong> with a specific role, running on a cron schedule. No human needs to intervene — the agents coordinate via a local REST API.</div>
    <h3>Why it works</h3>
    <ul>
      <li>Agents <strong>never get tired</strong> — they run every 30 minutes, 24/7</li>
      <li>Agents <strong>never hallucinate unchecked</strong> — QA verifies every finding before submission</li>
      <li>Agents <strong>coordinate asynchronously</strong> — via message passing, not shared memory</li>
      <li>Agents <strong>know their limits</strong> — each has a clear Definition of Done</li>
    </ul>
    <h3>What you'll build today</h3>
    <p>By the end of this workshop you'll have OpenClaw installed, a working agent workspace, and a scanner agent running tasks from the Collector API. You'll understand how to add more agents, debug common issues, and plug into the Percolator bounty pipeline.</p>
  </div>
  <span class="page-num">01</span>
</div>

<div class="page">
  <div class="stripe"></div>
  <div class="page-header"><span class="logo-small">⚗ Percolator</span><span class="section-label">Minute 5–15</span></div>
  <div class="content">
    <h2>The Agent Workspace — Files Are Everything</h2>
    <p>Every agent lives in a directory. There's no database, no fancy config — just files. The agent reads them at the start of every session. This is by design: files are inspectable, version-controllable, and easy to edit.</p>
    <pre>~/.openclaw/percolator/coder/
├── SOUL.md        — Who you are (personality, role, boundaries)
├── TOOLS.md       — What you can access (APIs, CLIs, repos)
├── RULES.md       — Team rules (how agents coordinate)
├── HEARTBEAT.md   — Wake-up checklist (runs every 30 min, keep tiny)
├── CONTEXT.md     — Recent context (what happened last session)
├── PROGRESS.md    — Cross-session memory (where you left off)
└── memory/        — Long-term logs (daily entries)</pre>
    <h3>File-by-file breakdown</h3>
    <h4>SOUL.md</h4>
    <p>Your agent's job description — personality, role, and hard limits. <span class="badge badge-red">Golden rule</span> 50–150 lines max. Show, don't tell — use examples, not abstractions.</p>
    <h4>HEARTBEAT.md</h4>
    <p>The checklist that runs every single wake-up cycle. <span class="badge badge-red">Golden rule</span> Under 20 lines. This loads 48× a day — every token counts.</p>
    <h4>TOOLS.md</h4>
    <p>Everything the agent can access: APIs, CLIs, endpoints, credentials. <span class="badge badge-red">Golden rule</span> If the agent needs a credential or API endpoint, it goes here — not in memory, not in chat.</p>
    <h4>RULES.md</h4>
    <p>Shared team rules — coordination norms, decision authority, escalation paths. <span class="badge badge-red">Golden rule</span> Include a Definition of Done for every role so agents know when they're actually finished.</p>
    <h4>PROGRESS.md</h4>
    <p>Where the agent picks up after sleeping. Structured cross-session state. <span class="badge badge-red">Golden rule</span> Structured format — <em>Last Heartbeat, Current Task, Status, Next Steps, Blockers.</em></p>
    <div class="callout tip"><strong>Pro tip:</strong> HEARTBEAT.md + SOUL.md + TOOLS.md load on <em>every</em> session. Keep them trim. PROGRESS.md and CONTEXT.md are selectively loaded — they can be longer.</div>
  </div>
  <span class="page-num">02</span>
</div>

<div class="page">
  <div class="stripe"></div>
  <div class="page-header"><span class="logo-small">⚗ Percolator</span><span class="section-label">Minute 15–20</span></div>
  <div class="content">
    <h2>How Agents Talk to Each Other</h2>
    <p>Agents don't have a shared brain. They communicate through <strong>the Collector API</strong> — a lightweight local REST service backed by SQLite. Any agent can post a task, send a message, or check its inbox with a single <code>curl</code>.</p>
    <div class="callout"><strong>Discord is for humans to watch.</strong> The Collector API is how agents actually coordinate.</div>
    <h3>Key commands</h3>
    <h4>Check your tasks</h4>
    <pre>curl "http://127.0.0.1:18801/api/tasks?assigned_to=coder&amp;status=backlog"</pre>
    <h4>Check your inbox</h4>
    <pre>curl "http://127.0.0.1:18801/api/messages?to_agent=coder&amp;unread=true"</pre>
    <h4>Send a message to another agent</h4>
    <pre>curl -X POST http://127.0.0.1:18801/api/messages \\
  -H "Content-Type: application/json" \\
  -d '{"from_agent":"coder","to_agent":"qa","message":"PR #42 ready for review"}'</pre>
    <h4>Full dashboard</h4>
    <pre>curl http://127.0.0.1:18801/api/dashboard</pre>
    <h3>Typical message flow</h3>
    <div class="diagram">
      <div class="flow">
        <div class="flow-step accent">Coder</div><div class="flow-arrow">── finishes PR ──▶</div>
        <div class="flow-step">messages QA</div><div class="flow-arrow">──▶</div>
        <div class="flow-step accent">QA</div><div class="flow-arrow">── approves ──▶</div>
        <div class="flow-step">messages DevOps</div>
      </div>
      <div class="flow" style="margin-top:10px;">
        <div class="flow-step accent">DevOps</div><div class="flow-arrow">──▶</div>
        <div class="flow-step">gh pr merge --admin</div><div class="flow-arrow">──▶</div>
        <div class="flow-step" style="border-color:#4ade80;color:#4ade80;">✓ Deployed</div>
      </div>
    </div>
    <h3>Why not just use Discord / chat?</h3>
    <ul>
      <li>Collector messages are <strong>persistent</strong> — agents can check them when they wake up</li>
      <li>Tasks have <strong>priority, status, and assignment</strong> — agents know what to work on next</li>
      <li>The dashboard gives a <strong>system-wide view</strong> — no agent needs to know the whole picture</li>
      <li>It's <strong>local and fast</strong> — no rate limits, no API keys needed</li>
    </ul>
  </div>
  <span class="page-num">03</span>
</div>

<div class="page">
  <div class="stripe"></div>
  <div class="page-header"><span class="logo-small">⚗ Percolator</span><span class="section-label">Minute 20–25</span></div>
  <div class="content">
    <h2>The Percolator Team — All 11 Agents</h2>
    <table>
      <thead><tr><th>Agent</th><th>Role</th><th>Model</th><th>What They Do</th></tr></thead>
      <tbody>
        <tr><td><strong>PM</strong></td><td>Coordinator</td><td><span class="badge badge-cyan">Sonnet</span></td><td>Assigns targets, prioritizes work, keeps agents unblocked</td></tr>
        <tr><td><strong>Coder</strong></td><td>Builder</td><td><span class="badge badge-red">Opus</span></td><td>Scans repos, writes code, creates PRs, writes bug reports</td></tr>
        <tr><td><strong>QA</strong></td><td>Verifier</td><td><span class="badge badge-cyan">Sonnet</span></td><td>Tests findings, catches hallucinations, approves PRs</td></tr>
        <tr><td><strong>Security</strong></td><td>Reviewer</td><td><span class="badge badge-red">Opus</span></td><td>Deep vulnerability analysis, severity assessment</td></tr>
        <tr><td><strong>DevOps</strong></td><td>Merger</td><td><span class="badge badge-cyan">Sonnet</span></td><td>CI/CD, merges PRs with --admin, deployment</td></tr>
        <tr><td><strong>Sysadmin</strong></td><td>Monitor</td><td><span class="badge badge-green">Haiku</span></td><td>Health checks, disk space, service uptime</td></tr>
        <tr><td><strong>Designer</strong></td><td>Visual</td><td><span class="badge badge-cyan">Sonnet</span></td><td>UI/UX, branding assets, social graphics</td></tr>
        <tr><td><strong>Writer</strong></td><td>Content</td><td><span class="badge badge-cyan">Sonnet</span></td><td>Documentation, blog posts, launch announcements</td></tr>
        <tr><td><strong>Researcher</strong></td><td>Intel</td><td><span class="badge badge-cyan">Sonnet</span></td><td>Market research, competitor analysis</td></tr>
        <tr><td><strong>Strategist</strong></td><td>Planning</td><td><span class="badge badge-cyan">Sonnet</span></td><td>Product strategy, roadmap, go-to-market</td></tr>
        <tr><td><strong>Mobile</strong></td><td>App Dev</td><td><span class="badge badge-red">Opus</span></td><td>Mobile app development, React Native</td></tr>
      </tbody>
    </table>
    <div class="callout"><strong>Key insight:</strong> Not all agents run all the time. PM enables/disables agent crons based on workload. <span class="badge badge-red">Opus</span> for heavy thinking, <span class="badge badge-cyan">Sonnet</span> for routine work, <span class="badge badge-green">Haiku</span> for lightweight monitoring.</div>
    <h3>Hierarchy</h3>
    <div class="diagram">PM → coder, qa, security, devops, sysadmin, designer, video, writer, researcher, strategist
coder → qa, security
qa → coder
devops → coder, sysadmin
security → coder, devops
designer → coder</div>
  </div>
  <span class="page-num">04</span>
</div>

<div class="page">
  <div class="stripe"></div>
  <div class="page-header"><span class="logo-small">⚗ Percolator</span><span class="section-label">Minute 25–35</span></div>
  <div class="content">
    <h2>Setup Guide — Install OpenClaw</h2>
    <div class="callout"><strong>Prerequisites:</strong> Node.js 22+ · Anthropic API key (console.anthropic.com) or Claude Max · Git · Terminal (macOS/Linux or WSL on Windows)</div>
    <div class="step"><div class="step-num">1</div><div class="step-body"><h4>Install</h4><pre>npm install -g openclaw@latest</pre></div></div>
    <div class="step"><div class="step-num">2</div><div class="step-body"><h4>Health check</h4><pre>openclaw doctor</pre><ul><li><em>"No API key found"</em> → <code>export ANTHROPIC_API_KEY=sk-ant-...</code> or set in <code>~/.openclaw/.env</code></li><li><em>"Node version too old"</em> → <code>nvm install 22</code></li><li><em>"Gateway not running"</em> → <code>openclaw gateway start</code></li></ul></div></div>
    <div class="step"><div class="step-num">3</div><div class="step-body"><h4>Create your first project</h4><pre>mkdir my-scanner &amp;&amp; cd my-scanner
openclaw setup</pre></div></div>
    <div class="step"><div class="step-num">4</div><div class="step-body"><h4>Write your SOUL.md</h4><pre>You are a code scanner. You clone repos and look for security vulnerabilities.

## Session Start
1. Read PROGRESS.md
2. Check tasks: curl "http://127.0.0.1:18801/api/tasks?assigned_to=scanner"
3. Pick highest priority task and start scanning

## Rules
- Clone the target repo. Read the code. Don't guess.
- If you find a bug: what, where, why, impact, fix suggestion.
- If you find nothing, say so honestly. Never fabricate findings.
- Update PROGRESS.md when done.</pre></div></div>
    <div class="step"><div class="step-num">5</div><div class="step-body"><h4>Start gateway + collector, then create a task</h4><pre>openclaw gateway start
node ~/.openclaw/collector/collector.mjs &amp;

curl -X POST http://127.0.0.1:18801/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Scan example-repo","assigned_to":"scanner","created_by":"human","priority":"P1"}'</pre></div></div>
  </div>
  <span class="page-num">05</span>
</div>

<div class="page">
  <div class="stripe"></div>
  <div class="page-header"><span class="logo-small">⚗ Percolator</span><span class="section-label">Minute 35–40</span></div>
  <div class="content">
    <h2>Debugging &amp; Common Issues</h2>
    <h3>🔇 "My agent isn't doing anything"</h3>
    <ul>
      <li>Cron enabled? → <code>openclaw cron list</code></li>
      <li>Gateway running? → <code>openclaw gateway status</code></li>
      <li>Collector running? → <code>curl http://127.0.0.1:18801/api/health</code></li>
      <li>Agent has tasks? → <code>curl "http://127.0.0.1:18801/api/tasks?assigned_to=scanner"</code></li>
      <li>Check logs → <code>~/.openclaw/logs/gateway.log</code></li>
    </ul>
    <h3>🌀 "My agent is hallucinating findings"</h3>
    <ul>
      <li>Add to SOUL.md: <em>"Never claim to have run a command you didn't run. Paste actual output as evidence."</em></li>
      <li>Add evidence rule to RULES.md: <em>"Ran a command? Paste the output. Every claim needs proof."</em></li>
      <li>Add a QA agent to verify — single-agent setups are prone to hallucination</li>
    </ul>
    <h3>🔁 "My agent keeps doing the same thing every session"</h3>
    <ul>
      <li>Is PROGRESS.md updating? If it's the same every session, the agent has no memory</li>
      <li>Add anti-repetition rule: <em>"Read PROGRESS.md first. If state is unchanged, don't repeat the same work."</em></li>
      <li>Check compaction settings — context may be getting pruned too aggressively</li>
    </ul>
    <h3>💸 "My agent is using too many tokens"</h3>
    <ul>
      <li>HEARTBEAT.md should be under 20 lines — all bootstrap files load 48× a day</li>
      <li>SOUL.md should be under 150 lines</li>
      <li>Use model tiering: <span class="badge badge-green">Haiku</span> for monitoring, <span class="badge badge-cyan">Sonnet</span> for routine, <span class="badge badge-red">Opus</span> only for complex analysis</li>
      <li>Set <code>contextPruning</code> and <code>compaction</code> in openclaw.json</li>
    </ul>
    <h3>⏱ "Rate limits"</h3>
    <ul>
      <li>Stagger cron schedules: 30-min intervals with 4-min gaps between agents</li>
      <li>Don't run more than 1–2 Opus agents concurrently</li>
      <li>Set <code>timeoutSeconds</code> on heartbeats (600s simple, 900s complex)</li>
    </ul>
    <h3>❓ "Agent keeps asking the user for permission"</h3>
    <ul>
      <li>Add to SOUL.md: <em>"You are autonomous. Do not ask the user what to do."</em></li>
      <li>Check permission settings in openclaw.json</li>
    </ul>
  </div>
  <span class="page-num">06</span>
</div>

<div class="page">
  <div class="stripe"></div>
  <div class="page-header"><span class="logo-small">⚗ Percolator</span><span class="section-label">Minute 40–50</span></div>
  <div class="content">
    <h2>The Bug Bounty Pipeline — How Percolator Earns</h2>
    <div class="flow">
      <div class="flow-step" style="font-size:0.72rem">1. PM finds target</div><div class="flow-arrow">→</div>
      <div class="flow-step" style="font-size:0.72rem">2. Coder scans</div><div class="flow-arrow">→</div>
      <div class="flow-step" style="font-size:0.72rem">3. QA verifies</div><div class="flow-arrow">→</div>
      <div class="flow-step" style="font-size:0.72rem">4. Security rates</div><div class="flow-arrow">→</div>
      <div class="flow-step" style="font-size:0.72rem">5. DevOps submits</div><div class="flow-arrow">→</div>
      <div class="flow-step" style="font-size:0.72rem;border-color:#4ade80;color:#4ade80;">💰 Paid</div>
    </div>
    <h3>Real Example — Finding That Earned $8,500</h3>
    <div class="bug-report">
      <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
        <span class="badge badge-red">HIGH</span>
        <span class="badge badge-cyan">Immunefi</span>
        <span class="badge badge-green">$8,500 bounty</span>
        <span style="font-family:var(--font-mono);font-size:0.78rem;color:var(--muted);">[Redacted DeFi Protocol]</span>
      </div>
      <div class="label">Vulnerability</div>
      <div class="value"><strong>Unchecked Return Value on Token Transfer — Reentrancy Risk</strong><br/><code>programs/vault/src/instructions/withdraw.rs</code> lines 84–97</div>
      <div class="label">Root Cause</div>
      <div class="value">The <code>process_withdraw</code> function updates user balance state <em>before</em> confirming the token transfer succeeds. State is mutated even if the transfer silently fails.</div>
      <pre style="font-size:0.72rem;">// ❌ VULNERABLE — state mutated before transfer confirmed
user_account.balance -= withdraw_amount;  // line 84 — state first
token::transfer(cpi_ctx, withdraw_amount)?; // line 97 — transfer after

// ✅ FIXED — transfer first, then update state
token::transfer(cpi_ctx, withdraw_amount)?; // transfer first
user_account.balance -= withdraw_amount;    // state only on success</pre>
      <div class="label">QA Verified</div>
      <div class="value">QA agent reproduced the ordering issue in a local fork. CVSS 3.1: <strong>8.1 HIGH</strong> — exploitable via custom RPC or block stuffing without special permissions.</div>
    </div>
    <h3>How contributors earn</h3>
    <ul>
      <li>Join the Discord — PM posts available targets</li>
      <li>Run your own scanner and submit findings through the pipeline</li>
      <li>QA catches false positives before submission (protects reputation)</li>
    </ul>
  </div>
  <span class="page-num">07</span>
</div>

<div class="page">
  <div class="stripe"></div>
  <div class="page-header"><span class="logo-small">⚗ Percolator</span><span class="section-label">Minute 50–55</span></div>
  <div class="content">
    <h2>Best Practices — Lessons From Running 11 Agents 24/7</h2>
    <div class="do-dont">
      <div class="do-list">
        <h3>✅ DO</h3>
        <ul>
          <li>Start with <strong>1 agent</strong>. Add more only when you need them.</li>
          <li>Write SOUL.md like a job description for a <strong>tired engineer at 3am</strong> — clear, specific, no fluff.</li>
          <li>Put credentials in <strong>TOOLS.md</strong> (loaded every session) not memory files (can get pruned).</li>
          <li>Use <strong>PROGRESS.md</strong> for cross-session continuity — structured format, not free text.</li>
          <li>Add a <strong>QA agent early</strong> — single agents hallucinate and you won't catch it.</li>
          <li><strong>Stagger cron schedules</strong> to avoid rate limits.</li>
          <li>Use <strong>model tiering</strong> — Haiku for monitoring, Sonnet for routine, Opus for analysis.</li>
        </ul>
      </div>
      <div class="dont-list">
        <h3>❌ DON'T</h3>
        <ul>
          <li>Don't use <strong>ALL-CAPS urgency markers</strong> (CRITICAL, MUST, NEVER) — causes agents to overtrigger.</li>
          <li>Don't put <strong>"if in doubt, ask"</strong> in prompts — agents will ask about everything.</li>
          <li>Don't make <strong>HEARTBEAT.md longer than 20 lines</strong> — it runs 48× a day.</li>
          <li>Don't let the <strong>PM agent write code</strong> — add explicit FORBIDDEN ACTIONS.</li>
          <li>Don't trust a <strong>single agent's findings</strong> — always verify with QA.</li>
          <li>Don't put <strong>secrets in workspace files</strong> — use .env files.</li>
          <li>Don't nest subagents <strong>deeper than 2 levels</strong> — diminishing returns.</li>
        </ul>
      </div>
    </div>
    <div class="callout tip" style="margin-top:16px;"><strong>The #1 mistake:</strong> Making HEARTBEAT.md too long. Every extra line runs 48 times a day, 1,440 times a month. A bloated heartbeat is a silent token drain that never shows up in any single session.</div>
    <h3>PROGRESS.md template — copy this</h3>
    <pre>## Last Heartbeat
2026-03-25 18:00 UTC

## Current Task
PERC-123 — Scan example/repo for reentrancy bugs

## Status
In progress — reviewed /src/vault/, moving to /src/instructions/

## Next Steps
- Finish reading withdraw.rs and deposit.rs
- Check for unchecked return values on token transfers

## Blockers
None</pre>
  </div>
  <span class="page-num">08</span>
</div>

<div class="page">
  <div class="stripe"></div>
  <div class="page-header"><span class="logo-small">⚗ Percolator</span><span class="section-label">Quick Reference — Screenshot This</span></div>
  <div class="content">
    <h2>Quick Reference Card</h2>
    <p style="color:var(--muted);font-size:0.82rem;margin-bottom:16px;">Screenshot this page. Everything you need in one place.</p>
    <div class="qr-card">
      <div class="two-col">
        <div>
          <h3 style="color:var(--accent2);margin-top:0;">OpenClaw CLI</h3>
          <pre style="margin:0;">openclaw doctor
openclaw gateway start
openclaw gateway status
openclaw gateway stop
openclaw cron list
openclaw cron enable &lt;id&gt;
openclaw cron disable &lt;id&gt;</pre>
        </div>
        <div>
          <h3 style="color:var(--accent2);margin-top:0;">Collector API</h3>
          <pre style="margin:0;">GET  /api/health
GET  /api/dashboard
GET  /api/tasks?assigned_to=X
GET  /api/messages?to_agent=X
POST /api/tasks
POST /api/messages
POST /api/activity</pre>
        </div>
      </div>
      <div style="margin-top:16px;">
        <h3 style="color:var(--accent2);margin-top:0;">File sizes (enforce these)</h3>
        <pre style="margin:0;">HEARTBEAT.md   → max 20 lines   (loads 48×/day)
SOUL.md        → max 150 lines
TOOLS.md       → any size       (credentials go here)
PROGRESS.md    → structured     (Last HB / Task / Status / Next / Blockers)</pre>
      </div>
      <div style="margin-top:16px;">
        <h3 style="color:var(--accent2);margin-top:0;">Model tiers</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <span class="badge badge-green">Haiku — monitoring</span>
          <span class="badge badge-cyan">Sonnet — routine work</span>
          <span class="badge badge-red">Opus — complex analysis</span>
        </div>
      </div>
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);">
        <div style="display:flex;gap:32px;flex-wrap:wrap;">
          <div><div style="font-size:0.72rem;color:var(--muted);font-family:var(--font-mono);">DISCORD</div><div style="font-size:0.9rem;color:var(--cyan);">discord.gg/guPnxpHkE</div></div>
          <div><div style="font-size:0.72rem;color:var(--muted);font-family:var(--font-mono);">GITHUB</div><div style="font-size:0.9rem;color:var(--cyan);">github.com/dcccrypto/percolator-launch</div></div>
          <div><div style="font-size:0.72rem;color:var(--muted);font-family:var(--font-mono);">COLLECTOR BASE</div><div style="font-size:0.9rem;color:var(--cyan);">http://127.0.0.1:18801</div></div>
        </div>
      </div>
    </div>
  </div>
  <span class="page-num">09</span>
</div>

<div class="page back-cover">
  <div style="position:relative;z-index:1;text-align:center;">
    <div style="font-family:var(--font-mono);font-size:2rem;font-weight:700;margin-bottom:8px;">⚗ <span style="color:var(--accent);">Percolator</span></div>
    <div style="font-size:0.82rem;color:var(--muted);font-family:var(--font-mono);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:32px;">OpenClaw Workshop</div>
    <div style="font-size:1.6rem;font-weight:700;line-height:1.3;max-width:480px;margin:0 auto 16px;">Built by agents.<br/>Verified by agents.<br/><span style="color:var(--accent);">Bounties paid to humans.</span></div>
    <div style="font-size:0.92rem;color:#888898;margin-bottom:40px;">Join the workshop. Bring a terminal.</div>
    <div style="display:inline-block;background:white;padding:16px;border-radius:8px;margin-bottom:20px;">
      <div style="width:96px;height:96px;background:var(--bg);display:grid;grid-template-columns:repeat(7,1fr);gap:2px;padding:4px;">
        <div style="grid-column:1/4;grid-row:1/4;border:4px solid #FF4444;border-radius:2px;"></div>
        <div style="grid-column:5/8;grid-row:1/4;border:4px solid #FF4444;border-radius:2px;"></div>
        <div style="grid-column:1/4;grid-row:5/8;border:4px solid #FF4444;border-radius:2px;"></div>
        <div style="grid-column:5;grid-row:5;background:#FF4444;"></div>
        <div style="grid-column:6;grid-row:6;background:#FF4444;"></div>
        <div style="grid-column:7;grid-row:7;background:#FF4444;"></div>
        <div style="grid-column:4;grid-row:3;background:#FF4444;"></div>
        <div style="grid-column:4;grid-row:5;background:#FF4444;"></div>
      </div>
    </div>
    <div style="font-family:var(--font-mono);font-size:1rem;color:var(--cyan);">discord.gg/guPnxpHkE</div>
  </div>
  <div class="cover-bottom-bar"></div>
</div>
`;

export default function OpenClawWorkshopPage() {
  return (
    <div className="oc-workshop">
      <style dangerouslySetInnerHTML={{ __html: workshopStyle }} />
      <div dangerouslySetInnerHTML={{ __html: workshopBody }} />
    </div>
  );
}
