You are shipping slop-computer-live to prod from a multi-agent worktree.

The user invoked `/deploy`. Multiple terminals share this checkout and
may fire `/deploy` concurrently. Your job is to bundle whatever's in
the working tree, commit it honestly, push to `origin/main`, and run
`./ops/deploy.sh` — or yield cleanly if someone else is already
shipping. Do NOT cherry-pick "your" files vs theirs: coupled changes
must ship together (your code may reference functions another agent
just added). The pre-commit hook is the safety net.

---

## Step 0: Confirm you're in slop-computer-live

This command targets slop-computer-live specifically (it shells out to
`./ops/deploy.sh` and SSHes to the `slopcomputer` prod box). Verify
first — `/deploy` is a global slash command and the user might fire
it from another project by accident.

```bash
test -x ./ops/deploy.sh && grep -q "slop-live" ./ops/deploy.sh && echo OK
```

If that doesn't print `OK`, exit cleanly with:
> `/deploy` is wired for slop-computer-live; the current directory
> doesn't have `./ops/deploy.sh`. cd into the project and re-invoke.

Do not improvise an alternative deploy path.

---

## The four hard rules (read these first)

1. **Never fix another agent's broken code.** If the pre-commit hook
   (tsc/eslint) blocks the commit, REPORT the failing file + error
   and STOP. Do not edit their WIP, do not `--no-verify`, do not
   stash to "get past it". Re-invoke `/deploy` later when their
   work compiles.
2. **Max 1 retry per failure class.** One `pull --rebase` after a
   non-fast-forward push. One re-bundle after a dirty-tree-mid-flow.
   After that, stop and report — don't loop chasing a moving tree.
3. **Skip deploy if prod is already on local HEAD.** Saves the ~30s
   of redundant build+rsync when another terminal shipped your
   commit five seconds ago.
4. **Yield on the lock — don't poll.** If `/tmp/slop-deploy.lock`
   exists, exit cleanly. Your commit is on `origin/main`; the lock
   holder will carry it through their deploy chain. Polling burns
   prompt-cache windows for nothing.

---

## Step 1: Scan the worktree AND check what prod is serving

Run in parallel:
- `git status`
- `git diff`
- `git log --oneline -3 origin/main`
- `git rev-parse --short HEAD`
- `ssh slopcomputer 'cd /home/ubuntu/slop-computer-live && git rev-parse --short HEAD'`
- `ls /tmp/slop-deploy.lock 2>/dev/null` (check if a deploy is already running)

The prod HEAD check is unconditional — even if the worktree looks
clean. The reason: a previous `/deploy` invocation may have yielded
on the lock (Rule 4). In that case, your commit is sitting on
`origin/main` and the user re-invokes `/deploy` to see if it landed.
You need to tell them.

Branch on the combined state:

- **Worktree clean, local HEAD == prod HEAD** → fully shipped.
  Report "already live at `$hash`" and EXIT.
- **Worktree clean, local HEAD is AHEAD of prod, lock is present** →
  another terminal is mid-deploy carrying `local..prod` forward.
  Report "in-flight — `$localHash` is on origin, lock holder will
  ship it" and EXIT (Rule 4: no polling).
- **Worktree clean, local HEAD is AHEAD of prod, lock is ABSENT** →
  prior `/deploy` yielded and the lock holder finished without
  shipping our commit (rare — maybe their deploy errored, maybe
  they yielded too). Jump to Step 5 to ship it ourselves.
- **Worktree clean, local is ahead of `origin/main`** → unusual.
  Push first (`git push origin main`), then Step 5.
- **Worktree dirty** → continue to Step 2.

---

## Step 2: Stage + security scan (HARD GATE)

```bash
git config user.email "clawd@buidlguidl.com" && git config user.name "clawdbotatg"
git add -A
git diff --cached
```

Scan the cached diff for:
- **Ethereum/EVM private keys**: any 64-hex string (with or without `0x`)
- **PEM keys**: `BEGIN PRIVATE KEY`, `BEGIN RSA PRIVATE KEY`, `BEGIN EC PRIVATE KEY`, `BEGIN OPENSSH PRIVATE KEY`
- **Mnemonics**: 12 or 24-word sequences, vars named `mnemonic` / `seed` / `recovery_phrase`
- **API tokens**: `sk-…` (OpenAI), `sk_live_` / `pk_live_` (Stripe), `ghp_…` / `gho_…` / `ghs_…` (GitHub), `AKIA…` (AWS), `xoxb-…` / `xoxp-…` (Slack), `Bearer <long>`, Alchemy/Infura keys in URLs
- **`.env` files** in the staged list (any name starting with `.env`)
- **Sensitive assignments**: hardcoded `password=`, `secret=`, `token=`, `API_KEY=` with real values (not placeholders)

If ANY hit: `git reset` to unstage everything, list findings with
file:line, STOP. Do not commit, do not deploy. Suggest `.gitignore`,
env var, or `.env.example` placeholder. (The `gitleaks` pre-commit
hook is a backstop — visual scan still required.)

---

## Step 3: Compose an honest commit message

Read the full staged diff and write ONE message that covers the
whole bundle. Don't claim authorship of work you didn't author —
describe what changed, not who.

- Lowercase imperative, summary under 72 chars
- If multiple unrelated concerns are bundled, use a "bundle: …"
  summary and let bullets carry detail. Honesty beats brevity.
- End with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

---

## Step 4: Commit + push (bounded retries)

```bash
git commit -m "$(cat <<'EOF'
<your message>
EOF
)"
```

**If the pre-commit hook fails** (tsc/eslint/gitleaks): apply Rule 1.
Report the failing file + error verbatim, EXIT cleanly. Tell the user
to re-invoke `/deploy` when the worktree stabilizes. Do not retry,
do not edit.

**If commit succeeds**: `git push origin main`.

**If push is rejected (non-fast-forward)** — apply Rule 2 (one retry):
```bash
git pull --rebase origin main && git push origin main
```
If this second push also fails, EXIT and report. Never force-push.

**Never** use `--no-verify`, `--amend` on pushed commits, `commit -m … -c commit.gpgsign=false`, or any flag that bypasses hooks/signing.

---

## Step 5: Deploy (lock-aware, idempotent)

Before running deploy, check the lock:

```bash
if [ -f /tmp/slop-deploy.lock ]; then
  echo "another deploy holds the lock; yielding"
  exit 0
fi
```

If yielding: report "yielded — commit `$hash` is on origin/main, the
running deploy will carry it." Done. (Rule 4: do not poll.)

If the lock is free:

```bash
./ops/deploy.sh
```

Possible outcomes:
- **`✓ Deploy complete — $hash live on prod`** → report and done.
- **`✗ Working tree is dirty`** — another agent dirtied the tree
  between commit and deploy. Apply Rule 2: ONE re-bundle attempt
  (back to Step 2). If it happens again, EXIT and report.
- **`✗ Local main is not in sync with origin/main`** — `git pull
  --rebase origin main` once, retry deploy. Second failure: EXIT.
- **`✗ Another deploy is running (PID …)`** — race with another
  terminal that grabbed the lock in the same second. Report yield
  per Rule 4, EXIT.

---

## Step 6: Report

One terse block:
- Commit hash + one-line description of what shipped
- Prod hash now serving (from deploy.sh output, or from the Step 1
  ssh check if you exited early)
- Anything notable

**When you yield** (lock held, or "already shipped" exit), always
include the next-step hint: "re-invoke `/deploy` in a minute to
confirm `$hash` is live on prod." That tells the user the dance
isn't broken — they just need to check again later.

---

## Forbidden ops (no exceptions, even if asked)

- `git push --force` / `--force-with-lease`
- `git reset --hard` against pushed commits
- `git commit --amend` after push
- `git commit --no-verify` / `--no-gpg-sign`
- `git stash` with selective paths (per `feedback_no_selective_stash`)
- Editing another agent's files to "unblock" the commit
- Force-clearing `/tmp/slop-deploy.lock` (only the lock holder can)

If you find a private key in the diff, treat it as already compromised
and tell the user to rotate it.

Be terse: findings, decisions, results. No walls of text.
