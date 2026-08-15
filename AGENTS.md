# Agent Instructions

## Committing

- Never commit or push automatically. Stop and ask the user for explicit approval before committing, pushing, merging, or opening a pull request.
- Leave changes uncommitted in the worktree for the user to review unless they explicitly asked you to commit.

## Versioning / package.json

- Never modify `package.json`, `package-lock.json`, or any version metadata on your own initiative.
- Version bumps (`patch` / `minor` / `major`) and dependency changes are decided and applied by the user, or only after an explicit request.
- If completed work would normally imply a version bump or dependency change, mention it in your final summary and let the user apply it.

## Worktree Workflow

Do all work in a git worktree on a new branch — never work directly on the shared checkout.

1. Base the new branch on the current release branch (e.g. `release/2026-08-20`), synced with origin:
   - `git fetch origin && git checkout release/2026-08-20 && git pull --ff-only`
2. Create the worktree on the new branch:
   - `git worktree add -b <branch> ../dungeon-blitz-r-<suffix> release/2026-08-20`
3. Implement the change inside the worktree and commit it there.
4. Push the branch to the remote so the work is available:
   - `git push -u origin <branch>`
5. Once all worktrees for that branch are done, merge them into one and finish:
   - In a worktree with the release branch checked out, squash-merge the worktree branch(es) into a single commit:
     - `git merge --squash <branch> && git commit`
   - Push the release branch: `git push origin release/2026-08-20`
   - Clean up: remove the worktree(s) (`git worktree remove <path> --force` if needed) and delete the temporary branch (`git branch -d <branch>`).
