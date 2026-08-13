# Pi

T3 Code runs Pi through the `pi-acp` adapter. Pi remains the agent runtime, while T3 Code owns the
project worktree and provides the web, desktop, and mobile thread interface.

Install and configure both commands on the machine running the T3 Code server:

```bash
npm install -g @earendil-works/pi-coding-agent pi-acp
pi
```

Open **Settings**, select the Pi provider, and refresh its status. If either command is outside the
server's `PATH`, set **ACP adapter path** or **Pi path** to the executable's absolute path.

Pi discovers its normal global and project extensions, tools, skills, prompts, context files,
models, providers, and credentials. The agent starts in the T3-managed worktree, so creating and
renaming worktree branches remains T3 Code's responsibility.

Terminal-only extension UI cannot render in T3 Code. Custom TUI widgets, footer/status changes,
themes, shortcuts, and editor dialogs are unavailable. Selection and confirmation requests are
shown through T3 Code's approval interface where the ACP adapter supports them.
