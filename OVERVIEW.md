# Run server requests on your laptop

Let a Paseo agent on your server request a laptop command without copying it into another terminal. Open **Client commands**, review the command and its reason, select your laptop and workspace, then press **Yep, run on Laptop**.

Commands run in a real PTY using your laptop account's login shell in interactive mode. Your normal bash, zsh, or fish startup files load. Output stays visible in the terminal, and the requesting agent receives a bounded copy of the combined stdout/stderr and exit status when the command finishes. Results can also be retrieved by request ID.

Install this plugin on the server. Your laptop needs a connected local Paseo daemon, which the desktop app starts automatically. Requires Paseo 0.15.0 or newer, and a macOS or Linux execution host.

Every command requires an individual approval. Multiple viewers share the queue; the first decision wins. Pending requests survive restarts, and uncertain launches are never retried automatically.

The sidebar shows a badge with the pending count. Enable desktop notifications in **Client commands** to get an alert while Paseo is open and connected, even with the queue page closed. Clicking an alert opens the queue for review.
