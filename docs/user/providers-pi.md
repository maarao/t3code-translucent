# Pi

T3 Code runs Pi directly through its RPC mode. Pi remains the agent runtime, while T3 Code owns the
project worktree and provides the web, desktop, and mobile thread interface.

Install and configure Pi on the machine running the T3 Code server:

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

Open **Settings**, select the Pi provider, and refresh its status. If Pi is outside the server's
`PATH`, set **Pi path** to the executable's absolute path.

Pi discovers its normal global extensions, tools, skills, prompts, context files, models, providers,
and credentials. Full-access threads trust project-local Pi resources in the T3-managed worktree.
Approval-required threads do not load untrusted project resources.

Pi extension selection, confirmation, text-input, and editor requests appear in T3 Code's user-input
interface. Terminal-only components such as custom widgets, footers, themes, shortcuts, and custom
TUI components do not render in T3 Code.

Subagents launched by Pi's `subagent_spawn` extension appear in T3 Code's Agents panel. Their start,
completion, harness, model, and final summary are retained even when they outlive the turn that
spawned them. Blocking workflow runs also show their current phase and completion progress, with each
workflow child listed under its coordinator with the child's harness, model, phase, status, and latest
summary.
Live child transcripts and takeover controls remain available only in Pi's terminal UI.
